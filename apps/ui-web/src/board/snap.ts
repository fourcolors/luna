/**
 * snap.ts — WinAmp-style FLUSH corner-weld snap math + emergent welding for
 * the Luna Studio board. A pure, side-effect-free 1:1 TypeScript reimpl of the
 * Moon Deck's vendor module
 * (apps/ui-moon-tauri/frontend/vendor/deck-snap.js → LunaDeckSnap). The two
 * packages share no module system, so the algorithm is MIRRORED here rather
 * than imported; the math is verbatim so the board and the Moon dock behave
 * identically (and so it can be unit-tested under ui-web's node-only vitest).
 *
 * A dragged panel clicks into one of 8 fully-specified tile positions flush at
 * a SHARED CORNER of an anchor — BOTH axes pinned — chosen by nearest 2D
 * distance, within a magnet threshold. That corner-aligns docked panels into a
 * clean stack/grid instead of merely flushing the contact edge (which leaves
 * the perpendicular axis ragged).
 *
 * EMERGENT welding: a "cluster" is whatever is flush right now (rectsTouch /
 * weldComponents / weldClusterOf) — there is no recorded pin graph. Dragging a
 * member tows its whole live cluster by a uniform delta (computeLiveDrag).
 *
 * All rects are { x, y, w, h } in the SAME coordinate space (canvas px).
 */

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Snap {
  x: number
  y: number
  edge: "l" | "r" | "t" | "b"
}

export interface Member {
  label: string
  rect: Rect
}

export interface LiveDragMember {
  label: string
  ox: number
  oy: number
}

export interface LiveDrag {
  ox: number
  oy: number
  ow: number
  oh: number
  dx: number
  dy: number
  members: LiveDragMember[]
}

export interface Candidate {
  label: string
  rect: Rect
}

export interface LiveDragResult {
  targets: Array<{ label: string; x: number; y: number }>
  snapped: boolean
  anchor: string | null
  edge: Snap["edge"] | null
}

/** px — matches the Luna Dock design file's SNAP=30. */
export const SNAP_THRESHOLD = 30
/** flush tolerance (matches Rust EPS). */
export const WELD_EPS = 2
/** perpendicular overlap that counts as adjacency. */
export const WELD_MIN_OVERLAP = 8
/** probe inset from a corner along each meeting edge. */
export const WELD_IN = 6

interface SnapCandidate {
  edge: Snap["edge"]
  x: number
  y: number
}

/**
 * computeSnap — the 8 corner-aligned candidate positions (both axes pinned),
 * nearest by 2D distance from where the widget is dropped, within `threshold`.
 * `edge` = which side of the anchor the widget lands on. Returns the snapped
 * top-left (rounded) or null when no corner-aligned tile is within threshold.
 */
export const computeSnap = (
  anchor: Rect,
  widget: Rect,
  threshold: number = SNAP_THRESHOLD,
): Snap | null => {
  const ax = anchor.x
  const ay = anchor.y
  const aw = anchor.w
  const ah = anchor.h
  const ww = widget.w
  const wh = widget.h

  // Order + geometry match deck-snap.js's candidate list exactly.
  const cands: SnapCandidate[] = [
    { edge: "b", x: ax, y: ay + ah }, //            below · left-aligned
    { edge: "b", x: ax + aw - ww, y: ay + ah }, //  below · right-aligned
    { edge: "t", x: ax, y: ay - wh }, //            above · left-aligned
    { edge: "t", x: ax + aw - ww, y: ay - wh }, //  above · right-aligned
    { edge: "r", x: ax + aw, y: ay }, //            right · top-aligned
    { edge: "r", x: ax + aw, y: ay + ah - wh }, //  right · bottom-aligned
    { edge: "l", x: ax - ww, y: ay }, //            left  · top-aligned
    { edge: "l", x: ax - ww, y: ay + ah - wh }, //  left  · bottom-aligned
  ]

  let best: { x: number; y: number; edge: Snap["edge"]; d: number } | null = null
  for (const c of cands) {
    const d = Math.hypot(widget.x - c.x, widget.y - c.y)
    if (d <= threshold && (best === null || d < best.d)) {
      best = { x: c.x, y: c.y, edge: c.edge, d }
    }
  }
  if (!best) return null
  return { x: Math.round(best.x), y: Math.round(best.y), edge: best.edge }
}

