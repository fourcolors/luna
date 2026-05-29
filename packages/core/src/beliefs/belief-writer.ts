import { Effect, Layer, Stream } from "effect"
import { MemoryRouterTag } from "@luna/memory"
import type { MemoryRecord } from "@luna/memory"
import { Clock } from "../clock.js"
import { BELIEF_CAP, BELIEF_KIND, BELIEF_NAMESPACE, readBelief } from "./types.js"
import type { BeliefContent, BeliefStatus } from "./types.js"
import { rankByStrength } from "./scoring.js"

export interface BeliefWriterApi {
  /** All belief records in the operator namespace. */
  readonly listAll: () => Effect.Effect<ReadonlyArray<MemoryRecord>>
  /** Active beliefs only (the injected set). */
  readonly listActive: () => Effect.Effect<ReadonlyArray<MemoryRecord>>
  readonly listByStatus: (status: BeliefStatus) => Effect.Effect<ReadonlyArray<MemoryRecord>>
  /** Stage a candidate as a `proposed` record (Dream's promotion target). */
  readonly stageProposed: (rec: MemoryRecord) => Effect.Effect<void>
  /** proposed → active. Enforces the ≤20 active cap (evicts the weakest). */
  readonly activateBelief: (id: string) => Effect.Effect<boolean>
  /** any → retired (record persists for audit/undo). */
  readonly retireBelief: (id: string) => Effect.Effect<boolean>
}

export class BeliefWriter extends Effect.Tag("luna/BeliefWriter")<
  BeliefWriter,
  BeliefWriterApi
>() {
  static readonly Default = Layer.effect(
    BeliefWriter,
    Effect.gen(function* () {
      const mem = yield* MemoryRouterTag
      const clock = yield* Clock

      const listAll = () =>
        mem
          .query({ namespace: BELIEF_NAMESPACE, kind: BELIEF_KIND })
          .pipe(Stream.runCollect, Effect.map((c) => Array.from(c)))

      const listByStatus = (status: BeliefStatus) =>
        listAll().pipe(Effect.map((rs) => rs.filter((r) => readBelief(r).status === status)))

      const listActive = () => listByStatus("active")

      const setStatus = (id: string, status: BeliefStatus) =>
        Effect.gen(function* () {
          const rec = yield* mem.get(id)
          if (rec === null || rec.kind !== BELIEF_KIND) return false
          const now = yield* clock.nowMs()
          const content: BeliefContent = { ...readBelief(rec), status }
          yield* mem.put({ ...rec, content, updatedAt: now })
          return true
        })

      const stageProposed = (rec: MemoryRecord) => mem.put(rec).pipe(Effect.asVoid)

      const retireBelief = (id: string) => setStatus(id, "retired")

      const activateBelief = (id: string) =>
        Effect.gen(function* () {
          const ok = yield* setStatus(id, "active")
          if (!ok) return false
          // Enforce the cap on the ACTIVE set only: keep the strongest
          // BELIEF_CAP active, retire the rest (weakest-first).
          const active = yield* listActive()
          if (active.length > BELIEF_CAP) {
            const now = yield* clock.nowMs()
            const ranked = rankByStrength(active, now)
            for (const loser of ranked.slice(BELIEF_CAP)) {
              yield* retireBelief(loser.id)
            }
          }
          return true
        })

      return { listAll, listActive, listByStatus, stageProposed, activateBelief, retireBelief }
    }),
  )
}
