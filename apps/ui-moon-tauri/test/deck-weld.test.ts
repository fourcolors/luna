/**
 * deck-weld.test.ts — the emergent welding geometry that replaces the Rust dock
 * graph (main.rs DockGroups / dock_outline_sides / dock_weld_corners /
 * dock_components). These oracles are Rust's OWN unit-test fixtures (main.rs
 * mod dock_link_tests / dock_geometry_tests); passing them proves the JS port is
 * behaviour-preserving, so deleting the Rust geometry is safe. Loaded the way
 * the browser does — a global IIFE.
 */
import { readFileSync } from "node:fs"
import * as path from "node:path"
import { describe, expect, it, beforeAll } from "vitest"

interface Rect { x: number; y: number; w: number; h: number }
interface Member { label: string; rect: Rect }

let S: {
  rectsTouch: (a: Rect, b: Rect) => boolean
  weldComponents: (m: Member[]) => string[][]
  weldClusterOf: (label: string, m: Member[]) => string[]
  weldOutlineSides: (m: Member[]) => Record<string, string[]>
  weldCorners: (m: Member[], hub?: string) => Record<string, string[]>
  weldStyle: (
    grouped: boolean,
    outlineSides: string[],
    weldCorners: string[],
    isAnchor?: boolean,
  ) => {
    radii: { tl: boolean; tr: boolean; br: boolean; bl: boolean }
    grouped: boolean
    weld: string
    boxShadow: string
    outlineClass: string
  }
}

// fixtures here are [label, [x,y,w,h]] (Rust's shape); adapt to { label, rect }.
const ms = (...rows: [string, [number, number, number, number]][]): Member[] =>
  rows.map(([label, [x, y, w, h]]) => ({ label, rect: { x, y, w, h } }))

beforeAll(() => {
  const src = readFileSync(path.resolve(__dirname, "../frontend/vendor/deck-snap.js"), "utf8")
  const sandbox: Record<string, unknown> = {}
  new Function("globalThis", src)(sandbox)
  S = sandbox.LunaDeckSnap as typeof S
})

describe("rectsTouch — flush edge with real overlap (vs Rust dock_rects_touch)", () => {
  it("touches a flush-right neighbour", () => expect(S.rectsTouch({ x: 0, y: 0, w: 100, h: 100 }, { x: 100, y: 0, w: 100, h: 100 })).toBe(true))
  it("touches a flush-below neighbour", () => expect(S.rectsTouch({ x: 0, y: 0, w: 100, h: 100 }, { x: 0, y: 100, w: 100, h: 100 })).toBe(true))
  it("rejects a 10px gap", () => expect(S.rectsTouch({ x: 0, y: 0, w: 100, h: 100 }, { x: 110, y: 0, w: 100, h: 100 })).toBe(false))
  it("rejects a corner-only graze (<8px overlap)", () => expect(S.rectsTouch({ x: 0, y: 0, w: 100, h: 100 }, { x: 100, y: 95, w: 100, h: 100 })).toBe(false))
})

describe("weldComponents / weldClusterOf — flood fill (vs Rust dock_components)", () => {
  it("partitions a welded stack and a detached island", () => {
    const comps = S.weldComponents(ms(["a", [0, 0, 200, 300]], ["b", [0, 300, 200, 300]], ["island", [600, 0, 200, 200]]))
      .map((c) => c.slice().sort())
      .sort()
    expect(comps).toEqual([["a", "b"], ["island"]])
  })
  it("clusterOf returns every transitively welded member", () => {
    const m = ms(["a", [0, 0, 200, 200]], ["b", [200, 0, 200, 200]], ["c", [400, 0, 200, 200]])
    expect(S.weldClusterOf("a", m).slice().sort()).toEqual(["a", "b", "c"])
  })
  it("clusterOf a lone window is just itself", () => {
    expect(S.weldClusterOf("solo", ms(["solo", [0, 0, 200, 200]]))).toEqual(["solo"])
  })
})

