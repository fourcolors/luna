/**
 * Account-rotation retry - split out of chat-service.ts along the seam its
 * own doc comments already named (`account-rotation.sim.test.ts`, the
 * module doc's "Ceiling on the ordinary path's per-turn account-rotation
 * BURST"). This is the ordinary (non-recall) thread's `runOrdinaryQuery`
 * recursive attempt loop, moved verbatim out of `createThread`.
 *
 * `runOrdinaryQuery` closed over one plain mutable `let activeSdkSessionId`
 * declared in `createThread` (also written directly by `recordSdkSession`,
 * which stays there) plus a handful of per-thread Refs/Queues and two
 * closures (`runReplies`, `handleAdapterFailure`) that themselves close over
 * `handleSdkMessage` and more per-thread state. Rather than restructure any
 * of that, this module takes it all as an explicit deps object - the same
 * "deps object" pattern used for the job-ticker split - with the mutable
 * `let` crossing the module boundary as a `getActiveSdkSessionId` /
 * `setActiveSdkSessionId` pair instead of a closed-over variable.
 *
 * The one shape change from the original inline closure: the three reads of
 * `activeSdkSessionId` at the top of an attempt are captured into a single
 * local snapshot (`currentActiveSdkSessionId`) up front, because TypeScript
 * cannot narrow a `getActiveSdkSessionId()` function call the way it narrows
 * a plain variable across repeated reads. Nothing mutates the value between
 * those reads in the original code either, so the snapshot is read at the
 * exact same point in the control flow and the behavior is unchanged.
 */
import {
  Cause,
  Effect,
  Exit,
  Fiber,
  Option,
  PubSub,
  Queue,
  Ref,
  Scope,
  Stream,
} from "effect"
import { type ObservabilityApi, type SessionOptions, defaultIsRotatableError } from "@luna/core"
import type { SDKAdapterService, QueryRequest } from "@luna/adapter-sdk"
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import type { ChatFrame } from "./types.js"
import type { TurnPrompt } from "./chat-service.js"

/**
 * Ceiling on the ordinary path's per-turn account-rotation BURST (chat-service
 * owns the turn boundary; see the module doc + `account-rotation.sim.test.ts`).
 * A cooled account must not be retried in a tight loop - 3 total attempts
 * (2 rotations) bounds the retry burst for a SINGLE turn before falling
 * through to the existing terminal `handleAdapterFailure` path. The budget is
 * tracked per-turn (a `rotationAttempts` Ref reset to 0 on every `result`),
 * NOT per-thread: a turn that completes cleanly proves the account just used
 * is healthy, so the next turn deserves the full burst again, however many
 * rotations happened earlier in the thread's life.
 */
export const MAX_ORDINARY_ROTATION_ATTEMPTS = 3

export interface AccountRotationDeps {
  readonly id: string
  /** Narrowed snapshot of the createThread opts this loop actually reads. */
  readonly opts: {
    readonly boundAccountId?: string
    readonly resumeFromSessionId?: string
  }
  readonly inbox: Queue.Queue<TurnPrompt>
  readonly inFlightPrompts: Ref.Ref<ReadonlyArray<TurnPrompt>>
  readonly rotationAttempts: Ref.Ref<number>
  readonly hasCompletedATurn: Ref.Ref<boolean>
  readonly assistantText: Ref.Ref<string>
  /** Reads/writes the SAME `let activeSdkSessionId` `recordSdkSession`
   *  (still in createThread) mutates directly. */
  readonly getActiveSdkSessionId: () => string | null
  readonly setActiveSdkSessionId: (sdkSessionId: string | null) => void
  readonly obs: ObservabilityApi
  readonly pubsub: PubSub.PubSub<ChatFrame>
  readonly threadScope: Scope.Closeable
  readonly queryBase: Omit<
    QueryRequest,
    "prompt" | "sessionOptions" | "onAccountAcquired" | "resumeFromSessionId"
  >
  readonly sessionOptions: SessionOptions
  readonly adapter: SDKAdapterService
  readonly runReplies: (
    replies: Stream.Stream<SDKMessage, unknown>,
  ) => Effect.Effect<Exit.Exit<void, unknown>, never>
  readonly handleAdapterFailure: (
    cause: Cause.Cause<unknown>,
  ) => Effect.Effect<void, never>
  readonly inc: (
    name: string,
    tags?: Readonly<Record<string, string>>,
    n?: number,
  ) => Effect.Effect<void, never>
}

