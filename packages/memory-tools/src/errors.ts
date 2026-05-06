/**
 * MemoryToolsError — tagged error raised by memory tool handlers.
 *
 * Wraps the underlying MemoryBackendError (or other failure) at the
 * tool boundary so the SDK builder maps it to a CallToolResult with
 * `isError: true`. Mirrors the pattern in `@luna/tools`'s ToolError.
 */
import { Data } from "effect"

export class MemoryToolsError extends Data.TaggedError("MemoryToolsError")<{
  readonly tool: string
  readonly op: string
  readonly cause: unknown
}> {}
