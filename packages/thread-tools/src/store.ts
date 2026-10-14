/**
 * In-memory ForkProposalStore — propose/accept/dismiss + change stream.
 *
 * Frame-agnostic (mirrors SuggestedActionsStore): chat-server / ui-ws
 * subscribe to `changes` and project wire frames. Proposals are not durable
 * across process restarts (v1); a restart simply drops unaccepted markers.
 */
import { Context, Effect, Layer, PubSub, Ref, Stream } from "effect"
import type {
  AcceptForkResult,
  ForkProposal,
  ForkProposalWire,
  ProposeForkInput,
} from "./types.js"

const newId = (): string =>
  `fork_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`

export interface ForkProposalStoreApi {
  readonly propose: (input: ProposeForkInput) => Effect.Effect<ForkProposal>
  /**
   * Atomic claim: pending → accepting. Call BEFORE createThread so a concurrent
   * second accept cannot create an orphaned sibling. Returns null if already
   * claimed / not pending.
   */
  readonly claim: (
    id: string,
    parentThreadId: string,
  ) => Effect.Effect<ForkProposal | null>
  /**
   * Undo a claim whose creation failed: accepting → pending for a fork marker
   * (the operator can retry), accepting → dismissed for create_thread.
   * Returns null when the proposal is not `accepting`.
   */
  readonly release: (
    id: string,
    parentThreadId: string,
  ) => Effect.Effect<ForkProposal | null>
  /** Finalize after createThread: accepting → accepted with childThreadId. */
  readonly completeAccept: (
    id: string,
    parentThreadId: string,
    childThreadId: string,
  ) => Effect.Effect<AcceptForkResult | null>
  readonly accept: (
    id: string,
    parentThreadId: string,
    childThreadId: string,
  ) => Effect.Effect<AcceptForkResult | null>
  readonly dismiss: (
    id: string,
    parentThreadId: string,
  ) => Effect.Effect<ForkProposal | null>
  readonly getById: (id: string) => Effect.Effect<ForkProposal | null>
  readonly listPendingByThread: (
    threadId: string,
  ) => Effect.Effect<ReadonlyArray<ForkProposal>>
  readonly changes: Stream.Stream<ForkProposal>
}

