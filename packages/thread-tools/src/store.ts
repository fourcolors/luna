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
          // Single-threaded Effect runtime + Ref: check-then-set is safe for
          // our in-process proposal store (no concurrent fibers share one
          // Ref.modify call without yielding). Claim before createThread.
          const current = (yield* Ref.get(rows)).get(id)
          if (
            current === undefined ||
            current.parentThreadId !== parentThreadId ||
            current.status !== "pending"
          ) {
            return null
          }
          const next: ForkProposal = { ...current, status: "accepting" }
          yield* Ref.update(rows, (m) => {
            // Re-check under the update so a second claim loses cleanly.
            const cur = m.get(id)
            if (
              cur === undefined ||
              cur.parentThreadId !== parentThreadId ||
              cur.status !== "pending"
            ) {
              return m
            }
            const map = new Map(m)
            map.set(id, next)
            return map
          })
          const after = (yield* Ref.get(rows)).get(id)
          if (after === undefined || after.status !== "accepting") return null
          yield* emit(after)
          return after
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
})
