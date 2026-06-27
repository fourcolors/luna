// packages/core/src/wake/types.ts
//
// WakeReasoner — Luna's cron-triggered "look at the workspace and decide what
// matters" reasoning step. Mirrors DreamReasoner's shape (single-shot SDK call,
// model emits a structured JSON op-list, code applies the ops). Wake's ops are
// observational: a digest of state + a picked next_action + proposed actions.
// Path A ships the observability; Path B (multi-turn agent) executes.
import type { Effect } from "effect"
import { Data } from "effect"

/** Outcome enum stored in wake_log.outcome.
 *  `skipped` = the workspace is not wake-enabled (no goals/next_actions schema);
 *  the cycle did no work and recorded a skip instead of a (misleading) error. */
export type WakeOutcome =
  | "success"
  | "no-op"
  | "error"
  | "timeout"
  | "skipped"

/** A new action the reasoner proposes filing into next_actions. */
export interface WakeProposedAction {
  readonly action: string
  /** 1 (low) - 5 (urgent). Mirrors workspace.db `next_actions.priority`. */
  readonly priority: number
  readonly rationale: string
  /** Optional goal_slug to attach to. null means "pick a goal manually". */
  readonly goalSlug: string | null
}

/** Structured output the reasoner emits, stored in wake_log.artifacts as JSON. */
export interface WakeDigest {
  readonly workspaceSlug: string
  /** 1-3 short observations about current state. */
  readonly observations: ReadonlyArray<string>
  /** id from open next_actions, or null if none fits as "next thing to do". */
  readonly pickedActionId: number | null
  /** Why this action (or why none). */
  readonly pickedReason: string
  /** 0-3 new actions the reasoner thinks should be filed. */
  readonly proposedActions: ReadonlyArray<WakeProposedAction>
}

/** Inputs the reasoner sees for one wake cycle. */
export interface WakeInputs {
  readonly workspaceSlug: string
  /** Verbatim workspace.md content (may be truncated by caller). */
  readonly workspaceMd: string
  readonly openGoals: ReadonlyArray<{
    readonly slug: string
    readonly title: string
    readonly priority: number
  }>
  readonly openNextActions: ReadonlyArray<{
    readonly id: number
    readonly goalSlug: string
    readonly action: string
    readonly priority: number
    readonly status: string
  }>
  readonly recentWakes: ReadonlyArray<{
    readonly wokeAt: number
    readonly summary: string
    readonly outcome: string
  }>
}

/**
 * Result of reading wake inputs: either the full inputs, or a skip signal when
 * the workspace has no `goals`/`next_actions` schema (i.e. wake was never
 * enabled there). A skip is NOT an error — runWake records a `skipped` outcome.
 */
export type WakeReadResult =
  | { readonly _tag: "inputs"; readonly inputs: WakeInputs }
  | { readonly _tag: "skip"; readonly reason: string }

export interface WakeReasonerApi {
  readonly reason: (
    inputs: WakeInputs,
  ) => Effect.Effect<WakeDigest, WakeError>
}

/** Error from any wake-cycle step (read inputs, reason, parse, write log). */
export class WakeError extends Data.TaggedError("WakeError")<{
  readonly op: string
  readonly message: string
  readonly cause?: unknown
}> {}

/** Row insert shape for wake_log table in workspace.db. */
export interface WakeLogRowInput {
  readonly wokeAt: number
  readonly goalSlug: string | null
  readonly summary: string
  readonly outcome: WakeOutcome
  /** JSON-encoded WakeDigest (or { error } shape for failed wakes). */
  readonly artifacts: string
}

export interface WakeLogRow extends WakeLogRowInput {
  readonly id: number
}
