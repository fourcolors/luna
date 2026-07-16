/**
 * rerank-support.ts - shared, SDK-free plumbing for gating/observing the
 * production memory reranker (Phase 3, PR #332 bench) from BOTH call sites
 * that use it: the `memory_search` MCP tool (tools.ts) and `recallForTurn`
 * (turn-memory.ts). Centralized here so the two lanes can't drift on
 * threshold resolution, the "log once per process" failure policy, or the
 * shape of the rerank observability event.
 */
import { createHash } from "node:crypto"
import { Cause, Effect } from "effect"
import type { ObservabilityApi, RerankError } from "@luna/core"

/** Matches the bench's holdout-validated gate (packages/memory/bench/
 * rerank-eval.ts): score>=75 rejects 97.5% of junk while keeping 93.7% of
 * good hits. Overridable via LUNA_RERANK_THRESHOLD. */
export const DEFAULT_RERANK_THRESHOLD = 75

export function resolveRerankThreshold(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env["LUNA_RERANK_THRESHOLD"]?.trim()
  if (raw === undefined || raw === "") return DEFAULT_RERANK_THRESHOLD
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : DEFAULT_RERANK_THRESHOLD
}

/** Both lanes are DEFAULT OFF, gated by their own env flag (separate flags -
 * per-turn recall's latency budget is unproven independent of the MCP tool
 * path). A flag is "on" only for the literal value "1". */
export function rerankFlagEnabled(
  varName: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[varName]?.trim() === "1"
}

/**
 * Per-call rerank budget for the PER-TURN recall path. recallForTurn runs
 * inside chat-service's outer recall timeout (DEFAULT_RECALL_TIMEOUT_MS =
 * 2500ms), and that outer timeout nulls the ENTIRE recall context when it
 * fires - it never reaches our degrade-to-un-reranked fallback (Codex
 * review finding). So the rerank call must give up comfortably inside that
 * budget: fail fast, degrade to the plain pack, keep recall alive. 1500ms
 * default leaves ~1s for retrieval + packing. Note: the Phase 3 Haiku
 * engine (~30s/call) can never finish inside this budget - per-turn rerank
 * only becomes functional with a fast engine (Phase 4 cross-encoder);
 * until then the flag degrades safely instead of nulling recall.
 * memory_search (explicit tool call, no 2.5s outer bound) is unaffected
 * and uses the engine's own default timeout.
 */
export function resolveRecallRerankTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env["LUNA_RECALL_RERANK_TIMEOUT_MS"]?.trim()
  const n = raw ? Number(raw) : 1500
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 1500
}

/**
 * "Log once per process" failure policy, keyed by a caller-supplied lane
 * name so memory_search's first failure doesn't suppress recallForTurn's
 * (and vice versa). A module-level Set is intentional here - this process
 * may serve MANY requests, and repeating an identical rerank-unavailable
 * warning on every single one would just be log noise once the operator has
 * seen it.
 */
const loggedLanes = new Set<string>()

export function logRerankFailureOnce(
  lane: string,
  failure: RerankError | Cause.Cause<RerankError>,
): Effect.Effect<void> {
  if (loggedLanes.has(lane)) return Effect.void
  loggedLanes.add(lane)
  // Accepts a bare RerankError or a full Cause for flexibility. Both call
  // sites now convert defects to RerankError via catchAllDefect (so
  // interrupts propagate), but a Cause-shaped failure still formats sanely
  // if a future call site passes one.
  const detail = Cause.isCause(failure)
    ? Cause.pretty(failure).split("\n")[0]
    : `${failure.op}: ${failure.message}`
  return Effect.logWarning(
    `[luna/memory] ${lane}: rerank failed (${detail}) - ` +
      "falling back to un-reranked order. Further rerank failures on this " +
      "lane are suppressed for the rest of this process.",
  )
}

/** Exposed for tests that need a clean slate between cases. */
export function resetRerankFailureLogState(): void {
  loggedLanes.clear()
}

const digestOf = (text: string): string =>
  createHash("sha256").update(text).digest("hex").slice(0, 16)

/**
 * Emit the rerank-stage RetrievalCall event (see @luna/core's
 * RetrievalCallRerankEvent) when an ObservabilityApi instance is available.
 * A no-op (Effect.void) when `obs` is undefined - callers that were built
 * without an ObservabilityService in context (e.g. bare unit tests) stay
 * silent rather than requiring one just to exercise the rerank path.
 */
export function emitRerankObservability(
  obs: ObservabilityApi | undefined,
  args: {
    readonly queryText: string
    readonly namespace?: string
    readonly mode: "hybrid"
    readonly rerankMs: number
    readonly kept: number
    readonly dropped: number
  },
): Effect.Effect<void> {
  if (obs === undefined) return Effect.void
  return obs.emit({
    ts: new Date().toISOString(),
    kind: "RetrievalCall",
    level: "info",
    mode: args.mode,
    queryDigest: digestOf(args.queryText),
    candidateCount: args.kept + args.dropped,
    durationMs: args.rerankMs,
    status: "success",
    reranked: true,
    rerankMs: args.rerankMs,
    kept: args.kept,
    dropped: args.dropped,
    ...(args.namespace !== undefined ? { namespace: args.namespace } : {}),
  })
}
