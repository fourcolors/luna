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
 *      message. When the dream lane's resolved provider profile supports
 *      structured output (default ON for capable lanes; LUNA_REASONER_STRUCTURED_OUTPUT
 *      overrides in either direction), the turn is issued with an `outputFormat`
 *      json_schema (DREAM_OPS_SCHEMA) and we consume the SDK's schema-validated
 *      `structured_output`; otherwise we take the message's `.result: string`.
 *   3. Structured path → validate op array shapes directly; text path →
 *      JSON.parse → validate op array shapes (shared validateRawOpsArray).
 *   4. For belief_candidate ops: derive targetId, build a proposed MemoryRecord,
 *      snapshot `before` from memory (idempotency + revert contract).
 *   5. Any parse/validation/memory failure → DreamError (never crashes the cron).
 */
import { Effect, Layer } from "effect"
import type { MemoryRecord } from "@luna/memory"
import { MemoryRouterTag } from "@luna/memory"
import {
  DreamReasoner,
  DreamError,
  deriveBeliefId,
  makeBeliefRecord,
  AccountBroker,
  DEFAULT_DISTILL_OPTIONS,
  DREAM_PROMPT_TOKEN_BUDGET,
  estimateTokens,
  deriveSkillImprovementTargetId,
  isSafeSkillId,
  MemoryBackendError,
} from "@luna/core"
import type {
  DreamInputs,
  DreamOp,
  DreamOpKind,
  DreamReasonerApi,
  SkillImprovementAfter,
} from "@luna/core"
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
  "skill_improvement",
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
      // skill_improvement fields
      mode: { type: "string", enum: ["create", "update"] },
      skillId: { type: ["string", "null"] },
      title: { type: "string" },
      detail: { type: ["string", "null"] },
      prompt: { type: "string" },
    },
  },
}

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

/** Shape for skill_improvement ops the model emits. */
interface RawSkillImprovementOp {
  readonly kind: "skill_improvement"
  readonly mode: "create" | "update"
  readonly skillId?: string | null
  readonly title: string
  readonly detail?: string | null
  readonly prompt: string
  readonly evidence?: ReadonlyArray<string>
  readonly rationale: string
}

