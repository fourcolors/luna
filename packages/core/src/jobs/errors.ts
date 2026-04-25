/**
 * Jobs & Schedule tagged errors — additive boundary per DESIGN §6.3.
 *
 * The frozen root taxonomy (`packages/core/src/errors.ts`) is NOT modified.
 * These errors compose alongside the frozen ones in module error channels.
 *
 *   - `JobSubmitError` — raised by `JobScheduler.submit` when the bounded
 *     inbox refuses an offer (`drop-newest` policy on a full queue) or
 *     the scheduler is shutting down. Surfaces synchronously to the caller.
 *   - `JobInterruptedError` — embedded in a `JobResult.exit` (Exit.fail or
 *     Exit.die / Exit.interrupt as appropriate). Provided as a convenience
 *     when callers want to inspect why a job stopped without unwrapping
 *     `Cause`. Note: real interruption from FiberSet/Scope cascade arrives
 *     as `Exit.isInterrupted` — this tagged error is reserved for explicit
 *     scheduler-shutdown semantics surfaced via the result Stream when we
 *     need a typed payload.
 *   - `TriggerError` — cron parse failure, unknown trigger kind, or trigger
 *     registration failure.
 */
import { Data } from "effect"

export class JobSubmitError extends Data.TaggedError("JobSubmitError")<{
  readonly reason: "queue-full" | "shutting-down"
  readonly jobId?: string
}> {}

export class JobInterruptedError extends Data.TaggedError(
  "JobInterruptedError",
)<{
  readonly jobId: string
  readonly reason: "scheduler-shutdown" | "drop-oldest-eviction"
}> {}

export class TriggerError extends Data.TaggedError("TriggerError")<{
  readonly kind: "cron-parse" | "unknown-kind" | "registration"
  readonly message: string
  readonly cause?: unknown
}> {}
