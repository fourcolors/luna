/**
 * dream-reasoner.ts — Model-backed DreamReasoner layer for adapter-sdk.
 *
 * WHY HERE (not core): adapter-sdk already depends on @luna/core; core does
 * NOT depend on adapter-sdk. Putting an SDKClient-using impl in core would
 * create a forbidden core → adapter-sdk → core cycle. So:
 *   - DreamReasoner Tag + FakeReasoner STAY in core/dream/reasoner.ts (unchanged).
 *   - This module exports DreamReasonerDefault: Layer.Layer<DreamReasoner, never, SDKClient | MemoryRouter | AccountBroker>
 *
 * Design (§3.1 Dream engine, §2.3 category boundary):
 *   1. Build a deterministic prompt from DreamInputs (sessions → belief candidates;
 *      memories = current state to reconcile). The category boundary (belief ops
 *      must derive from transcripts, never telemetry) is stated in the prompt.
 *   2. Call sdk.query({ prompt }) → collect the type:"result"/subtype:"success"
 *      message. When LUNA_REASONER_STRUCTURED_OUTPUT is on (default OFF), the
 *      turn is issued with an `outputFormat` json_schema (DREAM_OPS_SCHEMA) and
 *      we consume the SDK's schema-validated `structured_output`; otherwise we
 *      take the message's `.result: string`.
 *   3. Structured path → validate op array shapes directly; text path →
 *      JSON.parse → validate op array shapes (shared validateRawOpsArray).
 *   4. For belief_candidate ops: derive targetId, build a proposed MemoryRecord,
 *      snapshot `before` from memory (idempotency + revert contract).
 *   5. Any parse/validation/memory failure → DreamError (never crashes the cron).
 */
import { Effect, Layer, Option } from "effect"
import type { MemoryRecord } from "@luna/memory"
import { MemoryRouterTag } from "@luna/memory"
import {
  DreamReasoner,
  DreamError,
  deriveBeliefId,
  makeBeliefRecord,
  computeAgreement,
  CalibrationStore,
  AccountBroker,
  DEFAULT_DISTILL_OPTIONS,
  DREAM_PROMPT_TOKEN_BUDGET,
  estimateTokens,
} from "@luna/core"
import type {
  DreamInputs,
  DreamOp,
  DreamOpKind,
  DreamReasonerApi,
} from "@luna/core"
import { MemoryBackendError } from "@luna/core"
import { SDKClient } from "./sdk-client.js"
import { DEFAULT_QUERY_TIMEOUT_MS } from "./bounded-query.js"
import {
  resolveReasonerModel,
  runBrokeredReasonerTurn,
  reasonerStructuredOutputEnabled,
  type BrokeredTurnResult,
} from "./brokered-turn.js"

// ---------------------------------------------------------------------------
// Valid op kinds (mirrors DreamOpKind union)
// ---------------------------------------------------------------------------
const VALID_KINDS: ReadonlySet<string> = new Set<DreamOpKind>([
  "memory_dedup",
  "memory_staleness",
  "memory_contradiction",
  "belief_candidate",
])

/**
 * JSON Schema for the dream op array — passed as the SDK `outputFormat` when
 * structured output is enabled. The model emits a TOP-LEVEL ARRAY of ops; the
 * per-kind required fields differ, so the item schema is permissive (a union of
 * the two shapes) and validateRawOpsArray remains the authoritative validator.
 * The schema's job is to force valid JSON + the array envelope + the kind enum,
 * eliminating the "model wrapped its JSON / emitted a prose preamble" failures;
 * the fine-grained per-kind checks stay in validateRawOpsArray.
 */
const DREAM_OPS_SCHEMA: Record<string, unknown> = {
  type: "array",
  items: {
    type: "object",
    required: ["kind", "rationale"],
    properties: {
      kind: { type: "string", enum: [...VALID_KINDS] },
      rationale: { type: "string", minLength: 1 },
      domain: { type: "string" },
      statement: { type: "string" },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      evidence: { type: "array", items: { type: "string" } },
      targetId: { type: "string" },
      before: {},
      after: {},
    },
  },
}

