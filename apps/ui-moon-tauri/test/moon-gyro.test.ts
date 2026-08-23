// @vitest-environment jsdom
/**
 * moon-gyro.test.ts - the depth-sorted gyroscope orbit.
 *
 * Geometry is tested directly because the last two ring designs shipped wrong
 * precisely where nothing was tested: 0.0.73's dash lengths never checked
 * against the circumferences, 0.0.74's arcs never checked at true size. Here
 * the front/back split IS the feature (bloub's depth sort), so it gets pinned.
 */
import { describe, expect, it } from "vitest"
import {
  GYRO_BACK_DIM,
  GYRO_CX,
  GYRO_CY,
  GYRO_LONG_MULT,
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
  const rig = () => {
    const face = document.createElement("div")
    const eyes = document.createElement("div")
    const mk = () => document.createElementNS("http://www.w3.org/2000/svg", "path")
    const back = GYRO_RINGS.map(mk)
    const front = GYRO_RINGS.map(mk)
    const life = createMoonLife({
      lunaFace: face,
      lunaEyes: eyes as unknown as HTMLElement,
      gyroBack: back,
      gyroFront: front,
    })
    return { face, back, front, life }
  }

  it("drives the rings while the orbit is 'thinking' and flags data-gyro", () => {
    const { face, back, front, life } = rig()
    face.dataset["state"] = "busy"
    face.dataset["orbit"] = "thinking"
    life._frame(1000)
    life._frame(1033)
    expect(face.dataset["gyro"]).toBe("on")
    expect(front[0]!.getAttribute("d")).toBeTruthy()
    expect(back[0]!.getAttribute("d")).toBeTruthy()
    // Back half dimmer than front: the second depth cue.
    const fo = Number(front[0]!.style.opacity)
    const bo = Number(back[0]!.style.opacity)
    expect(fo).toBeGreaterThan(0)
    expect(bo).toBeCloseTo(fo * GYRO_BACK_DIM, 1)
  })

  it("parks the rings and clears the flag when the orbit goes quiet", () => {
    const { face, front, life } = rig()
    face.dataset["state"] = "busy"
    face.dataset["orbit"] = "thinking"
    life._frame(1000)
    life._frame(1033)
    face.dataset["state"] = ""
    delete face.dataset["orbit"]
    life._frame(1066)
    expect(face.dataset["gyro"]).toBeUndefined()
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

  it("does not drive the connecting/offline/listening states - those stay CSS", () => {
    const { face, front, life } = rig()
    face.dataset["state"] = "connecting"
    face.dataset["orbit"] = "connecting"
    life._frame(1000)
    life._frame(1033)
    expect(face.dataset["gyro"]).toBeUndefined()
    expect(front[0]!.getAttribute("d")).toBeNull()
  })

  it("stop() parks everything", () => {
    const { face, front, life } = rig()
    face.dataset["state"] = "busy"
    face.dataset["orbit"] = "thinking"
    life._frame(1000)
    life.stop()
    expect(face.dataset["gyro"]).toBeUndefined()
    expect(front[0]!.style.opacity).toBe("0")
  })
})
