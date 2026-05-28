import { Effect } from "effect"
import { MemoryRouterTag } from "@luna/memory"
import type { MemoryRecord } from "@luna/memory"
import { Clock } from "../clock.js"
import { DreamStore } from "./dream-store.js"
import type { DreamOp, DreamOpKind } from "./types.js"

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
