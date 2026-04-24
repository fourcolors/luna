/**
 * ToolError — tagged error raised by handlers built with `defineTool`.
 *
 * DESIGN.md §6 taxonomy: ValidationError/ConfigError/SDKError are the
 * canonical root errors; per-module leaf errors are permitted when the
 * failure has a distinct recovery story. Tool handlers need their own
 * tag because the builder translates it to the SDK's
 * `CallToolResult { isError: true }` convention — downstream code
 * branches on the tag, not on a generic ValidationError.
 */
import { Data } from "effect"

export class ToolError extends Data.TaggedError("ToolError")<{
  readonly tool: string
  readonly op: string
  readonly cause: unknown
}> {}
