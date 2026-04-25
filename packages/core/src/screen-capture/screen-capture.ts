/**
 * ScreenCapture — macOS visual context pipeline (Phase 13b).
 *
 * Uses the macOS `screencapture` CLI (available since macOS 10.x) to capture
 * screenshots. On non-macOS platforms, the layer returns
 * ScreenCaptureError(reason="platform_unavailable").
 *
 * Invariants:
 *   - §3.4 #4 interruption: the capture subprocess is killed on interrupt.
 *   - §3.4 #1 no cross-Scope refs: subprocess handle is purely internal.
 *   - Result is immutable (Buffer + primitive fields).
 *   - Redaction is reserved (Phase 13b+); capture + data URI are M3 scope.
 *
 * CLI invocation:
 *   screencapture [-x] [-D <display>] [-t <format>] <tmpfile>
 *   -x: no sound
 *   -D <n>: display number
 *   -t <fmt>: output type (png/jpg)
 *
 * Region capture uses:
 *   screencapture -R <x>,<y>,<w>,<h> ...
 */
import { execFile } from "node:child_process"
import { readFile, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { Effect, Layer } from "effect"
import { ScreenCaptureError } from "./errors.js"
import type { CaptureOptions, CaptureResult, ScreenCaptureApi } from "./types.js"

const execFileAsync = promisify(execFile)

const DEFAULT_TIMEOUT_MS = 10_000

function captureImpl(opts: CaptureOptions = {}): Effect.Effect<CaptureResult, ScreenCaptureError> {
  if (process.platform !== "darwin") {
    return Effect.fail(
      new ScreenCaptureError({
        reason: "platform_unavailable",
        message: `ScreenCapture is only supported on macOS; current platform: ${process.platform}`,
      }),
    )
  }

  const format = opts.format ?? "png"
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const tmpFile = join(
    tmpdir(),
    `sc-${Date.now()}-${Math.random().toString(36).slice(2)}.${format}`,
  )
  const mimeType = format === "jpg" ? ("image/jpeg" as const) : ("image/png" as const)

  const runCapture = Effect.tryPromise({
    try: async () => {
      const startMs = Date.now()
      const args: string[] = ["-x", "-t", format]
      if (opts.display !== undefined && opts.display !== 0) {
        args.push("-D", String(opts.display))
      }
      if (opts.region !== undefined) {
        const { x, y, width, height } = opts.region
        args.push("-R", `${x},${y},${width},${height}`)
      }
      args.push(tmpFile)
      await execFileAsync("screencapture", args, { timeout: timeoutMs })
      const data = await readFile(tmpFile)
      await unlink(tmpFile).catch(() => { /* best-effort cleanup */ })
      const base64 = data.toString("base64")
      const elapsedMs = Date.now() - startMs
      return {
        data,
        mimeType,
        dataUri: `data:${mimeType};base64,${base64}`,
        elapsedMs,
      } satisfies CaptureResult
    },
    catch: (err) => {
      // Best-effort cleanup
      unlink(tmpFile).catch(() => { /* ignore */ })
      const msg = String(err)
      if (msg.includes("permission") || msg.includes("denied") || msg.includes("CGWindowListCreateImage")) {
        return new ScreenCaptureError({
          reason: "permission_denied",
          message: `Screen recording permission denied: ${msg}`,
          cause: err,
        })
      }
      if (msg.includes("timeout")) {
        return new ScreenCaptureError({
          reason: "timeout",
          message: `Screenshot timed out after ${timeoutMs}ms`,
          cause: err,
        })
      }
      return new ScreenCaptureError({
        reason: "spawn_failed",
        message: `screencapture failed: ${msg}`,
        cause: err,
      })
    },
  })

  return runCapture.pipe(
    Effect.timeoutFail({
      duration: `${timeoutMs} millis`,
      onTimeout: () =>
        new ScreenCaptureError({
          reason: "timeout",
          message: `Screenshot timed out after ${timeoutMs}ms`,
        }),
    }),
  )
}

export class ScreenCapture extends Effect.Tag(
  "experiment-agent/ScreenCapture",
)<ScreenCapture, ScreenCaptureApi>() {
  static readonly Default: Layer.Layer<ScreenCapture> = Layer.succeed(
    ScreenCapture,
    {
      capture: (opts) => captureImpl(opts),
      captureDataUri: (opts) =>
        captureImpl(opts).pipe(Effect.map((r) => r.dataUri)),
    } satisfies ScreenCaptureApi,
  )
}
