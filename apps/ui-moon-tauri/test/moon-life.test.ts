// @vitest-environment jsdom
/**
 * moon-life.test.ts - gaze drift and the idle flourish (frontend-react/src/chat/moonLife.ts).
 *
 * The gaze loop is the ONLY timer on the face; everything else is a CSS
 * keyframe. So the things worth pinning here are the ones that would leak or
 * misfire: that it stops when the face is busy, that it stops when the document
 * hides, that stop() actually removes what it added, and that the flourish is
 * as rare as it claims to be.
 *
 * It deliberately uses setInterval rather than requestAnimationFrame: a
 * self-rescheduling rAF loop recurses synchronously under faked timers and
 * blew the stack across 292 unrelated tests. `does not recurse` guards that.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createMoonLife, loopNoise, FLOURISH_AFTER_MS, FLOURISH_EVERY_MS } from "../frontend-react/src/chat/moonLife"

function mount() {
  document.body.innerHTML =
    '<div id="luna-face" data-state=""><svg><g class="luna-eyes"></g></svg></div>'
  const face = document.getElementById("luna-face")!
  return {
    face,
    eyes: face.querySelector(".luna-eyes")! as unknown as HTMLElement,
    life: createMoonLife({ lunaFace: face, lunaEyes: face.querySelector(".luna-eyes") }),
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.useRealTimers(); document.body.innerHTML = "" })

describe("loopNoise", () => {
  it("is seamless across its period, so the drift never jumps", () => {
    // A visible discontinuity at the loop point is the whole failure mode.
    expect(loopNoise(0, 9.1)).toBeCloseTo(loopNoise(9.1, 9.1), 10)
  })
  it("stays inside a bounded range", () => {
    for (let t = 0; t < 20; t += 0.37) expect(Math.abs(loopNoise(t, 9.1))).toBeLessThan(1.01)
  })
})

describe("gaze", () => {
  it("offsets the eyes while idle", () => {
    const { eyes, life } = mount()
    life.start()
    life._frame(1234)
    expect(eyes.getAttribute("transform")).toMatch(/^translate\(/)
    life.stop()
  })

  it("hands the eyes back the moment the face is busy", () => {
    const { face, eyes, life } = mount()
    life.start()
    life._frame(1234)
    expect(eyes.getAttribute("transform")).toBeTruthy()
    face.dataset["state"] = "busy"
    life._frame(1300)
    // Not merely frozen: REMOVED, so the busy state's own eye rule applies.
    expect(eyes.getAttribute("transform")).toBeNull()
    life.stop()
  })

  it("stop() removes what it added and detaches its listeners", () => {
    const { face, eyes, life } = mount()
    life.start()
    life._frame(1234)
    expect(eyes.getAttribute("transform")).toBeTruthy()
    life.stop()
    expect(eyes.getAttribute("transform")).toBeNull()
    expect(face.classList.contains("is-shooting")).toBe(false)
    // Idempotent: a second stop must not throw.
    expect(() => life.stop()).not.toThrow()
  })

  it("does not recurse: advancing a long span is bounded", () => {
    // The regression this file exists for. Under faked timers a rAF loop that
    // reschedules itself is drained synchronously and blows the stack.
    const { life } = mount()
    life.start()
    expect(() => vi.advanceTimersByTime(60_000)).not.toThrow()
    life.stop()
  })

  it("pauses while the document is hidden", () => {
    const { life } = mount()
    life.start()
    const spy = vi.spyOn(document, "hidden", "get").mockReturnValue(true)
    document.dispatchEvent(new Event("visibilitychange"))
    // Nothing to assert visually; the contract is that it does not throw and
    // resumes cleanly, which the next event covers.
    spy.mockReturnValue(false)
    document.dispatchEvent(new Event("visibilitychange"))
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow()
    spy.mockRestore()
    life.stop()
  })
})

describe("the idle flourish", () => {
  it("never fires before the idle budget, however many frames pass", () => {
    const { face, life } = mount()
    life.start()
    const roll = vi.spyOn(Math, "random").mockReturnValue(0)  // always wins the roll
    for (let t = 0; t < FLOURISH_AFTER_MS; t += FLOURISH_EVERY_MS) life._frame(t)
    expect(face.classList.contains("is-shooting")).toBe(false)
    roll.mockRestore()
    life.stop()
  })

  it("fires once the budget has passed and the roll wins", () => {
    const { face, life } = mount()
    life.start()
    const roll = vi.spyOn(Math, "random").mockReturnValue(0)
    life._frame(0)                                  // establishes idleSince
    life._frame(FLOURISH_AFTER_MS + FLOURISH_EVERY_MS + 1)
    expect(face.classList.contains("is-shooting")).toBe(true)
    roll.mockRestore()
    // stop() must CANCEL the pending SHOOT_MS callback, not just remove the
    // class: an untracked timeout outlives teardown holding the captured face.
    life.stop()
    expect(face.classList.contains("is-shooting")).toBe(false)
    vi.advanceTimersByTime(10_000)
    expect(face.classList.contains("is-shooting")).toBe(false)
  })

  it("reduced motion never starts - both branches now injectable", () => {
    const face = document.createElement("div")
    const eyes = document.createElement("div")
    const life = createMoonLife({
      lunaFace: face,
      lunaEyes: eyes as unknown as HTMLElement,
      reducedMotion: { matches: true },
    })
    life.start()
    // No listeners, no interval, no drift: the whole point of the setting is
    // that nothing moves on its own. _frame still works (it is a seam), but
    // start() must be a no-op.
    expect(() => vi.advanceTimersByTime(5_000)).not.toThrow()
    expect(eyes.getAttribute("transform")).toBeNull()
    life.stop()
  })

  it("respects the roll: a losing throw stays quiet", () => {
    const { face, life } = mount()
    life.start()
    const roll = vi.spyOn(Math, "random").mockReturnValue(0.99)
    life._frame(0)
    life._frame(FLOURISH_AFTER_MS + FLOURISH_EVERY_MS + 1)
    expect(face.classList.contains("is-shooting")).toBe(false)
    roll.mockRestore()
    life.stop()
  })

  it("a turn resets the idle clock, so a busy app never gets one", () => {
    const { face, life } = mount()
    life.start()
    const roll = vi.spyOn(Math, "random").mockReturnValue(0)
    life._frame(0)
    face.dataset["state"] = "busy"
    life._frame(FLOURISH_AFTER_MS)      // a turn happened: clock resets
    face.dataset["state"] = ""
    life._frame(FLOURISH_AFTER_MS + 1)  // idle again, but only just
    expect(face.classList.contains("is-shooting")).toBe(false)
    roll.mockRestore()
    life.stop()
  })
})
