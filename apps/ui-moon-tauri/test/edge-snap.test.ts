/**
 * edge-snap.test.ts — the forgiving edge-snap magnet (computeEdgeSnap) that
 * replaces the corner-only computeSnap for lone-window drags.
 *
 * computeEdgeSnap docks the dragged window FLUSH against whichever neighbour
 * edge it's near (forgiving threshold), preserves the user's perpendicular
 * offset unless near a corner (then it corner-aligns), and ALWAYS resolves a
 * drop overlapping a neighbour on both axes to a flush-adjacent position
 * (anti-layer). We load the vendored module the way the browser does and
 * exercise computeEdgeSnap directly.
 */
import { readFileSync } from "node:fs"
import * as path from "node:path"
import { describe, expect, it, beforeAll } from "vitest"

interface Rect {
  x: number
  y: number
  w: number
  h: number
}
interface EdgeSnap {
  x: number
  y: number
  edge: "l" | "r" | "t" | "b"
  label: string
}
type Opts = { threshold?: number; cornerThreshold?: number; minOverlap?: number }
let computeEdgeSnap: (
  lead: Rect,
  candidates: { label: string; rect: Rect }[],
  opts?: Opts,
) => EdgeSnap | null

beforeAll(() => {
  const src = readFileSync(
    path.resolve(__dirname, "../frontend/vendor/deck-snap.js"),
    "utf8",
  )
  const sandbox: Record<string, unknown> = {}
  new Function("globalThis", src)(sandbox)
  computeEdgeSnap = (
    sandbox.LunaDeckSnap as { computeEdgeSnap: typeof computeEdgeSnap }
  ).computeEdgeSnap
})

// A 360×600 neighbour at (500,300): card edges L500 R860 T300 B900.
const neighbor: Rect = { x: 500, y: 300, w: 360, h: 600 }
const cands = [{ label: "n", rect: neighbor }]

describe("computeEdgeSnap — forgiving edge-flush magnet", () => {
  it("(1) docks RIGHT-of-neighbour, vertical overlap, FREE perpendicular offset preserved", () => {
    // lead just right of neighbour's right edge (gap 30 ≤ 80), y offset of 100
    // not near either corner (cornerThreshold 40) → preserved.
    const lead: Rect = { x: 890, y: 400, w: 300, h: 200 }
    const snap = computeEdgeSnap(lead, cands)
    expect(snap).not.toBeNull()
    expect(snap!.edge).toBe("r")
    expect(snap!.label).toBe("n")
    expect(snap!.x).toBe(860) // flush to neighbour right edge
    expect(snap!.y).toBe(400) // free offset preserved
  })

  it("(2) corner-aligns when tops are within cornerThreshold", () => {
    // lead top 320 is 20px below neighbour top 300 (≤ 40) → snap tops flush.
    const lead: Rect = { x: 890, y: 320, w: 300, h: 200 }
    const snap = computeEdgeSnap(lead, cands)
    expect(snap).not.toBeNull()
    expect(snap!.edge).toBe("r")
    expect(snap!.x).toBe(860)
    expect(snap!.y).toBe(300) // tops flush (corner-aligned)
  })

  it("(3) NO snap when perpendicular overlap <= minOverlap and gap huge → null", () => {
    // lead far below the neighbour (no vertical overlap) and far to the right
    // (huge horizontal gap) → nothing in range.
    const lead: Rect = { x: 1300, y: 1300, w: 300, h: 200 }
    expect(computeEdgeSnap(lead, cands)).toBeNull()
  })

  it("(4) anti-overlap: a drop overlapping on BOTH axes resolves to flush-adjacent even when gap > threshold", () => {
    // lead deeply overlapping the neighbour (both axes), no edge within 80px.
    const lead: Rect = { x: 560, y: 360, w: 300, h: 200 }
    const snap = computeEdgeSnap(lead, cands)
    expect(snap).not.toBeNull()
    // result must be flush-adjacent: verify no remaining overlap on the chosen axis.
    const sx = snap!.x, sy = snap!.y, sw = lead.w, sh = lead.h
    const overlapX = Math.min(sx + sw, neighbor.x + neighbor.w) - Math.max(sx, neighbor.x)
    const overlapY = Math.min(sy + sh, neighbor.y + neighbor.h) - Math.max(sy, neighbor.y)
    // At least one axis must be non-overlapping (flush-adjacent).
    expect(overlapX <= 0 || overlapY <= 0).toBe(true)
  })

  it("(5) threshold boundary — just inside snaps, just outside is null", () => {
    // vertical overlap present (y aligned). gap to neighbour right edge 860.
    const inside: Rect = { x: 939, y: 400, w: 300, h: 200 } // gap 79 ≤ 80
    expect(computeEdgeSnap(inside, cands)!.edge).toBe("r")
    const outside: Rect = { x: 941, y: 400, w: 300, h: 200 } // gap 81 > 80
    expect(computeEdgeSnap(outside, cands)).toBeNull()
  })

  it("(6) picks the LEAST-movement candidate when two neighbours are in range", () => {
    // Second neighbour to the LEFT. lead is closer to the left neighbour's right
    // edge than the right neighbour's left edge.
    const left: Rect = { x: 100, y: 300, w: 200, h: 600 } // card right edge 300
    const cands2 = [
      { label: "left", rect: left },
      { label: "right", rect: neighbor }, // left edge 500
    ]
    // lead at x=320 → 20px from left's right edge (300), 180px from right's left
    // edge — but right's left dock requires lead.right≈500; here lead.right=620.
    const lead: Rect = { x: 320, y: 400, w: 300, h: 200 }
    const snap = computeEdgeSnap(lead, cands2)
    expect(snap).not.toBeNull()
    expect(snap!.label).toBe("left")
    expect(snap!.edge).toBe("r")
    expect(snap!.x).toBe(300) // flush to left neighbour's right edge
  })
})
