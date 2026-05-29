import { Effect, Layer, Stream } from "effect"
import { MemoryRouterTag } from "@luna/memory"
import type { MemoryRecord } from "@luna/memory"
import { Clock } from "../clock.js"
import type { MemoryBackendError } from "../errors.js"
import { BELIEF_CAP, BELIEF_KIND, BELIEF_NAMESPACE, readBelief } from "./types.js"
import type { BeliefContent, BeliefStatus, BeliefValidation } from "./types.js"
import { rankByStrength } from "./scoring.js"

// Error channel carries MemoryBackendError (propagated from MemoryRouter ops),
// matching the DreamStore idiom of surfacing backend errors in the API. Success
// types are intentionally minimal; enriching them is deferred to Phase 3.
export interface BeliefWriterApi {
  /** All belief records in the operator namespace. */
  readonly listAll: () => Effect.Effect<ReadonlyArray<MemoryRecord>, MemoryBackendError>
  /** Active beliefs only (the injected set). */
  readonly listActive: () => Effect.Effect<ReadonlyArray<MemoryRecord>, MemoryBackendError>
  readonly listByStatus: (status: BeliefStatus) => Effect.Effect<ReadonlyArray<MemoryRecord>, MemoryBackendError>
  /** Stage a candidate as a `proposed` record (Dream's promotion target). */
  readonly stageProposed: (rec: MemoryRecord) => Effect.Effect<void, MemoryBackendError>
  /** proposed → active. Enforces the ≤20 active cap (evicts the weakest). */
  readonly activateBelief: (id: string) => Effect.Effect<boolean, MemoryBackendError>
  /** any → retired (record persists for audit/undo). */
  readonly retireBelief: (id: string) => Effect.Effect<boolean, MemoryBackendError>
  /**
   * Append a validation entry to a belief's per-belief track record.
   * Idempotent on (at, verdict, via): re-appending an identical validation is a
   * no-op (returns true without writing), so retried survey verdicts never
   * duplicate the history. Distinct entries with different tuples are allowed.
   * Returns false if the belief id is missing or not a belief record.
   */
  readonly recordValidation: (
    id: string,
    validation: BeliefValidation,
  ) => Effect.Effect<boolean, MemoryBackendError>
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
          // NOTE: if the just-activated belief is weaker than all BELIEF_CAP incumbents,
          // it is itself the loser and gets retired in this same call — activate→retire.
          // We still return `true` (the activation happened); callers needing to confirm
          // the belief stayed active should check listActive(). (Phase 3 may enrich this.)
          if (active.length > BELIEF_CAP) {
            const now = yield* clock.nowMs()
            const ranked = rankByStrength(active, now)
            for (const loser of ranked.slice(BELIEF_CAP)) {
              yield* retireBelief(loser.id)
            }
          }
          return true
        })

      const recordValidation = (id: string, validation: BeliefValidation) =>
        Effect.gen(function* () {
          const rec = yield* mem.get(id)
          if (rec === null || rec.kind !== BELIEF_KIND) return false
          const prev = readBelief(rec)
          // Idempotency: dedup on (at, verdict, via) — the stable tuple available
          // in BeliefValidation. A retry supplying the same validation is a no-op
          // (post-condition already holds); updating updatedAt on a no-op is avoided.
          const alreadyPresent = prev.validationHistory.some(
            (e) => e.at === validation.at && e.verdict === validation.verdict && e.via === validation.via,
          )
          if (alreadyPresent) return true
          const now = yield* clock.nowMs()
          const content: BeliefContent = {
            ...prev,
            validationHistory: [...prev.validationHistory, validation],
          }
          yield* mem.put({ ...rec, content, updatedAt: now })
          return true
        })

      return { listAll, listActive, listByStatus, stageProposed, activateBelief, retireBelief, recordValidation } satisfies BeliefWriterApi
    }),
  )
}
