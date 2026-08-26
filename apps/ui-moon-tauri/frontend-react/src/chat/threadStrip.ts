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
import type { LiveAgentRow, ThreadRow } from "./threadList"

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
  /** Agent sidebar S5, search mode only: rows wear their section as a tag
   *  when grouping is suspended by an active search. */
  readonly tagAgents?: boolean
  /**
   * The live subagents to nest under a given thread's row, newest turn only
   * (see threadList.liveAgentsForThread). ABSENT = no nesting at all, the
   * exact pre-existing paint.
   *
   * Nested rows are `.thread-agent-row` SIBLINGS of `.thread-row`, indented
   * by class — never wrappers, and never carrying the `.thread-row` class
   * themselves. Both halves matter: redock's `_placeInsertGap` walks
   * `querySelectorAll('.thread-row')` and `insertIndexForRatio` does index
   * math over exactly that list, so a wrapper would misparent the drop gap
   * and a shared class would shift every drop index by the number of live
   * agents on screen.
   */
  readonly agentRowsFor?: (threadId: string) => readonly LiveAgentRow[]
  /**
   * Agent sidebar S5: section rendering. ABSENT = the exact pre-S5 flat
   * path, byte-for-byte. When present, headers render as SIBLINGS of the
   * rows — rows stay DIRECT children of `listEl`, indented by class, never
   * nested in wrappers: redock's `querySelectorAll('.thread-row')` +
   * `insertBefore` contract (threadDrawer._placeInsertGap) requires the
   * flat child list, and a wrapper would silently put the drop gap in the
   * wrong parent.
   */
  readonly grouped?: {
    readonly sections: ReadonlyArray<{
      readonly agentName: string | null
      readonly label: string
      readonly description: string
      readonly known: boolean
      readonly rows: ReadonlyArray<ThreadRow>
      readonly collapsed: boolean
      /** Any non-active row in the section has work in flight — surfaces
       *  the busy pulse on the header while collapsed. */
      readonly busy: boolean
    }>
    readonly onToggle: (agentName: string | null) => void
    /** The header's "+" — mints a thread pre-filed to this agent. Known
     *  roster agents only (never general/orphans). */
    readonly onNewThread: (agentName: string) => void
  }
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

  // Search-mode agent tag (S5): grouping is suspended, so the row wears its
  // section. textContent only — agent names are server data.
  if (ctx.tagAgents && t.agentName) {
    const tag = document.createElement("span")
    tag.className = "thread-row-agent-tag"
    tag.textContent = t.agentName
    const info = row.querySelector(".thread-row-info")
    if (info) info.appendChild(tag)
  }

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

/** Static skeleton for a nested subagent row. Same discipline as
 *  ROW_SKELETON: constant markup, every scrap of text via textContent. */
const AGENT_ROW_SKELETON =
  '<span class="thread-agent-branch" aria-hidden="true">↳</span>' +
  '<span class="thread-agent-dot" aria-hidden="true"></span>' +
  '<span class="thread-agent-info">' +
  '<span class="thread-agent-name"></span>' +
  '<span class="thread-agent-tool"></span>' +
  "</span>"

/** One live subagent, rendered as a sibling row under its thread.
 *
 *  NOT focusable and NOT wired for drag: a subagent is a live readout, not a
 *  thread you can open, pop out, or pull into a window. Leaving it out of the
 *  tab order also keeps arrow/tab navigation over the thread list unchanged. */
export function buildAgentRow(entry: LiveAgentRow): HTMLElement {
  const node = entry.node
  const el = document.createElement("div")
  el.className = `thread-agent-row depth-${entry.depth} status-${node.status}`
  el.setAttribute("role", "listitem")
  el.dataset["agentId"] = node.id
  el.dataset["status"] = node.status
  el.innerHTML = AGENT_ROW_SKELETON

  const name = el.querySelector(".thread-agent-name")
  // A spawn with no subagent_type reports as "Agent" from the bridge; the
  // description is what makes it legible, so it is the subtitle, not a
  // tooltip only.
  if (name) name.textContent = (node.name && String(node.name).trim()) || "Agent"

  const tool = el.querySelector(".thread-agent-tool")
  if (tool) {
    const running = node.status === "running"
    // While running, the CURRENT tool is the useful thing to show; once it
    // stops, the tool it happened to end on is noise, so the outcome wins.
    const label = running
      ? node.tool || (node.description && String(node.description).trim()) || "working…"
      : node.status === "error"
        ? "failed"
        : "done"
    tool.textContent =
      running && node.toolCount > 1 ? `${label} · ${node.toolCount} tools` : label
  }

  if (node.description) el.title = String(node.description)
  el.setAttribute("aria-label", `${node.name || "Agent"} — ${node.status}`)
  return el
}

/** Append a thread's live subagents directly after its row. No-op when the
 *  caller supplied no `agentRowsFor` or the thread has none in flight. */
function appendAgentRows(ctx: ThreadStripCtx, threadId: string, frag: DocumentFragment): void {
  if (!ctx.agentRowsFor) return
  let entries: readonly LiveAgentRow[]
  try {
    entries = ctx.agentRowsFor(threadId) || []
  } catch {
    // A live readout must never be able to take the thread list down with
    // it — the drawer is the primary navigation surface.
    return
  }
  for (const entry of entries) {
    if (entry && entry.node) frag.appendChild(buildAgentRow(entry))
  }
}

