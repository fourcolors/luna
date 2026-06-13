/**
 * createBoard — the Luna Studio window manager, ported to Solid from the
 * "Luna Workspace" design handoff's luna-app.jsx (the reference
 * implementation lives at ~/Downloads/Brainstorm/project/luna-app.jsx).
 *
 * One canvas, free-floating panels:
 *   - drag by the panel head; edges magnetically snap to siblings + canvas
 *     margins with dashed guides (computeSnap/snapAxis are verbatim ports)
 *   - resize from the corner; minimize rolls a panel up to its title bar
 *   - closed panels collect as shelf chips in the topbar
 *   - board mode = the tidy default; stickies mode adds a hand-placed tilt
 *     and edge-to-edge PINNING — pinned panels straighten and drag as one
 *     group (groupOf/detectPins ported)
 *   - favorites: star a panel to keep it in the favorites grid
 *
 * Layout, mode, and favorites persist to localStorage (luna_board_v1) and
 * restore clamped to the current canvas size.
 *
 * Coordinates are CANVAS-relative (the .board element), not viewport.
 */
import { batch, createSignal } from "solid-js"
import { createStore, produce } from "solid-js/store"

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

export interface Pin {
  a: string
  b: string
}

export interface Guide {
  type: "v" | "h"
  at: number
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

interface SnapCandidate {
  pos: number
  line: number
}

const snapAxis = (
  raw: number,
  candidates: SnapCandidate[],
  thresh: number,
): (SnapCandidate & { d: number }) | null => {
  let best: (SnapCandidate & { d: number }) | null = null
  for (const c of candidates) {
    const d = Math.abs(raw - c.pos)
    if (d <= thresh && (best === null || d < best.d)) best = { ...c, d }
  }
  return best
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
  const [guides, setGuides] = createSignal<Guide[]>([])
  const [snappedId, setSnappedId] = createSignal<string | null>(null)
  const [dragId, setDragId] = createSignal<string | null>(null)
  const [mode, setModeSignal] = createSignal<BoardMode>(
    persisted?.mode === "stickies" ? "stickies" : "board",
  )
  const [favs, setFavs] = createSignal<string[]>(
    Array.isArray(persisted?.favs) ? persisted.favs.filter((f) => typeof f === "string") : [],
  )
  const [pins, setPins] = createSignal<Pin[]>([])

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

  /* ---------- magnetic snapping (verbatim port) ---------- */
  const computeSnap = (
    id: string,
    rx: number,
    ry: number,
    w: number,
    h: number,
    exclude?: string[],
  ): { x: number; y: number; guides: Guide[]; snapped: boolean } => {
    const skip = exclude ?? [id]
    const { vw, vh } = canvasSize()
    const candX: SnapCandidate[] = [
      { pos: EDGE_MARGIN, line: EDGE_MARGIN },
      { pos: vw - w - EDGE_MARGIN, line: vw - EDGE_MARGIN },
    ]
    const candY: SnapCandidate[] = [
      { pos: TOP_MIN, line: TOP_MIN },
      { pos: vh - h - EDGE_MARGIN, line: vh - EDGE_MARGIN },
    ]
    for (const p of panels) {
      if (skip.includes(p.id) || p.closed) continue
      const ph = p.min ? HEAD_H : p.h
      candX.push(
        { pos: p.x, line: p.x },
        { pos: p.x + p.w - w, line: p.x + p.w },
        { pos: p.x + p.w + SNAP_GAP, line: p.x + p.w + SNAP_GAP / 2 },
        { pos: p.x - w - SNAP_GAP, line: p.x - SNAP_GAP / 2 },
      )
      candY.push(
        { pos: p.y, line: p.y },
        { pos: p.y + ph - h, line: p.y + ph },
        { pos: p.y + ph + SNAP_GAP, line: p.y + ph + SNAP_GAP / 2 },
        { pos: p.y - h - SNAP_GAP, line: p.y - SNAP_GAP / 2 },
      )
    }
    const sx = thresh > 0 ? snapAxis(rx, candX, thresh) : null
    const sy = thresh > 0 ? snapAxis(ry, candY, thresh) : null
    const g: Guide[] = []
    if (sx) g.push({ type: "v", at: sx.line })
    if (sy) g.push({ type: "h", at: sy.line })
    return { x: sx ? sx.pos : rx, y: sy ? sy.pos : ry, guides: g, snapped: sx !== null || sy !== null }
  }

  /* ---------- pinning (stickies mode; verbatim port) ---------- */
  const groupOf = (id: string): string[] => {
    const open = new Set(panels.filter((p) => !p.closed).map((p) => p.id))
    const adj: Record<string, string[]> = {}
    for (const pin of pins()) {
      if (!open.has(pin.a) || !open.has(pin.b)) continue
      ;(adj[pin.a] = adj[pin.a] ?? []).push(pin.b)
      ;(adj[pin.b] = adj[pin.b] ?? []).push(pin.a)
    }
    const seen = new Set([id])
    const stack = [id]
    while (stack.length > 0) {
      const cur = stack.pop()!
      for (const nb of adj[cur] ?? []) {
        if (!seen.has(nb)) {
          seen.add(nb)
          stack.push(nb)
        }
      }
    }
    return [...seen]
  }

  const detectPins = (id: string, group: string[]): string[] => {
    const open = panels.filter((p) => !p.closed)
    const a = open.find((p) => p.id === id)
    if (!a) return []
    const tol = 3
    const out: string[] = []
    for (const b of open) {
      if (group.includes(b.id)) continue
      const vOv = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
      const hOv = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
      const sideBySide =
        vOv > 36 &&
        (Math.abs(a.x + a.w + SNAP_GAP - b.x) <= tol || Math.abs(b.x + b.w + SNAP_GAP - a.x) <= tol)
      const stacked =
        hOv > 36 &&
        (Math.abs(a.y + a.h + SNAP_GAP - b.y) <= tol || Math.abs(b.y + b.h + SNAP_GAP - a.y) <= tol)
      if (sideBySide || stacked) out.push(b.id)
    }
    return out
  }

  const unpin = (pin: Pin): void => {
    setPins((ps) => ps.filter((p) => p !== pin))
  }

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
    group: string[]
    origins: Record<string, { x: number; y: number }>
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
      const res = computeSnap(d.id, d.ox + dx, d.oy + dy, p.w, p.min ? HEAD_H : p.h, d.group)
      batch(() => {
        setGuides(res.guides)
        setSnappedId(res.snapped ? d.id : null)
        const fdx = res.x - d.ox
        const fdy = res.y - d.oy
        setPanels(
          produce((ps) => {
            for (const q of ps) {
              if (q.id === d.id) {
                q.x = res.x
                q.y = res.y
              } else if (d.group.includes(q.id)) {
                q.x = d.origins[q.id]!.x + fdx
                q.y = d.origins[q.id]!.y + fdy
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
    setGuides([])
    window.removeEventListener("pointermove", onPointerMove)
    window.removeEventListener("pointerup", onPointerUp)
  }

  const onPointerUp = (): void => {
    const d = drag
    if (d && d.dragMode === "move" && mode() === "stickies") {
      const mates = detectPins(d.id, d.group)
      if (mates.length > 0) {
        setPins((prev) => {
          const next = [...prev]
          for (const b of mates) {
            if (!next.some((pn) => (pn.a === d.id && pn.b === b) || (pn.a === b && pn.b === d.id))) {
              next.push({ a: d.id, b })
            }
          }
          return next
        })
      }
    }
    cancelDrag()
    setTimeout(() => setSnappedId(null), 250)
    persistSoon()
  }

  const startDrag = (e: PointerEvent, id: string, dragMode: "move" | "resize"): void => {
    if (e.button !== 0) return
    e.preventDefault()
    const p = panels[idx(id)]
    if (!p) return
    const group = dragMode === "move" && mode() === "stickies" ? groupOf(id) : [id]
    const origins: Record<string, { x: number; y: number }> = {}
    for (const q of panels) {
      if (group.includes(q.id)) origins[q.id] = { x: q.x, y: q.y }
    }
    drag = {
      id,
      dragMode,
      startX: e.clientX,
      startY: e.clientY,
      ox: p.x,
      oy: p.y,
      ow: p.w,
      oh: p.h,
      group,
      origins,
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
    if (m === "board") setPins([])
    persistSoon()
  }

  /* ---------- pin badge geometry (verbatim port) ---------- */
  const pinBadges = (): Array<{ pin: Pin; x: number; y: number; z: number }> => {
    if (mode() !== "stickies") return []
    const out: Array<{ pin: Pin; x: number; y: number; z: number }> = []
    for (const pin of pins()) {
      const a = panels.find((p) => p.id === pin.a && !p.closed)
      const b = panels.find((p) => p.id === pin.b && !p.closed)
      if (!a || !b) continue
      let x: number
      let y: number
      if (Math.abs(a.x + a.w + SNAP_GAP - b.x) < 26) {
        x = a.x + a.w + SNAP_GAP / 2
        y = (Math.max(a.y, b.y) + Math.min(a.y + a.h, b.y + b.h)) / 2
      } else if (Math.abs(b.x + b.w + SNAP_GAP - a.x) < 26) {
        x = b.x + b.w + SNAP_GAP / 2
        y = (Math.max(a.y, b.y) + Math.min(a.y + a.h, b.y + b.h)) / 2
      } else if (Math.abs(a.y + a.h + SNAP_GAP - b.y) < 26) {
        y = a.y + a.h + SNAP_GAP / 2
        x = (Math.max(a.x, b.x) + Math.min(a.x + a.w, b.x + b.w)) / 2
      } else if (Math.abs(b.y + b.h + SNAP_GAP - a.y) < 26) {
        y = b.y + b.h + SNAP_GAP / 2
        x = (Math.max(a.x, b.x) + Math.min(a.x + a.w, b.x + b.w)) / 2
      } else {
        x = (a.x + a.w / 2 + b.x + b.w / 2) / 2
        y = (a.y + a.h / 2 + b.y + b.h / 2) / 2
      }
      out.push({ pin, x, y, z: Math.max(a.z, b.z) + 1 })
    }
    return out
  }

  const pinnedIds = (): Set<string> => {
    const out = new Set<string>()
    if (mode() !== "stickies") return out
    for (const pin of pins()) {
      out.add(pin.a)
      out.add(pin.b)
    }
    return out
  }

  return {
    panels,
    guides,
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
    unpin,
    pinBadges,
    pinnedIds,
  }
}

export type Board = ReturnType<typeof createBoard>
