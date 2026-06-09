import { Effect, Option, Stream } from "effect"
import * as EffectClock from "effect/Clock"
import { MemoryRouterTag } from "@luna/memory"
import type { MemoryRecord, MemoryRouter } from "@luna/memory"
import { Clock } from "../clock.js"
import { CalibrationStore } from "../alignment/calibration-store.js"
import { classifyTier, revertabilityFor } from "../alignment/tier-classifier.js"
import { readBelief } from "../beliefs/types.js"
import { SessionStore } from "../session/session-store.js"
import type { TriggerAgentApi } from "../jobs/trigger-agent.js"
import { DreamStore } from "./dream-store.js"
import { DreamReasoner } from "./reasoner.js"
import type { DreamOp, DreamOpKind, DreamInputs } from "./types.js"

/**
 * Slice A detectability heuristic over DreamOpKind (PLACEHOLDER — a decision
 * needing confirmation; sampling-based detectability is deferred to Slice B).
 * belief_candidate → 1 (a confidence-bearing proposal we can later score),
 * everything else → 0.
 */
const detectabilityFor = (kind: DreamOpKind): number =>
  kind === "belief_candidate" ? 1 : 0

/**
 * Ops materialized to the store (vs. held as 'proposed' audit rows).
 *  - memory_dedup: idempotent delete of an exact duplicate (Phase 1).
 *  - belief_candidate: stage a PROPOSED belief record (Phase 2 §7.2). Safe to
 *    auto-write because a proposed belief is inert — only ACTIVE beliefs are
 *    injected, and activation stays gated on the Phase 3 survey. Undoable via
 *    revert (before:null → delete).
 * Still HELD as 'proposed' (no survey to catch a bad apply yet): memory_staleness,
 * memory_contradiction.
 */
const MATERIALIZE_OPS: ReadonlySet<DreamOpKind> = new Set<DreamOpKind>([
  "memory_dedup",
  "belief_candidate",
])

/**
 * Apply a reasoner's ops. Auto-applies exact-dedup (idempotent state-set);
 * holds everything else as a 'proposed' audit row. Caller advances the
 * watermark AFTER this resolves (see runDream) — re-running over the same
 * window is a no-op because dreamId is deterministic and record() is
 * INSERT OR IGNORE, and memory ops are idempotent.
 */
export const applyOps = (dreamId: string, ops: ReadonlyArray<DreamOp>) =>
  Effect.gen(function* () {
    const store = yield* DreamStore
    const mem = yield* MemoryRouterTag
    const clock = yield* Clock
    const now = yield* clock.nowMs()

    // Slice A calibration instrumentation (MEASURE-ONLY). OPTIONAL dependency:
    // serviceOption keeps applyOps' requirement channel unchanged, so existing
    // dream layers (DreamStore/MemoryRouter/Clock only) are untouched. The write
    // is Effect.ignore'd below — a calibration failure can NEVER alter a dream
    // turn, and nothing ever reads calibration_log back into behavior.
    const calOpt = yield* Effect.serviceOption(CalibrationStore)

    for (const op of ops) {
      if (MATERIALIZE_OPS.has(op.kind)) {
        // Idempotent state-set: null after = delete; else upsert to desired state.
        if (op.after === null) {
          yield* mem.delete(op.targetId)
        } else {
          yield* mem.put(op.after as MemoryRecord)
        }
        yield* store.record({
          dreamId, at: now, op: op.kind, targetId: op.targetId,
          before: op.before, after: op.after, rationale: op.rationale,
          status: "applied", appliedAt: now,
        })
        // Additive, write-only: log a calibration row for confidence-bearing
        // belief proposals (the only ops carrying a beliefId + verbalized
        // confidence). Slice A records the EXISTING verbalized confidence as a
        // placeholder + the trivial detectability heuristic; sampleCount=1.
        if (op.kind === "belief_candidate" && op.after !== null && Option.isSome(calOpt)) {
          const confidence = readBelief(op.after as MemoryRecord).confidence
          const detectability = detectabilityFor(op.kind)
          // Slice 3 MEASURE-ONLY: compute the autonomy tier write-only on the
          // SAME calibration row. stakes is ALWAYS null here (no stakes signal
          // exists anywhere in the codebase — FLAG), revertability is the
          // materialized placeholder heuristic, detectability is the existing
          // Slice A heuristic. HARD invariant: `tier` is NEVER gated and NEVER
          // read back into behavior — it is recorded purely to learn whether
          // the boundaries are sane. The whole write stays Effect.ignore'd, so
          // a tier/calibration failure can never alter a dream turn.
          const tier = classifyTier({
            confidence,
            detectability,
            revertability: revertabilityFor(op.kind, true), // op is materialized here
            stakes: null,
          })
          yield* calOpt.value
            .record({
              dreamId,
              targetId: op.targetId,
              beliefId: op.targetId, // belief_candidate targetId IS the belief id
              proposalAt: now,
              confidence,
              detectability,
              // Slice B MEASURE-ONLY: log the sampling-agreement confidence
              // ALONGSIDE the verbalized `confidence` above (NOT in place of it),
              // and the effective sample size. ABSENT (Slice A single pass) ⇒
              // sampledConfidence null + sampleCount 1, preserving prior behavior.
              // Write-only; never read back into scoring/injection/strength.
              sampledConfidence: op.sampledConfidence ?? null,
              sampleCount: op.sampleCount ?? 1,
              tier,
            })
            .pipe(Effect.ignore)
        }
      } else {
        yield* store.record({
          dreamId, at: now, op: op.kind, targetId: op.targetId,
          before: op.before, after: op.after, rationale: op.rationale,
          status: "proposed", appliedAt: null,
        })
      }
    }
  })