/** Repaint the strip wholesale. Ported 1:1 from `ThreadDrawerEngine.render`'s
 *  body, minus the mid-drag guard, which stays with the caller because it also
 *  sets the deferred-repaint flag. */
export function renderThreadStrip(ctx: ThreadStripCtx): void {
  const listEl = ctx.listEl
  if (!listEl) return

  // Drop existing rows, gaps, and section headers; the empty-state node is
  // left in place.
  listEl
    .querySelectorAll(
      ".thread-row, .thread-agent-row, .thread-row-insert-gap, .thread-section-header",
    )
    .forEach((n) => {
      n.remove()
    })

  const hasContent = ctx.grouped ? ctx.grouped.sections.length > 0 : ctx.rows.length > 0
  if (ctx.emptyEl) {
    ctx.emptyEl.style.display = hasContent ? "none" : ""
    ctx.emptyEl.textContent = (ctx.search || "").trim() ? "No matching threads." : "No threads yet."
  }

  const preview = ctx.preview
  const frag = document.createDocumentFragment()

  if (ctx.grouped) {
    // Grouped path (S5). Reorder is retired, so the redock insert-gap is a
    // purely visual "this drops here" affordance pinned to the top — the
    // drop lands by recency wherever the thread's section sorts it.
    if (preview && preview.over) frag.appendChild(ctx.makeInsertGap(preview))
    for (const section of ctx.grouped.sections) {
      frag.appendChild(buildSectionHeader(ctx.grouped, section))
      if (section.collapsed) continue
      for (const t of section.rows) {
        const row = buildThreadRow(ctx, t)
        row.classList.add("grouped")
        if (preview && preview.threadId && t.id === preview.threadId) {
          row.classList.add("redock-source")
        }
        frag.appendChild(row)
        appendAgentRows(ctx, t.id, frag)
      }
    }
  } else {
    for (let i = 0; i < ctx.rows.length; i++) {
      if (i === ctx.insertAt) frag.appendChild(ctx.makeInsertGap(preview))
      const t = ctx.rows[i]
      if (!t) continue
      const row = buildThreadRow(ctx, t)
      if (preview && preview.threadId && t.id === preview.threadId) {
        row.classList.add("redock-source")
      }
      frag.appendChild(row)
      appendAgentRows(ctx, t.id, frag)
    }
    // A drop past the last row appends the gap at the end.
    if (ctx.insertAt === ctx.rows.length) frag.appendChild(ctx.makeInsertGap(preview))
  }

  listEl.appendChild(frag)

  if (ctx.drawerEl) {
    ctx.drawerEl.classList.toggle("redock-target", !!(preview && preview.over))
  }
}

/** Static header skeleton — icons only, no interpolation (same discipline
 *  as ROW_SKELETON: all text lands via textContent). */
const SECTION_SKELETON =
  '<span class="thread-section-caret" aria-hidden="true">▾</span>' +
  '<span class="thread-section-dot" aria-hidden="true"></span>' +
  '<span class="thread-section-name"></span>' +
  '<span class="thread-section-count" aria-hidden="true"></span>'

/** Build one section header, a SIBLING of the rows it labels (see the
 *  grouped ctx doc for why nesting is forbidden). */
function buildSectionHeader(
  grouped: NonNullable<ThreadStripCtx["grouped"]>,
  section: NonNullable<ThreadStripCtx["grouped"]>["sections"][number],
): HTMLElement {
  const el = document.createElement("div")
  el.className = "thread-section-header"
  el.setAttribute("role", "button")
  el.tabIndex = 0
  el.setAttribute("aria-expanded", section.collapsed ? "false" : "true")
  if (section.agentName !== null) el.dataset["agentName"] = section.agentName
  el.innerHTML = SECTION_SKELETON

  const name = el.querySelector(".thread-section-name")
  if (name) name.textContent = section.label
  if (section.description) el.title = section.description
  const count = el.querySelector(".thread-section-count")
  if (count) count.textContent = String(section.rows.length)
  const caret = el.querySelector(".thread-section-caret") as HTMLElement | null
  // Nothing to collapse in an empty section — hide the affordance.
  if (caret && section.rows.length === 0) caret.style.visibility = "hidden"
  const dot = el.querySelector(".thread-section-dot")
  // Collapsed + busy inside: the header carries the pulse the hidden row
  // cannot show. (Expanded sections let the rows pulse for themselves.)
  if (dot && section.busy && section.collapsed) dot.classList.add("busy")
  if (!section.known) el.classList.add("orphan")

  const toggle = () => {
    if (section.rows.length === 0) return
    grouped.onToggle(section.agentName)
  }
  el.addEventListener("click", toggle)
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault()
      toggle()
    }
  })

  // The per-section "+" — known roster agents only: the general section's
  // new-thread is the drawer's existing "+ New", and an orphan can no
  // longer be created under (its definition is gone).
  if (section.known && section.agentName !== null) {
    const agentName = section.agentName
    const add = document.createElement("button")
    add.type = "button"
    add.className = "thread-section-new"
    add.title = `New ${section.label} thread`
    add.setAttribute("aria-label", `New ${section.label} thread`)
    add.textContent = "+"
    // Same guard as the row's ⤢: never let the button start the header's
    // click/toggle or a drag.
    add.addEventListener("pointerdown", (e) => e.stopPropagation())
    add.addEventListener("click", (e) => {
      e.stopPropagation()
      grouped.onNewThread(agentName)
    })
    el.appendChild(add)
  }
  return el
}
