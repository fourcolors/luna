/**
 * createBoard — the Luna Studio window manager, ported to Solid from the
 * "Luna Workspace" design handoff's luna-app.jsx, with its snap model swapped
 * to the Luna Dock / Moon Deck reference (mirrors
 * apps/ui-moon-tauri/frontend/vendor/deck-snap.js → LunaDeckSnap, reimplemented
 * in ./snap.ts since the two packages share no module system).
 *
 * One canvas, free-floating panels:
 *   - drag by the panel head; the panel clicks FLUSH at a shared CORNER of a
 *     sibling — both axes pinned — nearest within a magnet threshold
 *     (computeSnap/computeLiveDrag in ./snap.ts). No alignment guides.
 *   - resize from the corner; minimize rolls a panel up to its title bar
 *   - closed panels collect as shelf chips in the topbar
 *   - EMERGENT welding: a cluster is whatever is flush RIGHT NOW (weldClusterOf
 *     over the live rects — no recorded pins). Dragging a member tows its whole
 *     welded cluster by a uniform delta. Board mode = the tidy default;
 *     stickies mode adds a hand-placed tilt.
 *   - favorites: star a panel to keep it in the favorites grid
 *
 * Layout, mode, and favorites persist to localStorage (luna_board_v1) and
 * restore clamped to the current canvas size. Pins were never persisted, so
 * old saved state loads unchanged.
 *
 * Coordinates are CANVAS-relative (the .board element), not viewport.
 */
import { batch, createSignal } from "solid-js"
import { createStore, produce } from "solid-js/store"
import {
  computeLiveDrag,
  weldClusterOf,
  type Candidate,
  type LiveDragMember,
  type Member,
} from "./snap.js"

export const SNAP_GAP = 16
export const EDGE_MARGIN = 16
export const TOP_MIN = 8
export const HEAD_H = 36

export type BoardMode = "board" | "stickies"

export interface PanelRect {
  x: number
  y: number
  w: number
  h: number
}

export interface PanelState extends PanelRect {
  id: string
  z: number
  closed: boolean
  min: boolean
  entering: boolean
}

interface PersistedPanel extends PanelRect {
  closed: boolean
  min: boolean
}

interface PersistedBoard {
  layout: Record<string, PersistedPanel>
  mode: BoardMode
  favs: string[]
}

const STORAGE_KEY = "luna_board_v1"

/** Deterministic hand-placed tilt per panel id (stickies mode). */
export const tiltFor = (id: string): number => {
  let h = 0
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 997
  return ((h % 5) - 2) * 0.6
}

const loadPersisted = (): PersistedBoard | null => {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null) return null
    const parsed = JSON.parse(raw) as PersistedBoard
    if (typeof parsed !== "object" || parsed === null) return null
    return parsed
  } catch {
    return null
  }
}

export interface BoardOptions {
  /** Default rects, computed against the live canvas size. */
  defaults: (vw: number, vh: number) => Record<string, PersistedPanel>
  /** Snap magnet strength in px (design default 30). */
  snapThreshold?: number
}

