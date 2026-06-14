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
