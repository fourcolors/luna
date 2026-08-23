// @vitest-environment jsdom
/**
 * moon-gyro.test.ts - the depth-sorted gyroscope orbit.
 *
 * Geometry is tested directly because the last two ring designs shipped wrong
 * precisely where nothing was tested: 0.0.73's dash lengths never checked
 * against the circumferences, 0.0.74's arcs never checked at true size. Here
 * the front/back split IS the feature (bloub's depth sort), so it gets pinned.
 */
import { afterEach, describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  GYRO_BACK_DIM,
  GYRO_CX,
  GYRO_CY,
  GYRO_FRONT_DIM,
  GYRO_LONG_MULT,
  GYRO_ORBIT_STATES,
  GYRO_RINGS,
  gyroArc,
  gyroEntry,
} from "../frontend-react/src/chat/moonGyro"
import { createMoonLife } from "../frontend-react/src/chat/moonLife"

/** Pull the numeric points back out of a path string. */
const points = (d: string): Array<[number, number]> =>
  [...d.matchAll(/[ML]([\d.]+) ([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])])

describe("gyroArc - the depth split", () => {
  it("always yields BOTH a front and a back path, at any spin angle", () => {
    // Every sweep is over half a turn, so the z-sign must flip inside the
    // window no matter where the spin has rotated it to.
    for (const seed of GYRO_RINGS) {
      for (let a = 0; a < Math.PI * 2; a += Math.PI / 7) {
        const { front, back } = gyroArc(seed, a)
        expect(front.length, `front empty at angle ${a.toFixed(2)}`).toBeGreaterThan(0)
        expect(back.length, `back empty at angle ${a.toFixed(2)}`).toBeGreaterThan(0)
      }
    }
  })

  it("keeps every point within the ring's own semi-major axis of the centre", () => {
    for (const seed of GYRO_RINGS) {
      const { front, back } = gyroArc(seed, 1.234)
      for (const [x, y] of [...points(front), ...points(back)]) {
        const r = Math.hypot(x - GYRO_CX, y - GYRO_CY)
        expect(r).toBeLessThanOrEqual(seed.a + 0.51) // +rounding slack
      }
    }
  })

  it("produces no NaN and starts each path with a moveto", () => {
    const { front, back } = gyroArc(GYRO_RINGS[0]!, 0)
    expect(front).not.toContain("NaN")
    expect(back).not.toContain("NaN")
    expect(front.startsWith("M")).toBe(true)
    expect(back.startsWith("M")).toBe(true)
  })

  it("moves when the angle moves - the spin is real", () => {
    const a = gyroArc(GYRO_RINGS[0]!, 0)
    const b = gyroArc(GYRO_RINGS[0]!, 0.3)
    expect(a.front).not.toBe(b.front)
  })
})

describe("gyroEntry - staggered arrival", () => {
  it("brings rings in one by one", () => {
    // Just after activation ring 0 is fading in while ring 2 has not started.
    expect(gyroEntry(0.05, 0)).toBeGreaterThan(0)
    expect(gyroEntry(0.05, 2)).toBe(0)
  })
  it("settles at 0.92, never full opacity", () => {
    expect(gyroEntry(10, 0)).toBeCloseTo(0.92)
    expect(gyroEntry(10, 2)).toBeCloseTo(0.92)
  })
})