/**
 * Undo an applied op: restore the `before` snapshot to memory and mark the
 * audit row reverted. Returns false if the row is missing or not 'applied'.
 */
export const revert = (auditId: string) =>
  Effect.gen(function* () {
    const store = yield* DreamStore
    const mem = yield* MemoryRouterTag
    const clock = yield* Clock
    const row = yield* store.get(auditId)
    if (row === null || row.status !== "applied") return false
    // Reverse the idempotent state-set.
    if (row.before === null) {
      // op created/kept nothing to restore by id; undo = delete the target.
      yield* mem.delete(row.targetId)
    } else {
      yield* mem.put(row.before as MemoryRecord)
    }
    const now = yield* clock.nowMs()
    return yield* store.markReverted(auditId, now)
  })

export const deriveDreamId = (windowStart: number, windowEnd: number): string =>
  `dream-${windowStart}-${windowEnd}`

/**
 * Collect the dream window (watermark, now]: sessions whose lastMessageAt falls
 * in range, their messages, and operator-namespace memories.
 *
 * NOTE: SessionStore.list has no `since` param, so we list ordered by
 * lastMessageAt and filter the window in code.
 *
 * Adaptation from task spec: the error channel is `MemoryBackendError` (not
 * `never`) because MemoryRouter.query returns Stream<MemoryRecord, MemoryBackendError>.
 */
export const gatherInputs = (
  watermark: number,
  now: number,
) =>
  Effect.gen(function* () {
    const sessions = yield* SessionStore
    const mem = yield* MemoryRouterTag

    const summaries = yield* sessions
      .list({ orderBy: "lastMessageAt" })
      .pipe(
        Stream.filter(
          (s) => s.lastMessageAt !== null && s.lastMessageAt > watermark && s.lastMessageAt <= now,
        ),
        Stream.runCollect,
        Effect.map((c) => Array.from(c)),
      )

    const withMessages = yield* Effect.forEach(summaries, (summary) =>
      sessions
        .readMessages(summary.id)
        .pipe(
          Stream.runCollect,
          Effect.map((c) => ({ summary, messages: Array.from(c) })),
          Effect.catchAll(() => Effect.succeed({ summary, messages: [] as never[] })),
        ),
    )

    const memories = yield* mem
      .query({ namespace: "operator" })
      .pipe(Stream.runCollect, Effect.map((c) => Array.from(c)))

    return { sessions: withMessages, memories }
  })