/**
 * computeLiveDrag — the LIVE drag step. Apply the magnetic snap to the dragged
 * panel's LEAD position, then translate the WHOLE drag cluster by that same
 * delta so the cluster moves as one (1:1). Pure — the caller performs the
 * per-panel setPosition each pointermove frame.
 *   drag.members = every panel that travels with this drag (incl. itself),
 *                  each with its OWN origin.
 *   candidates   = panels NOT in the drag cluster.
 */
export const computeLiveDrag = (
  drag: LiveDrag,
  candidates: Candidate[],
  threshold: number = SNAP_THRESHOLD,
): LiveDragResult => {
  const lead: Rect = { x: drag.ox + drag.dx, y: drag.oy + drag.dy, w: drag.ow, h: drag.oh }
  let best: { x: number; y: number; edge: Snap["edge"]; label: string; d: number } | null = null
  for (const cand of candidates) {
    const s = computeSnap(cand.rect, lead, threshold)
    if (!s) continue
    const d = Math.hypot(s.x - lead.x, s.y - lead.y)
    if (best === null || d < best.d) {
      best = { x: s.x, y: s.y, edge: s.edge, label: cand.label, d }
    }
  }
  const tx = best ? best.x : lead.x
  const ty = best ? best.y : lead.y
  const fdx = tx - drag.ox
  const fdy = ty - drag.oy
  const targets: Array<{ label: string; x: number; y: number }> = []
  for (const m of drag.members) {
    targets.push({ label: m.label, x: m.ox + fdx, y: m.oy + fdy })
  }
  return {
    targets,
    snapped: best !== null,
    anchor: best ? best.label : null,
    edge: best ? best.edge : null,
  }
}

// ── Emergent welding geometry ────────────────────────────────────────────
// Cluster membership, the perimeter (free) sides, and the corners to square at
// an interior seam are all derivable from sibling rects — no central group
// graph, no IPC. Ported 1:1 from deck-snap.js (same constants).

/**
 * Two rects are welded when an edge is flush (≤EPS) AND they overlap on the
 * perpendicular axis (≥MIN_OVERLAP).
 */
export const rectsTouch = (a: Rect, b: Rect): boolean => {
  const al = a.x
  const at = a.y
  const ar = a.x + a.w
  const ab = a.y + a.h
  const bl = b.x
  const bt = b.y
  const br = b.x + b.w
  const bb = b.y + b.h
  const vOverlap = Math.min(ab, bb) - Math.max(at, bt) >= WELD_MIN_OVERLAP
  const hOverlap = Math.min(ar, br) - Math.max(al, bl) >= WELD_MIN_OVERLAP
  return (
    (vOverlap && (Math.abs(al - br) <= WELD_EPS || Math.abs(ar - bl) <= WELD_EPS)) ||
    (hOverlap && (Math.abs(at - bb) <= WELD_EPS || Math.abs(ab - bt) <= WELD_EPS))
  )
}

/** Flood-fill connected components over rectsTouch → array of label arrays. */
export const weldComponents = (members: Member[]): string[][] => {
  const n = members.length
  const seen: boolean[] = new Array(n).fill(false)
  const out: string[][] = []
  for (let s = 0; s < n; s++) {
    if (seen[s]) continue
    const comp: string[] = []
    const stack: number[] = [s]
    seen[s] = true
    while (stack.length) {
      const i = stack.pop()
      if (i === undefined) break
      const mi = members[i]
      if (!mi) continue
      comp.push(mi.label)
      for (let j = 0; j < n; j++) {
        const mj = members[j]
        if (!seen[j] && mj && rectsTouch(mi.rect, mj.rect)) {
          seen[j] = true
          stack.push(j)
        }
      }
    }
    out.push(comp)
  }
  return out
}

/** Every label transitively welded to `label` (its cluster), including itself. */
export const weldClusterOf = (label: string, members: Member[]): string[] => {
  const comps = weldComponents(members)
  for (const comp of comps) {
    if (comp.indexOf(label) !== -1) return comp
  }
  return [label]
}

