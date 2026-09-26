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

/**
 * Cross-encoder reranker score threshold: keeps 93-100% of correct memories
 * and rejects 100% of junk on the Phase 5 real-data sample (n=27; see the
 * real-data calibration section in packages/memory/bench/README.md, where
 * correct answers score a median of 100 and junk scores <=2). 40 is the
 * midpoint of the validated safe threshold range (~30-50). The original 75
 * was calibrated for the retired Haiku scorer's holdout and does not hold
 * for the cross-encoder engine. The synthetic baseline's own threshold
 * search picked 3 (ce-rerank-baseline-2026-07-16.json `injectionThreshold`),
 * but flagged it meetsGoal:false - it rejects only 75% of the synthetic
 * adversarial junk - which is exactly why the real-data calibration, not
 * the synthetic one, is the authority for this default.
 * Overridable via LUNA_RERANK_CE_THRESHOLD (or the legacy LUNA_RERANK_THRESHOLD,
 * see rerankTuningEnv). */
export const DEFAULT_RERANK_THRESHOLD = 40

/**
 * Env var prefix for each engine's own tuning knobs. "cross-encoder" uses CE
 * to match its existing LUNA_RERANK_CE_* variables.
 */
const ENGINE_ENV_PREFIX: Readonly<Record<string, string>> = {
  "cross-encoder": "CE",
  jev: "JEV",
}

const engineEnvPrefix = (engine: string): string =>
  ENGINE_ENV_PREFIX[engine] ?? engine.toUpperCase().replace(/[^A-Z0-9]+/g, "_")

/** The engine-scoped tuning variable name, e.g. LUNA_RERANK_JEV_THRESHOLD. */
export function rerankTuningVarName(knob: "THRESHOLD" | "MAX_CANDIDATES", engine: string): string {
  return `LUNA_RERANK_${engineEnvPrefix(engine)}_${knob}`
}

const warnedIgnoredLegacy = new Set<string>()

/**
 * Raw value of a rerank tuning knob for `engine`.
 *
 * Each engine's threshold and depth are calibrated for that engine's score
 * scale and latency (the cross-encoder: 40 / 8; Jev: 0 / 40), so a value
 * tuned for one engine is wrong for another. Lookup order:
 *
 * 1. The engine-scoped variable (LUNA_RERANK_CE_THRESHOLD,
 *    LUNA_RERANK_JEV_MAX_CANDIDATES, ...). Always wins.
 * 2. The legacy unscoped variable (LUNA_RERANK_THRESHOLD /
 *    LUNA_RERANK_MAX_CANDIDATES). These predate engine selection and were
 *    tuned for the cross-encoder, so they apply ONLY to the cross-encoder (or
 *    an unnamed engine, as in tests). For any other engine they are ignored,
 *    with a one-time warning. Before this rule, an operator who tuned the
 *    cross-encoder and then switched to Jev in the Models tab silently ran
 *    Jev at depth 8 with a threshold of 40, which dropped most memories.
 */
function rerankTuningEnv(
  knob: "THRESHOLD" | "MAX_CANDIDATES",
  env: Record<string, string | undefined>,
  engine: string | undefined,
): string | undefined {
  const legacyName = `LUNA_RERANK_${knob}`
  const legacy = env[legacyName]?.trim() || undefined
  if (engine === undefined) return legacy
  const scoped = env[rerankTuningVarName(knob, engine)]?.trim() || undefined
  if (scoped !== undefined) return scoped
  if (engine === "cross-encoder") return legacy
  if (legacy !== undefined) {
    const key = `${legacyName}\u0000${engine}`
    if (!warnedIgnoredLegacy.has(key)) {
      warnedIgnoredLegacy.add(key)
      console.warn(
        `[luna/memory] ${legacyName}=${legacy} is ignored for the ${engine} reranker: it is cross-encoder tuning. ` +
          `Using ${engine}'s own default. To override it for ${engine}, set ${rerankTuningVarName(knob, engine)}.`,
      )
    }
  }
  return undefined
}

/** Exposed for tests that need a clean slate between cases. */
export function resetRerankTuningWarnState(): void {
  warnedIgnoredLegacy.clear()
}

export function resolveRerankThreshold(
  env: Record<string, string | undefined> = process.env,
  /** The engine's own calibrated threshold (MemoryRerankerApi.defaults.threshold). */
  engineDefault: number = DEFAULT_RERANK_THRESHOLD,
  /** MemoryRerankerApi.engine; scopes which env override applies (see rerankTuningEnv). */
  engine?: string,
): number {
  const raw = rerankTuningEnv("THRESHOLD", env, engine)
  if (raw === undefined || raw === "") return engineDefault
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : engineDefault
}

/**
 * HARD cap on how many of the (retrieval-ordered) candidates memory_search
 * sends to the cross-encoder. The reranker scores each candidate in a SEPARATE
 * forward pass, so latency is ~linear in candidate count (measured
 * ~0.6s/candidate on the target GPU sidecar), and this cap is the latency
 * bound. It is a pure latency/recall knob: candidates beyond the cap are not
 * reranked (they keep retrieval order and are absent from the reranked output).
 *
 * The default of 8 (~5s) is a tradeoff, not a proven no-loss point. The
 * committed cap-sweep in packages/memory/bench/rerank-eval.ts (LUNA_BENCH_CAP_SWEEP)
 * shows recall@k across caps on the synthetic corpus; a separate real-DB-copy
 * sample (personal data, not committed - see the Phase 5 PR) put every labeled
 * target within retrieval rank 6. Raise the cap if you observe misses on a
 * query whose target sits deeper in retrieval; lower it (e.g. 5 -> ~3s) for
 * speed at some recall risk on deep targets.
 */
