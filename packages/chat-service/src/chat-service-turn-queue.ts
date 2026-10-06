/**
 * Queue and Steer for messages sent while a turn is running (recall path).
 *
 * A message sent while a turn is in flight WAITS. When the running turn
 * ends, it runs as its own turn with its own memory recall. The operator can
 * press Steer on a waiting message to push it into the running turn instead:
 * the CLI folds it in between tool rounds, or runs it as a queued turn inside
 * the same query.
 *
 * Steering is opt-in per message. Nothing is steered automatically.
 *
 * Ordering invariant (the observation-seed bookkeeping depends on it): the
 * thread's `pendingTurns` seeds are ordered
 *   [sends the live query consumed..., steered..., waiting...]
 * which is the order those turns resolve in. `steer` reorders the seeds in
 * the same locked step that moves the prompt, so the two never drift.
 */
import { Effect, Option, PubSub, Queue, Ref } from "effect"
import type { ChatFrame, QueuedMessageView } from "./types.js"
import type { ThreadEntry, TurnPrompt } from "./chat-service.js"

/** Longest message text carried in a `queue-update` frame. The full text is
 *  already in the transcript; the queue tray only needs a preview. */
export const QUEUED_PREVIEW_MAX = 280

export interface TurnQueue {
  /** Sends sitting in `inbox` behind a running turn, oldest first. */
  readonly waiting: Ref.Ref<ReadonlyArray<QueuedMessageView>>
  /** Steered prompts. The live query's steering tail drains this; anything
   *  left when the query ends runs next, ahead of `inbox`. */
  readonly steered: Queue.Queue<TurnPrompt>
  /** True while a recall query is running and has not settled. A steer is
   *  accepted only then; otherwise the message runs next anyway. */
  readonly steerOpen: Ref.Ref<boolean>
  /** True from when the turn loop takes a turn until its query ends. A send
   *  that lands while this is true is listed as waiting. */
  readonly busy: Ref.Ref<boolean>
}

export const makeTurnQueue: Effect.Effect<TurnQueue> = Effect.gen(function* () {
  return {
    waiting: yield* Ref.make<ReadonlyArray<QueuedMessageView>>([]),
    steered: yield* Queue.unbounded<TurnPrompt>(),
    steerOpen: yield* Ref.make(false),
    busy: yield* Ref.make(false),
  }
})

export const queueUpdateFrame = (
  threadId: string,
  queued: ReadonlyArray<QueuedMessageView>,
): ChatFrame => ({ type: "queue-update", threadId, queued })

export const previewText = (text: string): string =>
  text.length <= QUEUED_PREVIEW_MAX
    ? text
    : `${text.slice(0, QUEUED_PREVIEW_MAX - 1)}…`

/** Publish the current waiting list to the thread's subscribers. */
export const publishQueue = (
  entry: Pick<ThreadEntry, "pubsub">,
  tq: TurnQueue,
  threadId: string,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const queued = yield* Ref.get(tq.waiting)
    yield* PubSub.publish(entry.pubsub, queueUpdateFrame(threadId, queued))
  })

/** Drop one id from the waiting list. Returns true when it was listed. */
export const removeWaiting = (
  tq: TurnQueue,
  userMessageId: string,
): Effect.Effect<boolean> =>
  Ref.modify(tq.waiting, (w) => {
    const next = w.filter((x) => x.userMessageId !== userMessageId)
    return [next.length !== w.length, next]
  })

/** Next turn for the loop: carried-over first, then steered, then inbox. */
export const takeNextTurn = (
  carryOver: Array<TurnPrompt>,
  tq: TurnQueue,
  inbox: Queue.Queue<TurnPrompt>,
): Effect.Effect<TurnPrompt> =>
  Effect.gen(function* () {
    const carried = carryOver.shift()
    if (carried !== undefined) return carried
    const steered = yield* Queue.poll(tq.steered)
    if (Option.isSome(steered)) return steered.value
    return yield* Queue.take(inbox)
  })

/**
 * Move one waiting message into the running turn. Must run under the
 * thread's `pendingTurnsLock` (send() offers its seed + inbox pair under the
 * same lock, so the clear -> re-offer here is atomic against it). While
 * `steerOpen` is true the turn loop is inside a query and is not taking from
 * `inbox`, so nothing else consumes `inbox` concurrently.
 *
 * Returns false (and changes nothing) when no turn is open or the message is
 * no longer waiting.
 */
export const steerLocked = (
  entry: Pick<ThreadEntry, "inbox" | "pendingTurns">,
  tq: TurnQueue,
  userMessageId: string,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    if (!(yield* Ref.get(tq.steerOpen))) return false
    const items = yield* Queue.clear(entry.inbox)
    const idx = items.findIndex((i) => i.userMessageId === userMessageId)
    if (idx < 0) {
      yield* Queue.offerAll(entry.inbox, items)
      return false
    }
    const target = items[idx]!
    const rest = items.filter((_, i) => i !== idx)
    yield* Queue.offerAll(entry.inbox, rest)

    // Move the target's seed to just before the first still-waiting seed,
    // so seeds keep matching the order turns will resolve in.
    const seeds = yield* Queue.clear(entry.pendingTurns)
    const targetSeed = seeds.find((s) => s.userMessageId === userMessageId)
    const reordered = seeds.filter((s) => s.userMessageId !== userMessageId)
    if (targetSeed !== undefined) {
      const stillWaiting = new Set(rest.map((r) => r.userMessageId))
      const at = reordered.findIndex((s) => stillWaiting.has(s.userMessageId))
      reordered.splice(at < 0 ? reordered.length : at, 0, targetSeed)
    }
    yield* Queue.offerAll(entry.pendingTurns, reordered)

    yield* Queue.offer(tq.steered, target)
    yield* removeWaiting(tq, userMessageId)
    return true
  })
