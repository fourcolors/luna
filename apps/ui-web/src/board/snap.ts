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
const SNAP_THRESHOLD = 30
/** flush tolerance (matches Rust EPS). */
export const WELD_EPS = 2
/** perpendicular overlap that counts as adjacency. */
const WELD_MIN_OVERLAP = 8

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
const weldComponents = (members: Member[]): string[][] => {
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

