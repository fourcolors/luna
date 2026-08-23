/**
 * moonLife.ts - gaze drift, pointer tracking and the idle flourish.
 *
 * bloub's finding, and the reason this exists: what reads as alive is gaze
 * drift and blinking, NOT floating. Blinking is already a CSS keyframe; this is
 * the gaze half, plus the rare shooting star.
 *
 * THE ONLY rAF LOOP ON THE FACE. Everything else - rings, transients, blink,
 * mouth - is a CSS keyframe, because CSS is cheaper and already WKWebView-tuned.
 * Gaze cannot be, because it follows a pointer. So this loop is kept as small as
 * it can be: it writes two numbers onto one element, runs at 30fps, and stops
 * entirely when the document is hidden, when motion is reduced, or when the
 * face is not idle enough to be looking around.
 */

export interface MoonLifeDom {
  readonly lunaFace: HTMLElement | null
  /** The group the gaze offset is applied to. */
  readonly lunaEyes: HTMLElement | null
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
  let tick = 0
  let idleSince = -1
  let lastRoll = 0
  let shooting = false
  let look = { x: 0, y: 0 }
  let applied = ""
  let running = false

  const reduced =
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches

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

  function frame(nowMs: number) {
    tick++
    const eyes = DOM.lunaEyes
    const face = DOM.lunaFace
    if (!eyes || !face) return
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
    setTimeout(() => {
      face.classList.remove("is-shooting")
      shooting = false
    }, SHOOT_MS)
  }

  function resume() {
    if (timer || !running) return
    timer = setInterval(() => frame(Date.now()), TICK_MS)
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
      window.addEventListener("pointermove", onPointerMove, { passive: true })
      document.addEventListener("visibilitychange", onVisibility)
      resume()
    },
    stop() {
      running = false
      pause()
      window.removeEventListener("pointermove", onPointerMove)
      document.removeEventListener("visibilitychange", onVisibility)
      const eyes = DOM.lunaEyes
      if (eyes) eyes.removeAttribute("transform")
      DOM.lunaFace?.classList.remove("is-shooting")
      applied = ""
      idleSince = -1
      shooting = false
    },
    _frame(nowMs) { frame(nowMs) },
  }
}