/**
 * Slice B (sampling-based confidence, MEASURE-ONLY): how many UNSEEDED
 * reasoning passes to run for the SelfCheckGPT-style agreement signal. Pass 1
 * is the privileged "today's path" that SOLELY materializes ops; passes 2..N
 * are measurement-only. Overridable via LUNA_DREAM_SAMPLES (read at layer-build
 * time, mirroring LUNA_DREAM_TIMEOUT_MS); clamps to a positive integer.
 */
const DEFAULT_DREAM_SAMPLES = 5
/** Defensive upper bound on N: a misconfigured LUNA_DREAM_SAMPLES (e.g. 1000)
 * must not flood the system with SDK queries — each pass is a real query. */
const MAX_DREAM_SAMPLES = 10
/** Bounded concurrency for the measurement-only extra passes (avoid load
 * spikes / rate limits / memory pressure at high N). */
const DREAM_SAMPLE_CONCURRENCY = 4

// ---------------------------------------------------------------------------
// Raw op shape from the model's JSON output
// ---------------------------------------------------------------------------

/** Shape for a belief_candidate raw op the model emits. */
interface RawBeliefCandidateOp {
  readonly kind: "belief_candidate"
  readonly domain: string
  readonly statement: string
  readonly confidence: number
  readonly evidence?: ReadonlyArray<string>
  readonly rationale: string
}

/** Shape for other memory-hygiene ops the model emits. */
interface RawOtherOp {
  readonly kind: "memory_dedup" | "memory_staleness" | "memory_contradiction"
  readonly targetId: string
  readonly before?: unknown
  readonly after?: unknown
  readonly rationale: string
}

type RawOp = RawBeliefCandidateOp | RawOtherOp

// ---------------------------------------------------------------------------
// Prompt builder (pure, exported for tests)
// ---------------------------------------------------------------------------

/**
 * Cap the rendered memories block at `budget` chars. Keeps WHOLE leading lines
 * that fit alongside the omission marker, then appends a final
 * `[… N more memory records omitted]` line (N = dropped count). The returned
 * string — kept lines + marker — is always <= budget (issue #255 §memories cap).
 *
 * The marker shrinks as more lines are kept (fewer digits in N), so the per-line
 * fit check projects the marker for the count AFTER adding this line; the final
 * marker therefore never overflows the budget it was admitted under.
 */
function capMemories(lines: ReadonlyArray<string>, budget: number): string {
  const joined = lines.join("\n")
  if (joined.length <= budget) return joined

  const kept: string[] = []
  let used = 0 // length of kept.join("\n") so far
  for (const line of lines) {
    const addition = kept.length === 0 ? line.length : line.length + 1 // +1 = "\n"
    const omitted = lines.length - (kept.length + 1)
    const marker = `[… ${omitted} more memory records omitted]`
    if (used + addition + 1 + marker.length > budget) break // +1 = "\n" before marker
    kept.push(line)
    used += addition
  }
  const marker = `[… ${lines.length - kept.length} more memory records omitted]`
  return kept.length === 0 ? marker : `${kept.join("\n")}\n${marker}`
}

/**
 * Build a deterministic prompt from DreamInputs.
 *
 * Sessions arrive PRE-DISTILLED (gatherInputs → distillSession): render each as
 * its short excerpt under a count header. NEVER JSON.stringify the summary — the
 * whole point of the distiller (issue #255) is that raw payloads never reach the
 * prompt, and leaking summary fields (title, etc.) is both bloat and a category
 * leak. Memories render one line each, capped at DEFAULT_DISTILL_OPTIONS.memoriesChars.
 *
 * Exported so it can be unit-tested independently of the full layer.
 */
