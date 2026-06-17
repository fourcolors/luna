/**
 * board-snap.test.ts — the FLUSH corner-weld snap math + emergent welding for
 * the Luna Studio board (src/board/snap.ts), the pure reimpl of the Moon Deck's
 * deck-snap.js. These are the parts of the board that are window-free and fully
 * unit-testable; the engine wiring (onPointerMove → setPanels) is operator /
 * real-browser verify. Mirrors the Moon's test/deck-snap.test.ts +
 * test/dock-live-drag.test.ts, but imports the TS module directly.
 */
import { describe, expect, it } from "vitest"
import {
  WELD_EPS,
  computeLiveDrag,
  computeSnap,
  rectsTouch,
  weldClusterOf,
  type Candidate,
  type LiveDrag,
  type Member,
  type Rect,
} from "../../src/board/snap.js"

// The anchor sits at (500,300), 360x600 → corners TL(500,300) TR(860,300)
// BL(500,900) BR(860,900). A dragged panel snaps to one of 8 corner-aligned
// tiles (BOTH axes pinned), nearest-by-2D-distance within 30px.
const anchor: Rect = { x: 500, y: 300, w: 360, h: 600 }

describe("computeSnap — corner-aligned flush snap (Luna Dock model)", () => {
  it("snaps RIGHT · top-aligned near the anchor's top-right corner", () => {
    // right-top tile = (860, 300); drop at (868,308) → dist √(8²+8²)=11.3 ≤ 30.
    expect(computeSnap(anchor, { x: 868, y: 308, w: 300, h: 200 })).toEqual({
      x: 860,
      y: 300,
      edge: "r",
    })
  })

  it("snaps LEFT · top-aligned just outside the top-left corner", () => {
    // left-top tile = (500 - 300, 300) = (200, 300); drop at (208,306) → dist 10.
    expect(computeSnap(anchor, { x: 208, y: 306, w: 300, h: 200 })).toEqual({
      x: 200,
      y: 300,
      edge: "l",
    })
  })

  it("snaps BELOW · left-aligned near the bottom-left corner", () => {
    // below-left tile = (500, 900); drop at (506,892) → dist 10.
    expect(computeSnap(anchor, { x: 506, y: 892, w: 300, h: 200 })).toEqual({
      x: 500,
      y: 900,
      edge: "b",
    })
  })

  it("snaps ABOVE · right-aligned near the top-right corner from above", () => {
    // above-right tile = (860 - 300, 300 - 200) = (560, 100); drop at (566,106) → dist √72≈8.5.
    expect(computeSnap(anchor, { x: 566, y: 106, w: 300, h: 200 })).toEqual({
      x: 560,
      y: 100,
      edge: "t",
    })
  })

  it("snaps to the NEAREST corner tile (below · right-aligned beats below · left)", () => {
    // w=340 → below-left (500,900) and below-right (520,900) sit 20px apart.
    // drop at (518,894): below-right dist √(2²+6²)=6.3 beats below-left √(18²+6²)=19.
    expect(computeSnap(anchor, { x: 518, y: 894, w: 340, h: 200 })).toEqual({
      x: 520,
      y: 900,
      edge: "b",
    })
  })

  it("does NOT snap mid-edge — far from both corners of that edge", () => {
    // The corner-align signature: a panel at the vertical MIDDLE of the right
    // edge is far from right-top (860,300) and right-bottom (860,700) → no snap,
    // where the old edge-flush model would have stuck it mid-edge.
    expect(computeSnap(anchor, { x: 868, y: 560, w: 300, h: 200 })).toBeNull()
  })

  it("returns null when no corner tile is within threshold", () => {
    expect(computeSnap(anchor, { x: 1000, y: 320, w: 300, h: 200 })).toBeNull()
  })

  it("honors a custom threshold", () => {
    // drop at (884,318): right-top (860,300) dist √(24²+18²)=30 exactly.
    const w: Rect = { x: 884, y: 318, w: 300, h: 200 }
    expect(computeSnap(anchor, w, 25)).toBeNull() // 30 > 25
    expect(computeSnap(anchor, w, 35)?.edge).toBe("r") // 30 ≤ 35
  })
})

