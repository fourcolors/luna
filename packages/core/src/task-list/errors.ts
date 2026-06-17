/**
 * TaskList tagged errors — additive boundary per DESIGN §6.3.
 *
 * The frozen root taxonomy (`packages/core/src/errors.ts`) is NOT modified.
 * These errors compose alongside the frozen ones in module error channels.
 *
 *   - `TaskNotFoundError` — raised when claim/setStatus/complete reference
 *     a TaskId that is not present in the in-memory store.
 *   - `TaskAlreadyClaimedError` — raised when `claim` is called on a task
 *     that already has a DIFFERENT assignee. Same-assignee re-claim is
 *     idempotent (no error) — see task-list.ts for the rationale comment.
 *   - `TaskValidationError` — raised on invalid spec (e.g. empty subject)
 *     or invalid status transition (e.g. setStatus on a completed task).
 *
 * Decision: TaskValidationError is its own tagged error rather than reusing
 * the frozen `ValidationError` so callers can pattern-match on the TaskList
 * channel without false positives from upstream ValidationErrors. The frozen
 * `ValidationError` carries `module: string`, but multiplexing on `module`
 * forces stringly-typed branching — we prefer a dedicated tag here, the same
 * additive-error pattern the other module error channels use.
 */
import { Data } from "effect"

export class TaskNotFoundError extends Data.TaggedError("TaskNotFoundError")<{
  readonly taskId: string
}> {}

export class TaskAlreadyClaimedError extends Data.TaggedError(
  "TaskAlreadyClaimedError",
)<{
  readonly taskId: string
  readonly currentAssignee: string
  readonly attemptedAssignee: string
}> {}

export class TaskValidationError extends Data.TaggedError(
  "TaskValidationError",
)<{
  readonly field: string
  readonly message: string
}> {}
