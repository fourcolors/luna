/**
 * SandboxRuntime errors (Phase 13a).
 * Per DESIGN §6.1: leaf services raise; composing services translate.
 * These are module-local errors — NOT added to the frozen root errors.ts.
 */
import { Data } from "effect"

export type SandboxErrorReason =
  | "spawn_failed"
  | "timeout"
  | "non_zero_exit"
  | "output_limit_exceeded"

export class SandboxError extends Data.TaggedError("SandboxError")<{
  readonly reason: SandboxErrorReason
  readonly command: string
  readonly message: string
  readonly exitCode?: number
  readonly cause?: unknown
}> {}