describe("computeLiveDrag — flush snap + uniform cluster tow", () => {
  it("tows a 2-member cluster by a uniform delta and reports the snap", () => {
    // Drag a lone module toward the anchor's below-left tile; a welded partner
    // (24px to its right) must move by the SAME (fdx,fdy).
    const drag: LiveDrag = {
      ox: 540,
      oy: 920,
      ow: 360,
      oh: 200,
      dx: -40,
      dy: -22,
      members: [
        { label: "mod", ox: 540, oy: 920 },
        { label: "partner", ox: 924, oy: 920 },
      ],
    }
    const got = computeLiveDrag(drag, [{ label: "anchor", rect: anchor }])
    expect(got.snapped).toBe(true)
    expect(got.anchor).toBe("anchor")
    expect(got.edge).toBe("b")
    // lead snaps (540-40, 920-22)=(500,898) → below-left tile (500,900):
    // fdx = 500-540 = -40, fdy = 900-920 = -20.
    expect(got.targets).toEqual([
      { label: "mod", x: 500, y: 900 }, // flush below, left-aligned
      { label: "partner", x: 884, y: 900 }, // 924-40, 920-20 — moved 1:1
    ])
  })

  it("free-drags by the raw lead delta when no candidate is in range", () => {
    const drag: LiveDrag = {
      ox: 1600,
      oy: 1200,
      ow: 300,
      oh: 200,
      dx: 80,
      dy: 60,
      members: [{ label: "mod", ox: 1600, oy: 1200 }],
    }
    const got = computeLiveDrag(drag, [{ label: "anchor", rect: anchor }])
    expect(got.snapped).toBe(false)
    expect(got.anchor).toBeNull()
    expect(got.edge).toBeNull()
    expect(got.targets[0]).toEqual({ label: "mod", x: 1680, y: 1260 }) // raw cursor delta
  })

  it("picks the NEAREST candidate to snap against", () => {
    const near: Rect = { x: 200, y: 300, w: 360, h: 200 } // its below tile is closest
    const far: Rect = { x: 2000, y: 2000, w: 360, h: 200 }
    const drag: LiveDrag = {
      ox: 205,
      oy: 506,
      ow: 360,
      oh: 200,
      dx: 0,
      dy: 0, // already ~at near's below tile (200,500)
      members: [{ label: "mod", ox: 205, oy: 506 }],
    }
    const candidates: Candidate[] = [
      { label: "far", rect: far },
      { label: "near", rect: near },
    ]
    const got = computeLiveDrag(drag, candidates)
    expect(got.anchor).toBe("near")
    expect(got.targets[0]).toEqual({ label: "mod", x: 200, y: 500 })
  })
})

describe("rectsTouch — flush + perpendicular-overlap adjacency", () => {
  const base: Rect = { x: 0, y: 0, w: 100, h: 100 }

  it("is true for a flush right-edge neighbour that overlaps vertically", () => {
    expect(rectsTouch(base, { x: 100, y: 0, w: 100, h: 100 })).toBe(true)
  })

  it("is true within EPS of flush", () => {
    expect(rectsTouch(base, { x: 100 + WELD_EPS, y: 0, w: 100, h: 100 })).toBe(true)
  })

  it("is false when flush but with no perpendicular overlap (corner-touch only)", () => {
    // sits exactly below-right: shares only the BR corner, overlap 0 on both axes.
    expect(rectsTouch(base, { x: 100, y: 100, w: 100, h: 100 })).toBe(false)
  })

  it("is false when the gap exceeds EPS", () => {
    expect(rectsTouch(base, { x: 100 + WELD_EPS + 1, y: 0, w: 100, h: 100 })).toBe(false)
  })
})

describe("weldClusterOf — emergent transitive cluster", () => {
  it("returns the full A-B-C chain even though A and C are not adjacent", () => {
    // A | B | C laid left-to-right, each flush to the next, none overlapping A↔C.
    const members: Member[] = [
      { label: "A", rect: { x: 0, y: 0, w: 100, h: 100 } },
      { label: "B", rect: { x: 100, y: 0, w: 100, h: 100 } },
      { label: "C", rect: { x: 200, y: 0, w: 100, h: 100 } },
    ]
    expect(new Set(weldClusterOf("A", members))).toEqual(new Set(["A", "B", "C"]))
    expect(new Set(weldClusterOf("C", members))).toEqual(new Set(["A", "B", "C"]))
  })

  it("returns [self] for an isolated panel", () => {
    const members: Member[] = [
      { label: "A", rect: { x: 0, y: 0, w: 100, h: 100 } },
      { label: "lonely", rect: { x: 500, y: 500, w: 100, h: 100 } },
    ]
    expect(weldClusterOf("lonely", members)).toEqual(["lonely"])
  })

  it("excludes a panel that is flush but only corner-touching the cluster", () => {
    const members: Member[] = [
      { label: "A", rect: { x: 0, y: 0, w: 100, h: 100 } },
      { label: "B", rect: { x: 100, y: 0, w: 100, h: 100 } }, // welds A on the right
      // left edge (200) flush with B's right edge (200) but vertical overlap is
      // exactly 0 (< MIN_OVERLAP) — shares only B's bottom-right corner.
      { label: "corner", rect: { x: 200, y: 100, w: 100, h: 100 } },
    ]
    expect(new Set(weldClusterOf("A", members))).toEqual(new Set(["A", "B"]))
  })
})
