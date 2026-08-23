/**
 * moonGyro.ts - the thinking/long orbit as a depth-sorted gyroscope.
 *
 * Ported from bloub's `arcRender` (github.com/jeremy-prt/bloub, MIT,
 * src/bot/decor.ts): each ring is a genuine 3D circle living in the plane
 * spanned by u (in-screen, along `tilt`) and v (diving into depth, of which
 * only `k` projects on-screen). The z component's SIGN splits the ring into a
 * back path (drawn before the moon body, so occluded by it) and a front path
 * (drawn after, crossing the face). bloub's own comment on why: it is this
 * true depth sort that makes rings read as ORBITS and not as a flat drawing -
 * every earlier CSS attempt here (0.0.73's broken halos, 0.0.74's arcs that
 * read as sticks) failed for exactly that missing reason.
 *
 * PURE MATH ONLY. No DOM, no timers - the driver lives in moonLife.ts (the
 * face's one sanctioned loop) and calls these per frame. Pure functions are
 * what let the geometry be unit-tested, and untested geometry is how the last
 * two ring designs shipped wrong.
 *
 * Tuning vs bloub: their orbit is a 3.4s one-shot burst - six rings, ~3.3
 * turns/s, full rainbow. This is a persistent state someone stares at for a
 * whole turn, so: three rings, roughly a third the speed, moonlight palette
 * (the colours live in chat.html's CSS, one class per ring).
 */

export interface GyroSeed {
  /** Semi-major axis, in viewBox units (120-unit face, body r=47). */
  readonly a: number
  /** Projected flattening of the depth axis: small = seen nearly edge-on. */
  readonly k: number
  /** Orientation of the in-screen axis, radians. */
  readonly tilt: number
  /** Turns per second at thinking pace. */
  readonly speed: number
  /** Starting angle, radians - staggered so rings never align. */
  readonly phase: number
  /** Fraction of the full circle the arc covers. */
  readonly sweep: number
}

const TAU = Math.PI * 2

/** Face geometry: the rings orbit the moon body (cx 60, cy 60, r 47). */
export const GYRO_CX = 60
export const GYRO_CY = 60

/**
 * Three rings, tilts fanned across the half-circle like bloub's six, radii
 * just past the body's 47 (the old CSS rings topped out at rx 58, same
 * footprint). Sweeps 62-70% - long enough to read as rings, and any window
 * over half a turn is guaranteed to cross z=0, so both the front and the back
 * path always exist.
 */
export const GYRO_RINGS: readonly GyroSeed[] = [
  { a: 57, k: 0.18, tilt: 0.35, speed: 0.9, phase: 0.8, sweep: 0.7 },
  { a: 53, k: 0.38, tilt: 1.45, speed: 1.15, phase: 3.1, sweep: 0.62 },
  { a: 59, k: 0.1, tilt: 2.45, speed: 1.0, phase: 5.2, sweep: 0.66 },
]

/** A long turn spins the same rings harder rather than changing costume. */
export const GYRO_LONG_MULT = 1.6

/** The far half is dimmer - the second depth cue after occlusion. */
export const GYRO_BACK_DIM = 0.55

/** The near half is softened too: it crosses the FACE, and at 44px a
 *  full-opacity stroke over a 4-unit eye reads as a smudge, not as depth.
 *  Pairs with the thinner front stroke-width in chat.html. */
export const GYRO_FRONT_DIM = 0.7

/** Samples per arc. bloub uses 64 at full-screen size; 44 is indistinguishable
 *  at a 44px header and a third cheaper per frame. */
const N = 44

export interface GyroPaths {
  readonly front: string
  readonly back: string
}

/**
 * One ring's front/back path data at absolute spin angle `angle` (radians).
 *
 * The caller owns the angle (accumulated with dt x speed) rather than passing
 * wall-time, so a thinking->long speed change accelerates smoothly instead of
 * teleporting the rings to where the faster clock says they should be.
 */
export function gyroArc(seed: GyroSeed, angle: number): GyroPaths {
  const spin = seed.phase + angle
  const cu = Math.cos(seed.tilt)
  const su = Math.sin(seed.tilt)
  const kz = Math.sqrt(Math.max(0, 1 - seed.k * seed.k))
  const span = seed.sweep * TAU
  let front = ""
  let back = ""
  let prev: boolean | null = null
  for (let i = 0; i <= N; i++) {
    const th = spin + (i / N) * span
    const ct = Math.cos(th)
    const st = Math.sin(th)
    const x = GYRO_CX + seed.a * (ct * cu - st * su * seed.k)
    const y = GYRO_CY + seed.a * (ct * su + st * cu * seed.k)
    const z = st * kz
    const behind = z < 0
    const cmd = behind !== prev ? "M" : "L"
    const pt = `${cmd}${x.toFixed(1)} ${y.toFixed(1)}`
    if (behind) back += pt
    else front += pt
    prev = behind
  }
  return { front, back }
}

/**
 * Ring opacity `tSec` seconds after the gyroscope became active: they enter
 * one by one (bloub's stagger), then hold. 0.92 not 1 so the rings sit behind
 * the face in visual weight - they are weather, not the character.
 */
export function gyroEntry(tSec: number, i: number): number {
  const raw = (tSec - i * 0.13) / 0.3
  return Math.min(1, Math.max(0, raw)) * 0.92
}
