// @vitest-environment jsdom
/**
 * thread-drag-detach.test.ts - the drag-out gesture, driven for real
 * (stack23, closing the measurable half of S17's detach/redock gate).
 *
 * WHY THIS FILE EXISTS. threadDrag.ts's own module doc says mutation testing
 * "returns SILENCE here: deleting the whole wireRow call once left 1423 tests
 * green", and defers to a hands-on exercise. That is true of FEEL - a test
 * cannot tell you whether a 6px threshold reads as crisp or twitchy. It is NOT
 * true of the MECHANICS underneath it, and those were entirely uncovered.
 *
 * Two things this file was written to catch, both of which the 1531-test suite
 * missed completely:
 *
 *   1. `const owner = State.winLabel || null` in threadDrag.ts. Replacing it
 *      with `null` left every test green - and a null owner means
 *      begin_native_pullout_drag never fires, so the floater does not stick to
 *      the cursor and REDOCK HAS NO TARGET. That is the substance of
 *      "detach/redock feel", and it is perfectly assertable.
 *
 *   2. The `winLabel` dep threaded into wireThreadRow was DEAD - destructured
 *      and never read. Passing "XXX-GARBAGE-XXX" changed nothing. It is
 *      deleted now; a dead parameter that looks load-bearing is worse than no
 *      parameter, and S19j spent a paragraph justifying a change to it.
 *
 * WHAT IS STILL NOT CLAIMED: the thresholds and elasticity live in
 * vendor/thread-drag-session.js and are driven here, not asserted. Whether the
 * gesture FEELS right remains a human question. What this pins is that the
 * gesture happens, in the right order, with the right arguments.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as LunaTransport from "@luna/ui-transport/browser"
import {
  evalChatInlineScriptWithBridge,
  loadVendorInto,
  mountChatDomFromHtml,
  readChatHtml,
} from "./helpers/chat-harness"

describe("thread row drag-out (S17 detach path)", () => {
  const M = () => (window as any).__MoonInternals
  let invoke: ReturnType<typeof vi.fn>
  // One stable window object: getCurrentWindow must return THE instance the
  // boot wired, or its listen() calls are unreachable from a test.
  let tauriWindow: {
    label: string
    listen: ReturnType<typeof vi.fn>
    [k: string]: unknown
  }

  beforeEach(() => {
    const html = readChatHtml()
    mountChatDomFromHtml(html)
    invoke = vi.fn().mockResolvedValue("panel-chat-floater")
    tauriWindow = {
      label: "panel-chat-owner",
      listen: vi.fn(async () => () => {}),
      onMoved: vi.fn(async () => () => {}),
      isMinimized: vi.fn(async () => false),
      scaleFactor: vi.fn(async () => 1),
      outerPosition: vi.fn(async () => ({ x: 0, y: 0 })),
      outerSize: vi.fn(async () => ({ width: 560, height: 520 })),
      setPosition: vi.fn(async () => {}),
    }
    ;(window as any).__TAURI__ = {
      core: { invoke },
      window: {
        getCurrentWindow: () => tauriWindow,
        Window: { getByLabel: vi.fn(async () => null) },
      },
      event: { listen: vi.fn(async () => () => {}) },
    }
    for (const f of [
      "moon-protocol.js",
      "moon-ws.js",
      "moon-markdown.js",
      "moon-dock.js",
      "thread-drag-session.js",
    ]) {
      loadVendorInto(window, f)
    }
    ;(window as any).LunaTransport = LunaTransport
    localStorage.clear()
    vi.stubGlobal(
      "WebSocket",
      class {
        static CONNECTING = 0
        static OPEN = 1
        static CLOSING = 2
        static CLOSED = 3
        readyState = 0
        url: string
        constructor(u: string) {
          this.url = u
        }
        send() {}
        close() {}
        addEventListener() {}
        removeEventListener() {}
      },
    )
    evalChatInlineScriptWithBridge()
  })

  afterEach(() => {
    document.body.innerHTML = ""
    for (const k of ["__TAURI__", "__MoonInternals", "LunaChatHost", "LunaTransport", "ChatState", "ChatLoop", "ViewMode"]) {
      delete (window as any)[k]
    }
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  /** Paint one row and hand back the element the gesture runs on. */
  const paintRow = (id = "thr-drag") => {
    const m = M()
    m.State.threads = [
      { id, title: "Draggable", lastMessagePreview: "hi", lastActiveAt: Date.now() },
    ]
    m.ThreadDrawerEngine.openPanel()
    m.ThreadDrawerEngine.render()
    const row = document.querySelector(`.thread-row[data-thread-id="${id}"]`) as HTMLElement
    expect(row, "the row must render before it can be dragged").toBeTruthy()
    // jsdom has no layout; the session needs a strip rect with real width.
    const drawer = document.getElementById("thread-drawer") as HTMLElement
    drawer.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 240, bottom: 600, width: 240, height: 600, x: 0, y: 0 }) as DOMRect
    return row
  }

  const down = (row: HTMLElement, x = 100, y = 100) =>
    row.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true, cancelable: true, button: 0, pointerId: 7,
        clientX: x, clientY: y, screenX: x, screenY: y,
      }),
    )

  const move = (row: HTMLElement, x: number, y: number) =>
    row.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true, cancelable: true, pointerId: 7,
        clientX: x, clientY: y, screenX: x, screenY: y,
      }),
    )

  const up = (row: HTMLElement, x: number, y: number) =>
    row.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true, cancelable: true, pointerId: 7,
        clientX: x, clientY: y, screenX: x, screenY: y,
      }),
    )

  describe("gesture start", () => {
    it("pointerdown opens a drag session and marks the drag active", () => {
      const row = paintRow()
      expect(M().State.threadDragActive).toBeFalsy()
      down(row)
      expect(M().State.threadDragActive, "render() hard-returns on this flag mid-gesture").toBe(true)
    })

    it("captures the pointer, so drag-out does not freeze at the window edge", () => {
      const row = paintRow()
      // jsdom does not implement setPointerCapture at all, so it has to be
      // defined before it can be observed. Production wraps the call in
      // try/catch precisely because it is not universally available.
      const capture = vi.fn()
      ;(row as unknown as { setPointerCapture: unknown }).setPointerCapture = capture
      down(row)
      expect(capture).toHaveBeenCalledWith(7)
    })

    it("a non-primary button does not start a drag", () => {
      const row = paintRow()
      row.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 2, pointerId: 7, clientX: 1, clientY: 1 }),
      )
      expect(M().State.threadDragActive).toBeFalsy()
    })
  })

  describe("detach", () => {
    /** Drag far to the right of the strip - past any detach threshold. */
    const dragOut = async (row: HTMLElement) => {
      down(row, 100, 100)
      move(row, 140, 105)
      move(row, 600, 300)
      move(row, 900, 320)
      await Promise.resolve()
      await Promise.resolve()
    }

    it("spawns exactly ONE floater, and stamps it with the owner for redock", async () => {
      const row = paintRow()
      await dragOut(row)

      const opens = invoke.mock.calls.filter((c) => c[0] === "open_widget")
      expect(opens.length, "hard promote spawns once, never chases with more open_widget").toBe(1)
      const params = (opens[0]![1] as any).params
      expect(params.thread).toBe("thr-drag")
      // THE REDOCK TARGET. Without it the floater's Redock button has nowhere
      // to fold back to - which is exactly what "detach then redock" means.
      expect(params.redockTo).toBe("panel-chat-owner")
    })

    it("hands free motion to AppKit with the OWNER label", async () => {
      const row = paintRow()
      await dragOut(row)

      const pullout = invoke.mock.calls.find((c) => c[0] === "begin_native_pullout_drag")
      expect(pullout, "the OS must take over the window after promote").toBeTruthy()
      const args = pullout![1] as any
      // Nulling `const owner = State.winLabel || null` in threadDrag.ts left
      // all 1531 other tests green. This is the assertion that notices.
      expect(args.ownerLabel).toBe("panel-chat-owner")
      expect(args.threadId).toBe("thr-drag")
      expect(args.floaterLabel).toBe("panel-chat-floater")
      // Grab offsets must match begin_native_pullout_drag's own defaults or the
      // window jumps out from under the cursor on hand-off.
      expect(args.grabOffsetX).toBe(36)
      expect(args.grabOffsetY).toBe(18)
    })

    it("does NOT arm the native pullout when this window has no owner label", async () => {
      // A main-line window (no panel label) still detaches, but there is
      // nothing to redock INTO, so the native hand-off is correctly skipped.
      const row = paintRow()
      M().State.winLabel = null
      await dragOut(row)

      expect(invoke.mock.calls.some((c) => c[0] === "open_widget")).toBe(true)
      expect(invoke.mock.calls.some((c) => c[0] === "begin_native_pullout_drag")).toBe(false)
    })

    it("seeds the floater's transcript cache before the window exists", async () => {
      // Phase C: the floater paints its transcript from this seed instead of
      // waiting for its own first snapshot.
      const row = paintRow()
      const seed = vi.spyOn(M().ThreadDrawerEngine, "_seedFloaterCache")
      await dragOut(row)
      expect(seed).toHaveBeenCalledWith("thr-drag")
    })
  })

  describe("gesture end", () => {
    it("pointerup clears the drag flag so render() resumes", async () => {
      const row = paintRow()
      down(row, 100, 100)
      move(row, 140, 105)
      expect(M().State.threadDragActive).toBe(true)
      up(row, 140, 105)
      await Promise.resolve()
      expect(M().State.threadDragActive).toBeFalsy()
    })

    it("a click-sized gesture opens the thread instead of detaching", async () => {
      const row = paintRow()
      const onRow = vi.spyOn(M().ThreadDrawerEngine, "onRowClick").mockImplementation(() => {})
      down(row, 100, 100)
      up(row, 101, 100)
      await Promise.resolve()
      expect(invoke.mock.calls.some((c) => c[0] === "open_widget"), "a tap must not spawn a window").toBe(false)
      onRow.mockRestore()
    })

    it("ignores a second pointer's events mid-gesture", async () => {
      const row = paintRow()
      const sessions = vi.spyOn((window as any).LunaThreadDrag, "createSession")
      down(row, 100, 100) // pointerId 7 owns the session (see down/move/up)
      move(row, 140, 105)
      expect(M().State.threadDragActive).toBe(true)
      // A second finger's pointerdown must not hijack the live session - it
      // used to rebuild session/pid wholesale and hand the drag to finger 2.
      row.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true, cancelable: true, button: 0, pointerId: 9,
          clientX: 500, clientY: 400, screenX: 500, screenY: 400,
        }),
      )
      expect(
        sessions.mock.calls.length,
        "a second pointerdown while a gesture is live opens no new session",
      ).toBe(1)
      row.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true, cancelable: true, pointerId: 9,
          clientX: 140, clientY: 105, screenX: 140, screenY: 105,
        }),
      )
      expect(
        M().State.threadDragActive,
        "pointerId 9 must not settle pointerId 7's gesture",
      ).toBe(true)
      up(row, 140, 105) // the owning pointer ends it
      await Promise.resolve()
      expect(M().State.threadDragActive).toBeFalsy()
    })

    it("does not start a second drag from another row while one is active", async () => {
      paintRow()
      const m = M()
      m.State.threads.push({ id: "thr-other", title: "Other", lastMessagePreview: "", lastActiveAt: Date.now() })
      m.ThreadDrawerEngine.render()
      const first = document.querySelector('.thread-row[data-thread-id="thr-drag"]') as HTMLElement
      const second = document.querySelector('.thread-row[data-thread-id="thr-other"]') as HTMLElement
      const sessions = vi.spyOn((window as any).LunaThreadDrag, "createSession")
      down(first, 100, 100)
      second.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true, cancelable: true, button: 0, pointerId: 9,
          clientX: 110, clientY: 150, screenX: 110, screenY: 150,
        }),
      )
      expect(sessions).toHaveBeenCalledTimes(1)
      expect(m.State.threadDragActive).toBe(true)
      up(first, 100, 100)
      expect(m.State.threadDragActive).toBe(false)
    })

    it("lets the native probe own the preview once the pullout is armed", async () => {
      const row = paintRow()
      down(row, 100, 100)
      move(row, 140, 105)
      move(row, 600, 300)
      move(row, 900, 320)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      expect(
        invoke.mock.calls.some((c) => c[0] === "begin_native_pullout_drag"),
        "the floater resolved and the OS pullout armed",
      ).toBe(true)
      // Cursor back over the strip: 'reenter_attached'. With the pullout
      // armed, Rust's redock-preview emits own the insert gap - a second
      // writer here fights Rust's insert index on every sample.
      move(row, 120, 300)
      expect(
        M().State.redockPreview,
        "armed pullout: owner preview must come from Rust emits, not JS",
      ).toBeNull()
    })

    it("drops the drag ghost when the floater spawn fails", async () => {
      const row = paintRow()
      // open_widget rejects - no OS window ever comes up to take the ghost over.
      invoke.mockImplementation((cmd: string) =>
        cmd === "open_widget"
          ? Promise.reject(new Error("no window"))
          : Promise.resolve("panel-chat-floater"),
      )
      down(row, 100, 100)
      move(row, 140, 105)
      move(row, 600, 300)
      move(row, 900, 320)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      up(row, 900, 320)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      expect(
        document.querySelector(".thread-drag-ghost"),
        "a failed spawn must not strand the ghost element on screen",
      ).toBeNull()
      // The keep_floater retry also fails: the id must un-float AND re-paint -
      // without a render after clearFloatedAway the row stays excluded by the
      // last floated-away paint and silently vanishes from the strip.
      const rowBack = document.querySelector(
        '.thread-row[data-thread-id="thr-drag"]',
      ) as HTMLElement | null
      expect(rowBack, "a failed spawn must hand the row back to the strip").toBeTruthy()
      expect(rowBack?.classList.contains("floated-away")).toBe(false)
    })

    it("adopts at the live preview's index, not the session's own math", async () => {
      // The displayed gap near a header/bottom comes from Rust's probe over
      // the LIST band; the session's pointerUp maps clientY over the WHOLE
      // drawer rect. The adopt index must be the gap the user saw.
      const m = M()
      m.State.threads = [
        { id: "thr-drag", title: "Draggable", lastMessagePreview: "hi", lastActiveAt: Date.now() },
        { id: "thr-b", title: "B", lastMessagePreview: "", lastActiveAt: Date.now() },
        { id: "thr-c", title: "C", lastMessagePreview: "", lastActiveAt: Date.now() },
        { id: "thr-d", title: "D", lastMessagePreview: "", lastActiveAt: Date.now() },
      ]
      m.ThreadDrawerEngine.openPanel()
      m.ThreadDrawerEngine.render()
      const row = document.querySelector(
        '.thread-row[data-thread-id="thr-drag"]',
      ) as HTMLElement
      const drawer = document.getElementById("thread-drawer") as HTMLElement
      drawer.getBoundingClientRect = () =>
        ({ left: 0, top: 0, right: 240, bottom: 600, width: 240, height: 600, x: 0, y: 0 }) as DOMRect
      const adopt = vi.spyOn(m.ThreadDrawerEngine, "adoptAtIndex")
      down(row, 100, 100)
      move(row, 140, 105)
      move(row, 600, 300)
      move(row, 900, 320)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      expect(
        invoke.mock.calls.some((c) => c[0] === "begin_native_pullout_drag"),
        "the floater resolved and the OS pullout armed",
      ).toBe(true)
      // Rust's redock-preview emit: probe over the list band says index 1.
      m.ThreadDrawerEngine.applyRedockPreview({
        threadId: "thr-drag",
        title: "Draggable",
        yRatio: 0.34,
        over: true,
      })
      expect(m.State.redockPreview?.insertIndex).toBe(1)
      // Re-enter and release at the BOTTOM of the drawer: the session's own
      // stripRect math lands ~index 3; the displayed gap said 1.
      move(row, 120, 590)
      up(row, 120, 590)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      expect(
        adopt.mock.calls.some((c) => c[0] === "thr-drag" && c[1] === 1),
        "adoption must land where the displayed gap was, not where stripRect() puts it",
      ).toBe(true)
    })

    it("returns the strip row when its floater closes without redocking", async () => {
      const row = paintRow()
      down(row, 100, 100)
      move(row, 140, 105)
      move(row, 600, 300)
      move(row, 900, 320)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      // Row left the strip once the floater resolved.
      expect(M().State.floatedThreadIds["thr-drag"]).toBeTruthy()
      // Rust emits 'floater-closed' from WindowEvent::Destroyed when a chat
      // instance with thread + redockTo params dies by ANY path (close
      // button, ⌘W, close_widget). Only the redock path used to clear it -
      // the row stayed hidden forever.
      const handler = (tauriWindow.listen.mock.calls.find((c) => c[0] === "floater-closed") || [])[1] as
        | ((e: { payload: unknown }) => void)
        | undefined
      expect(handler, "the owner must listen for floater-closed").toBeTypeOf("function")
      handler!({ payload: { threadId: "thr-drag" } })
      expect(M().State.floatedThreadIds["thr-drag"]).toBeUndefined()
    })
  })
})
