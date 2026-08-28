/**
 * feedbackEngine.test.ts
 *
 * WHY THIS FILE EXISTS: the feedback form was not including screenshots.
 * S19c added screenshot capture; these tests verify the two contracts that
 * guard the feature:
 *
 *  1. When _captureScreenshot fails, submit() still sends the text note
 *     (non-blocking) AND the sent frame includes the failure reason under
 *     `screenshotCaptureError` (fail-loud-not-silent).
 *
 *  2. When _captureScreenshot succeeds, the frame includes `screenshot` and
 *     does NOT include `screenshotCaptureError`.
 *
 * We test the engine object returned by createFeedbackEngine directly,
 * monkey-patching `_captureScreenshot` so we never need a Tauri runtime.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { createFeedbackEngine, type FeedbackEngineDeps } from "./feedbackEngine"

// ---------------------------------------------------------------------------
// Minimal DOM stub — feedbackEngine reads several DOM nodes but each read is
// individually guarded with null checks. We provide just enough to let
// submit() reach the WebSocketEngine.send() call without throwing.
// ---------------------------------------------------------------------------
function makeDom() {
  return {
    feedbackBtn: null,
    feedbackPickerOverlay: null,
    feedbackPickerHighlight: null,
    feedbackPanel: null,
    feedbackTargetChip: null,
    feedbackInput: { value: "Test note" } as HTMLInputElement,
    feedbackSubmit: { disabled: false } as HTMLButtonElement,
    feedbackStatus: null,
  }
}

// A minimal target that passes submit()'s guard (selector must be non-empty,
// rect must be present for the screenshot path to have something to work with).
const SAMPLE_TARGET = {
  selector: "#some-btn",
  tag: "button",
  id: "some-btn",
  classes: [],
  text: "Click me",
  rect: { x: 10, y: 20, w: 100, h: 40 },
  route: { page: "chat.html", windowLabel: null, threadId: null, url: "http://localhost/chat.html" },
  appearance: {},
  viewport: { w: 1280, h: 800, dpr: 2 },
  textLength: 8,
  anchor: null,
  selectorStability: "best-effort",
  capturedAt: Date.now(),
}

function makeEngine(sendSpy: ReturnType<typeof vi.fn>) {
  const deps: FeedbackEngineDeps = {
    DOM: makeDom(),
    State: { activeThreadId: "thread-1", appVersion: "0.0.1", ws: null },
    isConnected: () => true,
    WebSocketEngine: { send: sendSpy },
  }
  const engine = createFeedbackEngine(deps)
  // Prime the engine: set _target and _enabled so submit() doesn't short-circuit.
  engine._enabled = true
  engine._target = SAMPLE_TARGET
  return engine
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("feedbackEngine.submit() — capture-failed path (fail-loud-not-silent)", () => {
  it("still sends the text note when _captureScreenshot returns an error", async () => {
    const send = vi.fn()
    const engine = makeEngine(send)

    // Override _captureScreenshot to simulate a Tauri invoke failure.
    engine._captureScreenshot = vi.fn().mockResolvedValue({ error: "invoke-failed: permission denied" })

    await engine.submit()

    // The note MUST have been sent — non-blocking.
    expect(send).toHaveBeenCalledOnce()
    const frame = send.mock.calls[0][0] as Record<string, unknown>
    expect(frame.type).toBe("feedback-submit")
    expect(frame.note).toBe("Test note")
  })

  it("records the capture error in screenshotCaptureError when capture fails", async () => {
    const send = vi.fn()
    const engine = makeEngine(send)
    engine._captureScreenshot = vi.fn().mockResolvedValue({ error: "invoke-failed: permission denied" })

    await engine.submit()

    const frame = send.mock.calls[0][0] as Record<string, unknown>
    expect(frame.screenshotCaptureError).toBe("invoke-failed: permission denied")
  })

  it("does NOT include screenshot field when capture fails", async () => {
    const send = vi.fn()
    const engine = makeEngine(send)
    engine._captureScreenshot = vi.fn().mockResolvedValue({ error: "no-tauri" })

    await engine.submit()

    const frame = send.mock.calls[0][0] as Record<string, unknown>
    expect(frame.screenshot).toBeUndefined()
  })

  it("handles all documented error reasons non-blocking", async () => {
    const reasons = ["no-tauri", "no-rect", "invoke-failed: some msg", "empty-result", "image-load-failed", "crop-failed", "unexpected: oops"]
    for (const reason of reasons) {
      const send = vi.fn()
      const engine = makeEngine(send)
      engine._captureScreenshot = vi.fn().mockResolvedValue({ error: reason })

      await engine.submit()

      expect(send).toHaveBeenCalledOnce()
      const frame = send.mock.calls[0][0] as Record<string, unknown>
      expect(frame.screenshotCaptureError).toBe(reason)
    }
  })
})

describe("feedbackEngine.submit() — capture-success path", () => {
  it("includes screenshot base64 in the frame when capture succeeds", async () => {
    const send = vi.fn()
    const engine = makeEngine(send)
    engine._captureScreenshot = vi.fn().mockResolvedValue({
      base64: "abc123==",
      width: 100,
      height: 40,
      bytes: 10,
    })

    await engine.submit()

    const frame = send.mock.calls[0][0] as Record<string, unknown>
    expect(frame.screenshot).toBe("abc123==")
  })

  it("does NOT include screenshotCaptureError when capture succeeds", async () => {
    const send = vi.fn()
    const engine = makeEngine(send)
    engine._captureScreenshot = vi.fn().mockResolvedValue({
      base64: "abc123==",
      width: 100,
      height: 40,
      bytes: 10,
    })

    await engine.submit()

    const frame = send.mock.calls[0][0] as Record<string, unknown>
    expect(frame.screenshotCaptureError).toBeUndefined()
  })
})

describe("feedbackEngine._captureScreenshot() — discriminated union contract", () => {
  it("returns { error } shape (not null) when Tauri is unavailable", async () => {
    // jsdom has no window.__TAURI__ — this is the no-tauri path.
    const engine = makeEngine(vi.fn())
    const result = await engine._captureScreenshot(SAMPLE_TARGET)
    // Must return an object with an `error` key, never null or undefined.
    expect(result).toBeDefined()
    expect(result).not.toBeNull()
    expect(typeof (result as { error: string }).error).toBe("string")
    expect((result as { error: string }).error).toBe("no-tauri")
  })

  it("never throws even when called with null target", async () => {
    const engine = makeEngine(vi.fn())
    // Should return { error: 'no-tauri' } (Tauri check fires first) — key
    // point is it must not throw.
    await expect(engine._captureScreenshot(null)).resolves.toBeDefined()
  })
})
