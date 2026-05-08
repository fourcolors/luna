import { Data } from "effect"

export class SchedulerToolsError extends Data.TaggedError("SchedulerToolsError")<{
  readonly tool: string
  readonly op: string
  readonly cause: unknown
}> {}
