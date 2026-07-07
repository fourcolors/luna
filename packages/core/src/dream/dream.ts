import { Effect, Option, Stream } from "effect"
import { MemoryRouterTag } from "@luna/memory"
import type { MemoryRecord, MemoryRouter } from "@luna/memory"
import { Clock } from "../clock.js"
import { CalibrationStore } from "../alignment/calibration-store.js"
import { classifyTier, revertabilityFor } from "../alignment/tier-classifier.js"
import { readBelief } from "../beliefs/types.js"
import { SessionStore } from "../session/session-store.js"
import { DreamStore } from "./dream-store.js"
import { DreamReasoner } from "./reasoner.js"
import { distillSession, DEFAULT_DISTILL_OPTIONS } from "./distill.js"
import type { DreamOp, DreamOpKind, DreamInputs } from "./types.js"
import { DREAM_OP_TRAITS } from "./types.js"

const OP_KINDS = Object.keys(DREAM_OP_TRAITS) as ReadonlyArray<DreamOpKind>

/**
 * Slice A detectability heuristic (PLACEHOLDER — a decision needing
 * confirmation). Derived from DREAM_OP_TRAITS — the single exhaustive
 * op-kind table in types.ts — so a new DreamOpKind can't silently default.
 */
const detectabilityFor = (kind: DreamOpKind): number =>
  DREAM_OP_TRAITS[kind].detectability

/**
 * Ops materialized to the store (vs. held as 'proposed' audit rows). Derived
 * from DREAM_OP_TRAITS.materialize:
 *  - memory_dedup: idempotent delete of an exact duplicate (Phase 1).
 *  - belief_candidate: stage a PROPOSED belief record (Phase 2 §7.2). Safe to
 *    auto-write because a proposed belief is inert — only ACTIVE beliefs are
 *    injected, and activation stays gated on the Phase 3 survey. Undoable via
 *    revert (before:null → delete).
 * Still HELD as 'proposed' (no survey to catch a bad apply yet): memory_staleness,
 * memory_contradiction.
 */
const MATERIALIZE_OPS: ReadonlySet<DreamOpKind> = new Set<DreamOpKind>(
  OP_KINDS.filter((k) => DREAM_OP_TRAITS[k].materialize),
)

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
        if (op.kind === "belief_candidate" && op.after !== null) {
          if (Option.isNone(calOpt)) {
            // Diagnosability: without this line a missing CalibrationStore
            // silently no-ops the entire instrumentation (the deploy-shaped
            // failure: sampling cost paid upstream, zero rows written). Warn —
            // never fail — so an unwired sink is visible in the dream logs.
            yield* Effect.logWarning(
              "[luna/dream] CalibrationStore not provided — calibration row NOT recorded " +
                `(beliefId=${op.targetId}); wire CalibrationStore.makeLayer into the dream layer to collect ECE data`,
            )
          } else {
            const cal = calOpt.value
            // The ENTIRE calibration block — input prep (readBelief /
            // classifyTier can throw on a malformed `after`) AND the write —
            // lives inside this suspended effect, and the whole thing is
            // swallowed via catchAllCause (failures AND defects). HARD
            // invariant: a calibration/tier failure can NEVER alter a dream
            // turn. (Effect.ignore alone would miss defects, and prep that
            // throws OUTSIDE the effect would fail the turn.)
            yield* Effect.suspend(() => {
              const confidence = readBelief(op.after as MemoryRecord).confidence
              const detectability = detectabilityFor(op.kind)
              // Slice 3 MEASURE-ONLY: compute the autonomy tier write-only on
              // the SAME calibration row. stakes is ALWAYS null here (no stakes
              // signal exists anywhere in the codebase — FLAG); revertability
              // is the materialized placeholder heuristic. `tier` is NEVER
              // gated and NEVER read back into behavior.
              const tier = classifyTier({
                confidence,
                detectability,
                revertability: revertabilityFor(op.kind, true), // op is materialized here
                stakes: null,
              })
              return cal.record({
                dreamId,
                targetId: op.targetId,
                beliefId: op.targetId, // belief_candidate targetId IS the belief id
                proposalAt: now,
                confidence,
                detectability,
                // Slice B MEASURE-ONLY: log the sampling-agreement confidence
                // ALONGSIDE the verbalized `confidence` above (NOT in place of
                // it), and the effective sample size. ABSENT (single pass) ⇒
                // sampledConfidence null + sampleCount 1, preserving prior
                // behavior. Write-only; never read back into behavior.
                sampledConfidence: op.sampledConfidence ?? null,
                sampleCount: op.sampleCount ?? 1,
                tier,
              })
            }).pipe(Effect.catchAllCause(() => Effect.void))
          }
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
 * in range, their messages DISTILLED to a bounded excerpt, and operator-namespace
 * memories.
 *
 * Distillation (issue #255): each in-window session's raw StoredMessages are run
 * through distillSession(...) so the reasoner receives a short excerpt (message-
 * granularity windowing + per-scope char caps) instead of every raw payload —
 * the reasoner MUST NOT re-serialize whole message bags into the prompt.
 *
 * NOTE: SessionStore.list has no `since` param, so we list ordered by
 * lastMessageAt and filter the window in code.
 *
 * A readMessages failure yields an EMPTY-message distillation (the session is
 * still surfaced with excerpt="" and windowMessageCount=0), never a dropped
 * session — losing a session silently is worse than reasoning over an empty one.
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
          Effect.map((c) =>
            distillSession(summary, Array.from(c), { watermark, now }, DEFAULT_DISTILL_OPTIONS),
          ),
          // A failed readMessages still surfaces the session as an empty-message
          // distillation (not a dropped session — see header comment).
          Effect.catchAll(() =>
            Effect.succeed(distillSession(summary, [], { watermark, now }, DEFAULT_DISTILL_OPTIONS)),
          ),
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

// The legacy `registerDreamCron` (TriggerAgent fiber-per-cron registration)
// was removed with the V1 scheduler. The nightly dream now runs exclusively
// through the V2 path: a `kind:"dream"` job row drained by the JobTicker into
// the DreamWorker (see dream-worker.ts), which calls `runDream` directly.