/**
 * One dream cycle. `now` is injected (caller/cron supplies the clock reading)
 * so the function is deterministic in tests. Watermark is advanced LAST.
 *
 * Crash-recovery idempotency: dreamId and the watermark advance are keyed on
 * the MAX `lastMessageAt` of sessions actually gathered this cycle (the
 * "cutoff"), NOT on `now`. `now` is only the upper bound for gatherInputs.
 *
 * This means:
 *   - A crash retry on a LATER tick (different `now`) gathers the same
 *     sessions (same watermark, same data), produces the same cutoff, and
 *     therefore the same dreamId → INSERT OR IGNORE collapses duplicates.
 *   - Sessions that arrive between gather and watermark-advance (with
 *     lastMessageAt ≤ now but > cutoff) are NOT skipped forever; the
 *     watermark only advances to the latest session actually processed.
 *
 * When no sessions are in the window, cutoff === watermark, so the watermark
 * doesn't move and dreamId is "dream-W-W" — memory-hygiene ops (if any) still
 * get logged, and a clean re-run collapses them.
 */
export const runDream = (now: number) =>
  Effect.gen(function* () {
    const store = yield* DreamStore
    const reasoner = yield* DreamReasoner
    const watermark = (yield* store.getWatermark) ?? 0
    yield* Effect.logInfo(
      `[luna/dream] runDream(${now}) starting; watermark=${watermark}`,
    )

    const inputs = yield* gatherInputs(watermark, now)
    yield* Effect.logInfo(
      `[luna/dream] runDream: gathered ${inputs.sessions.length} session(s) and ${inputs.memories.length} memory record(s)`,
    )

    // Cutoff = the latest lastMessageAt actually processed this cycle (spec
    // §3.1.1 step 5). Keying dreamId + the watermark advance on processed data
    // (not on `now`) makes a crash retry over the same sessions regenerate the
    // same dreamId — so INSERT OR IGNORE collapses the re-run — and prevents
    // skipping sessions that arrive between gather and watermark-advance.
    const cutoff = inputs.sessions.reduce(
      (max, s) => Math.max(max, s.summary.lastMessageAt ?? 0),
      watermark,
    )
    const dreamId = deriveDreamId(watermark, cutoff)

    const ops = yield* reasoner.reason(inputs)
    yield* applyOps(dreamId, ops)

    // Advance to the latest processed lastMessageAt (no-op when no new sessions),
    // LAST — a crash before this re-runs the same window safely.
    yield* store.setWatermark(cutoff)
    yield* Effect.logInfo(
      `[luna/dream] runDream: completed dreamId=${dreamId}; ops=${ops.length}; watermark advanced to ${cutoff}`,
    )
  }).pipe(
    Effect.tapErrorCause((cause) =>
      Effect.logError(`[luna/dream] runDream FAILED`, { cause }),
    ),
  )

/**
 * Register a nightly (or custom cron) dream on the given TriggerAgent.
 * At each cron tick, reads the ambient (test or live) Effect runtime clock
 * and runs one dream cycle.
 *
 * Adaptation note: `JobSpec.run` is typed as
 * `Effect.Effect<unknown, unknown, Scope.Scope>` — no other services allowed
 * in R. Since `runDream` requires `DreamStore | DreamReasoner | SessionStore |
 * MemoryRouterTag | Clock`, we capture the ambient context at registration
 * time via `Effect.context<R>()` and bake it into the `run` effect via
 * `Effect.provide(ctx)`. Scope is intentionally excluded — the pool provides
 * a fresh per-job Scope; capturing the registration Scope would be wrong.
 *
 * Note: `MemoryRouterTag` is a `Context.GenericTag<MemoryRouter>` value; the
 * service type is `MemoryRouter` — use the interface type, not the tag, in
 * the type parameter.
 *
 * Returns the TriggerId inside `Effect.gen` (R includes the dream deps).
 */
export const registerDreamCron = (trigger: TriggerAgentApi, expr: string) =>
  Effect.gen(function* () {
    // Capture the dream-service environment at registration time.
    // Scope is NOT included — the pool injects a per-job Scope.
    const ctx = yield* Effect.context<
      DreamStore | DreamReasoner | SessionStore | MemoryRouter | Clock
    >()
    return yield* trigger.register({
      kind: "cron",
      expr,
      build: () => ({
        run: EffectClock.currentTimeMillis.pipe(
          Effect.flatMap((now) => runDream(now)),
          Effect.provide(ctx),
        ),
      }),
    })
  })
