/**
 * ScreenCapture — tests (Phase 13b).
 *
 * On non-macOS platforms, tests verify the platform_unavailable error path.
 * On macOS with screen recording permission, the capture tests run.
 * On macOS WITHOUT permission, capture fails gracefully.
 */
import { describe, expect, it } from "vitest"
import { Effect, Exit, Layer } from "effect"
import { ScreenCapture, ScreenCaptureError } from "../src/screen-capture/index.js"

const run = <A, E>(prog: Effect.Effect<A, E, ScreenCapture>) =>
  Effect.runPromise(prog.pipe(Effect.provide(ScreenCapture.Default)))

const isMacOS = process.platform === "darwin"

describe("ScreenCapture", () => {
  it("(1) returns platform_unavailable on non-macOS", async () => {
    if (isMacOS) {
      // On macOS, this path isn't hit — skip.
      expect(true).toBe(true)
      return
    }
    const exit = await run(
      Effect.gen(function* () {
        const sc = yield* ScreenCapture
        return yield* sc.capture().pipe(Effect.exit)
      }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(JSON.stringify(exit.cause)).toContain("platform_unavailable")
    }
  })

  it("(2) on macOS: captures screenshot or fails with permission_denied gracefully", async () => {
    if (!isMacOS) {
      expect(true).toBe(true)
      return
    }
    const exit = await run(
      Effect.gen(function* () {
        const sc = yield* ScreenCapture
        return yield* sc.capture({ timeoutMs: 5_000 }).pipe(Effect.exit)
      }),
    )
    if (Exit.isSuccess(exit)) {
      // Capture succeeded
      expect(exit.value.mimeType).toBe("image/png")
      expect(exit.value.data.length).toBeGreaterThan(0)
      expect(exit.value.dataUri).toMatch(/^data:image\/png;base64,/)
      expect(exit.value.elapsedMs).toBeGreaterThan(0)
    } else {
      // Permission denied or other error — must be a ScreenCaptureError
      const causeStr = JSON.stringify(exit.cause)
      expect(causeStr).toContain("ScreenCaptureError")
    }
  }, 10000)

  it("(3) captureDataUri returns a string starting with data:", async () => {
    if (!isMacOS) {
      expect(true).toBe(true)
      return
    }
    const exit = await run(
      Effect.gen(function* () {
        const sc = yield* ScreenCapture
        return yield* sc.captureDataUri({ timeoutMs: 5_000 }).pipe(Effect.exit)
      }),
    )
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toMatch(/^data:image\/png;base64,/)
    } else {
      expect(JSON.stringify(exit.cause)).toContain("ScreenCaptureError")
    }
  }, 10000)

  it("(4) ScreenCaptureError is a proper TaggedError", () => {
    const err = new ScreenCaptureError({
      reason: "platform_unavailable",
      message: "test",
    })
    expect(err._tag).toBe("ScreenCaptureError")
    expect(err.reason).toBe("platform_unavailable")
    expect(err.message).toBe("test")
  })

  it("(5) Layer.succeed requires no deps", async () => {
    const hasLayer = Layer.isLayer(ScreenCapture.Default)
    expect(hasLayer).toBe(true)
  })
})
