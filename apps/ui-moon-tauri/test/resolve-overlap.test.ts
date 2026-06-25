/**
 * resolve-overlap.test.ts — the HARD "never overlap" guarantee layered on top
 * of the forgiving edge magnet (deck-snap.js computeEdgeSnap). computeEdgeSnap
 * only clears the ONE neighbour it docks against; resolveOverlap is the pure,
 * iterative minimal-push solver that guarantees a released window's CARD rect
 * overlaps NONE of the other cards. We load the vendored module the way the
 * browser does (a global IIFE) and exercise resolveOverlap directly.
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
interface Bounds {
  x: number
  y: number
  w: number
  h: number
}
type ResolveOpts = number | { maxIter?: number; bounds?: Bounds }
let resolveOverlap: (rect: Rect, others: Rect[], opts?: ResolveOpts) => { x: number; y: number }

// Assert the resolved rect lies fully WITHIN bounds.
function expectInBounds(resolved: { x: number; y: number }, w: number, h: number, b: Bounds) {
  expect(resolved.x).toBeGreaterThanOrEqual(b.x)
  expect(resolved.y).toBeGreaterThanOrEqual(b.y)
  expect(resolved.x + w).toBeLessThanOrEqual(b.x + b.w)
  expect(resolved.y + h).toBeLessThanOrEqual(b.y + b.h)
}

beforeAll(() => {
  const src = readFileSync(
    path.resolve(__dirname, "../frontend/vendor/deck-snap.js"),
    "utf8",
  )
  const sandbox: Record<string, unknown> = {}
  new Function("globalThis", src)(sandbox)
  resolveOverlap = (sandbox.LunaDeckSnap as { resolveOverlap: typeof resolveOverlap }).resolveOverlap
})

// Local overlap helper: do two rects overlap on BOTH axes (positive area)?
function overlaps(a: Rect, b: Rect): boolean {
  const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return ox > 0 && oy > 0
}

// Assert the resolved rect overlaps NONE of `others`.
function expectClear(resolved: { x: number; y: number }, w: number, h: number, others: Rect[]) {
  const r: Rect = { x: resolved.x, y: resolved.y, w, h }
  for (const n of others) {
    expect(overlaps(r, n)).toBe(false)
  }
}

describe("resolveOverlap — hard no-overlap guarantee", () => {
  it("(1) already-clear rect → returned unchanged", () => {
    const rect: Rect = { x: 0, y: 0, w: 100, h: 100 }
    const others: Rect[] = [{ x: 200, y: 200, w: 100, h: 100 }]
    const out = resolveOverlap(rect, others)
    expect(out).toEqual({ x: 0, y: 0 })
    expectClear(out, rect.w, rect.h, others)
  })

  it("(2) single overlap → zero overlap and flush-adjacent (one edge equal)", () => {
    // rect (100,100,100,100) overlaps n (150,100,100,100) on the right by 50px,
    // 0 on Y-penetration depth difference → least axis is X. Pushed flush.
    const rect: Rect = { x: 100, y: 100, w: 100, h: 100 }
    const n: Rect = { x: 150, y: 100, w: 100, h: 100 }
    const others = [n]
    const out = resolveOverlap(rect, others)
    expectClear(out, rect.w, rect.h, others)
    // flush-adjacent: one edge of the result coincides with one edge of n.
    const r: Rect = { x: out.x, y: out.y, w: rect.w, h: rect.h }
    const flush =
      r.x + r.w === n.x || r.x === n.x + n.w || r.y + r.h === n.y || r.y === n.y + n.h
    expect(flush).toBe(true)
  })

  it("(3) rect fully CONTAINED in a neighbour → pushed out, zero overlap", () => {
    const rect: Rect = { x: 220, y: 220, w: 40, h: 40 }
    const n: Rect = { x: 200, y: 200, w: 100, h: 100 }
    const others = [n]
    const out = resolveOverlap(rect, others)
    expectClear(out, rect.w, rect.h, others)
  })

  it("(4) two neighbours where a naive single-push lands in the other → clears NEITHER", () => {
    // rect overlaps A (slightly, on its left) and B (heavily, on its right).
    // The worst overlap is B → minimal push is LEFT out of B; that move would
    // deepen the A overlap, so the loop must take another round to clear A too.
    // A leaves a wide clear lane to its left (x≤-100), so the loop converges.
    const rect: Rect = { x: 100, y: 100, w: 100, h: 100 }
    const a: Rect = { x: 40, y: 100, w: 70, h: 100 }  // overlaps rect's left by 10
    const b: Rect = { x: 120, y: 100, w: 100, h: 100 } // overlaps rect's right by 80
    const others = [a, b]
    const out = resolveOverlap(rect, others)
    expectClear(out, rect.w, rect.h, others)
  })

  it("(5) a row of 3 neighbours → result clears all", () => {
    // Three 100-wide cards span x∈[0,300] in a tight row; rect (100 wide)
    // overlaps the middle one. No 100px gap exists between them, so the loop
    // must push rect out past one END of the row (x≥300 or x≤-100).
    const rect: Rect = { x: 130, y: 100, w: 100, h: 100 }
    const others: Rect[] = [
      { x: 0, y: 100, w: 100, h: 100 },
      { x: 100, y: 100, w: 100, h: 100 },
      { x: 200, y: 100, w: 100, h: 100 },
    ]
    const out = resolveOverlap(rect, others)
    expectClear(out, rect.w, rect.h, others)
  })

  it("(6) back-compat: maxIter passed as a bare NUMBER still works", () => {
    const rect: Rect = { x: 100, y: 100, w: 100, h: 100 }
    const n: Rect = { x: 150, y: 100, w: 100, h: 100 }
    const others = [n]
    const out = resolveOverlap(rect, others, 12)
    expectClear(out, rect.w, rect.h, others)
  })

  it("(7) bounds: shortest push (up) would exit bounds → picks a longer in-bounds push", () => {
    // rect overlaps n. The least-penetration move is UP (smallest distance), but
    // that lands rect ABOVE the bounds top → off-screen. A longer move (down or
    // right) stays inside bounds, so the resolver must take it.
    const bounds: Bounds = { x: 0, y: 0, w: 1000, h: 1000 }
    // rect at the very top; n sits just below-overlapping its bottom half, so the
    // minimal clear is UP (y = n.y - h = -? ) → off the top of bounds.
    const rect: Rect = { x: 100, y: 0, w: 100, h: 100 }
    // n overlaps rect's bottom by 40 (least Y-penetration) but its right/left
    // overlap is larger, making UP the shortest move overall.
    const n: Rect = { x: 100, y: 60, w: 100, h: 100 }
    const others = [n]
    const out = resolveOverlap(rect, others, { maxIter: 12, bounds })
    expectClear(out, rect.w, rect.h, others)
    expectInBounds(out, rect.w, rect.h, bounds)
    // Specifically, it must NOT have gone up off the top (which would be y<0).
    expect(out.y).toBeGreaterThanOrEqual(0)
  })

  it("(8) bounds: a row of neighbours where only a down/right escape stays in bounds", () => {
    // rect overlaps the middle of a tight 3-card row at the TOP of bounds. Pushing
    // up/left would exit bounds; the resolver must walk it out the bottom/right
    // and still clear all three, staying inside bounds.
    const bounds: Bounds = { x: 0, y: 0, w: 2000, h: 2000 }
    const rect: Rect = { x: 130, y: 0, w: 100, h: 100 }
    const others: Rect[] = [
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 100, y: 0, w: 100, h: 100 },
      { x: 200, y: 0, w: 100, h: 100 },
    ]
    const out = resolveOverlap(rect, others, { maxIter: 12, bounds })
    expectClear(out, rect.w, rect.h, others)
    expectInBounds(out, rect.w, rect.h, bounds)
  })

  it("(9) bounds, no escape: no single in-bounds move fully clears → still returns (best effort)", () => {
    // Contrived: bounds is barely larger than rect, and a neighbour overlaps such
    // that EVERY clearing move pushes rect out of bounds. The resolver must not
    // throw or loop forever — it returns a best-effort result.
    const bounds: Bounds = { x: 0, y: 0, w: 120, h: 120 }
    const rect: Rect = { x: 10, y: 10, w: 100, h: 100 }
    // n covers the centre; right (x=...>20) and down both overflow the 120 box,
    // left/up go negative → no in-bounds escape exists.
    const n: Rect = { x: 0, y: 0, w: 100, h: 100 }
    const others = [n]
    let out: { x: number; y: number } | undefined
    expect(() => {
      out = resolveOverlap(rect, others, { maxIter: 12, bounds })
    }).not.toThrow()
    expect(out).toBeDefined()
    // best-effort: it made a move (didn't silently stay overlapping the SAME spot
    // with no attempt). We only assert it terminated and returned a rect.
    expect(typeof out!.x).toBe("number")
    expect(typeof out!.y).toBe("number")
  })
})
