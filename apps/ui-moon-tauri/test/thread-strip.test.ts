// @vitest-environment jsdom
/**
 * thread-strip.test.ts - unit tests for src/chat/threadStrip.ts, the thread
 * drawer's row rendering (stack23 S17c).
 *
 * WHY THIS FILE EXISTS AT ALL. Before the extraction this logic lived inside
 * chat.html's 9.5k-line inline script as `ThreadDrawerEngine._renderRow` and
 * `.render`, reachable only by booting the whole page. Being a plain module
 * with an injected ctx is what makes the assertions below possible - that is
 * the concrete payoff of the move, not a side effect of it.
 *
 * THE ASSERTION THAT MOTIVATED IT: deleting `ctx.wireRow(row, t)` from the
 * renderer left the ENTIRE Moon suite green (1423/0). The row's drag wiring -
 * pointer capture, pull-out, redock, the whole feel-critical gesture S17 is
 * about - had no coverage whatsoever, so a refactor could have silently
 * disabled drag-out and every gate would still have passed. `wireRow` is
 * pinned here per row, and the mutation is now caught.
 */
import { describe, it, expect, vi } from "vitest"
import { renderThreadStrip, type RedockPreview, type ThreadStripCtx } from "../frontend-react/src/chat/threadStrip"
import type { ThreadRow } from "../frontend-react/src/chat/threadList"

function mount() {
  document.body.innerHTML =
    '<div id="thread-drawer"><div id="thread-drawer-list"></div><div id="thread-drawer-empty"></div></div>'
  return {
    drawerEl: document.getElementById("thread-drawer"),
    listEl: document.getElementById("thread-drawer-list"),
    emptyEl: document.getElementById("thread-drawer-empty"),
  }
}

function makeCtx(rows: ThreadRow[], over: Partial<ThreadStripCtx> = {}): ThreadStripCtx {
  const els = mount()
  return {
    ...els,
    rows,
    search: "",
    activeThreadId: null,
    preview: null,
    insertAt: -1,
    isBusy: () => false,
    relTime: () => "",
    wireRow: () => {},
    makeInsertGap: () => {
      const gap = document.createElement("div")
      gap.className = "thread-row-insert-gap"
      return gap
    },
    onRowKeyActivate: () => {},
    onPopOut: () => {},
    ...over,
  } as ThreadStripCtx
}

const rowEls = () => Array.from(document.querySelectorAll("#thread-drawer-list .thread-row"))
const ids = () => rowEls().map((el) => (el as HTMLElement).dataset["threadId"])