export const createBoard = (opts: BoardOptions) => {
  const persisted = loadPersisted()

  const [panels, setPanels] = createStore<PanelState[]>([])
  // Live "is the dragged panel currently corner-snapped" flag — set to the
  // dragged id while a flush snap is active (drives .panel.snapped), null
  // otherwise. Replaces the old gap-snap guide state.
  const [snappedId, setSnappedId] = createSignal<string | null>(null)
  const [dragId, setDragId] = createSignal<string | null>(null)
  const [mode, setModeSignal] = createSignal<BoardMode>(
    persisted?.mode === "stickies" ? "stickies" : "board",
  )
  const [favs, setFavs] = createSignal<string[]>(
    Array.isArray(persisted?.favs) ? persisted.favs.filter((f) => typeof f === "string") : [],
  )

  let canvasEl: HTMLElement | null = null
  let zTop = 10
  const thresh = opts.snapThreshold ?? 30

  const canvasSize = (): { vw: number; vh: number } => {
    if (canvasEl) return { vw: canvasEl.clientWidth, vh: canvasEl.clientHeight }
    return { vw: window.innerWidth, vh: window.innerHeight - 60 }
  }

  // NOTE: z-order is deliberately NOT persisted — on reload, panels restack
  // in sync order. Rect/closed/min state is what matters across sessions;
  // stacking is one click away (the design reference persisted nothing).
  const persist = (): void => {
    try {
      const layout: Record<string, PersistedPanel> = {}
      for (const p of panels) {
        layout[p.id] = { x: p.x, y: p.y, w: p.w, h: p.h, closed: p.closed, min: p.min }
      }
      const out: PersistedBoard = { layout, mode: mode(), favs: favs() }
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(out))
    } catch {
      /* storage unavailable — layout just won't survive reload */
    }
  }

  let persistTimer: ReturnType<typeof setTimeout> | null = null
  const persistSoon = (): void => {
    if (persistTimer !== null) clearTimeout(persistTimer)
    persistTimer = setTimeout(persist, 250)
  }

  const attach = (el: HTMLElement): void => {
    canvasEl = el
  }

  /**
   * Reconcile the panel set against the ids the app wants on the board
   * right now (capability-gated ids come and go after the hello frame).
   * Ids already on the board KEEP their live state; new ids take their
   * saved rect if one exists, else the provided default; ids no longer
   * wanted are dropped. Rects are clamped so a panel saved on a big
   * monitor stays reachable on a laptop.
   */
  let syncRetries = 0
  const sync = (ids: string[]): void => {
    const { vw, vh } = canvasSize()
    // In dev, JS-injected stylesheets can land a frame after onMount — the
    // canvas then measures ~0 and every default rect collapses to minimums.
    // Wait for a real measurement before laying out (a few frames max).
    if ((vw < 100 || vh < 100) && syncRetries < 20) {
      syncRetries += 1
      requestAnimationFrame(() => sync(ids))
      return
    }
    const defaults = opts.defaults(vw, vh)
    const saved = persisted?.layout ?? {}
    const existing = new Map(panels.map((p) => [p.id, p]))
    const next: PanelState[] = []
    let changed = false
    for (const id of ids) {
      const live = existing.get(id)
      if (live) {
        next.push(live)
        continue
      }
      const base = saved[id] ?? defaults[id]
      if (!base) continue
      changed = true
      const w = Math.max(190, Math.min(base.w, vw - EDGE_MARGIN * 2))
      const h = Math.max(130, Math.min(base.h, vh - TOP_MIN - EDGE_MARGIN))
      next.push({
        id,
        x: Math.min(Math.max(base.x, EDGE_MARGIN - w + 60), Math.max(EDGE_MARGIN, vw - 60)),
        y: Math.min(Math.max(base.y, TOP_MIN), Math.max(TOP_MIN, vh - HEAD_H)),
        w,
        h,
        z: ++zTop,
        closed: base.closed,
        min: base.min,
        entering: false,
      })
    }
    if (changed || next.length !== panels.length) setPanels(next)
  }

  const idx = (id: string): number => panels.findIndex((p) => p.id === id)

  const bringToFront = (id: string): void => {
    const i = idx(id)
    if (i === -1) return
    zTop += 1
    setPanels(i, "z", zTop)
  }

  /* ---------- emergent welding ---------- */
  // The live rect of an open panel (minimized panels are head-height only).
  const memberRect = (p: PanelState): Member => ({
    label: p.id,
    rect: { x: p.x, y: p.y, w: p.w, h: p.min ? HEAD_H : p.h },
  })
  // Every OPEN panel as a weld member — the substrate for cluster detection.
  const openMembers = (): Member[] => panels.filter((p) => !p.closed).map(memberRect)

  /* ---------- drag / resize ---------- */
  interface DragState {
    id: string
    dragMode: "move" | "resize"
    startX: number
    startY: number
    ox: number
    oy: number
    ow: number
    oh: number
    /** Panels towed with this drag (the live weld cluster, incl. self). */
    cluster: Set<string>
    /** Each towed panel's origin, captured at drag start. */
    members: LiveDragMember[]
  }
  let drag: DragState | null = null

  const onPointerMove = (e: PointerEvent): void => {
    const d = drag
    if (!d) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    if (d.dragMode === "move") {
      const p = panels[idx(d.id)]
      if (!p) return
      // Candidates = open panels NOT in the towed cluster. Snap the lead panel
      // flush at a sibling corner, then tow the whole cluster by that delta.
      const candidates: Candidate[] = thresh > 0
        ? panels
            .filter((q) => !q.closed && !d.cluster.has(q.id))
            .map((q) => ({ label: q.id, rect: { x: q.x, y: q.y, w: q.w, h: q.min ? HEAD_H : q.h } }))
        : []
      const res = computeLiveDrag(
        { ox: d.ox, oy: d.oy, ow: p.w, oh: p.min ? HEAD_H : p.h, dx, dy, members: d.members },
        candidates,
        thresh,
      )
      batch(() => {
        setSnappedId(res.snapped ? d.id : null)
        const by = new Map(res.targets.map((t) => [t.label, t]))
        setPanels(
          produce((ps) => {
            for (const q of ps) {
              const t = by.get(q.id)
              if (t) {
                q.x = t.x
                q.y = t.y
              }
            }
          }),
        )
      })
    } else {
      const w = Math.max(190, d.ow + dx)
      const h = Math.max(130, d.oh + dy)
      const i = idx(d.id)
      if (i !== -1) {
        batch(() => {
          setPanels(i, "w", w)
          setPanels(i, "h", h)
        })
      }
    }
  }

  /** Abort an in-flight drag and drop the window listeners. Idempotent —
   *  Board calls this from onCleanup so an unmount mid-drag can't leak
   *  pointermove/pointerup listeners on window. */
  const cancelDrag = (): void => {
    drag = null
    setDragId(null)
    window.removeEventListener("pointermove", onPointerMove)
    window.removeEventListener("pointerup", onPointerUp)
  }

  const onPointerUp = (): void => {
    // Welding is emergent — a panel that lands flush IS welded on the next
    // drag (weldClusterOf reads the live rects), so there is nothing to record.
    cancelDrag()
    setTimeout(() => setSnappedId(null), 250)
    persistSoon()
  }

  const startDrag = (e: PointerEvent, id: string, dragMode: "move" | "resize"): void => {
    if (e.button !== 0) return
    e.preventDefault()
    const p = panels[idx(id)]
    if (!p) return
    // Emergent weld cluster: whatever is flush with the grabbed panel RIGHT NOW
    // tows with it. Applies in BOTH board and stickies modes (matches Moon).
    const cluster =
      dragMode === "move" ? weldClusterOf(id, openMembers()) : [id]
    const clusterSet = new Set(cluster)
    const members: LiveDragMember[] = panels
      .filter((q) => clusterSet.has(q.id))
      .map((q) => ({ label: q.id, ox: q.x, oy: q.y }))
    drag = {
      id,
      dragMode,
      startX: e.clientX,
      startY: e.clientY,
      ox: p.x,
      oy: p.y,
      ow: p.w,
      oh: p.h,
      cluster: clusterSet,
      members,
    }
    bringToFront(id)
    setDragId(id)
    window.addEventListener("pointermove", onPointerMove)
    window.addEventListener("pointerup", onPointerUp)
  }

  /* ---------- open / close / restore ---------- */
  const close = (id: string): void => {
    const i = idx(id)
    if (i !== -1) setPanels(i, "closed", true)
    persistSoon()
  }

  const toggleMin = (id: string): void => {
    const i = idx(id)
    if (i !== -1) setPanels(i, "min", (m) => !m)
    persistSoon()
  }

  const restore = (id: string): void => {
    const i = idx(id)
    if (i === -1) return
    zTop += 1
    batch(() => {
      setPanels(i, { closed: false, entering: true, z: zTop })
    })
    setTimeout(() => {
      const j = idx(id)
      if (j !== -1) setPanels(j, "entering", false)
    }, 750)
    persistSoon()
  }

  /** Open-or-focus: shelf chips, favorites cards, and "open settings". */
  const summon = (id: string): void => {
    const p = panels[idx(id)]
    if (!p) return
    if (p.closed) restore(id)
    else bringToFront(id)
  }

  const toggleFav = (id: string): void => {
    setFavs((fs) => (fs.includes(id) ? fs.filter((f) => f !== id) : [...fs, id]))
    persistSoon()
  }

  const setMode = (m: BoardMode): void => {
    setModeSignal(m)
    persistSoon()
  }

  return {
    panels,
    snappedId,
    dragId,
    mode,
    favs,
    attach,
    sync,
    startDrag,
    cancelDrag,
    close,
    restore,
    summon,
    toggleMin,
    toggleFav,
    bringToFront,
    setMode,
  }
}

export type Board = ReturnType<typeof createBoard>