export const DEFAULT_RERANK_MAX_CANDIDATES = 8

export function resolveRerankMaxCandidates(
  env: Record<string, string | undefined> = process.env,
  /** The engine's own latency-validated depth (MemoryRerankerApi.defaults.maxCandidates). */
  engineDefault: number = DEFAULT_RERANK_MAX_CANDIDATES,
  /** MemoryRerankerApi.engine; scopes which env override applies (see rerankTuningEnv). */
  engine?: string,
): number {
  const raw = rerankTuningEnv("MAX_CANDIDATES", env, engine)
  const n = raw ? Number(raw) : engineDefault
  return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : engineDefault
}

/**
 * Whether a lane reranks: "1" forces it on, "0" forces it off, and unset
 * follows the engine (MemoryRerankerApi.defaults.enabled) - on for an engine
 * the operator explicitly configured (LUNA_RERANK_ENGINE=jev), off for the
 * always-bound default cross-encoder, which keeps today's opt-in behavior.
 */
export function rerankLaneEnabled(
  varName: string,
  engineEnabledByDefault: boolean | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env[varName]?.trim()
  if (raw === "1") return true
  if (raw === "0") return false
  return engineEnabledByDefault === true
}

/**
 * Per-call rerank budget for the PER-TURN recall path. recallForTurn runs
 * inside chat-service's outer recall timeout (DEFAULT_RECALL_TIMEOUT_MS =
 * 2500ms), and that outer timeout nulls the ENTIRE recall context when it
 * fires - it never reaches our degrade-to-un-reranked fallback (Codex
 * review finding). So the rerank call must give up comfortably inside that
 * budget: fail fast, degrade to the plain pack, keep recall alive. 1500ms
 * default leaves ~1s for retrieval + packing. Only a fast engine fits: on
 * laptop measurements Jev at depth 40 (~0.2 s warm) does, the cross-encoder
 * at depth 40 (~2.2 s) does not (the removed Haiku engine took ~30 s); a
 * slow engine degrades to the plain pack instead of nulling recall.
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
 * The OUTER per-turn recall budget - the same env chat-service's
 * parseRecallTimeoutMs reads (packages/chat-service/src/chat-service.ts),
 * default 2500ms there too. Read here so the rerank stage can budget from
 * the REMAINDER of that window after retrieval spends its share; when that
 * outer timeout fires it nulls the whole recall context, bypassing every
 * degrade path (Codex probe: 1.1s retrieval + a static 1.5s rerank cap =
 * 2506ms = TimeoutException, zero context). Keep the default in lockstep
 * with chat-service's DEFAULT_RECALL_TIMEOUT_MS.
 */
export function resolveOuterRecallBudgetMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env["LUNA_CHAT_RECALL_TIMEOUT_MS"]?.trim()
  const n = raw ? Number(raw) : 2500
  return Number.isFinite(n) && n >= 0 ? n : 2500
}

/** Reserved for packing + timer skew when computing the rerank's share of
 * the outer recall window. */
export const RECALL_RERANK_SAFETY_MARGIN_MS = 400

/** Below this remaining budget, starting a rerank call is pointless - skip
 * it and pack un-reranked instead of launching a doomed call. */
export const RECALL_RERANK_MIN_USEFUL_MS = 250

/**
 * "Log once per process" failure policy, keyed by lane AND error type, so
 * memory_search's first failure doesn't suppress recallForTurn's (and vice
 * versa), and one kind of failure doesn't hide another (a hosted engine's
 * first-call cold-start timeout must not swallow a later auth or rate-limit
 * error). A module-level Set is intentional here - this process may serve
 * MANY requests, and repeating an identical rerank-unavailable warning on
 * every single one would just be log noise once the operator has seen it.
 */
const loggedLanes = new Set<string>()

export function logRerankFailureOnce(
  lane: string,
  failure: RerankError | Cause.Cause<RerankError>,
): Effect.Effect<void> {
  const key = `${lane}\u0000${Cause.isCause(failure) ? "cause" : failure.op}`
  if (loggedLanes.has(key)) return Effect.void
  loggedLanes.add(key)
  // Accepts a bare RerankError or a full Cause for flexibility. Both call
  // sites now convert defects to RerankError via catchAllDefect (so
  // interrupts propagate), but a Cause-shaped failure still formats sanely
  // if a future call site passes one.
  const detail = Cause.isCause(failure)
    ? Cause.pretty(failure).split("\n")[0]
    : `${failure.op}: ${failure.message}`
  return Effect.logWarning(
    `[luna/memory] ${lane}: rerank failed (${detail}) - ` +
      "falling back to un-reranked order. Further rerank failures of this " +
      "kind on this lane are suppressed for the rest of this process.",
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