/**
 * Ordinary threads retain a long-lived SDK query for the thread's whole
 * life - but "long-lived" no longer means un-restartable. On an EARLY,
 * rotatable throttle (no assistant content yet streamed for the in-flight
 * turn, on an unbound/Auto request the broker says has a viable failover
 * target, with THIS TURN's rotation budget remaining) the query restarts on
 * a fresh account instead of silently dropping the user's turn - see the
 * module doc and `account-rotation.sim.test.ts`. Any other failure
 * (including a rotatable one with no budget left) falls through to the
 * existing terminal `handleAdapterFailure` path, unchanged.
 *
 * Each ATTEMPT gets its OWN private prompt source - never the thread's
 * shared `inbox` directly, and never a Stream built once and handed to
 * more than one `adapter.query()` call. A dead attempt's internal
 * SDK-input bridge (`Stream.toAsyncIterableEffect`, adapter.ts) is an
 * unsupervised fiber we cannot reliably interrupt from here - if it were
 * ever subscribed to `inbox` directly, it would sit parked on
 * `Queue.take(inbox)` and could silently steal a turn re-offered (or
 * freshly sent) after we've already moved on to a new attempt (Defect #1,
 * verbatim). Instead: a fresh `attemptQueue` per attempt, fed by a
 * `forwarderFiber` WE fork and interrupt ourselves - a fiber we own and
 * can deterministically stop, unlike the adapter-internal bridge. The
 * forwarder's take-then-record-then-forward step runs `uninterruptible`
 * so a turn is never lost mid-handoff: either it was never taken off
 * `inbox` (nothing lost), or it is FULLY recorded into `inFlightPrompts`
 * AND forwarded to `attemptQueue` before any pending interrupt is
 * honored.
 */
