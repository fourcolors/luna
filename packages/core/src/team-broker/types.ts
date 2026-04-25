/**
 * TeamBroker — public types (Phase 11c).
 *
 * Frozen-error-only module: this file declares the public types per
 * DESIGN §6.2 (TeammateOrphanedError, TaskCompletionLagError) and the
 * Phase-11c brief §3.b. NO new TaggedErrors are defined here.
 */
import type { Effect, Exit, Stream } from "effect"
import type * as Queue from "effect/Queue"
import type * as Scope from "effect/Scope"
import type {
  IntegrityError,
  TaskCompletionLagError,
  TeammateOrphanedError,
} from "../errors.js"

export type TeamName = string
export type TeammateName = string

/**
 * Mailbox message shape — internal queue payloads pushed to a teammate.
 * `task` for dispatched task ids (broker calls TaskList.claim atomically
 * and forwards the id). `raw` for user-supplied opaque payloads via send().
 */
export type TeamMsg =
  | { readonly _tag: "task"; readonly taskId: string }
  | { readonly _tag: "raw"; readonly payload: unknown }

export interface TeammateSpec {
  readonly name: TeammateName
  /**
   * Per-teammate loop. Receives a Dequeue end of the mailbox; the broker
   * owns the Enqueue side. Loop must be `Effect<void, never>` — failures
   * should be handled inside; the broker treats fiber Exit as the
   * "stopped" signal only.
   */
  readonly loop: (
    mailbox: Queue.Dequeue<TeamMsg>,
  ) => Effect.Effect<void, never>
}

export interface TeamSpec {
  readonly name: TeamName
  readonly teammates: ReadonlyArray<TeammateSpec>
  /**
   * Per-task lag threshold. If a teammate has held a claim past this
   * many ms without setting status to `completed`, the broker emits a
   * `TaskCompletionLagError` once per claim cycle.
   * Default: 60_000 ms.
   */
  readonly lagThresholdMs?: number
  /**
   * Watchdog tick interval — drives both lag detection and orphan polling.
   * Default: 5_000 ms.
   */
  readonly orphanCheckIntervalMs?: number
}

export type TeamEvent =
  | {
      readonly _tag: "started"
      readonly team: TeamName
      readonly teammate: TeammateName
    }
  | {
      readonly _tag: "stopped"
      readonly team: TeamName
      readonly teammate: TeammateName
      readonly exit: Exit.Exit<unknown, unknown>
    }
  | {
      readonly _tag: "orphaned"
      readonly error: TeammateOrphanedError
    }
  | {
      readonly _tag: "lag"
      readonly error: TaskCompletionLagError
    }

export interface TeamBrokerApi {
  /**
   * Spawn a team. Each team is managed by its own private Scope internally.
   * When the broker's Layer scope closes, all teams are torn down automatically.
   * Use dissolve() for on-demand teardown.
   *
   * §3.4 #4 caller-Scope cascade: if you want closing a specific scope to
   * cascade-interrupt this team, use spawnIn(spec, leadScope).
   */
  readonly spawn: (spec: TeamSpec) => Effect.Effect<void, IntegrityError>

  /**
   * Spawn a team AND link its lifecycle to the given lead scope.
   * When `leadScope` closes, the team is dissolved (same as calling dissolve()).
   * This is the §3.3 "lead-session Scope" pattern.
   */
  readonly spawnIn: (
    spec: TeamSpec,
    leadScope: Scope.Scope,
  ) => Effect.Effect<void, IntegrityError>

  /**
   * Atomically claim a task on TaskList for `to`, then push a `task` msg
   * into that teammate's mailbox. Failure to claim surfaces as IntegrityError
   * (no mailbox push).
   */
  readonly dispatch: (
    team: TeamName,
    to: TeammateName,
    taskId: string,
  ) => Effect.Effect<void, IntegrityError>

  /**
   * Push an opaque payload into a teammate's mailbox as `{_tag: "raw"}`.
   */
  readonly send: (
    team: TeamName,
    to: TeammateName,
    payload: unknown,
  ) => Effect.Effect<void, IntegrityError>

  readonly members: (
    team: TeamName,
  ) => Effect.Effect<ReadonlyArray<TeammateName>>

  readonly events: Stream.Stream<TeamEvent>

  readonly dissolve: (team: TeamName) => Effect.Effect<void>
}