describe("the moonLife gyroscope driver", () => {
  const lives: Array<{ stop: () => void }> = []
  afterEach(() => {
    // start() arms a real interval; every rig must be torn down or it leaks
    // across the suite.
    for (const l of lives.splice(0)) l.stop()
  })

  const rig = (opts?: { ringCount?: number; start?: boolean }) => {
    const face = document.createElement("div")
    const eyes = document.createElement("div")
    const mk = () => document.createElementNS("http://www.w3.org/2000/svg", "path")
    const n = opts?.ringCount ?? GYRO_RINGS.length
    const back = Array.from({ length: n }, mk)
    const front = Array.from({ length: n }, mk)
    const life = createMoonLife({
      lunaFace: face,
      lunaEyes: eyes as unknown as HTMLElement,
      gyroBack: back,
      gyroFront: front,
    })
    if (opts?.start !== false) life.start()
    lives.push(life)
    return { face, back, front, life }
  }

  it("start() claims the orbit channel immediately - data-gyro is on BEFORE any frame", () => {
    // The flag set per-frame lagged the state change by a tick and flashed
    // the CSS ellipse at every turn start; owning the channel from start()
    // is the fix, so it is pinned here.
    const { face } = rig()
    expect(face.dataset["gyro"]).toBe("on")
  })

  it("drives the rings while the orbit is 'thinking'", () => {
    const { face, back, front, life } = rig()
    face.dataset["state"] = "busy"
    face.dataset["orbit"] = "thinking"
    life._frame(1000)
    life._frame(1100)
    life._frame(1200) // settled past the 0.3s entry ramp (dt caps at 0.1)
    life._frame(1300)
    expect(front[0]!.getAttribute("d")).toBeTruthy()
    expect(back[0]!.getAttribute("d")).toBeTruthy()
    // Depth cues: the back half is dimmer than the front by the ratio of the
    // two dims (both start from the same entry opacity).
    const fo = Number(front[0]!.style.opacity)
    const bo = Number(back[0]!.style.opacity)
    expect(fo).toBeGreaterThan(0)
    expect(bo / fo).toBeCloseTo(GYRO_BACK_DIM / GYRO_FRONT_DIM, 1)
  })

  it("parks the rings when the orbit goes quiet - but keeps owning the channel", () => {
    const { face, front, life } = rig()
    face.dataset["state"] = "busy"
    face.dataset["orbit"] = "thinking"
    life._frame(1000)
    life._frame(1033)
    face.dataset["state"] = ""
    delete face.dataset["orbit"]
    life._frame(1066)
    // Arcs park; the flag stays, because it means "driver alive", and the CSS
    // stand-down rule only matches thinking/long anyway.
    expect(face.dataset["gyro"]).toBe("on")
    expect(front[0]!.style.opacity).toBe("0")
  })

  it("keeps spinning across a thinking->long escalation (no teleport)", () => {
    const { face, front, life } = rig()
    face.dataset["state"] = "busy"
    face.dataset["orbit"] = "thinking"
    life._frame(1000)
    life._frame(1033)
    const before = front[0]!.getAttribute("d")
    face.dataset["orbit"] = "long"
    life._frame(1066)
    const after = front[0]!.getAttribute("d")
    expect(after).toBeTruthy()
    expect(after).not.toBe(before) // still advancing, faster
    expect(GYRO_LONG_MULT).toBeGreaterThan(1)
  })

  it("a backward timestamp dims at most one frame - it never blanks the rings", () => {
    // Production time is performance.now() (monotonic), but the _frame seam
    // takes arbitrary values and a wall-clock step must not zero tActive.
    const { face, front, life } = rig()
    face.dataset["state"] = "busy"
    face.dataset["orbit"] = "thinking"
    life._frame(1000)
    life._frame(1500) // well past the entry ramp for ring 0
    life._frame(400) // clock steps back a second
    expect(Number(front[0]!.style.opacity)).toBeGreaterThan(0)
  })

  it("does not drive the connecting/offline/listening states - those stay CSS", () => {
    const { face, front, life } = rig()
    face.dataset["state"] = "connecting"
    face.dataset["orbit"] = "connecting"
    life._frame(1000)
    life._frame(1033)
    expect(front[0]!.getAttribute("d")).toBeNull()
  })

  it("refuses to half-drive a markup/seed mismatch", () => {
    // Fewer paths than seeds = a markup edit drifted. Half-driving would
    // misalign colours with seeds; the driver must no-op entirely.
    const { face, front, life } = rig({ ringCount: GYRO_RINGS.length - 1 })
    face.dataset["state"] = "busy"
    face.dataset["orbit"] = "thinking"
    life._frame(1000)
    life._frame(1033)
    expect(front[0]!.getAttribute("d")).toBeNull()
  })

  it("stop() parks everything and releases the channel", () => {
    const { face, front, life } = rig()
    face.dataset["state"] = "busy"
    face.dataset["orbit"] = "thinking"
    life._frame(1000)
    life.stop()
    expect(face.dataset["gyro"]).toBeUndefined()
    expect(front[0]!.style.opacity).toBe("0")
  })
})

describe("chat.html wiring - the part the synthetic rig cannot see", () => {
  // The depth sort IS the feature: back halves must be drawn before
  // .luna-bob and front halves after, one path per seed, colours in seed
  // order. A markup edit that breaks any of this ships green through every
  // other test, because they all build their own paths.
  const html = readFileSync(join(__dirname, "../frontend-react/chat.html"), "utf8")

  it("draws back halves before the moon body and front halves after", () => {
    const back = html.indexOf('class="luna-gyro-back"')
    const bob = html.indexOf('<g class="luna-bob">')
    const front = html.indexOf('class="luna-gyro-front"')
    expect(back).toBeGreaterThan(-1)
    expect(bob).toBeGreaterThan(back)
    expect(front).toBeGreaterThan(bob)
  })

  it("chat.html's selector chains agree with GYRO_ORBIT_STATES", () => {
    // The {thinking, long} set is declared once in moonGyro and consumed by
    // moonLife's gate AND two CSS selector chains. Build the chains FROM the
    // constant and require them verbatim, so adding a third gyro state (or
    // renaming one) cannot leave CSS and driver disagreeing - the failure
    // mode is a state with both ring systems visible, or neither.
    const park = `.luna-face${GYRO_ORBIT_STATES.map((s) => `:not([data-orbit="${s}"])`).join("")} .luna-gyro-arc`
    expect(html, "arc park belt drifted from GYRO_ORBIT_STATES").toContain(park)
    for (const state of GYRO_ORBIT_STATES) {
      expect(html, `ellipse stand-down missing for "${state}"`).toContain(
        `.luna-face[data-gyro="on"][data-orbit="${state}"] .luna-ring`,
      )
    }
  })

  it("has exactly one path per seed in each half, colours in seed order", () => {
    for (const cls of ["luna-gyro-back", "luna-gyro-front"]) {
      const start = html.indexOf(`class="${cls}"`)
      const end = html.indexOf("</g>", start)
      const group = html.slice(start, end)
      const paths = [...group.matchAll(/luna-gyro-c(\d)/g)].map((m) => Number(m[1]))
      expect(paths, cls).toEqual(GYRO_RINGS.map((_, i) => i + 1))
    }
  })
})
