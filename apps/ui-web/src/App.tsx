/**
 * Phase 0 foundation shell.
 *
 * Proves the toolchain end-to-end: Vite + React render the @luna/design-system
 * watercolor cascade, with appearance (palette/theme/chrome/grain) driving the
 * `.luna-root` token scope exactly as the design mock does. This is deliberately
 * static — the real StudioApp (panel engine, ctx, data seams) lands in P2/P3.
 */
import { useEffect, useState } from "react"
import {
  getAppearance,
  onAppearanceChange,
  type Appearance,
} from "@luna/design-system/appearance"

/** style objects that also set CSS custom properties (--ws-tint, --panel-tint). */
type CSSVars = React.CSSProperties & Record<`--${string}`, string | number>

interface Workspace {
  readonly id: string
  readonly name: string
  readonly tint: string
}

const WORKSPACES: ReadonlyArray<Workspace> = [
  { id: "home", name: "Home", tint: "var(--wash-1)" },
  { id: "city", name: "The City", tint: "var(--wash-3)" },
  { id: "build", name: "Build", tint: "var(--wash-4)" },
]

interface SamplePanel {
  readonly id: string
  readonly title: string
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly tint: string
  readonly body: string
}

const SAMPLE_PANELS: ReadonlyArray<SamplePanel> = [
  { id: "threads", title: "threads", x: 40, y: 84, w: 300, h: 380, tint: "var(--wash-2)", body: "brooding on you · 5 threads" },
  { id: "chat", title: "morning", x: 372, y: 84, w: 360, h: 440, tint: "var(--brain-luna)", body: "ask luna anything…" },
  { id: "inbox", title: "inbox", x: 764, y: 84, w: 360, h: 300, tint: "var(--wash-1)", body: "9 in your inbox · 2 need you" },
]

export function App() {
  const [appearance, setAppearance] = useState<Appearance>(getAppearance)
  useEffect(() => onAppearanceChange(setAppearance), [])

  const dateStr = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  })

  return (
    <div
      className="luna-root studio"
      data-palette={appearance.palette}
      data-theme={appearance.theme}
      data-chrome={appearance.chrome}
      data-grain={appearance.grain ? "on" : "off"}
      data-motion="lively"
      data-ready="true"
    >
      <div className="bg-blooms" aria-hidden="true">
        <div className="bloom b1" />
        <div className="bloom b2" />
        <div className="bloom b3" />
      </div>

      {/* workspace rail */}
      <div className="ws-rail">
        <div className="ws-moon" title="Luna Studio" />
        <div className="ws-list">
          {WORKSPACES.map((w, i) => (
            <button
              key={w.id}
              className={"ws-tab" + (i === 0 ? " active" : "")}
              style={{ "--ws-tint": w.tint } as CSSVars}
              title={w.name}
            >
              <span className="ws-wash" />
              <span className="ws-name">{w.name}</span>
              <span className="ws-num">{i + 1}</span>
            </button>
          ))}
          <button className="ws-add" title="new space">+</button>
        </div>
        <div className="ws-kbd-hint">
          press <b>1–{WORKSPACES.length}</b>
          <br />
          to jump
        </div>
      </div>

      {/* top bar */}
      <div className="topbar">
        <div className="wordmark">
          <span className="name">Luna</span>
          <span className="sub">studio</span>
        </div>
        <div className="topbar-actions">
          <span className="date">{dateStr}</span>
        </div>
      </div>

      {/* sample panels — static placeholders proving panel chrome + washes */}
      {SAMPLE_PANELS.map((p) => (
        <div
          key={p.id}
          className="panel"
          style={
            {
              left: p.x,
              top: p.y,
              width: p.w,
              height: p.h,
              "--panel-tint": p.tint,
            } as CSSVars
          }
        >
          <div className="panel-wash" />
          <div className="panel-head">
            <span className="wash-dot" />
            <span className="panel-title">{p.title}</span>
          </div>
          <div className="panel-body">
            <div className="phase0-placeholder">{p.body}</div>
          </div>
          <div className="resize-handle" />
        </div>
      ))}
    </div>
  )
}
