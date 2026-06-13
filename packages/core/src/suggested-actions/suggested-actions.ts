/**
 * SuggestedActions — the shared service the live `suggest_action` tool AND the
 * nightly Dream both call to propose actions, and the ui-ws layer calls to
 * respond (accept/dismiss). It is the single MUTATION gateway over the store
 * and the single change-EMISSION point: every mutation publishes the resulting
 * row to a domain `changes` Stream. The chat layer subscribes to `changes` and
 * translates each row into a per-thread frame — so this service (and core as a
 * whole) stays FRAME-AGNOSTIC (no websocket/sink knowledge here).
 *
 * Mirrors alignment/survey.ts: an Effect.Tag service over a store, with status
 * state-machine transitions guarded in the store layer.
 */
import { Effect, Layer, Option, PubSub, Stream } from "effect"
import { SuggestedActionsStore } from "./suggested-actions-store.js"
import { SuggestedActionsError } from "./types.js"
import type {
  ExecutionRef,
  ListThreadQuery,
  ProposeInput,
  SuggestedActionRow,
} from "./types.js"

/** A user's response to one suggested action (from the ui-ws router). */
export interface RespondInput {
  readonly threadId: string
  readonly actionId: string
  readonly decision: "accept" | "dismiss"
}

/**
 * AcceptHandler — pluggable executor for an accepted action (built in P6). The
 * service resolves it via `Effect.serviceOption`, so dismiss-only deployments
 * (and unit tests) work without the job machinery. When present, `accept` is
 * responsible for submitting the durable job and calling
 * `SuggestedActions.recordExecution` to move the row to `in_progress`.
 */
export interface AcceptHandlerApi {
  readonly accept: (row: SuggestedActionRow) => Effect.Effect<void, SuggestedActionsError>
}
export class AcceptHandler extends Effect.Tag("luna/SuggestedActionsAcceptHandler")<
  AcceptHandler,
  AcceptHandlerApi
>() {}

export interface SuggestedActionsApi {
  /** Stage a proposed action (idempotent on content). Emits on `changes`. */
  readonly propose: (
    input: ProposeInput,
  ) => Effect.Effect<SuggestedActionRow, SuggestedActionsError>
  /** Accept (→ auto-execute via AcceptHandler) or dismiss one action. Enforces
   *  thread ownership; the accept transition is atomic (double-accept is safe).
   *  Returns the resulting row, or null if unknown / cross-thread / lost-race. */
  readonly respond: (
    input: RespondInput,
  ) => Effect.Effect<SuggestedActionRow | null, SuggestedActionsError>
  /** `accepted → in_progress` with the execution link. Emits. (For AcceptHandler.) */
  readonly recordExecution: (
    id: string,
    exec: ExecutionRef,
  ) => Effect.Effect<SuggestedActionRow | null, SuggestedActionsError>
  /** `accepted|in_progress → completed|failed`. Emits. (For the completion observer.) */
  readonly recordTerminal: (
    id: string,
    status: "completed" | "failed",
    error?: string | null,
  ) => Effect.Effect<SuggestedActionRow | null, SuggestedActionsError>
  readonly getById: (
    id: string,
  ) => Effect.Effect<SuggestedActionRow | null, SuggestedActionsError>
  readonly listByThread: (
    threadId: string,
    q?: ListThreadQuery,
  ) => Effect.Effect<ReadonlyArray<SuggestedActionRow>, SuggestedActionsError>
  readonly listInProgress: () => Effect.Effect<
    ReadonlyArray<SuggestedActionRow>,
    SuggestedActionsError
  >
  /** Domain change stream — every mutation publishes the resulting row. The
   *  chat layer subscribes and maps each row to a per-thread frame. */
  readonly changes: Stream.Stream<SuggestedActionRow>
}

export class SuggestedActions extends Effect.Tag("luna/SuggestedActions")<
  SuggestedActions,
  SuggestedActionsApi
>() {
  static readonly layer: Layer.Layer<SuggestedActions, never, SuggestedActionsStore> =
    Layer.effect(
      SuggestedActions,
      Effect.gen(function* () {
        const store = yield* SuggestedActionsStore
        const hub = yield* PubSub.unbounded<SuggestedActionRow>()
        const emit = (row: SuggestedActionRow | null) =>
          row ? PubSub.publish(hub, row).pipe(Effect.asVoid) : Effect.void

        const propose: SuggestedActionsApi["propose"] = (input) =>
          store.propose(input).pipe(Effect.tap(emit))

        const recordExecution: SuggestedActionsApi["recordExecution"] = (id, exec) =>
          store.recordExecution(id, exec).pipe(Effect.tap(emit))

        const recordTerminal: SuggestedActionsApi["recordTerminal"] = (id, status, error) =>
          store.recordTerminal(id, status, error).pipe(Effect.tap(emit))

        const respond: SuggestedActionsApi["respond"] = (input) =>
          Effect.gen(function* () {
            const existing = yield* store.getById(input.actionId)
            // Unknown action or cross-thread response → reject (per-thread guard).
            if (!existing || existing.threadId !== input.threadId) return null

            if (input.decision === "dismiss") {
              const r = yield* store.markDismissed(input.actionId)
              yield* emit(r)
              return r
            }

            // accept — atomic proposed→accepted; only the winner proceeds.
            const accepted = yield* store.markAccepted(input.actionId)
            if (!accepted) return null
            yield* emit(accepted)

            // Auto-execute when an AcceptHandler is wired (P6). Absent → the row
            // simply rests at `accepted` (dismiss-only / test deployments).
            const handler = yield* Effect.serviceOption(AcceptHandler)
            if (Option.isSome(handler)) {
              const outcome = yield* Effect.either(handler.value.accept(accepted))
              if (outcome._tag === "Left") {
                const failed = yield* store.recordTerminal(
                  accepted.id,
                  "failed",
                  outcome.left.message,
                )
                yield* emit(failed)
                return failed ?? accepted
              }
            }
            // The handler may have advanced the row to in_progress — return latest.
            return (yield* store.getById(accepted.id)) ?? accepted
          })

        return {
          propose,
          respond,
          recordExecution,
          recordTerminal,
          getById: store.getById,
          listByThread: store.listByThread,
          listInProgress: store.listInProgress,
          changes: Stream.fromPubSub(hub),
        } satisfies SuggestedActionsApi
      }),
    )
}