export function buildDreamPrompt(inputs: DreamInputs): string {
  const sessions = inputs.sessions
    .map(
      (s) =>
        `SESSION ${s.summary.id} (${s.windowMessageCount}/${s.messageCount} msgs in window):\n` +
        s.excerpt,
    )
    .join("\n\n")

  const mems = capMemories(
    inputs.memories.map(
      (m) => `MEMORY ${m.id} namespace=${m.namespace} kind=${m.kind}`,
    ),
    DEFAULT_DISTILL_OPTIONS.memoriesChars,
  )

  return [
    "You are Luna's nightly Dream reasoner. Reflect over the sessions and current",
    "memory/beliefs below and propose state changes as a STRICT JSON array of ops.",
    "",
    "Rules (ALL are load-bearing — violating them corrupts the alignment loop):",
    "",
    "1. Output ONLY a JSON array. No markdown, no prose, no code fences.",
    "",
    "2. Each op MUST have exactly these fields:",
    '   { "kind": ..., "domain"?: ..., "statement"?: ..., "confidence"?: ...,',
    '     "evidence"?: [...], "targetId"?: ..., "before"?: ..., "after"?: ...,',
    '     "rationale": "..." }',
    "",
    `3. kind MUST be one of: ${[...VALID_KINDS].join(" | ")}`,
    "",
    "4. For kind=belief_candidate (§2.3 CATEGORY BOUNDARY — STRICTLY ENFORCED):",
    "   - MUST derive from SESSION TRANSCRIPTS only. Never from telemetry or memories.",
    "   - Required fields: domain (string), statement (string), confidence (0-1 float),",
    "     evidence (array of 'session:id#msg_id' strings), rationale (string).",
    "   - targetId and before/after are COMPUTED by the system — do NOT supply them.",
    "",
    "5. For kind=memory_dedup|memory_staleness|memory_contradiction:",
    "   - Required fields: targetId (the memory record id), rationale (string).",
    "   - Optional: before (current state), after (desired state or null for delete).",
    "",
    "SESSIONS (source of truth for belief candidates):",
    sessions || "(none)",
    "",
    "CURRENT MEMORY STATE (for dedup/staleness/contradiction ops only):",
    mems || "(none)",
  ].join("\n")
}

// ---------------------------------------------------------------------------
// Parse + shape-validate the raw op array
// ---------------------------------------------------------------------------

/**
 * Pure shape-validator: turn an already-parsed JSON value into a RawOp array,
 * THROWING on any shape violation. Shared by both consumption paths —
 * `parseRawOps` (text → JSON.parse → here) and `validateRawOps` (the SDK's
 * schema-validated `structured_output` → here) — so they can never drift.
 */
function validateRawOpsArray(raw: unknown): ReadonlyArray<RawOp> {
  if (!Array.isArray(raw)) {
    throw new Error("model output is not a JSON array")
  }
  return raw.map((o: unknown, i: number): RawOp => {
        const op = o as Record<string, unknown>
        const kind = op["kind"]
        if (typeof kind !== "string" || !VALID_KINDS.has(kind)) {
          throw new Error(`op[${i}] has invalid or missing kind: ${String(kind)}`)
        }
        const rationale = op["rationale"]
        if (typeof rationale !== "string" || rationale.length === 0) {
          throw new Error(`op[${i}] missing rationale string`)
        }
        if (kind === "belief_candidate") {
          const domain = op["domain"]
          const statement = op["statement"]
          const confidence = op["confidence"]
          if (typeof domain !== "string" || domain.length === 0) {
            throw new Error(`op[${i}] belief_candidate missing domain`)
          }
          if (typeof statement !== "string" || statement.length === 0) {
            throw new Error(`op[${i}] belief_candidate missing statement`)
          }
          if (typeof confidence !== "number" || confidence < 0 || confidence > 1) {
            throw new Error(`op[${i}] belief_candidate confidence must be 0-1 number`)
          }
          const evidence = op["evidence"]
          return {
            kind: "belief_candidate",
            domain,
            statement,
            confidence,
            evidence: Array.isArray(evidence) ? (evidence as ReadonlyArray<string>) : [],
            rationale,
          } satisfies RawBeliefCandidateOp
        } else {
          // memory_dedup | memory_staleness | memory_contradiction
          const targetId = op["targetId"]
          if (typeof targetId !== "string" || targetId.length === 0) {
            throw new Error(`op[${i}] ${kind} missing targetId`)
          }
          return {
            kind: kind as "memory_dedup" | "memory_staleness" | "memory_contradiction",
            targetId,
            before: op["before"] ?? null,
            after: op["after"] ?? null,
            rationale,
          } satisfies RawOtherOp
        }
      })
}

/**
 * Validate an already-parsed value (the SDK's schema-validated
 * `structured_output`) into a RawOp array. No JSON.parse, no fence-stripping —
 * the SDK already guaranteed valid JSON conforming to DREAM_OPS_SCHEMA; this is
 * the defense-in-depth per-kind shape check.
 */
