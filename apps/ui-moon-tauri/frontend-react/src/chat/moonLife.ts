/**
 * moonLife.ts - gaze drift, pointer tracking and the idle flourish.
 *
 * bloub's finding, and the reason this exists: what reads as alive is gaze
 * drift and blinking, NOT floating. Blinking is already a CSS keyframe; this is
 * the gaze half, plus the rare shooting star.
 *
 * THE ONLY TIMER ON THE FACE. Everything else - rings, transients, blink,
 * mouth - is a CSS keyframe, because CSS is cheaper and already WKWebView-tuned.
 * Gaze cannot be, because it follows a pointer. So the loop is kept small: it
 * writes two numbers onto one element and runs at 30fps.
 *
 * It genuinely STOPS only for reduced motion (never starts) and while the
 * document is hidden. When the face is busy it keeps ticking and early-returns
 * after one dataset read - cheap, but not free, and worth stating accurately
 * rather than claiming it stops.
 */

import { GYRO_BACK_DIM, GYRO_FRONT_DIM, GYRO_LONG_MULT, GYRO_ORBIT_STATES, GYRO_RINGS, gyroArc, gyroEntry } from "./moonGyro"

export interface MoonLifeDom {
  readonly lunaFace: HTMLElement | null
  /** The group the gaze offset is applied to. */
  readonly lunaEyes: HTMLElement | null
  /** Far halves of the gyroscope rings (occluded by the moon body). One path
   *  per GYRO_RINGS entry, in order. Optional: tests and older callers that
   *  omit them simply get no gyroscope. */
  readonly gyroBack?: readonly SVGPathElement[]
  /** Near halves, drawn over the face. Same order. */
  readonly gyroFront?: readonly SVGPathElement[]
  /** The reduced-motion media query result. Injected like every other window
   *  concern so BOTH branches are testable - the ambient read below is only
   *  the production default, and vitest-setup pins the global stub to
   *  matches:false, which left the reduced branch with zero coverage. */
  readonly reducedMotion?: { matches: boolean }
}

export interface MoonLifeApi {
  start: () => void
  stop: () => void
  /** Test seam: advance one frame at an explicit time. */
  _frame: (nowMs: number) => void
}

/** ~30fps. An INTERVAL, not requestAnimationFrame: a self-rescheduling rAF loop
 *  recurses synchronously under faked timers and blows the stack, and an
 *  interval cannot. Visibility is handled explicitly below, which is the only
 *  thing rAF would have given us for free. */
const TICK_MS = 33

/** Periodic 1D noise, seamless over `period`. Gives drift a wander that never
 *  repeats visibly and never jumps at the loop point. */
