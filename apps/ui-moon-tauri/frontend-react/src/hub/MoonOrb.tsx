/**
 * MoonOrb.tsx - the draggable crescent-moon orb + its two ambient pips,
 * ported 1:1 from the deleted vanilla `DOM.moon`/`UIController`/pip markup
 * in frontend/index.html. Same class names/ids as the vanilla markup so the
 * page's untouched <style> block (kept verbatim in index.html, per the
 * project brief's "window-envelope chrome... keep their existing CSS
 * untouched") paints an identical result.
 *
 * Parallax/tilt/press-scale is applied directly to this component's own DOM
 * nodes via refs, synchronously inside the pointer handlers that produced
 * them - the same thing every React drag/parallax implementation does for
 * per-frame perf, and NOT the DOM-poking-from-a-transport-callback pattern
 * the project brief warns against (WS/Tauri callbacks below only ever
 * dispatch into the hub store; only voice-state/absorb effects, which are
 * driven by that store, touch this component's DOM directly, and only
 * because CSS custom properties have no JSX prop equivalent).
 */
import { useEffect, useRef } from "react"
import type { HubController } from "./hubEngines"
import type { HubState } from "./hubReducer"

export interface MoonOrbProps {
  readonly controller: HubController
  readonly state: HubState
}

const PRESS_MS = 280
const PRESS_DIST_PX = 5