function validateRawOps(
  raw: unknown,
): Effect.Effect<ReadonlyArray<RawOp>, DreamError> {
  return Effect.try({
    try: (): ReadonlyArray<RawOp> => validateRawOpsArray(raw),
    catch: (cause) =>
      new DreamError({
        op: "parse",
        message: `failed to validate structured output: ${String(cause)}`,
        cause,
      }),
  })
}

/**
 * Parse and shape-validate the model's text JSON output into a RawOp array. The
 * fallback used when structured output is disabled or unavailable.
 */
function parseRawOps(text: string): Effect.Effect<ReadonlyArray<RawOp>, DreamError> {
  return Effect.try({
    try: (): ReadonlyArray<RawOp> => {
      // Strip accidental markdown fences if the model wraps output despite the prompt.
      const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim()
      return validateRawOpsArray(JSON.parse(trimmed))
    },
    catch: (cause) =>
      new DreamError({
        op: "parse",
        message: `failed to parse/validate model output: ${String(cause)}`,
        cause,
      }),
  })
}

/**
 * Slice B clustering: derive the belief-candidate `beliefId`s from a parsed pass.
 * ONLY belief_candidate ops cluster — memory hygiene ops carry a targetId but
 * are NOT beliefs, so they must not enter the agreement count. The id is
 * deriveBeliefId(domain, statement), which trims/lowercases/collapses
 * whitespace, so case/whitespace variants of one statement collapse to one id.
 */