export function loopNoise(t: number, period: number, seed = 0): number {
  const p = (t / period) * Math.PI * 2
  return (
    0.55 * Math.sin(p + seed) +
    0.3 * Math.sin(2 * p + seed * 1.7 + 1.1) +
    0.15 * Math.sin(3 * p + seed * 2.3 + 2.4)
  )
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

/** Eye travel, in viewBox units of the 120-unit face. Deliberately small: the
 *  eyes should suggest attention, not swivel. */
const DRIFT = 2.6
const POINTER = 3.4
/** States where she is composed enough to be looking around. During a turn or
 *  a voice exchange the face has its own business. */
const ALIVE_STATES = new Set(["", "suggesting"])

/** Flourish budget. Idle this long before she is allowed one at all, then a
 *  1-in-3 roll each interval. Rare on purpose: the shooting star is the only
 *  purely-decorative thing on the face, so it has to stay a surprise. */
export const FLOURISH_AFTER_MS = 4 * 60 * 1000
export const FLOURISH_EVERY_MS = 90 * 1000
export const FLOURISH_CHANCE = 1 / 3
const SHOOT_MS = 2400

export function createMoonLife(DOM: MoonLifeDom): MoonLifeApi {
  let timer: ReturnType<typeof setInterval> | null = null
  let idleSince = -1
  let lastRoll = 0
  let shooting = false
  let shootTimer: ReturnType<typeof setTimeout> | null = null
  let look = { x: 0, y: 0 }
  let applied = ""
  let running = false
  /** Whether the gyroscope is currently driving. The entry ramp is driven by
   *  gyroT below, never by wall-time - see the dt notes. */
  let gyroOn = false
  let gyroLastNow = 0
  /** Seconds since activation, ACCUMULATED from floored dt - never derived
   *  from wall-time, so a backward timestamp cannot rewind the entry ramp
   *  and blank the rings. */
  let gyroT = 0
  /** Accumulated spin per ring, radians. Advanced by dt x speed each frame so
   *  the thinking->long speed change ACCELERATES instead of teleporting the
   *  rings to where a faster wall-clock formula says they should be. */
  const gyroAngle = GYRO_RINGS.map(() => 0)

  const reduced =
    DOM.reducedMotion?.matches ??
    (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches)

  function onPointerMove(e: PointerEvent) {
    const face = DOM.lunaFace
    if (!face) return
    const r = face.getBoundingClientRect()
    if (!r.width || !r.height) return
    // Normalised offset from the face's centre, clamped so a pointer on the far
    // side of the screen does not peg the eyes at their limit forever.
    look = {
      x: clamp((e.clientX - (r.left + r.width / 2)) / 220, -1, 1),
      y: clamp((e.clientY - (r.top + r.height / 2)) / 180, -1, 1),
    }
  }

  /** Drive (or park) the gyroscope. Runs BEFORE the alive-states gate below:
   *  the gyroscope's whole life is spent in busy states the gaze code exits
   *  on, so it cannot live after that return. */
  function driveGyro(face: HTMLElement, nowMs: number) {
    const back = DOM.gyroBack
    const front = DOM.gyroFront
    // EXACT length: a seed with no matching <path> would silently drop a ring
    // (or worse, misalign colours with seeds), so a mismatched markup edit
    // no-ops the whole gyroscope loudly-in-tests instead of half-working.
    if (back?.length !== GYRO_RINGS.length || front?.length !== GYRO_RINGS.length) return
    const orbit = face.dataset["orbit"] ?? ""
    const active = (GYRO_ORBIT_STATES as readonly string[]).includes(orbit)
    if (!active) {
      if (gyroOn) {
        gyroOn = false
        // Inline STYLE, not the opacity attribute: the stylesheet's
        // `.luna-gyro-arc { opacity: 0 }` base outranks any presentation
        // attribute, so attribute writes would never show at all.
        // (data-gyro is NOT touched here - it means "the driver owns the
        // orbit channel", set in start(), cleared in stop(). Managed per
        // frame it lagged the state change and flashed the CSS ellipse at
        // every turn start.)
        for (const p of back) p.style.opacity = "0"
        for (const p of front) p.style.opacity = "0"
      }
      return
    }
    if (!gyroOn) {
      gyroOn = true
      gyroLastNow = nowMs
      gyroT = 0
    }
    // Floor as well as cap: nowMs is monotonic in production (see resume()),
    // but the public _frame() seam takes arbitrary timestamps.
    const dt = Math.max(0, Math.min(0.1, (nowMs - gyroLastNow) / 1000))
    gyroLastNow = nowMs
    const mult = orbit === "long" ? GYRO_LONG_MULT : 1
    gyroT += dt
    GYRO_RINGS.forEach((seed, i) => {
      const angle = (gyroAngle[i] ?? 0) - dt * seed.speed * mult * Math.PI * 2
      gyroAngle[i] = angle
      const { front: fd, back: bd } = gyroArc(seed, angle)
      const o = gyroEntry(gyroT, i)
      const f = front[i]
      const b = back[i]
      if (f) { f.setAttribute("d", fd); f.style.opacity = (o * GYRO_FRONT_DIM).toFixed(2) }
      if (b) { b.setAttribute("d", bd); b.style.opacity = (o * GYRO_BACK_DIM).toFixed(2) }
    })
  }

  function frame(nowMs: number) {
    const eyes = DOM.lunaEyes
    const face = DOM.lunaFace
    if (!eyes || !face) return
    driveGyro(face, nowMs)
    const state = face.dataset["state"] ?? ""
    if (!ALIVE_STATES.has(state)) {
      // Not idle: hand the eyes back to whatever the state rule wants, once.
      if (applied !== "") { applied = ""; eyes.removeAttribute("transform") }
      idleSince = -1
      return
    }
    maybeFlourish(face, nowMs)
    const t = nowMs / 1000
    const x = loopNoise(t, 9.1, 0.4) * DRIFT + look.x * POINTER
    const y = loopNoise(t, 7.3, 2.2) * DRIFT * 0.6 + look.y * POINTER * 0.7
    const next = `translate(${x.toFixed(2)} ${y.toFixed(2)})`
    if (next !== applied) { applied = next; eyes.setAttribute("transform", next) }
  }

  /** Roll for a shooting star. Never during a turn (the caller only reaches
   *  here in an idle state), never while one is already crossing. */
  function maybeFlourish(face: HTMLElement, nowMs: number) {
    if (idleSince < 0) { idleSince = nowMs; lastRoll = nowMs; return }
    if (shooting) return
    if (nowMs - idleSince < FLOURISH_AFTER_MS) return
    if (nowMs - lastRoll < FLOURISH_EVERY_MS) return
    lastRoll = nowMs
    if (Math.random() >= FLOURISH_CHANCE) return
    shooting = true
    face.classList.add("is-shooting")
    // Tracked like every other timer in this arc: stop() must be able to
    // cancel it, or a 2400ms callback outlives teardown holding `face`.
    shootTimer = setTimeout(() => {
      shootTimer = null
      face.classList.remove("is-shooting")
      shooting = false
    }, SHOOT_MS)
  }

  function resume() {
    if (timer || !running) return
    // performance.now(), not Date.now(): every use of nowMs is a DELTA (dt,
    // tActive, idle age), and a backward wall-clock step would blank the
    // rings for the length of the step via a negative tActive.
    timer = setInterval(() => frame(performance.now()), TICK_MS)
  }
  function pause() {
    if (timer) { clearInterval(timer); timer = null }
  }
  function onVisibility() {
    if (document.hidden) pause()
    else resume()
  }

  return {
    start() {
      // Reduced motion gets no drift at all, not slower drift: the whole point
      // of the setting is that nothing moves on its own.
      if (reduced || running) return
      running = true
      // "The driver owns the orbit channel." The CSS ellipse stand-down keys
      // on this, and it must be true from the FIRST paint of a busy state -
      // set per-frame it arrived a tick late and flashed the old ellipse.
      // Reduced motion returned above, so the flag doubles as "not reduced
      // at boot" and the CSS fallback story holds.
      if (DOM.lunaFace && DOM.gyroBack?.length && DOM.gyroFront?.length) {
        DOM.lunaFace.dataset["gyro"] = "on"
      }
      window.addEventListener("pointermove", onPointerMove, { passive: true })
      document.addEventListener("visibilitychange", onVisibility)
      resume()
    },
    stop() {
      running = false
      pause()
      if (shootTimer) { clearTimeout(shootTimer); shootTimer = null }
      window.removeEventListener("pointermove", onPointerMove)
      document.removeEventListener("visibilitychange", onVisibility)
      const eyes = DOM.lunaEyes
      if (eyes) eyes.removeAttribute("transform")
      DOM.lunaFace?.classList.remove("is-shooting")
      applied = ""
      idleSince = -1
      shooting = false
      // Park the gyroscope and hand the orbit channel back to the CSS rings.
      gyroOn = false
      if (DOM.lunaFace) delete DOM.lunaFace.dataset["gyro"]
      for (const p of DOM.gyroBack ?? []) p.style.opacity = "0"
      for (const p of DOM.gyroFront ?? []) p.style.opacity = "0"
    },
    _frame(nowMs) { frame(nowMs) },
  }
}