describe("renderThreadStrip", () => {
  describe("the drag seam", () => {
    it("hands EVERY rendered row to wireRow", () => {
      // The pin that was missing. Without it, dropping the wireRow call is
      // invisible to the whole suite.
      const wireRow = vi.fn()
      const ctx = makeCtx([{ id: "a" }, { id: "b" }, { id: "c" }], { wireRow })
      renderThreadStrip(ctx)
      expect(wireRow).toHaveBeenCalledTimes(3)
      expect(wireRow.mock.calls.map((c) => (c[1] as ThreadRow).id)).toEqual(["a", "b", "c"])
    })

    it("wires each row BEFORE it is attached to the document", () => {
      // Load-bearing ordering: vanilla wired inside _renderRow, before the
      // fragment was appended. A row wired after attachment would briefly
      // exist in the DOM with no drag handler, and a pointerdown in that
      // window would be swallowed.
      const attachedWhenWired: boolean[] = []
      const ctx = makeCtx([{ id: "a" }, { id: "b" }], {
        wireRow: (row) => attachedWhenWired.push(document.contains(row)),
      })
      renderThreadStrip(ctx)
      expect(attachedWhenWired).toEqual([false, false])
    })

    it("passes the row element and its own thread, not a stale one", () => {
      const seen: Array<[string | undefined, string]> = []
      const ctx = makeCtx([{ id: "a" }, { id: "b" }], {
        wireRow: (row, t) => seen.push([row.dataset["threadId"], t.id]),
      })
      renderThreadStrip(ctx)
      expect(seen).toEqual([
        ["a", "a"],
        ["b", "b"],
      ])
    })
  })

  describe("row content", () => {
    it("renders the title and preview as TEXT, never as markup", () => {
      renderThreadStrip(makeCtx([{ id: "a", title: "<img src=x onerror=1>", lastMessagePreview: "<b>hi</b>" }]))
      const row = rowEls()[0]!
      expect(row.querySelector(".thread-row-title")!.textContent).toBe("<img src=x onerror=1>")
      expect(row.querySelector(".thread-row-preview")!.textContent).toBe("<b>hi</b>")
      expect(row.querySelector("img"), "a server title must never become an element").toBeNull()
      expect(row.querySelector(".thread-row-preview b")).toBeNull()
    })

    it("falls back to 'Untitled thread' and to relTime", () => {
      renderThreadStrip(makeCtx([{ id: "a", title: "   " }], { relTime: () => "2d ago" }))
      const row = rowEls()[0]!
      expect(row.querySelector(".thread-row-title")!.textContent).toBe("Untitled thread")
      expect(row.querySelector(".thread-row-preview")!.textContent).toBe("2d ago")
    })

    it("marks the active row, and marks a busy BACKGROUND row only", () => {
      const ctx = makeCtx([{ id: "a" }, { id: "b" }], { activeThreadId: "a", isBusy: () => true })
      renderThreadStrip(ctx)
      const [a, b] = rowEls()
      expect(a!.classList.contains("active")).toBe(true)
      // The viewed thread's busy state is carried by the moon face, not the
      // row - so the ACTIVE row never pulses even while busy.
      expect(a!.classList.contains("busy")).toBe(false)
      expect(b!.classList.contains("busy")).toBe(true)
    })
  })

  describe("empty state", () => {
    it("shows the placeholder when there are no rows, and hides it otherwise", () => {
      const ctx = makeCtx([])
      renderThreadStrip(ctx)
      expect(ctx.emptyEl!.style.display).toBe("")
      expect(ctx.emptyEl!.textContent).toBe("No threads yet.")

      renderThreadStrip(makeCtx([{ id: "a" }]))
      expect(document.getElementById("thread-drawer-empty")!.style.display).toBe("none")
    })

    it("says 'No matching threads.' when a search is active", () => {
      const ctx = makeCtx([], { search: "  zzz  " })
      renderThreadStrip(ctx)
      expect(ctx.emptyEl!.textContent).toBe("No matching threads.")
    })
  })

  describe("redock preview", () => {
    const preview: RedockPreview = { over: true, threadId: "b", yRatio: 0.5 }

    it("places the insert gap at insertAt, and flags the drawer as a drop target", () => {
      const ctx = makeCtx([{ id: "a" }, { id: "b" }], { preview, insertAt: 1 })
      renderThreadStrip(ctx)
      const kids = Array.from(ctx.listEl!.children).map((el) => el.className.split(" ")[0])
      expect(kids).toEqual(["thread-row", "thread-row-insert-gap", "thread-row"])
      expect(ctx.drawerEl!.classList.contains("redock-target")).toBe(true)
    })

    it("appends the gap past the last row when insertAt equals the row count", () => {
      const ctx = makeCtx([{ id: "a" }, { id: "b" }], { preview, insertAt: 2 })
      renderThreadStrip(ctx)
      expect(ctx.listEl!.lastElementChild!.className).toContain("thread-row-insert-gap")
    })

    it("marks the dragged thread's own row as the redock source", () => {
      const ctx = makeCtx([{ id: "a" }, { id: "b" }], { preview, insertAt: 0 })
      renderThreadStrip(ctx)
      const b = rowEls().find((el) => (el as HTMLElement).dataset["threadId"] === "b")!
      expect(b.classList.contains("redock-source")).toBe(true)
    })

    it("clears the drop-target flag when no preview is live", () => {
      const ctx = makeCtx([{ id: "a" }])
      ctx.drawerEl!.classList.add("redock-target")
      renderThreadStrip(ctx)
      expect(ctx.drawerEl!.classList.contains("redock-target")).toBe(false)
    })
  })

  describe("repaint", () => {
    it("rebuilds wholesale rather than appending", () => {
      // makeCtx() mounts the DOM itself, so the ctx must be reused as-is -
      // re-mounting between renders would detach the very elements it holds.
      const ctx = makeCtx([{ id: "a" }, { id: "b" }])
      renderThreadStrip(ctx)
      renderThreadStrip(ctx)
      expect(ids()).toEqual(["a", "b"])
    })

    it("degrades to a no-op when the list element is missing", () => {
      const ctx = makeCtx([{ id: "a" }], { listEl: null })
      expect(() => renderThreadStrip(ctx)).not.toThrow()
    })
  })

  describe("row affordances", () => {
    it("Enter activates in place; Meta+Enter opens a new window", () => {
      const onRowKeyActivate = vi.fn()
      renderThreadStrip(makeCtx([{ id: "a" }], { onRowKeyActivate }))
      const row = rowEls()[0]!
      row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
      row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true, cancelable: true }))
      expect(onRowKeyActivate.mock.calls).toEqual([
        ["a", false],
        ["a", true],
      ])
    })

    it("the pop-out button opens a window and does NOT start a row drag", () => {
      const onPopOut = vi.fn()
      const wireRowDown = vi.fn()
      renderThreadStrip(
        makeCtx([{ id: "a" }], {
          onPopOut,
          // Stand in for the drag machinery: it listens for pointerdown on the
          // row, and must not see the button's.
          wireRow: (row) => row.addEventListener("pointerdown", wireRowDown),
        }),
      )
      const pop = rowEls()[0]!.querySelector(".thread-row-pop")!
      pop.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }))
      pop.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      expect(onPopOut).toHaveBeenCalledWith("a")
      expect(wireRowDown, "pressing the pop-out button must not begin a pull-out").not.toHaveBeenCalled()
    })
  })
})
