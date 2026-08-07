/**
 * threadStrip.ts - the thread drawer's row rendering (stack23 S17c).
 *
 * WHY IMPERATIVE DOM AND NOT REACT, deliberately. S17's charter names a React
 * drawer, and the row list is the one part of it that superficially looks like
 * a good fit. It is not, and the reason is the same cycle that shaped this
 * whole slice: a row IS a drag handle. During a pull-out it holds pointer
 * capture, carries a CSS ghost, participates in a FLIP animation, and hands
 * off to a native OS window. React owning those nodes means React may replace
 * one mid-gesture, which is precisely what `State.threadDragActive` exists to
 * prevent - so a React row list would need a guard that suppresses rendering
 * during exactly the interaction React was brought in to manage.
 *
 * Moving the code OUT of the 9.5k-line monolith is the win worth having here;
 * changing its paradigm at the same time would put Moon's most feel-critical
 * interaction on a rewrite no automated test can judge (S17's own deployNote
 * says a screenshot cannot prove threshold feel).
 *
 * THE render/_wireRow CYCLE IS PRESERVED, NOT SPLIT. `renderThreadStrip`
 * builds each row and hands it straight to the caller's `wireRow` before it is
 * ever attached, exactly as vanilla's `_renderRow` did. The drag machinery
 * stays where it is; this module never reaches into it. That is what lets the
 * rendering move without touching the cycle the S17 seam finding said must not
 * be broken (docs/next/stack23-slices.md).
 *
 * ESCAPING: titles and previews are server-provided, so they are written with
 * `textContent` and never interpolated into markup. The static skeleton below
 * is the ONLY innerHTML, and it is a constant with no interpolation at all.
 */
import type { ThreadRow } from "./threadList"

/** The redock drop preview, when a floater is being dragged over the strip. */
export interface RedockPreview {
  readonly over?: boolean
  readonly threadId?: string | null
  readonly yRatio?: unknown
}

export interface ThreadStripCtx {
  /** `#thread-drawer-list` - the scroller rows are appended to. */
  readonly listEl: HTMLElement | null
  /** `#thread-drawer-empty` - the "No threads yet." placeholder. */
  readonly emptyEl: HTMLElement | null
  /** `#thread-drawer` - carries the `redock-target` class while a drop is live. */
  readonly drawerEl: HTMLElement | null
  /** Rows to paint, already filtered and ordered (see threadList.ts). */
  readonly rows: readonly ThreadRow[]
  /** The live search string, for the empty-state wording only. */
  readonly search: string
  /** The thread currently in view, which gets the `active` class. */
  readonly activeThreadId: string | null
  /** Live redock preview, or null. */
  readonly preview: RedockPreview | null
  /** Where a redock drop would land, or -1 for none. */
  readonly insertAt: number
  /** True while a thread has work in flight - drives the row's busy dot. */
  readonly isBusy: (threadId: string) => boolean
  /** Relative-time string for a row with no preview text. */
  readonly relTime: (t: ThreadRow) => string
  /** Attach the drag/click gesture to a freshly built row. Called BEFORE the
   *  row is attached to the document, exactly as vanilla's `_renderRow` did. */
  readonly wireRow: (row: HTMLElement, t: ThreadRow) => void
  /** Build the insert-gap placeholder shown at the drop position. */
  readonly makeInsertGap: (preview: RedockPreview | null) => HTMLElement
  /** Enter/Space on a focused row. `inNewWindow` is true for Meta/Ctrl, which
   *  opens a Phase-8 pop-out instead of switching in place. */
  readonly onRowKeyActivate: (threadId: string, inNewWindow: boolean) => void
  /** The row's ⤢ button. */
  readonly onPopOut: (threadId: string) => void
}

/** Static row skeleton - icons only, no interpolation. Text is set via
 *  `textContent` below so a server-provided title can never become markup. */