/**
 * The FREE (non-touching) sides of each member — drives the perimeter
 * silhouette. Push order l,r,t,b.
 */
export const weldOutlineSides = (members: Member[]): Record<string, Array<Snap["edge"]>> => {
  const out: Record<string, Array<Snap["edge"]>> = {}
  for (let i = 0; i < members.length; i++) {
    const mi = members[i]
    if (!mi) continue
    const a = mi.rect
    const l = a.x
    const t = a.y
    const r = a.x + a.w
    const b = a.y + a.h
    const touched = { l: false, r: false, t: false, b: false }
    for (let j = 0; j < members.length; j++) {
      if (j === i) continue
      const mj = members[j]
      if (!mj) continue
      const o = mj.rect
      const ol = o.x
      const ot = o.y
      const or_ = o.x + o.w
      const ob = o.y + o.h
      const vOverlap = Math.min(b, ob) - Math.max(t, ot) >= WELD_MIN_OVERLAP
      const hOverlap = Math.min(r, or_) - Math.max(l, ol) >= WELD_MIN_OVERLAP
      if (vOverlap && Math.abs(l - or_) <= WELD_EPS) touched.l = true
      if (vOverlap && Math.abs(r - ol) <= WELD_EPS) touched.r = true
      if (hOverlap && Math.abs(t - ob) <= WELD_EPS) touched.t = true
      if (hOverlap && Math.abs(b - ot) <= WELD_EPS) touched.b = true
    }
    const sides: Array<Snap["edge"]> = []
    if (!touched.l) sides.push("l")
    if (!touched.r) sides.push("r")
    if (!touched.t) sides.push("t")
    if (!touched.b) sides.push("b")
    out[mi.label] = sides
  }
  return out
}

type Corner = "tl" | "tr" | "br" | "bl"

/**
 * Which CORNERS of each member sit at an interior weld seam (square them). A
 * corner squares only when a flush neighbour REACHES it (probed WELD_IN px in),
 * so a partial-width weld keeps its still-exposed corners round. The hub label
 * (default "main") is alignment-only and never welds. Push order tl,tr,br,bl.
 */
export const weldCorners = (members: Member[], hubLabel = "main"): Record<string, Corner[]> => {
  const out: Record<string, Corner[]> = {}
  for (let i = 0; i < members.length; i++) {
    const mi = members[i]
    if (!mi) continue
    const a = mi.rect
    const l = a.x
    const t = a.y
    const r = a.x + a.w
    const b = a.y + a.h
    let tl = false
    let tr = false
    let br = false
    let bl = false
    const pyT = t + WELD_IN
    const pyB = b - WELD_IN
    const pxL = l + WELD_IN
    const pxR = r - WELD_IN
    for (let j = 0; j < members.length; j++) {
      const mj = members[j]
      if (j === i || !mj || mj.label === hubLabel) continue
      const o = mj.rect
      const ol = o.x
      const ot = o.y
      const or_ = o.x + o.w
      const ob = o.y + o.h
      const flushLeft = Math.abs(l - or_) <= WELD_EPS
      const flushRight = Math.abs(r - ol) <= WELD_EPS
      const flushTop = Math.abs(t - ob) <= WELD_EPS
      const flushBottom = Math.abs(b - ot) <= WELD_EPS
      const covYpyT = ot - WELD_EPS <= pyT && pyT <= ob + WELD_EPS
      const covYpyB = ot - WELD_EPS <= pyB && pyB <= ob + WELD_EPS
      const covXpxL = ol - WELD_EPS <= pxL && pxL <= or_ + WELD_EPS
      const covXpxR = ol - WELD_EPS <= pxR && pxR <= or_ + WELD_EPS
      if ((flushLeft && covYpyT) || (flushTop && covXpxL)) tl = true
      if ((flushRight && covYpyT) || (flushTop && covXpxR)) tr = true
      if ((flushRight && covYpyB) || (flushBottom && covXpxR)) br = true
      if ((flushLeft && covYpyB) || (flushBottom && covXpxL)) bl = true
    }
    const corners: Corner[] = []
    if (tl) corners.push("tl")
    if (tr) corners.push("tr")
    if (br) corners.push("br")
    if (bl) corners.push("bl")
    out[mi.label] = corners
  }
  return out
}
