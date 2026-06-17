/**
 * dock-live-drag.test.ts — CONFORMANCE of the live-drag math against the
 * design file's actual behavior.
 *
 * This is the golden-reference harness: `refOnMove` below is a direct,
 * independent port of the Luna Dock design file's drag step
 * (the Luna Dock prototype's luna-dock.jsx → its dockSnap + onMove). We then
 * assert that `LunaDeckSnap.computeLiveDrag` (the math
 * the Moon live-drag handler will call every pointermove) lands EVERY window at
 * the EXACT same position the design would — for both a plain module drag and a
 * whole-cluster anchor drag. If this passes, the Moon drag math IS the design's.
 *
 * Integer coordinates throughout so the reference's unrounded snap == the
 * implementation's Math.round'd snap (rounding is a no-op on integers).
 */
import { readFileSync } from "node:fs"
import * as path from "node:path"
import { describe, expect, it, beforeAll } from "vitest"

interface Rect { x: number; y: number; w: number; h: number }
interface Member { label: string; ox: number; oy: number }
interface Drag {
  ox: number; oy: number; ow: number; oh: number
  dx: number; dy: number
  members: Member[]
}
interface Candidate { label: string; rect: Rect }
interface Target { label: string; x: number; y: number }

let computeLiveDrag: (
  drag: Drag,
  candidates: Candidate[],
  threshold?: number,
) => { targets: Target[]; snapped: boolean; anchor: string | null; edge: string | null }

interface Monitor { x: number; y: number; w: number; h: number; sf: number }
let logicalToPhysical: (
  x: number,
  y: number,
  monitors: Monitor[],
) => { x: number; y: number } | null

beforeAll(() => {
  const src = readFileSync(path.resolve(__dirname, "../frontend/vendor/deck-snap.js"), "utf8")
  const sandbox: Record<string, unknown> = {}
  new Function("globalThis", src)(sandbox)
  const ns = sandbox.LunaDeckSnap as {
    computeLiveDrag: typeof computeLiveDrag
    logicalToPhysical: typeof logicalToPhysical
  }
  computeLiveDrag = ns.computeLiveDrag
  logicalToPhysical = ns.logicalToPhysical
})

// ── GOLDEN REFERENCE — ported verbatim from luna-dock.jsx ──────────────────
const SNAP = 30 // jsx:9

// jsx dockSnap (164-185): 8 corner-aligned candidates, nearest by 2D distance
// from the dragged window's lead position, within SNAP.
function refDockSnap(a: Rect, others: Rect[]): { x: number; y: number } | null {
  let best: { x: number; y: number; d: number } | null = null
  const consider = (x: number, y: number) => {
    const d = Math.hypot(a.x - x, a.y - y)
    if (d <= SNAP && (!best || d < best.d)) best = { x, y, d }
  }
  for (const b of others) {
    const bh = b.h
    consider(b.x, b.y + bh) //              below · left
    consider(b.x + b.w - a.w, b.y + bh) //  below · right
    consider(b.x, b.y - a.h) //             above · left
    consider(b.x + b.w - a.w, b.y - a.h) // above · right
    consider(b.x + b.w, b.y) //             right · top
    consider(b.x + b.w, b.y + bh - a.h) //  right · bottom
    consider(b.x - a.w, b.y) //             left  · top
    consider(b.x - a.w, b.y + bh - a.h) //  left  · bottom
  }
  return best ? { x: best.x, y: best.y } : null
}

// jsx onMove (245-256): lead = origin+cursor; snap; translate the whole group
// by (snappedTarget - origin).
function refOnMove(drag: Drag, others: Rect[]): Target[] {
  const lead: Rect = { x: drag.ox + drag.dx, y: drag.oy + drag.dy, w: drag.ow, h: drag.oh }
  const snap = refDockSnap(lead, others)
  const tx = snap ? snap.x : lead.x
  const ty = snap ? snap.y : lead.y
  const fdx = tx - drag.ox
  const fdy = ty - drag.oy
  return drag.members.map((m) => ({ label: m.label, x: m.ox + fdx, y: m.oy + fdy }))
}

// Run the same scenario through BOTH and assert identical window targets.
function expectMatchesDesign(drag: Drag, candidates: Candidate[]) {
  const ref = refOnMove(drag, candidates.map((c) => c.rect))
  const got = computeLiveDrag(drag, candidates)
  expect(got.targets).toEqual(ref)
  return got
}

