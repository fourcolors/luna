// packages/core/src/suggested-actions/types.ts
//
// Domain types for the Suggested Actions feature — Luna proposes actions inline
// in a chat thread ("do a task", "create a skill", "do research", "create /
// run a workflow"); the user accepts (auto-executes as a durable job) or
// dismisses. Mirrors the alignment module's type conventions (a COMPONENT key,
// Row/RowInput shapes, a Data.TaggedError). Frame shapes live in
// @luna/ui-shared + @luna/ui-ws, NOT here — core stays frame-agnostic.
import { Data } from "effect"

/** Migration-ladder component key for the suggested-actions tables (§5.2). */
export const SUGGESTED_ACTIONS_COMPONENT = "suggested_actions"

/** The five action kinds Luna can propose. */
export type SuggestedActionType =
  | "task"
  | "research"
  | "create_skill"
  | "create_workflow"
  | "run_workflow"

/** Lifecycle status of a proposed action (also the log `event` enum). */
export type SuggestedActionStatus =
  | "proposed"
  | "accepted"
  | "in_progress"
  | "completed"
  | "failed"
  | "dismissed"

/** Who proposed the action: the live in-turn agent, or the nightly Dream. */
export type SuggestedActionSource = "agent" | "dream"

/** Terminal states — `respond()` and lifecycle transitions are no-ops here. */
export const TERMINAL_STATUSES: ReadonlySet<SuggestedActionStatus> =
  new Set<SuggestedActionStatus>(["completed", "failed", "dismissed"])

/** Non-terminal states — what replay-on-subscribe surfaces to a reopened thread. */
export const ACTIVE_STATUSES: ReadonlyArray<SuggestedActionStatus> = [
  "proposed",
  "accepted",
  "in_progress",
]

/* ── Payloads (serialized to payload_json; interpreted by the accept-handler) ─ */

/** Prompt-style actions (task / research / create_skill / create_workflow):
 *  the accept-handler turns this into a durable `kind:'prompt'` job that spawns
 *  a subagent. `create_workflow` lets the subagent author + run a workflow. */
export interface PromptActionPayload {
  readonly prompt: string
  /** Fully-qualified tools the spawned subagent may use. */
  readonly allowedTools?: ReadonlyArray<string>
  /** Optional model override for the spawned subagent. */
  readonly model?: string
  /**
   * Optional turn-budget override for the spawned subagent. The accept-handler
   * stamps `DEFAULT_MAX_TURNS` (see accept-handler.ts) when this is absent —
   * without it the prompt-worker's own default of 1 turn applies, which fails
   * any suggested action that needs more than a single tool call (task-23).
   */
  readonly maxTurns?: number
}

/** `run_workflow`: dispatch an EXISTING saved `kind:'workflow'` job (one-shot).
 *  `jobId` is a row in the durable jobs store (surfaced by the WorkflowGallery). */
export interface RunWorkflowPayload {
  readonly jobId: string
}

export type SuggestedActionPayload = PromptActionPayload | RunWorkflowPayload

/** Input to `propose()`. `id`/`at` are optional idempotency anchors. */
export interface ProposeInput {
  readonly threadId: string
  readonly source: SuggestedActionSource
  readonly actionType: SuggestedActionType
  readonly title: string
  readonly detail?: string
  readonly rationale?: string
  readonly payload: SuggestedActionPayload
  /** Stable creation timestamp; falls back to Clock.nowMs() when absent. */
  readonly at?: number
  /** Explicit action id; defaults to a content-derived id (dedup re-proposes). */
  readonly id?: string
}

/** A persisted state row — one per action, holding its current status. */
export interface SuggestedActionRow {
  readonly id: string
  readonly threadId: string
  readonly source: SuggestedActionSource
  readonly actionType: SuggestedActionType
  readonly title: string
  readonly detail: string | null
  readonly rationale: string | null
  readonly payload: SuggestedActionPayload
  readonly status: SuggestedActionStatus
  readonly executionKind: "job" | "workflow" | null
  readonly executionId: string | null
  readonly error: string | null
  readonly createdAt: number
  readonly updatedAt: number
}

/** One append-only audit-log row (event ledger). */
export interface SuggestedActionLogRow {
  readonly id: string
  readonly actionId: string
  readonly at: number
  readonly event: SuggestedActionStatus
  readonly threadId: string
  readonly source: SuggestedActionSource
  readonly actionType: SuggestedActionType
}

export interface ListThreadQuery {
  /** Restrict to these statuses (e.g. ACTIVE_STATUSES for replay). */
  readonly status?: ReadonlyArray<SuggestedActionStatus>
}

/** The execution link recorded when an accepted action begins running. */
export interface ExecutionRef {
  readonly kind: "job" | "workflow"
  readonly id: string
}

export class SuggestedActionsError extends Data.TaggedError(
  "SuggestedActionsError",
)<{
  readonly op: string
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * Wire-safe projection of a row — NO `payload` (prompts / job ids stay
 * server-side). Structurally identical to @luna/ui-shared and @luna/ui-ws
 * `SuggestedActionWire`, so chat-service builds frames with this view and ui-ws
 * passes them through unchanged. Core stays frame-agnostic; this is just a
 * redacted DTO, not a frame.
 */
export interface SuggestedActionView {
  readonly id: string
  readonly threadId: string
  readonly actionType: SuggestedActionType
  readonly title: string
  readonly detail?: string
  readonly rationale?: string
  readonly status: SuggestedActionStatus
  readonly source: SuggestedActionSource
  readonly createdAt: number
  readonly executionId?: string | null
  readonly error?: string | null
}

/** Project a persisted row to its wire-safe view (drops the payload). */
export const toView = (r: SuggestedActionRow): SuggestedActionView => ({
  id: r.id,
  threadId: r.threadId,
  actionType: r.actionType,
  title: r.title,
  ...(r.detail !== null ? { detail: r.detail } : {}),
  ...(r.rationale !== null ? { rationale: r.rationale } : {}),
  status: r.status,
  source: r.source,
  createdAt: r.createdAt,
  executionId: r.executionId,
  error: r.error,
})
