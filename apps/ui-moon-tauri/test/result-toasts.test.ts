// @vitest-environment jsdom
/**
 * result-toasts.test.ts - the background-result toast (#124, stack23 S19a).
 *
 * WHY IT NEEDED TESTS AT ALL. Three mutations of the module all left the full
 * 1477-test Moon suite GREEN:
 *   - the auto-dismiss timer never armed  -> toasts pile up forever
 *   - the preview written with innerHTML  -> MARKUP INJECTION from a server frame
 *   - the dismiss path not clearing timers -> stale callbacks leak
 *
 * The second is the one that matters most: `preview` arrives on a
 * `result-delivered` frame, so it is server-controlled text rendered into the
 * chat window. Nothing was asserting it stayed text.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createResultToasts } from "../frontend-react/src/chat/resultToasts"

const toasts = () => Array.from(document.querySelectorAll("#result-toasts .result-toast"))
const titleOf = (el: Element) => el.querySelector(".rt-title")!.textContent
const previewOf = (el: Element) => el.querySelector(".rt-preview")?.textContent

describe("resultToasts", () => {
  beforeEach(() => {
    document.body.innerHTML = ""
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  describe("rendering", () => {
    it("mounts its own container lazily and shows a titled toast", () => {
      const rt = createResultToasts()
      expect(document.getElementById("result-toasts")).toBeNull()
      rt.show({ label: "the build" })
      expect(document.getElementById("result-toasts")).not.toBeNull()
      expect(toasts()).toHaveLength(1)
      expect(titleOf(toasts()[0]!)).toBe("✓Luna finished: the build")
    })

    it("omits the label suffix when there is none", () => {
      const rt = createResultToasts()
      rt.show({})
      expect(titleOf(toasts()[0]!)).toBe("✓Luna finished")
      rt.show(null)
      expect(titleOf(toasts()[1]!)).toBe("✓Luna finished")
    })

    it("omits the preview node entirely when there is no preview", () => {
      const rt = createResultToasts()
      rt.show({ label: "x" })
      expect(toasts()[0]!.querySelector(".rt-preview")).toBeNull()
    })

    it("reuses the existing container across toasts", () => {
      const rt = createResultToasts()
      rt.show({ label: "a" })
      rt.show({ label: "b" })
      expect(document.querySelectorAll("#result-toasts")).toHaveLength(1)
      expect(toasts()).toHaveLength(2)
    })

    it("re-creates the container if the document was wiped underneath it", () => {
      const rt = createResultToasts()
      rt.show({ label: "a" })
      document.body.innerHTML = "" // window teardown / a test resetting the DOM
      rt.show({ label: "b" })
      // A cached detached host would swallow this silently.
      expect(toasts()).toHaveLength(1)
    })
  })

  describe("escaping - preview and label are SERVER-controlled", () => {
    it("renders a preview as TEXT, never as markup", () => {
      const rt = createResultToasts()
      rt.show({ label: "job", preview: '<img src=x onerror=alert(1)><b>bold</b>' })
      const toast = toasts()[0]!
      expect(previewOf(toast)).toBe('<img src=x onerror=alert(1)><b>bold</b>')
      expect(toast.querySelector("img"), "a server preview must never become an element").toBeNull()
      expect(toast.querySelector("b")).toBeNull()
    })

    it("renders a label as TEXT, never as markup", () => {
      const rt = createResultToasts()
      rt.show({ label: "<script>alert(1)</script>" })
      const toast = toasts()[0]!
      expect(titleOf(toast)).toContain("<script>")
      expect(toast.querySelector("script")).toBeNull()
    })

    it("stringifies a non-string preview rather than dropping it", () => {
      const rt = createResultToasts()
      rt.show({ label: "x", preview: 42 })
      expect(previewOf(toasts()[0]!)).toBe("42")
    })
  })

  describe("auto-dismiss", () => {
    it("removes the toast on its own after the dismiss window", () => {
      const rt = createResultToasts()
      rt.show({ label: "a" })
      expect(toasts()).toHaveLength(1)
      vi.advanceTimersByTime(6500) // auto-dismiss fires
      vi.advanceTimersByTime(220) // leave transition completes
      expect(toasts(), "an un-dismissed toast would pile up forever").toHaveLength(0)
    })

    it("marks the toast as leaving before removing it", () => {
      const rt = createResultToasts()
      rt.show({ label: "a" })
      vi.advanceTimersByTime(6500)
      expect(toasts()[0]!.classList.contains("leaving")).toBe(true)
      vi.advanceTimersByTime(220)
      expect(toasts()).toHaveLength(0)
    })

    it("dismisses each toast independently", () => {
      const rt = createResultToasts()
      rt.show({ label: "first" })
      vi.advanceTimersByTime(3000)
      rt.show({ label: "second" })
      vi.advanceTimersByTime(3500 + 220) // first's window elapses, second's has not
      expect(toasts()).toHaveLength(1)
      expect(titleOf(toasts()[0]!)).toContain("second")
    })
  })

  describe("manual dismiss", () => {
    it("dismisses on click", () => {
      const rt = createResultToasts()
      rt.show({ label: "a" })
      toasts()[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      vi.advanceTimersByTime(220)
      expect(toasts()).toHaveLength(0)
    })

    it("CLEARS the pending auto-dismiss timer, leaving no stale callback", () => {
      const rt = createResultToasts()
      const id = rt.show({ label: "a" })
      rt.dismiss(id)
      vi.advanceTimersByTime(220)
      expect(toasts()).toHaveLength(0)
      // The real assertion: nothing is still scheduled for this toast. A leaked
      // timer would fire into a removed node later.
      expect(vi.getTimerCount()).toBe(0)
    })

    it("is safe to call twice, and safe for an unknown id", () => {
      const rt = createResultToasts()
      const id = rt.show({ label: "a" })
      rt.dismiss(id)
      expect(() => rt.dismiss(id)).not.toThrow()
      expect(() => rt.dismiss("rt-never-existed")).not.toThrow()
    })

    it("is safe before anything has been shown", () => {
      const rt = createResultToasts()
      expect(() => rt.dismiss("rt-1")).not.toThrow()
    })
  })

  describe("instances", () => {
    it("two instances keep separate ids and timers", () => {
      // A module-level singleton would leak timers across windows and across
      // test files sharing a jsdom global.
      const a = createResultToasts()
      const b = createResultToasts()
      expect(a.show({ label: "x" })).toBe("rt-1")
      expect(b.show({ label: "y" })).toBe("rt-1")
      expect(toasts()).toHaveLength(2)
    })
  })
})
