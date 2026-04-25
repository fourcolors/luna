/**
 * ScreenCapture — public types (Phase 13b).
 *
 * Visual context pipeline with redaction.
 * Per DESIGN §2.1.13: "Visual context pipeline with redaction."
 */
import type { Effect } from "effect"
import type { ScreenCaptureError } from "./errors.js"

export interface CaptureOptions {
  /**
   * Display number to capture. 0 = main display. Default: 0.
   * On macOS, uses `screencapture -D <display>`.
   */
  readonly display?: number

  /**
   * Region to capture (pixels from top-left of display).
   * If omitted, captures the entire display.
   */
  readonly region?: {
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
  }

  /**
   * Image format. Default: "png".
   */
  readonly format?: "png" | "jpg"

  /**
   * Timeout for the capture operation in ms. Default: 10_000.
   */
  readonly timeoutMs?: number

  /**
   * Apply basic redaction: blur regions matching common PII patterns.
   * Phase 13b: not yet implemented; reserved for a future phase.
   * Default: false.
   */
  readonly redact?: boolean
}

export interface CaptureResult {
  /** Raw image bytes. */
  readonly data: Buffer
  /** MIME type of the image. */
  readonly mimeType: "image/png" | "image/jpeg"
  /** Width in pixels. */
  readonly width?: number
  /** Height in pixels. */
  readonly height?: number
  /** Base64-encoded data URI (data:<mimeType>;base64,...). */
  readonly dataUri: string
  /** Elapsed capture time in ms. */
  readonly elapsedMs: number
}

export interface ScreenCaptureApi {
  /**
   * Capture a screenshot. Returns image bytes and metadata.
   * Throws ScreenCaptureError on platform unavailability, timeout, or
   * permission denial.
   */
  readonly capture: (
    opts?: CaptureOptions,
  ) => Effect.Effect<CaptureResult, ScreenCaptureError>

  /**
   * Capture and return only the base64 data URI. Convenience wrapper
   * for use in prompt context.
   */
  readonly captureDataUri: (
    opts?: CaptureOptions,
  ) => Effect.Effect<string, ScreenCaptureError>
}
