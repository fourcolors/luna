/**
 * physical-snap.test.ts — unit tests for physicalSnapEdge in deck-snap.js.
 *
 * physicalSnapEdge computes the PHYSICAL frame top-left for a window snapping
 * flush against a neighbour, eliminating the 1-physical-pixel seam that opens
 * when the OS rounds logical→physical independently per window. Unlike the old
 * physicalSnapOrigin it carries the EXACT perpendicular offset chosen by
 * computeEdgeSnap (anchored to the neighbour's physical card frame), so a free
 * (non-corner-aligned) snap keeps the user's offset.
 *
 * We load the vendored module exactly the same way deck-snap.test.ts does —
 * as a global IIFE executed with a sandboxed globalThis — and pull the export
 * from sandbox.LunaDeckSnap.
 */
import { readFileSync } from "node:fs"
import * as path from "node:path"
import { describe, expect, it, beforeAll } from "vitest"

type PhysFrame = { x: number; y: number; w: number; h: number }
type Rect = { x: number; y: number; w: number; h: number }
type Ins = { l: number; r: number; t: number; b: number }

let physicalSnapEdge: (
  neighborPhys: PhysFrame,
  neighborCard: Rect,
  snappedLeadCard: { x: number; y: number },
  selfPhys: { w: number; h: number },
  edge: "l" | "r" | "t" | "b",
  ins: Ins,
  sf: number,
) => { x: number; y: number }

beforeAll(() => {
  const src = readFileSync(
    path.resolve(__dirname, "../frontend/vendor/deck-snap.js"),
    "utf8",
  )
  const sandbox: Record<string, unknown> = {}
  new Function("globalThis", src)(sandbox)
  physicalSnapEdge = (
    sandbox.LunaDeckSnap as { physicalSnapEdge: typeof physicalSnapEdge }
  ).physicalSnapEdge
})

// Local helpers — compute physical card edges from a physical frame.
// These deliberately re-derive the edge math independently of the library so
// that the assertions are not circular.
function Lp(v: number, sf: number) { return Math.round(v * sf) }
function cardBottom(f: PhysFrame, ins: Ins, sf: number) { return f.y + f.h - Lp(ins.b, sf) }
function cardTop(f: PhysFrame, ins: Ins, sf: number)    { return f.y + Lp(ins.t, sf) }
function cardLeft(f: PhysFrame, ins: Ins, sf: number)   { return f.x + Lp(ins.l, sf) }
function cardRight(f: PhysFrame, ins: Ins, sf: number)  { return f.x + f.w - Lp(ins.r, sf) }

// A neighbour LOGICAL card rect derived from its physical frame, for building
// snappedLeadCard inputs. (Card-space = frame inset by ins.)
function neighborCardFrom(neighborPhys: PhysFrame, ins: Ins, sf: number): Rect {
  return {
    x: (neighborPhys.x + Lp(ins.l, sf)) / sf,
    y: (neighborPhys.y + Lp(ins.t, sf)) / sf,
    w: (neighborPhys.w - Lp(ins.l, sf) - Lp(ins.r, sf)) / sf,
    h: (neighborPhys.h - Lp(ins.t, sf) - Lp(ins.b, sf)) / sf,
  }
}

