// @vitest-environment jsdom
/**
 * moon-face-bar.test.ts - the header's expression + message zone
 * (src/chat/moonFace.ts, src/chat/moonBar.ts, stack23 S19e).
 *
 * WHY THESE NEEDED THEIR OWN FILE. Five mutations, run against the other 1493
 * Moon tests with this file EXCLUDED, then against this file alone:
 *
 *   mutation                                  rest of suite   this file
 *   reverse MoonFace's priority ladder        caught (2)      caught
 *   static aria-label on the chip             caught (1)      caught
 *   drop the torn-down guard (setInterval)    ALL GREEN       caught
 *   rotate the quip under a live suggestion   ALL GREEN       caught
 *   default MoonFace to 'connected'           ALL GREEN       caught (3)
 *
 * So the booted-window tests already cover the loud, visible behaviours and
 * genuinely did not cover the three quiet ones - a leaked timer on a detached
 * node, a chip churning underneath itself, and the default state.
 *
 * THE BOOT-ORDER IDENTITY IS THE LOAD-BEARING TEST HERE. S19e added `?.` to
 * three call sites in chat.html because loadConnectionAndConnect() can reach
 * them BEFORE the deferred module publishes these controllers. That is only
 * safe because skipping those three calls is the identity - both objects
 * already default to exactly what the calls would set. `boot-order identity`
 * below asserts that equivalence directly, so if a future change gives either
 * controller a different default, the `?.` decision fails loudly here instead
 * of silently showing a wrong face on the first paint. That is the mutation
 * nothing else in the repo catches: defaulting the face to 'connected' leaves
 * the other 1493 tests green while making the first painted frame a lie.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createMoonFace } from "../frontend-react/src/chat/moonFace"
import { createMoonBar } from "../frontend-react/src/chat/moonBar"

const QUIP_ROTATE_MS = 14000
const FADE_MS = 600

function mountFace() {
  document.body.innerHTML = '<div id="luna-face"></div>'
  return {
    face: createMoonFace({ lunaFace: document.getElementById("luna-face") }),
    el: document.getElementById("luna-face")!,
  }
}

function mountBar() {
  document.body.innerHTML =
    '<div id="luna-quip"></div>' +
    '<button id="luna-suggestion" hidden><span id="luna-suggestion-text"></span></button>'
  const quip = document.getElementById("luna-quip")!
  const chip = document.getElementById("luna-suggestion")!
  return {
    bar: createMoonBar({
      lunaQuip: quip,
      lunaSuggestion: chip,
      lunaSuggestionText: document.getElementById("luna-suggestion-text"),
    }),
    quip,
    chip,
  }
}

describe("MoonFace", () => {
  it("paints nothing until init, then paints the resolved state", () => {
    const { face, el } = mountFace()
    expect(el.dataset["state"]).toBeUndefined()
    face.init()
    expect(el.dataset["state"]).toBe("connecting")
  })

  describe("the priority ladder", () => {
    // connection > thinking > voice > suggesting > idle. Each case below sets
    // EVERY lower-priority signal too, so a mutant that reorders the ladder
    // produces the lower signal's answer rather than passing by accident.
    const cases: Array<[string, (f: ReturnType<typeof createMoonFace>) => void, string]> = [
      [
        "connecting outranks everything",
        (f) => {
          f.setBusy(true)
          f.setVoice("listening")
          f.setSuggesting(true)
          f.setConnection("connecting")
        },
        "connecting",
      ],
      [
        "offline outranks busy, voice and suggesting",
        (f) => {
          f.setBusy(true)
          f.setVoice("speaking")
          f.setSuggesting(true)
          f.setConnection("disconnected")
        },
        "offline",
      ],
      [
        "busy outranks voice and suggesting",
        (f) => {
          f.setConnection("connected")
          f.setVoice("listening")
          f.setSuggesting(true)
          f.setBusy(true)
        },
        "busy",
      ],
      [
        "listening outranks suggesting",
        (f) => {
          f.setConnection("connected")
          f.setSuggesting(true)
          f.setVoice("listening")
        },
        "listening",
      ],
      [
        "speaking outranks suggesting",
        (f) => {
          f.setConnection("connected")
          f.setSuggesting(true)
          f.setVoice("speaking")
        },
        "speaking",
      ],
      [
        "suggesting is the last non-idle rung",
        (f) => {
          f.setConnection("connected")
          f.setSuggesting(true)
        },
        "suggesting",
      ],
      ["idle is the empty string", (f) => f.setConnection("connected"), ""],
    ]
    for (const [name, drive, expected] of cases) {
      it(name, () => {
        const { face, el } = mountFace()
        face.init()
        drive(face)
        expect(el.dataset["state"]).toBe(expected)
      })
    }
  })

  it("a version-warning still chats, so the face reads as connected", () => {
    // Not cosmetic: a version-warning connection is fully usable, and showing
    // an 'offline' moon over a working socket would be a lie.
    const { face, el } = mountFace()
    face.init()
    face.setConnection("version-warning")
    expect(el.dataset["state"]).toBe("")
  })

  it("treats any unrecognised status as connected rather than offline", () => {
    const { face, el } = mountFace()
    face.init()
    face.setConnection("something-new")
    expect(el.dataset["state"]).toBe("")
  })

  it("ignores a voice state it does not know", () => {
    const { face, el } = mountFace()
    face.init()
    face.setConnection("connected")
    face.setVoice("humming")
    expect(el.dataset["state"]).toBe("")
  })

  it("coerces truthiness rather than requiring booleans", () => {
    const { face, el } = mountFace()
    face.init()
    face.setConnection("connected")
    face.setBusy(1)
    expect(el.dataset["state"]).toBe("busy")
    face.setBusy(0)
    expect(el.dataset["state"]).toBe("")
  })

  it("re-resolves its element when it was absent at construction", () => {
    // main-chat.tsx constructs from document.getElementById, which is null if
    // the node is not there yet; _apply must be able to pick it up later.
    document.body.innerHTML = ""
    const face = createMoonFace({
      get lunaFace() {
        return document.getElementById("luna-face")
      },
    })
    face.init() // no element - must not throw
    document.body.innerHTML = '<div id="luna-face"></div>'
    face.setConnection("connected")
    expect(document.getElementById("luna-face")!.dataset["state"]).toBe("")
  })

  it("two instances do not share state", () => {
    document.body.innerHTML = '<div id="a"></div><div id="b"></div>'
    const a = createMoonFace({ lunaFace: document.getElementById("a") })
    const b = createMoonFace({ lunaFace: document.getElementById("b") })
    a.init()
    b.init()
    a.setConnection("connected")
    a.setBusy(true)
    expect(document.getElementById("a")!.dataset["state"]).toBe("busy")
    expect(document.getElementById("b")!.dataset["state"]).toBe("connecting")
  })
})

describe("MoonBar", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("opens on the connection mood line, not a quip", () => {
    const { bar, quip } = mountBar()
    bar.init()
    expect(quip.textContent).toBe("waking up…")
  })

  it("switches to a playful quip once connected", () => {
    const { bar, quip } = mountBar()
    bar.init()
    bar.setConnection("connected")
    expect(quip.textContent).toBe("just vibing ✨")
  })

  it("a version-warning counts as connected here too", () => {
    const { bar, quip } = mountBar()
    bar.init()
    bar.setConnection("version-warning")
    expect(quip.textContent).toBe("just vibing ✨")
  })

  it("says something honest when the socket drops", () => {
    const { bar, quip } = mountBar()
    bar.init()
    bar.setConnection("connected")
    bar.setConnection("disconnected")
    expect(quip.textContent).toBe("lost the thread… reconnecting")
  })

  describe("quip rotation", () => {
    it("rotates to the next quip after the interval, through a fade", () => {
      const { bar, quip } = mountBar()
      bar.init()
      bar.setConnection("connected")
      expect(quip.textContent).toBe("just vibing ✨")
      vi.advanceTimersByTime(QUIP_ROTATE_MS)
      expect(quip.classList.contains("fading"), "the swap fades rather than snapping").toBe(true)
      vi.advanceTimersByTime(FADE_MS)
      expect(quip.textContent).toBe("ready when you are 🌙")
      expect(quip.classList.contains("fading")).toBe(false)
    })

    it("wraps around the whole quip list", () => {
      const { bar, quip } = mountBar()
      bar.init()
      bar.setConnection("connected")
      const seen = new Set<string>()
      for (let i = 0; i < 8; i++) {
        seen.add(quip.textContent || "")
        vi.advanceTimersByTime(QUIP_ROTATE_MS + FADE_MS)
      }
      expect(seen.size, "all eight quips should appear before repeating").toBe(8)
      expect(quip.textContent, "and then it wraps to the first").toBe("just vibing ✨")
    })

    it("does NOT rotate while a suggestion is showing", () => {
      const { bar, quip } = mountBar()
      bar.init()
      bar.setConnection("connected")
      bar.showSuggestion({ title: "Run the migration" })
      vi.advanceTimersByTime((QUIP_ROTATE_MS + FADE_MS) * 3)
      expect(quip.textContent, "the chip owns the bar; the quip must not churn underneath").toBe(
        "just vibing ✨",
      )
    })

    it("does NOT rotate away from a connection mood line", () => {
      const { bar, quip } = mountBar()
      bar.init() // still 'connecting'
      vi.advanceTimersByTime((QUIP_ROTATE_MS + FADE_MS) * 3)
      expect(quip.textContent).toBe("waking up…")
    })

    it("STOPS rescheduling once its node leaves the document", () => {
      // The reason this is a self-rescheduling timeout and not a setInterval.
      // A mutant using setInterval leaks a timer that fires forever on a
      // detached node - which is what hangs a jsdom suite.
      const { bar } = mountBar()
      bar.init()
      bar.setConnection("connected")
      expect(vi.getTimerCount()).toBe(1)
      document.body.innerHTML = "" // teardown
      vi.advanceTimersByTime(QUIP_ROTATE_MS)
      expect(vi.getTimerCount(), "a torn-down bar must not keep a timer alive").toBe(0)
    })

    it("arms only one rotation timer no matter how often init is called", () => {
      const { bar } = mountBar()
      bar.init()
      bar.init()
      bar.init()
      expect(vi.getTimerCount()).toBe(1)
    })

    it("does nothing at all when there is no quip element", () => {
      document.body.innerHTML = ""
      const bar = createMoonBar({ lunaQuip: null, lunaSuggestion: null, lunaSuggestionText: null })
      bar.init()
      expect(vi.getTimerCount()).toBe(0)
      expect(() => {
        bar.setConnection("connected")
        bar.clearSuggestion()
        bar.showSuggestion({ title: "x" })
      }).not.toThrow()
    })
  })

  describe("the suggestion chip", () => {
    it("reveals the chip, hides the quip, and paints the title", () => {
      const { bar, quip, chip } = mountBar()
      bar.init()
      bar.showSuggestion({ title: "Run the migration" })
      expect(chip.hidden).toBe(false)
      expect(quip.hidden).toBe(true)
      expect(document.getElementById("luna-suggestion-text")!.textContent).toBe(
        "Run the migration",
      )
      expect(chip.title).toBe("Run the migration")
    })

    it("gives the chip a DYNAMIC accessible name", () => {
      // A static aria-label would override the visible title and hide the
      // actual suggestion from a screen reader - the whole point of the chip.
      const { bar, chip } = mountBar()
      bar.init()
      bar.showSuggestion({ title: "Run the migration" })
      expect(chip.getAttribute("aria-label")).toBe("Open Luna’s suggestion: Run the migration")
    })

    it("falls back to a generic title rather than an empty chip", () => {
      const { bar, chip } = mountBar()
      bar.init()
      bar.showSuggestion({})
      expect(document.getElementById("luna-suggestion-text")!.textContent).toBe(
        "Luna has an idea",
      )
      bar.showSuggestion(null)
      expect(chip.title).toBe("Luna has an idea")
    })

    it("renders a hostile title as TEXT, never as markup", () => {
      // `title` originates in a server frame via SuggestedActionsEngine.
      const { bar, chip } = mountBar()
      bar.init()
      bar.showSuggestion({ title: '<img src=x onerror=alert(1)>' })
      expect(chip.querySelector("img")).toBeNull()
      expect(document.getElementById("luna-suggestion-text")!.textContent).toBe(
        "<img src=x onerror=alert(1)>",
      )
    })

    it("clearing restores the quip and resumes rotation", () => {
      const { bar, quip, chip } = mountBar()
      bar.init()
      bar.setConnection("connected")
      bar.showSuggestion({ title: "x" })
      bar.clearSuggestion()
      expect(chip.hidden).toBe(true)
      expect(quip.hidden).toBe(false)
      vi.advanceTimersByTime(QUIP_ROTATE_MS + FADE_MS)
      expect(quip.textContent).toBe("ready when you are 🌙")
    })

    it("a connection change while the chip is up does not repaint the quip", () => {
      const { bar, quip } = mountBar()
      bar.init()
      bar.setConnection("connected")
      bar.showSuggestion({ title: "x" })
      bar.setConnection("disconnected")
      expect(quip.textContent).toBe("just vibing ✨")
      bar.clearSuggestion()
      expect(quip.textContent, "the mood line lands when the chip steps aside").toBe(
        "lost the thread… reconnecting",
      )
    })
  })
})

describe("boot-order identity (why chat.html's three `?.` are safe)", () => {
  // chat.html's loadConnectionAndConnect() can reach connect() and
  // updateStatus() BEFORE the deferred module publishes these controllers, so
  // S19e made exactly three reads optional:
  //     MoonFace?.setBusy(false)
  //     MoonFace?.setConnection('connecting')
  //     MoonBar?.setConnection('connecting')
  // Skipping them is only safe if a controller that NEVER received them is
  // indistinguishable from one that did. That is what these two assert.
  it("a face that missed the early calls looks identical to one that got them", () => {
    document.body.innerHTML = '<div id="early"></div><div id="late"></div>'
    const early = createMoonFace({ lunaFace: document.getElementById("early") })
    const late = createMoonFace({ lunaFace: document.getElementById("late") })

    early.setBusy(false) // the two calls chat.html makes pre-module
    early.setConnection("connecting")
    early.init()

    late.init() // the module-published path: init only

    expect(document.getElementById("late")!.dataset["state"]).toBe(
      document.getElementById("early")!.dataset["state"],
    )
    expect(document.getElementById("late")!.dataset["state"]).toBe("connecting")
  })

  it("a bar that missed the early call opens on the same line", () => {
    vi.useFakeTimers()
    try {
      document.body.innerHTML = '<div id="q1"></div><div id="q2"></div>'
      const early = createMoonBar({
        lunaQuip: document.getElementById("q1"),
        lunaSuggestion: null,
        lunaSuggestionText: null,
      })
      const late = createMoonBar({
        lunaQuip: document.getElementById("q2"),
        lunaSuggestion: null,
        lunaSuggestionText: null,
      })
      early.setConnection("connecting")
      early.init()
      late.init()
      expect(document.getElementById("q2")!.textContent).toBe(
        document.getElementById("q1")!.textContent,
      )
      expect(document.getElementById("q2")!.textContent).toBe("waking up…")
    } finally {
      vi.useRealTimers()
    }
  })
})