export class ForkProposalStore extends Context.Service<ForkProposalStore, ForkProposalStoreApi>()("luna/ForkProposalStore") {
  static readonly Memory: Layer.Layer<ForkProposalStore> = Layer.effect(
    ForkProposalStore,
    Effect.gen(function* () {
      const rows = yield* Ref.make(new Map<string, ForkProposal>())
      const hub = yield* PubSub.unbounded<ForkProposal>()
      const emit = (row: ForkProposal) =>
        PubSub.publish(hub, row).pipe(Effect.asVoid)

      const propose: ForkProposalStoreApi["propose"] = (input) =>
        Effect.gen(function* () {
          const row: ForkProposal = {
            id: newId(),
            parentThreadId: input.parentThreadId,
            title: input.title.trim(),
            summary: input.summary.trim(),
            seed: input.seed,
            mode: input.mode ?? "propose",
            status: "pending",
            createdAt: input.nowMs,
          }
          yield* Ref.update(rows, (m) => {
            const next = new Map(m)
            next.set(row.id, row)
            return next
          })
          yield* emit(row)
          return row
        })

      const claim: ForkProposalStoreApi["claim"] = (id, parentThreadId) =>
        Effect.gen(function* () {
          // ONE Ref.modify decides the winner: the check and the write happen
          // in a single atomic step, so two concurrent claims can never both
          // see "pending" and both succeed.
          const won = yield* Ref.modify(rows, (m): readonly [ForkProposal | null, Map<string, ForkProposal>] => {
            const cur = m.get(id)
            if (cur === undefined || cur.parentThreadId !== parentThreadId || cur.status !== "pending") {
              return [null, m]
            }
            const next: ForkProposal = { ...cur, status: "accepting" }
            const map = new Map(m)
            map.set(id, next)
            return [next, map]
          })
          if (won !== null) yield* emit(won)
          return won
        })

      const release: ForkProposalStoreApi["release"] = (id, parentThreadId) =>
        Effect.gen(function* () {
          const out = yield* Ref.modify(rows, (m): readonly [ForkProposal | null, Map<string, ForkProposal>] => {
            const cur = m.get(id)
            if (cur === undefined || cur.parentThreadId !== parentThreadId || cur.status !== "accepting") {
              return [null, m]
            }
            // A failed fork marker goes back to pending so the operator can
            // retry; a failed create_thread is closed (nobody is waiting on it).
            const next: ForkProposal = {
              ...cur,
              status: cur.mode === "create" ? "dismissed" : "pending",
            }
            const map = new Map(m)
            map.set(id, next)
            return [next, map]
          })
          if (out !== null) yield* emit(out)
          return out
        })

      const completeAccept: ForkProposalStoreApi["completeAccept"] = (
        id,
        parentThreadId,
        childThreadId,
      ) =>
        Effect.gen(function* () {
          const current = (yield* Ref.get(rows)).get(id)
          if (current === undefined) return null
          if (current.parentThreadId !== parentThreadId) return null
          if (current.status === "accepted" && current.childThreadId === childThreadId) {
            return { proposal: current, newlyAccepted: false }
          }
          if (current.status !== "accepting" && current.status !== "pending") return null
          const next: ForkProposal = {
            ...current,
            status: "accepted",
            childThreadId,
          }
          yield* Ref.update(rows, (m) => {
            const map = new Map(m)
            map.set(id, next)
            return map
          })
          yield* emit(next)
          return { proposal: next, newlyAccepted: true }
        })

      const accept: ForkProposalStoreApi["accept"] = (id, parentThreadId, childThreadId) =>
        Effect.gen(function* () {
          // Convenience: claim + complete in one step (single-caller paths).
          const claimed = yield* claim(id, parentThreadId)
          if (claimed === null) {
            const current = (yield* Ref.get(rows)).get(id)
            if (
              current &&
              current.status === "accepted" &&
              current.childThreadId === childThreadId
            ) {
              return { proposal: current, newlyAccepted: false }
            }
            return null
          }
          return yield* completeAccept(id, parentThreadId, childThreadId)
        })

      const dismiss: ForkProposalStoreApi["dismiss"] = (id, parentThreadId) =>
        Effect.gen(function* () {
          const current = (yield* Ref.get(rows)).get(id)
          if (current === undefined) return null
          if (current.parentThreadId !== parentThreadId) return null
          if (current.status !== "pending") return null
          const next: ForkProposal = { ...current, status: "dismissed" }
          yield* Ref.update(rows, (m) => {
            const map = new Map(m)
            map.set(id, next)
            return map
          })
          yield* emit(next)
          return next
        })

      const getById: ForkProposalStoreApi["getById"] = (id) =>
        Ref.get(rows).pipe(Effect.map((m) => m.get(id) ?? null))

      const listPendingByThread: ForkProposalStoreApi["listPendingByThread"] = (
        threadId,
      ) =>
        Ref.get(rows).pipe(
          Effect.map((m) =>
            [...m.values()].filter(
              (r) => r.parentThreadId === threadId && r.status === "pending",
            ),
          ),
        )

      return {
        propose,
        claim,
        release,
        completeAccept,
        accept,
        dismiss,
        getById,
        listPendingByThread,
        changes: Stream.fromPubSub(hub),
      } satisfies ForkProposalStoreApi
    }),
  )
}

/** Project a full proposal to the wire shape (no seed). */
export const toForkProposalWire = (p: ForkProposal): ForkProposalWire => ({
  id: p.id,
  parentThreadId: p.parentThreadId,
  title: p.title,
  summary: p.summary,
  status: p.status,
  createdAt: p.createdAt,
  ...(p.childThreadId !== undefined ? { childThreadId: p.childThreadId } : {}),
  ...(p.mode === "create" ? { autoOpen: true } : {}),
})