// ---------------------------------------------------------------------------
// Suite 1: corner-aligned (offset == 0) — the touching seam is pixel-exact and
// the perpendicular card origins coincide. Run at sf=2 and sf=1.25.
// ---------------------------------------------------------------------------
function cornerAlignedSuite(sf: number, ins: Ins) {
  describe(`physicalSnapEdge — corner-aligned, sf=${sf}`, () => {
    const neighborPhys: PhysFrame = { x: 100, y: 200, w: 720, h: 1200 }
    const selfSize = { w: 600, h: 400 }
    const nCard = neighborCardFrom(neighborPhys, ins, sf)

    it("edge='b': self.cardTop_phys === neighbor.cardBottom_phys AND cardLeft coincides", () => {
      // corner-aligned: lefts flush → snappedLeadCard.x === neighborCard.x
      const snapped = { x: nCard.x, y: 0 }
      const o = physicalSnapEdge(neighborPhys, nCard, snapped, selfSize, "b", ins, sf)
      const selfFrame: PhysFrame = { x: o.x, y: o.y, w: selfSize.w, h: selfSize.h }
      expect(cardTop(selfFrame, ins, sf)).toBe(cardBottom(neighborPhys, ins, sf))
      expect(cardLeft(selfFrame, ins, sf)).toBe(cardLeft(neighborPhys, ins, sf))
    })

    it("edge='t': self.cardBottom_phys === neighbor.cardTop_phys AND cardLeft coincides", () => {
      const snapped = { x: nCard.x, y: 0 }
      const o = physicalSnapEdge(neighborPhys, nCard, snapped, selfSize, "t", ins, sf)
      const selfFrame: PhysFrame = { x: o.x, y: o.y, w: selfSize.w, h: selfSize.h }
      expect(cardBottom(selfFrame, ins, sf)).toBe(cardTop(neighborPhys, ins, sf))
      expect(cardLeft(selfFrame, ins, sf)).toBe(cardLeft(neighborPhys, ins, sf))
    })

    it("edge='r': self.cardLeft_phys === neighbor.cardRight_phys AND cardTop coincides", () => {
      const snapped = { x: 0, y: nCard.y }
      const o = physicalSnapEdge(neighborPhys, nCard, snapped, selfSize, "r", ins, sf)
      const selfFrame: PhysFrame = { x: o.x, y: o.y, w: selfSize.w, h: selfSize.h }
      expect(cardLeft(selfFrame, ins, sf)).toBe(cardRight(neighborPhys, ins, sf))
      expect(cardTop(selfFrame, ins, sf)).toBe(cardTop(neighborPhys, ins, sf))
    })

    it("edge='l': self.cardRight_phys === neighbor.cardLeft_phys AND cardTop coincides", () => {
      const snapped = { x: 0, y: nCard.y }
      const o = physicalSnapEdge(neighborPhys, nCard, snapped, selfSize, "l", ins, sf)
      const selfFrame: PhysFrame = { x: o.x, y: o.y, w: selfSize.w, h: selfSize.h }
      expect(cardRight(selfFrame, ins, sf)).toBe(cardLeft(neighborPhys, ins, sf))
      expect(cardTop(selfFrame, ins, sf)).toBe(cardTop(neighborPhys, ins, sf))
    })
  })
}

cornerAlignedSuite(2, { l: 22, r: 22, t: 22, b: 22 })
cornerAlignedSuite(1.25, { l: 22, r: 22, t: 4, b: 22 })

// ---------------------------------------------------------------------------
// Suite 2: FREE perpendicular offset preserved — self's perpendicular card
// origin === neighbour's perpendicular card origin + Lp(offset).
// ---------------------------------------------------------------------------
describe("physicalSnapEdge — free perpendicular offset preserved", () => {
  const sf = 2
  const ins: Ins = { l: 22, r: 22, t: 22, b: 22 }
  const neighborPhys: PhysFrame = { x: 100, y: 200, w: 720, h: 1200 }
  const selfSize = { w: 600, h: 400 }
  const nCard = neighborCardFrom(neighborPhys, ins, sf)

  it("edge='r': touching seam exact AND self.cardTop_phys === neighbor.cardTop_phys + Lp(offset)", () => {
    const offset = 137 // logical px down from neighbour card top
    const snapped = { x: 0, y: nCard.y + offset }
    const o = physicalSnapEdge(neighborPhys, nCard, snapped, selfSize, "r", ins, sf)
    const selfFrame: PhysFrame = { x: o.x, y: o.y, w: selfSize.w, h: selfSize.h }
    expect(cardLeft(selfFrame, ins, sf)).toBe(cardRight(neighborPhys, ins, sf))
    expect(cardTop(selfFrame, ins, sf)).toBe(cardTop(neighborPhys, ins, sf) + Lp(offset, sf))
  })

  it("edge='b': touching seam exact AND self.cardLeft_phys === neighbor.cardLeft_phys + Lp(offset)", () => {
    const offset = 91 // logical px right from neighbour card left
    const snapped = { x: nCard.x + offset, y: 0 }
    const o = physicalSnapEdge(neighborPhys, nCard, snapped, selfSize, "b", ins, sf)
    const selfFrame: PhysFrame = { x: o.x, y: o.y, w: selfSize.w, h: selfSize.h }
    expect(cardTop(selfFrame, ins, sf)).toBe(cardBottom(neighborPhys, ins, sf))
    expect(cardLeft(selfFrame, ins, sf)).toBe(cardLeft(neighborPhys, ins, sf) + Lp(offset, sf))
  })
})
