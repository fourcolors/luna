import { Effect, Stream } from "effect"
import * as EffectClock from "effect/Clock"
import { MemoryRouterTag } from "@luna/memory"
import type { MemoryRecord, MemoryRouter } from "@luna/memory"
import { Clock } from "../clock.js"
import { SessionStore } from "../session/session-store.js"
import type { TriggerAgentApi } from "../jobs/trigger-agent.js"
import { DreamStore } from "./dream-store.js"
import { DreamReasoner } from "./reasoner.js"
import type { DreamOp, DreamOpKind, DreamInputs } from "./types.js"

/** Phase 1: the ONLY op kind safe to auto-apply without survey/undo coverage. */
const AUTO_APPLY: ReadonlySet<DreamOpKind> = new Set<DreamOpKind>(["memory_dedup"])

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

    for (const op of ops) {
      if (AUTO_APPLY.has(op.kind)) {
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

    const inputs = yield* gatherInputs(watermark, now)

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
  })

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