export const makeRunOrdinaryQuery = (
  deps: AccountRotationDeps,
): ((
  attemptNum: number,
  seedTurns: ReadonlyArray<TurnPrompt>,
) => Effect.Effect<void, never>) => {
  const {
    id,
    opts,
    inbox,
    inFlightPrompts,
    rotationAttempts,
    hasCompletedATurn,
    assistantText,
    getActiveSdkSessionId,
    setActiveSdkSessionId,
    obs,
    pubsub,
    threadScope,
    queryBase,
    sessionOptions,
    adapter,
    runReplies,
    handleAdapterFailure,
    inc,
  } = deps

  const runOrdinaryQuery = (
    attemptNum: number,
    seedTurns: ReadonlyArray<TurnPrompt>,
  ): Effect.Effect<void, never> =>
    Effect.gen(function* () {
      const attemptQueue = yield* Queue.unbounded<TurnPrompt>()
      // `inFlightPrompts` must mirror exactly what THIS attempt's
      // queue holds, in the same FIFO order - the `result` handler's
      // head-shift (`xs.slice(1)`, below in `handleSdkMessage`)
      // assumes the head of this list is always the turn the next
      // `result` closes. Seeding both in the same step (rather than
      // leaving `inFlightPrompts` at whatever a PRIOR attempt left
      // it, or clearing it to `[]` unconditionally) is what keeps
      // that invariant true across a rotation: attempt 1 starts
      // with `seedTurns === []`, and a rotated attempt carries the
      // prior attempt's unresolved turns onto BOTH the queue and
      // this Ref together.
      yield* Ref.set(inFlightPrompts, seedTurns)
      if (seedTurns.length > 0) {
        yield* Queue.offerAll(attemptQueue, seedTurns)
      }
      const forwarderFiber = yield* Effect.forkChild(
        Effect.forever(
          Queue.take(inbox).pipe(
            Effect.flatMap((turn) =>
              Effect.uninterruptible(
                Ref.update(inFlightPrompts, (xs) => [
                  ...xs,
                  turn,
                ]).pipe(Effect.andThen(Queue.offer(attemptQueue, turn))),
              ),
            ),
          ),
        ),
      )
      const attemptPromptStream: Stream.Stream<SDKUserMessage> =
        Stream.fromQueue(attemptQueue).pipe(
          Stream.map((turn) => turn.payload),
        )

      // Populated synchronously by the adapter, inside its
      // acquire step, before `query()`'s Effect resolves - set
      // before `runReplies` ever runs. Also RE-FIRED by the
      // adapter with a freshly recomputed `failoverPossible`
      // immediately before a throttle-classified failure
      // surfaces (see `onAccountAcquired`'s doc comment in
      // adapter.ts) - this closure just overwrites `acquired` on
      // every call, so it always holds the LATEST reading, never
      // the stale one from whenever this query was first
      // acquired (which, on a long-lived thread, can be many
      // turns and hours before the failure being decided here).
      let acquired: {
        accountId: string
        failoverPossible: boolean
      } | null = null
      const onAccountAcquired = (info: {
        accountId: string
        failoverPossible: boolean
      }): void => {
        acquired = info
      }

      // Attempt 1 resumes the thread's existing SDK session as
      // before. A ROTATED attempt (attemptNum > 1) moves to a
      // DIFFERENT account - a session id minted under the OLD
      // account's subprocess cannot be resumed on the new one, so
      // it must be dropped rather than silently carried over
      // (never silently re-point `activeSdkSessionId`). Only
      // surfaced when there was actually a session to drop.
      //
      // Snapshot once: nothing mutates the shared `activeSdkSessionId`
      // between these reads (same as the pre-split inline closure), and a
      // single local `const` lets TS narrow the `!== null` check below the
      // way it narrowed the original plain variable.
      const currentActiveSdkSessionId = getActiveSdkSessionId()
      let resumeFromSessionId: string | undefined =
        currentActiveSdkSessionId ?? undefined
      if (attemptNum > 1 && currentActiveSdkSessionId !== null) {
        const droppedSessionId = currentActiveSdkSessionId
        setActiveSdkSessionId(null)
        resumeFromSessionId = undefined
        // Was there REAL history behind that session id? Either
        // this thread was resumed from a prior server run, or a
        // turn on THIS thread has actually reached a `result`.
        // Without this check, the SDK's own init/system frame can
        // mint a session id moments before turn 1's OWN throttle
        // on a brand-new thread - `activeSdkSessionId !== null`
        // would then be true with nothing whatsoever lost, and
        // the user-visible notice below would be a false alarm on
        // the single most common rotation case. The obs event
        // (traceability) and the null-out above always happen
        // regardless; only the USER-VISIBLE frame is gated.
        const hadRealHistory =
          opts.resumeFromSessionId !== undefined ||
          (yield* Ref.get(hasCompletedATurn))
        yield* obs.emit({
          kind: "Error",
          ts: new Date().toISOString(),
          level: "warn",
          errorTag: "ChatRotationHistoryDropped",
          message:
            `account rotation on thread ${id}: SDK session ` +
            `${droppedSessionId} cannot be resumed on the newly ` +
            `rotated-to account; conversation history before ` +
            `this point was dropped from the live SDK context ` +
            `(the transcript store is unaffected).` +
            (hadRealHistory
              ? ""
              : " No turn had completed yet on this thread, so " +
                "no real history was actually lost."),
          context: { threadId: id },
        })
        if (hadRealHistory) {
          yield* PubSub.publish(pubsub, {
            type: "assistant-error",
            threadId: id,
            turnId: null,
            error: {
              kind: "sdk",
              message:
                "Switched to another account to keep this " +
                "conversation going. The model's short-term memory " +
                "of earlier turns in this session was reset (the " +
                "saved transcript itself is unaffected).",
            },
          })
        }
      }

      // A fresh CHILD scope per attempt (BLOCKER #2), not
      // `Scope.provide(threadScope)` directly: the old code
      // attached every attempt's `abortController.abort()`
      // finalizer and the broker's `inFlight` release finalizer
      // straight onto the THREAD scope, so a failed attempt's
      // resources were never released until the whole thread
      // died - each rotation orphaned a live SDK subprocess and
      // permanently inflated the just-throttled account's
      // `inFlight` count. `Scope.close` below runs those
      // finalizers as soon as WE decide this attempt is done
      // (rotate or terminal), not when the thread eventually ends.
      const attemptScope = yield* Scope.fork(threadScope, "parallel")
      const queryEffect = adapter
        .query({
          ...queryBase,
          prompt: attemptPromptStream,
          sessionOptions,
          onAccountAcquired,
          ...(resumeFromSessionId !== undefined
            ? { resumeFromSessionId }
            : {}),
        })
        .pipe(Scope.provide(attemptScope))

      let replies: Stream.Stream<SDKMessage, unknown>
      if (attemptNum === 1) {
        // Byte-identical to the pre-rotation behavior: the
        // thread's very FIRST acquire failing (e.g. broker
        // misconfiguration) is a genuine defect, not a routine
        // exhaustion.
        replies = yield* queryEffect.pipe(Effect.orDie)
      } else {
        // BLOCKER #4: a ROTATION re-acquire hitting
        // `AllAccountsExhaustedError` is an EXPECTED outcome (we
        // just cooled the account that was throttled; the pool
        // can legitimately have nothing left, or a sibling lane
        // sharing the pool can have cooled the only other
        // candidate in the meantime) - not a bug. `Effect.orDie`
        // here would convert it into an unhandled DEFECT that
        // escapes this Effect.gen's fiber (forked via
        // `Effect.forkIn(threadScope)`), permanently killing the
        // thread's consumer with no error frame ever reaching the
        // user and `pendingTurns` never draining - every later
        // `send()` on this thread would silently go nowhere.
        // Route it through the SAME terminal path an ordinary
        // rotatable-but-out-of-budget failure already takes.
        const acquireExit = yield* Effect.exit(queryEffect)
        if (Exit.isFailure(acquireExit)) {
          yield* Fiber.interrupt(forwarderFiber)
          yield* Scope.close(attemptScope, acquireExit)
          yield* handleAdapterFailure(acquireExit.cause)
          return
        }
        replies = acquireExit.value
      }

      const exit = yield* runReplies(replies)
      // Interrupt the forwarder BEFORE reading `inFlightPrompts`
      // below - otherwise it could still be concurrently pulling
      // a brand-new turn off `inbox` while we're computing the
      // rotation decision, making the snapshot racy. Interrupting
      // first (and awaiting it, which `Fiber.interrupt` does)
      // guarantees no further writes can land once we read it.
      yield* Fiber.interrupt(forwarderFiber)
      yield* Scope.close(attemptScope, exit)
      if (Exit.isSuccess(exit)) return

      const cause = exit.cause
      const failure = Cause.findErrorOption(cause)
      const inFlight = yield* Ref.get(inFlightPrompts)
      const currentAssistantText = yield* Ref.get(assistantText)
      const rotationAttemptsUsed = yield* Ref.get(rotationAttempts)
      // Snapshot into a `const`, re-widened via `as`: `acquired` is
      // a `let` mutated ONLY through the `onAccountAcquired`
      // callback the adapter invokes opaquely, so TS's flow
      // analysis (seeing no direct call to it in this scope) keeps
      // narrowing `acquired`'s type to its initial literal `null` -
      // the `as` restores the real declared type so the `!== null`
      // check below actually narrows instead of collapsing to
      // `never`.
      const acquiredSnapshot = acquired as {
        accountId: string
        failoverPossible: boolean
      } | null
      // ALL SIX must hold: (a) unbound/Auto request, (b) broker
      // says failover is viable - a FRESH reading re-checked at
      // failure time, not the stale value from this query's
      // original acquire (see the `onAccountAcquired` doc comment
      // in adapter.ts), (c) the cause is rotatable per core's
      // shared predicate, (d) at least one turn is in flight,
      // (e) no assistant content streamed yet for the OLDEST one,
      // (f) THIS TURN's rotation budget remains - reset to 0 on
      // every `result`, so a turn that completed cleanly restores
      // the full budget for whatever comes next (see the module
      // doc's per-turn-not-per-thread note).
      const rotatable =
        opts.boundAccountId === undefined &&
        acquiredSnapshot !== null &&
        acquiredSnapshot.failoverPossible === true &&
        Option.isSome(failure) &&
        defaultIsRotatableError(failure.value) &&
        inFlight.length > 0 &&
        currentAssistantText === "" &&
        rotationAttemptsUsed < MAX_ORDINARY_ROTATION_ATTEMPTS - 1

      // The redundant `acquiredSnapshot` null re-check (already
      // implied by `rotatable`) is what lets TS narrow it to
      // non-null below without a cast.
      if (!rotatable || acquiredSnapshot === null) {
        yield* handleAdapterFailure(cause)
        return
      }

      yield* Ref.update(rotationAttempts, (n) => n + 1)
      yield* inc("luna.chat.account_rotation.attempts")
      yield* Effect.logWarning(
        `[chat] thread ${id}: early rotatable throttle on ` +
          `attempt ${attemptNum} (account ` +
          `${acquiredSnapshot.accountId}); carrying ` +
          `${inFlight.length} in-flight turn(s) onto a fresh ` +
          `account's own attempt queue and rotating.`,
      )
      // Carry the unresolved turn(s) DIRECTLY onto the next
      // attempt's own queue, in ORIGINAL order - never back onto
      // the shared `inbox` (that reintroduces exactly the steal
      // risk this design avoids). Do NOT clear `inFlightPrompts`
      // here: the next attempt is about to start EXECUTING these
      // exact turns, so the tracking Ref must keep reflecting them
      // as in-flight, not go empty out from under a query that
      // hasn't finished them yet (that gap is what let a SECOND
      // consecutive throttle on the same turn read `inFlight = []`
      // and refuse to rotate again). `runOrdinaryQuery` seeds
      // `inFlightPrompts` fresh from `seedTurns` in its own first
      // step, in the same order these are being handed off here.
      yield* runOrdinaryQuery(attemptNum + 1, inFlight)
    })

  return runOrdinaryQuery
}