describe("weldOutlineSides — perimeter free sides (vs Rust dock_outline_sides)", () => {
  it("marks only perimeter sides for a side-by-side pair", () => {
    const out = S.weldOutlineSides(ms(["a", [0, 0, 100, 100]], ["b", [100, 0, 100, 100]]))
    expect(out.a).toEqual(["l", "t", "b"]) // right is interior
    expect(out.b).toEqual(["r", "t", "b"]) // left is interior
  })
  it("ignores near-misses and corner touches", () => {
    const out = S.weldOutlineSides(ms(["a", [0, 0, 100, 100]], ["far", [110, 0, 100, 100]], ["corner", [100, 95, 100, 100]]))
    expect(out.a).toEqual(["l", "r", "t", "b"]) // all sides free
  })
})

describe("weldCorners — per-corner squaring (vs Rust dock_weld_corners)", () => {
  it("vertical pair squares only the inner corners", () => {
    const out = S.weldCorners(ms(["a", [0, 0, 200, 300]], ["b", [0, 300, 200, 300]]))
    expect(out.a).toEqual(["br", "bl"])
    expect(out.b).toEqual(["tl", "tr"])
  })
  it("partial width squares only the covered corner", () => {
    const out = S.weldCorners(ms(["a", [0, 0, 200, 300]], ["b", [0, 300, 100, 300]]))
    expect(out.a).toEqual(["bl"])
    expect(out.b).toEqual(["tl", "tr"])
  })
  it("L-trio keeps the exposed outer corner round", () => {
    const out = S.weldCorners(ms(["a", [0, 0, 200, 200]], ["b", [200, 0, 200, 200]], ["c", [0, 200, 200, 200]]))
    expect(out.a).toEqual(["tr", "br", "bl"])
  })
  it("ignores a 10px-gap near-miss", () => {
    expect(S.weldCorners(ms(["a", [0, 0, 200, 200]], ["gap", [210, 0, 200, 200]])).a).toEqual([])
  })
  it("a solo window squares nothing", () => {
    expect(S.weldCorners(ms(["solo", [0, 0, 200, 200]])).solo).toEqual([])
  })
  it("never welds against the hub ('main')", () => {
    expect(S.weldCorners(ms(["widget-a", [0, 0, 200, 200]], ["main", [200, 0, 200, 200]]))["widget-a"]).toEqual([])
  })
})

describe("weldStyle — pure geometry → card visual style", () => {
  it("a solo (ungrouped) window squares nothing and clears its chrome", () => {
    const s = S.weldStyle(false, [], [])
    expect(s.grouped).toBe(false)
    expect(s.radii).toEqual({ tl: false, tr: false, br: false, bl: false })
    expect(s.boxShadow).toBe("")
    expect(s.weld).toBe("")
    expect(s.outlineClass).toBe("")
  })

  it("a left-welded window squares its left corners, casts free-side edges, marks the weld", () => {
    // free sides t,r,b (left is welded) → welded marker = 'l'
    const s = S.weldStyle(true, ["t", "r", "b"], ["tl", "bl"], false)
    expect(s.radii).toEqual({ tl: true, tr: false, br: false, bl: true })
    expect(s.weld).toBe("l")
    expect(s.boxShadow).toContain("var(--dk-edge-amb)")
    expect(s.boxShadow).toContain("var(--dk-edge-t)")
    expect(s.boxShadow).toContain("var(--dk-edge-r)")
    expect(s.boxShadow).not.toContain("var(--dk-edge-l)") // welded side casts no edge
    expect(s.outlineClass).toBe("gt gr gb")
  })

  it("the chat anchor casts the distinct bottom accent edge", () => {
    expect(S.weldStyle(true, ["b"], [], true).boxShadow).toContain("var(--dk-edge-b-anchor)")
    expect(S.weldStyle(true, ["b"], [], false).boxShadow).toContain("var(--dk-edge-b)")
    expect(S.weldStyle(true, ["b"], [], false).boxShadow).not.toContain("anchor")
  })
})
