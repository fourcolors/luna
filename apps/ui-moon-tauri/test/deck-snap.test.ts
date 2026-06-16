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
let computeSnap: (a: Rect, w: Rect, t?: number) => Snap | null

beforeAll(() => {
  const src = readFileSync(
    path.resolve(__dirname, "../frontend/vendor/deck-snap.js"),
    "utf8",
  )
  const sandbox: Record<string, unknown> = {}
  // The module assigns to globalThis.LunaDeckSnap; run it with `globalThis`
  // bound to our sandbox so we don't pollute the real global.
  new Function("globalThis", src)(sandbox)
  computeSnap = (sandbox.LunaDeckSnap as { computeSnap: typeof computeSnap }).computeSnap
})

// The chat anchor sits at (500,300), 360x600 → corners TL(500,300) TR(860,300)
// BL(500,900) BR(860,900). The design snaps a dragged window to one of 8
// corner-aligned tiles (BOTH axes pinned), nearest-by-2D-distance within 30px.
const anchor: Rect = { x: 500, y: 300, w: 360, h: 600 }

describe("computeSnap — corner-aligned magnetic snap (Luna Dock model)", () => {
  it("snaps RIGHT · top-aligned when dropped near the anchor's top-right corner", () => {
    // right-top tile = (860, 300); drop at (868,308) → dist √(8²+8²)=11.3 ≤ 30.
    const snap = computeSnap(anchor, { x: 868, y: 308, w: 300, h: 200 })
    expect(snap).toEqual({ x: 860, y: 300, edge: "r" })
  })

  it("snaps LEFT · top-aligned when dropped just outside the top-left corner", () => {
    // left-top tile = (500 - 300, 300) = (200, 300); drop at (208,306) → dist 10.
    const snap = computeSnap(anchor, { x: 208, y: 306, w: 300, h: 200 })
    expect(snap).toEqual({ x: 200, y: 300, edge: "l" })
  })

  it("snaps BELOW · left-aligned when dropped near the bottom-left corner", () => {
    // below-left tile = (500, 900); drop at (506,892) → dist 10.
    const snap = computeSnap(anchor, { x: 506, y: 892, w: 300, h: 200 })
    expect(snap).toEqual({ x: 500, y: 900, edge: "b" })
  })

  it("snaps to the NEAREST corner tile (below · right-aligned)", () => {
    // w=340 → below-left (500,900) and below-right (520,900) sit 20px apart.
    // drop at (518,894): below-right dist √(2²+6²)=6.3 beats below-left √(18²+6²)=19.
    const snap = computeSnap(anchor, { x: 518, y: 894, w: 340, h: 200 })
    expect(snap).toEqual({ x: 520, y: 900, edge: "b" })
  })

  it("does NOT snap mid-edge — far from both corners of that edge", () => {
    // The corner-align signature: a window at the vertical MIDDLE of the right
    // edge is far from right-top (860,300) and right-bottom (860,700) → no snap,
    // where the old edge-flush model would have stuck it mid-edge.
    expect(computeSnap(anchor, { x: 868, y: 560, w: 300, h: 200 })).toBeNull()
  })

  it("returns null when no corner tile is within threshold", () => {
    expect(computeSnap(anchor, { x: 1000, y: 320, w: 300, h: 200 })).toBeNull()
  })

  it("honors a custom threshold", () => {
    // drop at (884,318): right-top (860,300) dist √(24²+18²)=30 exactly.
    const w = { x: 884, y: 318, w: 300, h: 200 }
    expect(computeSnap(anchor, w, 25)).toBeNull() // 30 > 25
    expect(computeSnap(anchor, w, 35)?.edge).toBe("r") // 30 ≤ 35
  })
})