type RawOp = RawBeliefCandidateOp | RawOtherOp | RawSkillImprovementOp

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
 * `structuredOutputEnabled` (default false, i.e. today's prose) drops the
 * verbose field-by-field union restatement (rule 2) in favor of a short
 * instruction plus one worked example when the turn will carry a native
 * `outputFormat` json_schema (DREAM_OPS_SCHEMA already enforces the top-level
 * field union) - the substantive per-kind rules (3-6: category boundary,
 * required fields NOT covered by the permissive top-level schema, the skill-chip
 * cap, etc.) are unaffected either way, since the schema doesn't encode them.
 *
 * Exported so it can be unit-tested independently of the full layer.
 */
export function buildDreamPrompt(
  inputs: DreamInputs,
  structuredOutputEnabled = false,
): string {
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

  const skillLines = (inputs.skills ?? []).map(
    (s) =>
      `SKILL id=${s.id} name=${JSON.stringify(s.name)} enabled=${s.enabled} source=${s.source}: ${s.description}`,
  )
  // Cap skill catalog block hard so a large registry cannot bloat the prompt.
  const skillsBlock = capMemories(skillLines, 4_000)

  // Rule 2 (op field shape): on the structured path, the SDK's outputFormat
  // json_schema (DREAM_OPS_SCHEMA) already enforces the field union, so
  // restating it in prose is redundant - a short instruction plus one worked
  // example is enough. The parse path (structured output off, "none" lanes or
  // an explicit rollback) keeps the full field-by-field restatement, since it
  // is the model's ONLY source of the required shape there.
  const opShapeRule = structuredOutputEnabled
    ? [
        "2. The op field shape is enforced by the response schema. Example op:",
        '   { "kind": "belief_candidate", "domain": "comms", "statement": "...",',
        '     "confidence": 0.8, "evidence": ["session:s-1#m-1"], "rationale": "..." }',
      ]
    : [
        "2. Each op MUST have exactly these fields:",
        '   { "kind": ..., "domain"?: ..., "statement"?: ..., "confidence"?: ...,',
        '     "evidence"?: [...], "targetId"?: ..., "before"?: ..., "after"?: ...,',
        '     "mode"?: ..., "skillId"?: ..., "title"?: ..., "detail"?: ..., "prompt"?: ...,',
        '     "rationale": "..." }',
      ]

  return [
    "You are Luna's nightly Dream reasoner. Reflect over the sessions and current",
    "memory/beliefs/skills below and propose state changes as a STRICT JSON array of ops.",
    "",
    "Rules (ALL are load-bearing — violating them corrupts the alignment loop):",
    "",
    "1. Output ONLY a JSON array. No markdown, no prose, no code fences.",
    "",
    ...opShapeRule,
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
    "6. For kind=skill_improvement (skills/workflows the operator should build next):",
    "   - MUST derive from SESSION TRANSCRIPTS: repeated work, friction, missing playbooks.",
    "   - Required: mode ('create'|'update'), title (short chip title), prompt (self-contained",
    "     authoring instructions for a subagent), rationale (why, with session evidence).",
    "   - Optional: skillId (REQUIRED when mode=update — must match a SKILL id below),",
    "     detail (longer chip blurb), evidence (session:id#msg_id strings).",
    "   - Prefer mode=update for existing user skills; use mode=create for new ones.",
    "   - NEVER propose editing source=builtin skills in place — if a builtin needs",
    "     improvement, mode=create a NEW user skill that supersedes it.",
    "   - The system enforces a hard cap of ~3 skill chips per night — propose only the",
    "     highest-value ideas. Empty array is fine when nothing skill-worthy happened.",
    "   - Do NOT write skill file contents into the op; put authoring instructions in prompt.",
    "",
    "SESSIONS (source of truth for belief candidates + skill improvements):",
    sessions || "(none)",
    "",
    "SKILL CATALOG (metadata only; for skill_improvement create/update):",
    skillsBlock || "(none — skill catalog not available this cycle)",
    "",
    // CURRENT MEMORY STATE stays LAST so memory-cap tests that measure from
    // this header to end of prompt remain valid (skills must not follow it).
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
        } else if (kind === "skill_improvement") {
          const mode = op["mode"]
          if (mode !== "create" && mode !== "update") {
            throw new Error(`op[${i}] skill_improvement mode must be 'create'|'update'`)
          }
          const title = op["title"]
          if (typeof title !== "string" || title.trim().length === 0) {
            throw new Error(`op[${i}] skill_improvement missing title`)
          }
          const prompt = op["prompt"]
          if (typeof prompt !== "string" || prompt.trim().length === 0) {
            throw new Error(`op[${i}] skill_improvement missing prompt`)
          }
          const skillIdRaw = op["skillId"]
          const skillId =
            skillIdRaw === undefined || skillIdRaw === null
              ? null
              : typeof skillIdRaw === "string"
                ? skillIdRaw
                : null
          if (mode === "update" && (!skillId || skillId.length === 0)) {
            throw new Error(`op[${i}] skill_improvement mode=update requires skillId`)
          }
          // Single-segment slug only — reject path traversal / whitespace that
          // would poison the accept-handler path preface (~/.luna/skills/<id>/).
          if (skillId !== null && !isSafeSkillId(skillId)) {
            throw new Error(
              `op[${i}] skill_improvement skillId is not a safe single-segment slug`,
            )
          }
          const detailRaw = op["detail"]
          const detail =
            detailRaw === undefined || detailRaw === null
              ? null
              : typeof detailRaw === "string"
                ? detailRaw
                : null
          const evidence = op["evidence"]
          return {
            kind: "skill_improvement",
            mode,
            skillId,
            title: title.trim(),
            detail,
            prompt: prompt.trim(),
            evidence: Array.isArray(evidence) ? (evidence as ReadonlyArray<string>) : [],
            rationale,
          } satisfies RawSkillImprovementOp
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
  } else if (raw.kind === "skill_improvement") {
    const after: SkillImprovementAfter = {
      mode: raw.mode,
      skillId: raw.skillId ?? null,
      title: raw.title,
      detail: raw.detail ?? null,
      prompt: raw.prompt,
    }
    const targetId =
      raw.mode === "update" && raw.skillId
        ? raw.skillId
        : deriveSkillImprovementTargetId(raw.title, raw.prompt)
    return Effect.succeed({
      kind: "skill_improvement",
      targetId,
      before: null,
      after,
      rationale: raw.rationale,
    } satisfies DreamOp)
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

    // Native structured output gate. DEFAULT ON whenever dreamModel's resolved
    // provider profile supports structured output (laneSupportsStructuredOutput,
    // via @luna/core's provider-profile registry) - the "default" lane (anthropic)
    // and google both qualify today; a "none" lane falls back to prompt-and-parse
    // exactly as before. LUNA_REASONER_STRUCTURED_OUTPUT overrides in EITHER
    // direction: force it on to try a lane ahead of the capability check, or off
    // to roll back instantly if dream's op-validation failure rate rises.
    const structuredOutputEnabled = reasonerStructuredOutputEnabled(dreamModel)

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

    // Wall-clock ceiling for one reasoning turn. The dream is dispatched by
    // the V2 JobTicker (kind:"dream" -> DreamWorker), whose per-dispatch
    // backstop deadline interrupts an overrunning CHUNK; runDream commits the
    // watermark per chunk, so an interrupted chunk cleanly re-runs next
    // dispatch. This timeout is the inner per-SDK-call ceiling so a wedged
    // turn can't hold the worker until the ticker kills it. Overridable via
    // env; defaults to 10 min.
    //
    // job-ticker-oban-deadlines (Seam 1): the ticker's `grace` window (which
    // lets a worker's OWN inner timeout fire first, on its own typed
    // WorkerError terms, before the ticker's outer timeoutFail) only helps
    // SINGLE-TURN-shaped workers (prompt/workflow) whose one inner timeout
    // maps directly onto the whole dispatch. It does NOT save a large dream
    // backlog: this LUNA_DREAM_TIMEOUT_MS is a PER-CHUNK ceiling, unrelated to
    // the whole-dispatch backstop, and a dream draining many chunks can
    // legitimately run past `defaultTimeoutMs + grace`. For dream, hitting the
    // ticker's backstop `deadline_passed` on a large backlog remains the
    // EXPECTED terminal outcome — it is now survivable because Seam 3 retries
    // the job with backoff and runDream resumes from its last committed
    // per-chunk watermark, not because grace prevents it from happening.
    const dreamTimeoutMs = (() => {
      const raw = process.env["LUNA_DREAM_TIMEOUT_MS"]?.trim()
      const n = raw ? Number(raw) : DEFAULT_QUERY_TIMEOUT_MS
      return Number.isFinite(n) && n > 0 ? Math.trunc(n) : DEFAULT_QUERY_TIMEOUT_MS
    })()

    const reason: DreamReasonerApi["reason"] = (inputs: DreamInputs) =>
      Effect.gen(function* () {
        const prompt = buildDreamPrompt(inputs, structuredOutputEnabled)

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
          dreamModel: dreamModel ?? "(default)",
          pathToClaudeCodeExecutable: pathToClaudeCodeExecutable ?? "(unset)",
        })

        // ── PASS 1 — the SOLE materializer ─────────────────────────────────────
        // Brokered turn → parseRawOps → materializeOp.
        //
        // One brokered turn (shared with wake-reasoner): scoped acquire so the
        // broker's inFlight finalizer fires at turn end, the model-gate +
        // provider env-overlay options fragment, and usage / rate-limit
        // reporting so chain budgets and 429 failover apply to this lane.
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
        // is exactly the prior parseRawOps(text) path.
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

        yield* Effect.logInfo(
          `[luna/dream] reasoner.reason: returning ${ops.length} op(s)`,
        )
        return ops
      })

    return { reason } satisfies DreamReasonerApi
  }),
)