describe("computeLiveDrag — conforms to the Luna Dock design's onMove", () => {
  const anchorRect: Rect = { x: 500, y: 300, w: 360, h: 600 }

  it("a module dragged near the anchor's bottom-left corner snaps below, left-aligned", () => {
    // module origin below-right of the tile; cursor pulls it toward (500,900).
    const drag: Drag = {
      ox: 540, oy: 920, ow: 360, oh: 200, dx: -40, dy: -22,
      members: [{ label: "mod", ox: 540, oy: 920 }],
    }
    const got = expectMatchesDesign(drag, [{ label: "anchor", rect: anchorRect }])
    expect(got.snapped).toBe(true)
    expect(got.targets[0]).toEqual({ label: "mod", x: 500, y: 900 }) // flush below, left-aligned
  })

  it("dragging the ANCHOR tows the whole cluster 1:1 when nothing's in range", () => {
    const drag: Drag = {
      ox: 500, oy: 300, ow: 360, oh: 600, dx: 50, dy: 30,
      members: [
        { label: "anchor", ox: 500, oy: 300 },
        { label: "below", ox: 500, oy: 900 },
      ],
    }
    const got = expectMatchesDesign(drag, []) // no other windows
    expect(got.snapped).toBe(false)
    expect(got.targets).toEqual([
      { label: "anchor", x: 550, y: 330 },
      { label: "below", x: 550, y: 930 }, // moved by the SAME (50,30) — cluster intact
    ])
  })

  it("a module dragged clear of every window free-drags (no snap → detach on release)", () => {
    const drag: Drag = {
      ox: 1600, oy: 1200, ow: 300, oh: 200, dx: 80, dy: 60,
      members: [{ label: "mod", ox: 1600, oy: 1200 }],
    }
    const got = expectMatchesDesign(drag, [{ label: "anchor", rect: anchorRect }])
    expect(got.snapped).toBe(false)
    expect(got.targets[0]).toEqual({ label: "mod", x: 1680, y: 1260 }) // raw cursor delta
  })

  it("picks the NEAREST candidate window to snap against", () => {
    const near: Rect = { x: 200, y: 300, w: 360, h: 200 } // its bottom tile is closest
    const far: Rect = { x: 2000, y: 2000, w: 360, h: 200 }
    const drag: Drag = {
      ox: 205, oy: 506, ow: 360, oh: 200, dx: 0, dy: 0, // already ~at near's below tile (200,500)
      members: [{ label: "mod", ox: 205, oy: 506 }],
    }
    const got = expectMatchesDesign(drag, [
      { label: "far", rect: far },
      { label: "near", rect: near },
    ])
    expect(got.anchor).toBe("near")
    expect(got.targets[0]).toEqual({ label: "mod", x: 200, y: 500 })
  })
})

// ── logicalToPhysical — the mixed-DPI write fix ────────────────────────────
// A LogicalPosition write across a 2× laptop / 1× external seam flickers
// because the platform reconverts using the dragged window's own (seam-
// bistable) scale factor. logicalToPhysical resolves each target to a PHYSICAL
// position using the DESTINATION monitor's DPI instead, picked by the target
// POINT so the chosen factor stays stable regardless of how much has crossed.
describe("logicalToPhysical — places targets at the destination monitor's DPI", () => {
  // The classic MacBook setup: Retina built-in (2×) at the origin, a 1×
  // external to its right. Monitor rects are PHYSICAL px exactly as Tauri's
  // availableMonitors() reports them; logical (point) widths are half / equal.
  //   laptop   : physical 2880×1800 @ (0,0)     → logical 1440×900  @ point (0,0)
  //   external : physical 1920×1080 @ (1440,0)  → logical 1920×1080 @ point (1440,0)
  const laptop: Monitor = { x: 0, y: 0, w: 2880, h: 1800, sf: 2 }
  const external: Monitor = { x: 1440, y: 0, w: 1920, h: 1080, sf: 1 }
  const monitors = [laptop, external]

  it("a point on the Retina laptop scales by 2×", () => {
    expect(logicalToPhysical(100, 100, monitors)).toEqual({ x: 200, y: 200 })
  })

  it("a point on the 1× external scales by 1× (no flicker — destination DPI wins)", () => {
    // point (1500,100) is inside the external's logical rect [1440,3360)×[0,1080)
    expect(logicalToPhysical(1500, 100, monitors)).toEqual({ x: 1500, y: 100 })
  })

  it("the same logical point resolves differently per monitor — that's the bug being fixed", () => {
    // 1439 (still laptop) → ×2; 1441 (now external) → ×1. The factor is chosen
    // by where the point IS, never by the window's straddling state, so it
    // can't oscillate between frames for a given cursor position.
    expect(logicalToPhysical(1439, 10, monitors)).toEqual({ x: 2878, y: 20 })
    expect(logicalToPhysical(1441, 10, monitors)).toEqual({ x: 1441, y: 10 })
  })

  it("a point past every display falls back to the NEAREST monitor, not monitors[0]", () => {
    // far right of the external → still the external's 1×, not the laptop's 2×
    expect(logicalToPhysical(5000, 100, monitors)).toEqual({ x: 5000, y: 100 })
  })

  it("returns null with no layout so the caller keeps the LogicalPosition path", () => {
    expect(logicalToPhysical(100, 100, [])).toBeNull()
    expect(logicalToPhysical(100, 100, undefined as unknown as Monitor[])).toBeNull()
  })
})