const ROW_SKELETON =
  '<span class="thread-row-grip" aria-hidden="true">' +
  "<span></span><span></span><span></span><span></span><span></span><span></span>" +
  "</span>" +
  '<span class="thread-row-dot" aria-hidden="true"></span>' +
  '<span class="thread-row-info">' +
  '<span class="thread-row-title"></span>' +
  '<span class="thread-row-preview"></span>' +
  "</span>" +
  '<button type="button" class="thread-row-pop" title="Open in new window" aria-label="Open in new window">⤢</button>'

/** Build one row element, wired and ready to attach. Ported 1:1 from
 *  `ThreadDrawerEngine._renderRow`. */
export function buildThreadRow(ctx: ThreadStripCtx, t: ThreadRow): HTMLElement {
  const row = document.createElement("div")
  row.className = "thread-row"
  row.setAttribute("role", "listitem")
  row.tabIndex = 0
  row.dataset["threadId"] = t.id
  if (t.id === ctx.activeThreadId) row.classList.add("active")
  // A background thread with work in flight pulses; the ACTIVE one does not,
  // because the moon face already carries that state for the viewed thread.
  if (ctx.isBusy(t.id) && t.id !== ctx.activeThreadId) row.classList.add("busy")

  row.innerHTML = ROW_SKELETON
  const titleEl = row.querySelector(".thread-row-title")
  const previewEl = row.querySelector(".thread-row-preview")
  if (titleEl) titleEl.textContent = (t.title && String(t.title).trim()) || "Untitled thread"
  if (previewEl) {
    previewEl.textContent = (t.lastMessagePreview && String(t.lastMessagePreview).trim()) || ctx.relTime(t)
  }

  // Primary click/drag belongs to wireRow (pointer capture); this only adds
  // the keyboard affordance, which the pointer path never sees.
  row.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault()
      ctx.onRowKeyActivate(t.id, e.metaKey || e.ctrlKey)
    }
  })

  ctx.wireRow(row, t)

  const pop = row.querySelector(".thread-row-pop")
  if (pop) {
    // stopPropagation on pointerdown so the pop-out button never starts a
    // row drag - without it, pressing it would begin a pull-out gesture.
    pop.addEventListener("pointerdown", (e) => e.stopPropagation())
    pop.addEventListener("click", (e) => {
      e.stopPropagation()
      ctx.onPopOut(t.id)
    })
  }
  return row
}

/** Repaint the strip wholesale. Ported 1:1 from `ThreadDrawerEngine.render`'s
 *  body, minus the mid-drag guard, which stays with the caller because it also
 *  sets the deferred-repaint flag. */
export function renderThreadStrip(ctx: ThreadStripCtx): void {
  const listEl = ctx.listEl
  if (!listEl) return

  // Drop existing rows and gaps; the empty-state node is left in place.
  listEl.querySelectorAll(".thread-row, .thread-row-insert-gap").forEach((n) => {
    n.remove()
  })

  if (ctx.emptyEl) {
    ctx.emptyEl.style.display = ctx.rows.length ? "none" : ""
    ctx.emptyEl.textContent = (ctx.search || "").trim() ? "No matching threads." : "No threads yet."
  }

  const preview = ctx.preview
  const frag = document.createDocumentFragment()
  for (let i = 0; i < ctx.rows.length; i++) {
    if (i === ctx.insertAt) frag.appendChild(ctx.makeInsertGap(preview))
    const t = ctx.rows[i]
    if (!t) continue
    const row = buildThreadRow(ctx, t)
    if (preview && preview.threadId && t.id === preview.threadId) {
      row.classList.add("redock-source")
    }
    frag.appendChild(row)
  }
  // A drop past the last row appends the gap at the end.
  if (ctx.insertAt === ctx.rows.length) frag.appendChild(ctx.makeInsertGap(preview))

  listEl.appendChild(frag)

  if (ctx.drawerEl) {
    ctx.drawerEl.classList.toggle("redock-target", !!(preview && preview.over))
  }
}
