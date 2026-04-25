/**
 * ScreenCapture errors (Phase 13b).
 * Module-local errors — NOT added to the frozen root errors.ts.
 */
import { Data } from "effect"

export type ScreenCaptureErrorReason =
  | "platform_unavailable"
  | "permission_denied"
  | "timeout"
  | "spawn_failed"
  | "parse_failed"

export class ScreenCaptureError extends Data.TaggedError("ScreenCaptureError")<{
  readonly reason: ScreenCaptureErrorReason
  readonly message: string
  readonly cause?: unknown
}> {}