export function MoonOrb({ controller, state }: MoonOrbProps): React.JSX.Element {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const pressRef = useRef({ time: 0, x: 0, y: 0 })

  // ── voice-state visuals (data-voice-state + --voice-level) ────────────
  useEffect(() => {
    const w = wrapperRef.current
    if (!w) return
    w.dataset.voiceState = state.voiceState
    if (state.voiceState === "listening") {
      w.style.setProperty("--voice-level", String(state.voiceLevel))
    } else {
      w.style.removeProperty("--voice-level")
    }
  }, [state.voiceState, state.voiceLevel])

  // ── "absorbed into the moon" pulse (re-armable: drop then re-add the
  // class so the CSS animation can replay on every collapse) ────────────
  useEffect(() => {
    const w = wrapperRef.current
    if (!w || !state.absorbing) return
    w.classList.remove("absorbing")
    void w.offsetWidth // reflow so re-adding the class restarts the animation
    w.classList.add("absorbing")
  }, [state.absorbing])

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>): void {
    pressRef.current = { time: Date.now(), x: e.clientX, y: e.clientY }
    if (wrapperRef.current) wrapperRef.current.style.transform = "scale(0.92)"
    controller.startDragging()
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>): void {
    const container = containerRef.current
    const svg = svgRef.current
    const wrapper = wrapperRef.current
    if (!container || !svg || !wrapper) return
    const rect = container.getBoundingClientRect()
    const centerX = rect.left + rect.width / 2
    const centerY = rect.top + rect.height / 2
    const deltaX = e.clientX - centerX
    const deltaY = e.clientY - centerY
    const maxShift = 6
    const dist = Math.sqrt(deltaX * deltaX + deltaY * deltaY)
    const ratio = Math.min(1, dist / 120)
    const shiftX = (deltaX / 120) * maxShift * ratio
    const shiftY = (deltaY / 120) * maxShift * ratio
    svg.style.setProperty("--px", `${shiftX}px`)
    svg.style.setProperty("--py", `${shiftY}px`)
    const tiltX = -(deltaY / 120) * 8 * ratio
    const tiltY = (deltaX / 120) * 8 * ratio
    const rot = (deltaX / 120) * 4 * ratio
    svg.style.setProperty("--rot", `${rot}deg`)
    const scale = Date.now() - pressRef.current.time < 200 && e.buttons === 1 ? 0.92 : 1.04
    wrapper.style.transform = `rotateX(${tiltX}deg) rotateY(${tiltY}deg) scale(${scale})`
  }

  function handlePointerUp(e: React.PointerEvent<HTMLDivElement>): void {
    if (wrapperRef.current) wrapperRef.current.style.transform = "none"
    const duration = Date.now() - pressRef.current.time
    const distMove = Math.sqrt(
      Math.pow(e.clientX - pressRef.current.x, 2) + Math.pow(e.clientY - pressRef.current.y, 2),
    )
    if (duration < PRESS_MS && distMove < PRESS_DIST_PX) {
      controller.expandFromMoon()
    }
  }

  function handlePointerLeave(): void {
    const svg = svgRef.current
    const wrapper = wrapperRef.current
    if (svg) {
      svg.style.setProperty("--px", "0px")
      svg.style.setProperty("--py", "0px")
      svg.style.setProperty("--rot", "0deg")
    }
    if (wrapper) wrapper.style.transform = "none"
  }

  function handleAnimationEnd(e: React.AnimationEvent<HTMLDivElement>): void {
    if (e.animationName === "moon-absorb" && wrapperRef.current) {
      wrapperRef.current.classList.remove("absorbing")
    }
  }

  function onPipClick(e: React.PointerEvent | React.MouseEvent, kind: "open" | "notifications"): void {
    // The pip is its own pointer target; keep the whole pointer sequence
    // from reaching #moon (which opens chat on pointerup) so a pip tap
    // can never co-trigger expand_from_moon.
    e.stopPropagation()
    if (kind === "open") controller.openUpdatesPanel()
    else if (kind === "notifications") controller.openNotificationsPanel()
  }

  return (
    <div
      ref={containerRef}
      className="moon-container"
      id="moon"
      data-tauri-drag-region
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerLeave}
    >
      <div
        className="needs-input-pip"
        id="needs-input-pip"
        aria-hidden="true"
        hidden={state.needsInputCount === 0}
      />
      <div
        className="update-pip"
        id="update-pip"
        aria-hidden="true"
        hidden={!state.updatePipVisible}
        onClick={(e) => onPipClick(e, "open")}
        onPointerDown={(e) => e.stopPropagation()}
        onPointerMove={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
      />
      {/* Unread-notification pip. Unlike its two siblings this one carries a
          count and an accessible name, because "3 results are waiting" is
          materially different from "1 is" - and it is the only affordance
          that makes the notification log discoverable at all. */}
      <div
        className="notification-pip"
        id="notification-pip"
        role="button"
        tabIndex={state.notificationCount === 0 ? -1 : 0}
        aria-label={`${state.notificationCount} unread notification${state.notificationCount === 1 ? "" : "s"}`}
        hidden={state.notificationCount === 0}
        onClick={(e) => onPipClick(e, "notifications")}
        onPointerDown={(e) => e.stopPropagation()}
        onPointerMove={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
      >
        {state.notificationCount > 9 ? "9+" : state.notificationCount}
      </div>
      <div className="moon-aura" aria-hidden="true" />
      <div className="moon-wrapper" id="moon-wrapper" ref={wrapperRef} onAnimationEnd={handleAnimationEnd}>
        <div className="moon-glow" />
        <div className="moon-sphere">
          <svg className="moon-svg" viewBox="0 0 100 100" ref={svgRef}>
            <defs>
              <linearGradient id="crescent-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#ffffff" />
                <stop offset="35%" stopColor="#e2ecfd" />
                <stop offset="70%" stopColor="#8ab4f8" />
                <stop offset="100%" stopColor="#1b2a4a" />
              </linearGradient>
              <filter id="glow-filter" x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur stdDeviation="3" result="blur" />
                <feComposite in="SourceGraphic" in2="blur" operator="over" />
              </filter>
            </defs>
            <path
              d="M 62 12 A 38 38 0 1 0 88 62 A 30 30 0 1 1 62 12 Z"
              fill="url(#crescent-grad)"
              filter="url(#glow-filter)"
            />
            <circle cx={40} cy={42} r={4.5} fill="#05070f" opacity={0.35} />
            <circle cx={34} cy={60} r={3.5} fill="#05070f" opacity={0.35} />
            <circle cx={48} cy={28} r={3} fill="#05070f" opacity={0.35} />
            <circle cx={28} cy={48} r={2.5} fill="#05070f" opacity={0.3} />
          </svg>
        </div>
      </div>
    </div>
  )
}
