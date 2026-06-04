/**
 * dream-reasoner.ts — Model-backed DreamReasoner layer for adapter-sdk.
 *
 * WHY HERE (not core): adapter-sdk already depends on @luna/core; core does
 * NOT depend on adapter-sdk. Putting an SDKClient-using impl in core would
 * create a forbidden core → adapter-sdk → core cycle. So:
 *   - DreamReasoner Tag + FakeReasoner STAY in core/dream/reasoner.ts (unchanged).
 *   - This module exports DreamReasonerDefault: Layer.Layer<DreamReasoner, never, SDKClient | MemoryRouter>
 *
 * Design (§3.1 Dream engine, §2.3 category boundary):
 *   1. Build a deterministic prompt from DreamInputs (sessions → belief candidates;
 *      memories = current state to reconcile). The category boundary (belief ops
 *      must derive from transcripts, never telemetry) is stated in the prompt.
 *   2. Call sdk.query({ prompt }) → collect the type:"result"/subtype:"success"
 *      message's `.result: string`.
 *   3. JSON.parse → validate op array shapes.
 *   4. For belief_candidate ops: derive targetId, build a proposed MemoryRecord,
 *      snapshot `before` from memory (idempotency + revert contract).
 *   5. Any parse/validation/memory failure → DreamError (never crashes the cron).
 */
import { Effect, Layer, Stream } from "effect"
import type { MemoryRecord } from "@luna/memory"
import { MemoryRouterTag } from "@luna/memory"
import {
  DreamReasoner,
  DreamError,
  deriveBeliefId,
  makeBeliefRecord,
} from "@luna/core"
import type {
  DreamInputs,
  DreamOp,
  DreamOpKind,
  DreamReasonerApi,
} from "@luna/core"
import { MemoryBackendError } from "@luna/core"
import type { SDKMessage } from "./sdk-client.js"
import { SDKClient } from "./sdk-client.js"

// ---------------------------------------------------------------------------
// Valid op kinds (mirrors DreamOpKind union)
// ---------------------------------------------------------------------------
const VALID_KINDS: ReadonlySet<string> = new Set<DreamOpKind>([
  "memory_dedup",
  "memory_staleness",
  "memory_contradiction",
  "belief_candidate",
])

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
 * Build a deterministic prompt from DreamInputs.
 *
 * Exported so it can be unit-tested independently of the full layer.
 */
export function buildDreamPrompt(inputs: DreamInputs): string {
  const sessions = inputs.sessions
    .map(
      (s) =>
        `SESSION ${s.summary.id} (${s.messages.length} msgs):\n` +
        s.messages
          .map((m) => `  [${m.kind}] ${JSON.stringify(m.payload)}`)
          .join("\n"),
    )
    .join("\n\n")

  const mems = inputs.memories
    .map((m) => `MEMORY ${m.id} namespace=${m.namespace} kind=${m.kind}`)
    .join("\n")

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
// SDK result collection
// ---------------------------------------------------------------------------

/**
 * Iterate the Query stream and extract the `.result` string from the
 * `type:"result"` / `subtype:"success"` message.
 * Any other outcome → DreamError({ op:"reason", ... }).
 */
function collectResultText(
  query: import("./sdk-client.js").Query,
): Effect.Effect<string, DreamError> {
  return Stream.fromAsyncIterable(query, (cause) =>
    new DreamError({
      op: "reason",
      message: `SDK stream error: ${String(cause)}`,
      cause,
    }),
  ).pipe(
    Stream.runFold(
      null as string | null,
      (acc: string | null, msg: SDKMessage) => {
        const m = msg as {
          type?: string
          subtype?: string
          result?: string
        }
        if (m.type === "result" && m.subtype === "success" && typeof m.result === "string") {
          return m.result
        }
        return acc
      },
    ),
    Effect.flatMap((result) => {
      if (result === null) {
        return Effect.fail(
          new DreamError({
            op: "reason",
            message: "SDK stream produced no type:result/subtype:success message",
          }),
        )
      }
      return Effect.succeed(result)
    }),
  )
}

// ---------------------------------------------------------------------------
// Parse + shape-validate the raw op array
// ---------------------------------------------------------------------------

function parseRawOps(text: string): Effect.Effect<ReadonlyArray<RawOp>, DreamError> {
  return Effect.try({
    try: (): ReadonlyArray<RawOp> => {
      // Strip accidental markdown fences if the model wraps output despite the prompt.
      const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim()
      const raw = JSON.parse(trimmed) as unknown
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
 * Model-backed DreamReasoner layer. Requires SDKClient + MemoryRouter.
 * The returned `reason` effect has R=never (both are closed over at build time).
 */
export const DreamReasonerDefault: Layer.Layer<
  DreamReasoner,
  never,
  SDKClient | import("@luna/memory").MemoryRouter
> = Layer.effect(
  DreamReasoner,
  Effect.gen(function* () {
    const sdk = yield* SDKClient
    const mem = yield* MemoryRouterTag

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

    const reason: DreamReasonerApi["reason"] = (inputs: DreamInputs) =>
      Effect.gen(function* () {
        const prompt = buildDreamPrompt(inputs)
        yield* Effect.logInfo("[luna/dream] reasoner.reason: starting", {
          sessions: inputs.sessions.length,
          memories: inputs.memories.length,
          pathToClaudeCodeExecutable: pathToClaudeCodeExecutable ?? "(unset)",
        })
        const query = yield* sdk.query({
          prompt,
          options: {
            maxTurns: 1,
            ...(pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable } : {}),
          },
        })
        const resultText = yield* collectResultText(query)
        const rawOps = yield* parseRawOps(resultText)
        const ops: DreamOp[] = []
        for (const raw of rawOps) {
          const op = yield* materializeOp(raw, mem)
          ops.push(op)
        }
        yield* Effect.logInfo(
          `[luna/dream] reasoner.reason: returning ${ops.length} op(s)`,
        )
        return ops as ReadonlyArray<DreamOp>
      })

    return { reason } satisfies DreamReasonerApi
  }),
)
