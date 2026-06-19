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
  dockOnOpenPosition: (
    self: Rect,
    members: Member[],
    insets: { l: number; r: number; t: number; b: number },
    prefer?: string | null,
    monitorRight?: number,
  ) => { x: number; y: number; anchor: string; edge: string } | null
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

describe("dockOnOpenPosition — JS snap-on-open (replaces Rust group_bbox_of + panel_spawn_pos)", () => {
  const insets = { l: 22, r: 22, t: 4, b: 22 }
  const self = (w: number, h: number): Rect => ({ x: 0, y: 0, w, h })

  it("returns null when nothing dockable is open", () => {
    expect(S.dockOnOpenPosition(self(360, 440), [], insets, null, 1600)).toBeNull()
  })

  it("single anchor: card-flush right — MATCHES the Rust panel_spawn_pos fixture (416,50,r)", () => {
    // Cross-check: the Rust test asserts panel_spawn_pos((100,50,360,440),360,1600)=(416,50,"r").
    const got = S.dockOnOpenPosition(self(360, 440), ms(["a", [100, 50, 360, 440]]), insets, "a", 1600)
    expect(got).toEqual({ x: 416, y: 50, anchor: "a", edge: "r" })
  })

  it("single anchor: overflow falls back to the LEFT — MATCHES Rust (984,50,l)", () => {
    const got = S.dockOnOpenPosition(self(360, 440), ms(["a", [1300, 50, 360, 440]]), insets, "a", 1600)
    expect(got).toEqual({ x: 984, y: 50, anchor: "a", edge: "l" })
  })

  it("docks past the WHOLE cluster, not just the anchor (card-flush cluster bbox)", () => {
    // A at (100,50); B card-flush to A's right (B.x = 100+360-44 = 416). The new
    // panel must land right of B (the cluster's right card edge), not over B.
    const members = ms(["a", [100, 50, 360, 440]], ["b", [416, 50, 360, 440]])
    const got = S.dockOnOpenPosition(self(360, 440), members, insets, "a", 9999)
    // cluster card bbox right = (416+22)+(360-44) = 754 → frame x = 754-22 = 732.
    expect(got).toEqual({ x: 732, y: 50, anchor: "a", edge: "r" })
  })

  it("prefers the named anchor (e.g. panel-chat) over the nearest", () => {
    const members = ms(["panel-chat", [100, 50, 360, 440]], ["widget-x", [40, 600, 360, 440]])
    const got = S.dockOnOpenPosition(self(360, 440), members, insets, "panel-chat", 9999)
    expect(got!.anchor).toBe("panel-chat")
  })

  it("without a prefer, picks the nearest by centre with a stable label tie-break", () => {
    const near: Member[] = ms(["far", [2000, 2000, 360, 440]], ["near", [60, 60, 360, 440]])
    const got = S.dockOnOpenPosition({ x: 50, y: 50, w: 360, h: 440 }, near, insets, null, 9999)
    expect(got!.anchor).toBe("near")
  })
})