function beliefIdsOf(ops: ReadonlyArray<RawOp>): ReadonlyArray<{ readonly beliefId: string }> {
  const out: Array<{ readonly beliefId: string }> = []
  for (const raw of ops) {
    if (raw.kind === "belief_candidate") {
      out.push({ beliefId: deriveBeliefId(raw.domain, raw.statement) })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Map RawOp → DreamOp (with before-snapshot for belief_candidate)
// ---------------------------------------------------------------------------

function materializeOp(
  raw: RawOp,
  mem: import("@luna/memory").MemoryRouter,
): Effect.Effect<DreamOp, DreamError> {
  if (raw.kind === "belief_candidate") {
    const { domain, statement, confidence, evidence, rationale } = raw
    const id = deriveBeliefId(domain, statement)
    const after: MemoryRecord = makeBeliefRecord({
      statement,
      confidence,
      domain,
      evidence: evidence ?? [],
      status: "proposed",
    })
    // Before-snapshot: if the belief already exists, capture it so revert can
    // restore it; null only when genuinely new.
    return mem.get(id).pipe(
      Effect.mapError(
        (cause: MemoryBackendError) =>
          new DreamError({
            op: "reason",
            message: `mem.get(${id}) failed during before-snapshot: ${cause.message}`,
            cause,
          }),
      ),
      Effect.map(
        (existing: MemoryRecord | null): DreamOp => ({
          kind: "belief_candidate",
          targetId: id,
          before: existing ?? null,
          after,
          rationale,
        }),
      ),
    )
  } else {
    // memory_dedup | memory_staleness | memory_contradiction — pass through
    return Effect.succeed({
      kind: raw.kind,
      targetId: raw.targetId,
      before: raw.before ?? null,
      after: raw.after ?? null,
      rationale: raw.rationale,
    } satisfies DreamOp)
  }
}

// ---------------------------------------------------------------------------
// DreamReasonerDefault — the exported Layer
// ---------------------------------------------------------------------------

/**
 * Model-backed DreamReasoner layer. Requires SDKClient + MemoryRouter +
 * AccountBroker. The returned `reason` effect has R=never (all are closed over
 * at build time); the per-turn credential acquire runs inside `Effect.scoped`
 * so the broker's inFlight finalizer fires at turn end without leaking Scope.
 */
export const DreamReasonerDefault: Layer.Layer<
  DreamReasoner,
  never,
  SDKClient | import("@luna/memory").MemoryRouter | AccountBroker
> = Layer.effect(
  DreamReasoner,
  Effect.gen(function* () {
    const sdk = yield* SDKClient
    const mem = yield* MemoryRouterTag
    const broker = yield* AccountBroker

    // Provider-seam routing: the nightly Dream can run on a cheap model. Pick the
    // model from LUNA_DREAM_MODEL (falling back to the shared LUNA_REASONER_MODEL,
    // each var trimmed independently so a set-but-blank primary falls through);
    // unset → undefined → broker acquired with "default" → anthropic login-ref
    // account → no env overlay, no options.model → today's behavior exactly.
    const dreamModel = resolveReasonerModel("LUNA_DREAM_MODEL")

    // Native structured output gate (default OFF). When on, each dream turn is
    // issued with an outputFormat json_schema and we consume the SDK's validated
    // structured_output; when off, behavior is byte-identical to before. Applies
    // uniformly to pass 1 AND the sampling extras so agreement stays meaningful.
    const structuredOutputEnabled = reasonerStructuredOutputEnabled()

    /**
     * The SDK package ships per-arch native binaries under
     * @anthropic-ai/claude-agent-sdk-linux-x64{-musl}/. In a Bun-installed
     * monorepo on a glibc Linux container, the SDK's default lookup picks
     * the musl variant which is not executable, so `query()` throws:
     *
     *   ReferenceError: Claude Code native binary not found at
     *   …/claude-agent-sdk-linux-x64-musl@…/claude. Please specify a valid
     *   path with options.pathToClaudeCodeExecutable.
     *
     * The live server already exports LUNA_CLAUDE_CODE_EXECUTABLE
     * (/usr/local/bin/claude on the container) and ChatService.callSDK
     * reads it on every chat turn. Dream did NOT — so every 3am cron tick
     * was firing, throwing this exact error, getting swallowed by the
     * trigger agent's Effect.either, and leaving dream_state + dream_audit
     * empty with zero log lines. This line is the fix: same env var, same
     * shape, read at call time so tests can override it.
     */
    const pathToClaudeCodeExecutable =
      process.env["LUNA_CLAUDE_CODE_EXECUTABLE"]?.trim() || undefined

    // Wall-clock ceiling for the single reasoning turn. Dream runs on its own
    // cron (not the V2 ticker), so a hung turn doesn't stall other jobs — but
    // without a deadline a wedged 3am turn would leave a zombie subprocess and
    // never reschedule. Overridable via env; defaults to 10 min.
    const dreamTimeoutMs = (() => {
      const raw = process.env["LUNA_DREAM_TIMEOUT_MS"]?.trim()
      const n = raw ? Number(raw) : DEFAULT_QUERY_TIMEOUT_MS
      return Number.isFinite(n) && n > 0 ? Math.trunc(n) : DEFAULT_QUERY_TIMEOUT_MS
    })()

    // Slice B (MEASURE-ONLY): the number of UNSEEDED reasoning passes N for the
    // sampling-agreement signal. Read at layer-build time (same pattern as the
    // timeout above). An EXPLICIT finite value < 1 (e.g. "0", "-1" — the natural
    // "disable sampling" spellings) clamps to 1 = sampling OFF, honoring the
    // operator's opt-out; only an absent/non-numeric value falls back to the
    // default. Upper-clamped so a misconfiguration cannot flood SDK queries.
    const dreamSamples = (() => {
      const raw = process.env["LUNA_DREAM_SAMPLES"]?.trim()
      if (!raw) return DEFAULT_DREAM_SAMPLES
      const n = Number(raw)
      if (!Number.isFinite(n)) return DEFAULT_DREAM_SAMPLES
      return Math.max(1, Math.min(Math.trunc(n), MAX_DREAM_SAMPLES))
    })()

    const reason: DreamReasonerApi["reason"] = (inputs: DreamInputs) =>
      Effect.gen(function* () {
        const prompt = buildDreamPrompt(inputs)

        // Pre-flight token budget gate (issue #255): distillation bounds each
        // session/memory scope, but a pathological input can still overflow the
        // model's context window. Reject BEFORE acquiring an account or issuing
        // any SDK query — a prompt that would never fit is zero-cost to refuse.
        // The message names BOTH numbers so the failure is self-explaining.
        const estimatedTokens = estimateTokens(prompt)
        if (estimatedTokens > DREAM_PROMPT_TOKEN_BUDGET) {
          return yield* Effect.fail(
            new DreamError({
              op: "reason",
              message:
                `dream prompt too large: estimated ${estimatedTokens} tokens ` +
                `exceeds budget of ${DREAM_PROMPT_TOKEN_BUDGET}`,
            }),
          )
        }

        yield* Effect.logInfo("[luna/dream] reasoner.reason: starting", {
          sessions: inputs.sessions.length,
          memories: inputs.memories.length,
          samples: dreamSamples,
          dreamModel: dreamModel ?? "(default)",
          pathToClaudeCodeExecutable: pathToClaudeCodeExecutable ?? "(unset)",
        })

        // ── PASS 1 — the PRIVILEGED "today's path" (SOLE materializer) ────────
        // Issued FIRST and SEQUENTIALLY, NOT inside any concurrency: brokered
        // turn → parseRawOps → materializeOp, EXACTLY as the single-pass impl.
        // A pass-1 failure (timeout/parse/SDK error) propagates as today's
        // DreamError — no new failure modes. (Locking pass-1 as the first
        // sdk.query() call is also what makes the integration test's
        // confidence===0.85 assertion deterministic against the fake's closure
        // counter.)
        //
        // One brokered turn (shared with wake-reasoner): scoped acquire so the
        // broker's inFlight finalizer fires at turn end, the model-gate +
        // provider env-overlay options fragment, and usage / rate-limit
        // reporting so chain budgets and 429 failover apply to this lane.
        // Pass 1 AND the sampling extras below share this thunk so every pass
        // samples the SAME model/provider lane (agreement over mixed providers
        // would be meaningless) and every pass is metered — the N× nightly
        // sampling cost lands in the spend meter, not off the books.
        const runDreamTurn = () =>
          runBrokeredReasonerTurn({
            sdk,
            broker,
            model: dreamModel,
            prompt,
            baseOptions: {
              maxTurns: 1,
              ...(structuredOutputEnabled
                ? {
                    outputFormat: {
                      type: "json_schema",
                      schema: DREAM_OPS_SCHEMA,
                    },
                  }
                : {}),
              ...(pathToClaudeCodeExecutable
                ? { pathToClaudeCodeExecutable }
                : {}),
            },
            timeoutMs: dreamTimeoutMs,
            errors: {
              acquire: (cause) =>
                new DreamError({
                  op: "reason",
                  message: `failed to acquire account: ${String(cause)}`,
                  cause,
                }),
              timeout: (timeoutMs) =>
                new DreamError({
                  op: "reason",
                  message: `SDK query timed out after ${timeoutMs}ms`,
                }),
              streamError: (cause) =>
                new DreamError({
                  op: "reason",
                  message: `SDK stream error: ${String(cause)}`,
                  cause,
                }),
              empty: () =>
                new DreamError({
                  op: "reason",
                  message:
                    "SDK stream produced no type:result/subtype:success message",
                }),
            },
          })
        // Prefer the SDK's schema-validated structured_output; fall back to
        // parsing the text result. structuredOutput is only ever present when
        // the gate is on AND the provider honored outputFormat — otherwise this
        // is exactly the prior parseRawOps(text) path. Shared by pass 1 and the
        // sampling extras so every pass is validated identically.
        const opsFromTurn = (
          turn: BrokeredTurnResult,
        ): Effect.Effect<ReadonlyArray<RawOp>, DreamError> =>
          turn.structuredOutput !== undefined
            ? validateRawOps(turn.structuredOutput)
            : parseRawOps(turn.text)

        const pass1Turn = yield* runDreamTurn()
        const pass1Raw = yield* opsFromTurn(pass1Turn)
        const ops: DreamOp[] = []
        for (const raw of pass1Raw) {
          const op = yield* materializeOp(raw, mem)
          ops.push(op)
        }

        // ── PASSES 2..N — MEASUREMENT-ONLY extras (never materialize) ─────────
        // COST IS CONTINGENT ON THE SINK: the only consumer of the agreement
        // signal is the calibration log, so extras run ONLY when (a) a
        // CalibrationStore is actually present in the ambient context (else the
        // data is dropped on the floor — paying ~N× SDK cost for nothing),
        // (b) N >= 2 was configured, and (c) pass 1 produced at least one
        // belief_candidate (agreement can only ever attach to pass-1 belief
        // ops — on a no-candidate night extras would be pure waste).
        // serviceOption keeps reason()'s R channel unchanged.
        const calOpt = yield* Effect.serviceOption(CalibrationStore)
        const pass1HasCandidates = pass1Raw.some(
          (r) => r.kind === "belief_candidate",
        )
        const samplingActive =
          Option.isSome(calOpt) && dreamSamples >= 2 && pass1HasCandidates
        if (dreamSamples >= 2 && !samplingActive) {
          yield* Effect.logInfo(
            `[luna/dream] reasoner.reason: sampling extras SKIPPED (` +
              `${Option.isNone(calOpt) ? "no CalibrationStore sink" : "no pass-1 belief candidates"})`,
          )
        }

        // Run AFTER pass 1, concurrently with EACH OTHER. Each extra swallows
        // ALL failures AND defects (timeout/parse/SDK error/sync throw — a
        // plain catchAll would miss defects and fail the turn after pass 1
        // already succeeded) → `null`, lowering the effective N. The whole
        // extras phase shares ONE additional dreamTimeoutMs deadline, so the
        // turn's wall-clock ceiling is ≤ 2× dreamTimeoutMs REGARDLESS of N
        // (without it, batching makes the ceiling (1 + ceil((N-1)/4)) ×
        // timeout). On phase timeout the completed batches are discarded and
        // the turn degrades to no sampling fields — never fails.
        const extraCount = samplingActive ? dreamSamples - 1 : 0
        const extraResults =
          extraCount === 0
            ? []
            : yield* Effect.all(
                Array.from({ length: extraCount }, () =>
                  runDreamTurn().pipe(
                    Effect.flatMap(opsFromTurn),
                    Effect.map(
                      (raw): ReadonlyArray<{ readonly beliefId: string }> | null =>
                        beliefIdsOf(raw),
                    ),
                    // RESILIENCE: an extra-pass failure is SKIPPED — failures
                    // AND defects — it only lowers the effective N.
                    Effect.catchAllCause(() => Effect.succeed(null)),
                  ),
                ),
                { concurrency: DREAM_SAMPLE_CONCURRENCY },
              ).pipe(
                Effect.timeout(dreamTimeoutMs),
                Effect.catchAll(() =>
                  Effect.succeed(
                    [] as ReadonlyArray<ReadonlyArray<{ readonly beliefId: string }> | null>,
                  ),
                ),
              )

        // ── Agreement over ALL surviving passes (pass 1 + surviving extras) ───
        // sampleCount = the number of passes that did NOT error (an empty-but-
        // successful pass still counts toward the denominator). computeAgreement
        // owns the degenerate-N sentinel: with < 2 surviving passes it returns
        // an EMPTY map, so the fields below stay ABSENT (identical to Slice A)
        // rather than logging a meaningless constant-1 "agreement".
        const survivingExtras = extraResults.filter(
          (r): r is ReadonlyArray<{ readonly beliefId: string }> => r !== null,
        )
        const pass1Ids = beliefIdsOf(pass1Raw)
        const passes: ReadonlyArray<ReadonlyArray<{ readonly beliefId: string }>> =
          [pass1Ids, ...survivingExtras]
        const agreement = computeAgreement(passes)

        // Attach the MEASURE-ONLY sampling fields to each PASS-1 belief_candidate
        // op. targetId IS the beliefId. The materialized belief + its verbalized
        // confidence are UNCHANGED — these fields are additive logging metadata
        // (absent whenever the agreement map is empty).
        const withSampling: ReadonlyArray<DreamOp> = ops.map((op) => {
          if (op.kind !== "belief_candidate") return op
          const m = agreement.get(op.targetId)
          if (m === undefined) return op
          return {
            ...op,
            sampledConfidence: m.sampledConfidence,
            sampleCount: m.sampleCount,
          }
        })

        yield* Effect.logInfo(
          `[luna/dream] reasoner.reason: returning ${withSampling.length} op(s) ` +
            `(N=${passes.length} effective sample(s))`,
        )
        return withSampling
      })

    return { reason } satisfies DreamReasonerApi
  }),
)
