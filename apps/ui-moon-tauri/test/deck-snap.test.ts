/**
 * deck-snap.test.ts — the magnetic snap math for the Moon Deck (PRD W2).
 *
 * The snap algorithm is the one piece of the deck that is pure and fully
 * unit-testable (window creation + the actual onMoved→setPosition wiring are
 * operator-verify on a real Tauri build). We load the vendored module the way
 * the browser does (a global IIFE) and exercise computeSnap directly.
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
interface Snap {
  x: number
  y: number
  edge: "l" | "r" | "t" | "b"
}
interface Seam {
  partner: string
  edge: "r" | "b"
  x: number
  y: number
}
interface Member {
  label: string
  rect: Rect
}
let computeSnap: (a: Rect, w: Rect, t?: number) => Snap | null
let computeSeams: (self: Rect, others: Member[]) => Seam[]

beforeAll(() => {
  const src = readFileSync(
    path.resolve(__dirname, "../frontend/vendor/deck-snap.js"),
    "utf8",
  )
  const sandbox: Record<string, unknown> = {}
  // The module assigns to globalThis.LunaDeckSnap; run it with `globalThis`
  // bound to our sandbox so we don't pollute the real global.
  new Function("globalThis", src)(sandbox)
  const mod = sandbox.LunaDeckSnap as {
    computeSnap: typeof computeSnap
    computeSeams: typeof computeSeams
  }
  computeSnap = mod.computeSnap
  computeSeams = mod.computeSeams
})

// The chat anchor sits at (500,300), 360x600.
const anchor: Rect = { x: 500, y: 300, w: 360, h: 600 }

describe("computeSnap", () => {
  it("snaps to the RIGHT edge when the widget's left edge is within threshold", () => {
    // widget left edge at 870, anchor right edge at 860 → gap 10 ≤ 22.
    const snap = computeSnap(anchor, { x: 870, y: 320, w: 300, h: 200 })
    expect(snap).toEqual({ x: 860, y: 320, edge: "r" })
  })

  it("snaps to the LEFT edge, placing the widget flush to the left of the anchor", () => {
    // widget right edge near anchor left (500); widget at x=190 w=300 → right=490, gap 10.
    const snap = computeSnap(anchor, { x: 190, y: 320, w: 300, h: 200 })
    expect(snap).toEqual({ x: 200, y: 320, edge: "l" }) // 500 - 300
  })

  it("snaps to the BOTTOM edge when below and horizontally overlapping", () => {
    // anchor bottom = 900; widget top at 912 → gap 12.
    const snap = computeSnap(anchor, { x: 520, y: 912, w: 300, h: 200 })
    expect(snap).toEqual({ x: 520, y: 900, edge: "b" })
  })

  it("returns null when no edge is within threshold", () => {
    expect(computeSnap(anchor, { x: 1000, y: 320, w: 300, h: 200 })).toBeNull()
  })

  it("does NOT side-snap when there is no vertical overlap (diagonal off the corner)", () => {
    // Left edge would be within threshold of the right edge, but the widget is
    // entirely ABOVE the anchor (y+h=250 < anchor.y=300) → no vertical overlap.
    const snap = computeSnap(anchor, { x: 870, y: 50, w: 300, h: 200 })
    expect(snap).toBeNull()
  })

  it("picks the NEAREST edge when two are within threshold", () => {
    // Near the bottom-right corner: right-gap 5, bottom-gap 15 → right wins.
    const snap = computeSnap(anchor, { x: 865, y: 885, w: 300, h: 200 })
    expect(snap?.edge).toBe("r")
  })

  it("honors a custom threshold", () => {
    const w = { x: 880, y: 320, w: 300, h: 200 } // right-gap 20
    expect(computeSnap(anchor, w, 10)).toBeNull() // 20 > 10
    expect(computeSnap(anchor, w, 25)?.edge).toBe("r") // 20 ≤ 25
  })
})

describe("computeSeams", () => {
  // `self` is the LEFT window: 200x300 at the origin, right edge at x=200.
  const self: Rect = { x: 0, y: 0, w: 200, h: 300 }

  it("reports a RIGHT seam when a partner sits flush to self's right edge", () => {
    // partner left edge at 200 (flush, gap 0), vertically overlapping.
    const seams = computeSeams(self, [
      { label: "widget-b", rect: { x: 200, y: 40, w: 250, h: 220 } },
    ])
    // Overlap run is [40, 260] → mid 150 (local y). Badge centered on self's
    // right edge, inset 11px so it stays fully inside the window.
    expect(seams).toEqual([{ partner: "widget-b", edge: "r", x: 189, y: 150 }])
  })

  it("reports a BOTTOM seam when a partner sits flush below self", () => {
    // partner top edge at 300 (self.bottom), horizontally overlapping.
    const seams = computeSeams(self, [
      { label: "widget-c", rect: { x: 30, y: 300, w: 140, h: 180 } },
    ])
    // Overlap run is [30, 170] → mid 100 (local x); y pinned to self.h - 11.
    expect(seams).toEqual([{ partner: "widget-c", edge: "b", x: 100, y: 289 }])
  })

  it("does NOT report the seam from the RIGHT/BOTTOM window (ownership)", () => {
    // The mirror of test 1: `self` is now the RIGHT window of the same pair.
    const right: Rect = { x: 200, y: 40, w: 250, h: 220 }
    const seams = computeSeams(right, [
      { label: "widget-a", rect: { x: 0, y: 0, w: 200, h: 300 } },
    ])
    // The shared seam is on `right`'s LEFT edge, which computeSeams never
    // inspects — so the left window (test 1) owns it and this one is silent.
    expect(seams).toEqual([])
  })

  it("ignores partners that are near but not flush (gap beyond EPS)", () => {
    // partner left edge at 205 → 5px gap from self.right (200), EPS is 2.
    const seams = computeSeams(self, [
      { label: "widget-b", rect: { x: 205, y: 40, w: 250, h: 220 } },
    ])
    expect(seams).toEqual([])
  })

  it("ignores a flush partner with too little perpendicular overlap", () => {
    // Flush on the right edge, but vertical overlap is only [295,300] = 5px (< 8).
    const seams = computeSeams(self, [
      { label: "widget-b", rect: { x: 200, y: 295, w: 250, h: 220 } },
    ])
    expect(seams).toEqual([])
  })

  it("reports one seam per docked partner in a multi-window group", () => {
    const seams = computeSeams(self, [
      { label: "right", rect: { x: 200, y: 0, w: 250, h: 300 } }, // right seam
      { label: "below", rect: { x: 0, y: 300, w: 200, h: 180 } }, // bottom seam
      { label: "afar", rect: { x: 600, y: 600, w: 100, h: 100 } }, // unrelated
    ])
    expect(seams).toHaveLength(2)
    expect(seams.map((s) => s.partner).sort()).toEqual(["below", "right"])
  })

  it("clamps the badge toward the overlapping end so it stays on-window", () => {
    // A tall partner overlaps only self's very top → midpoint would be ~20px
    // up-edge; the clamp floor keeps the badge fully inside (y ≥ 11).
    const seams = computeSeams(self, [
      { label: "tall", rect: { x: 200, y: -260, w: 200, h: 280 } },
    ])
    // Overlap [0, 20] → mid 10 → clamped up to the 11px floor.
    expect(seams[0]).toMatchObject({ edge: "r", y: 11 })
  })

  it("returns [] for an ungrouped window (no others)", () => {
    expect(computeSeams(self, [])).toEqual([])
  })
})
