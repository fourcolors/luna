/**
 * RightToolbar — the floating vertical-pill of drawing tools.
 *
 * v1: every tool is a disabled chip with a "coming soon" tooltip. Per
 * advisor: clickable no-ops lie about capability and create support
 * load. When real tools land, swap `disabled` to `aria-pressed` and
 * wire each to an action.
 */
type ToolEntry =
  | { kind: "tool"; id: string; icon: string; label: string }
  | { kind: "divider"; id: string }

// Two semantic groups separated by a thin divider: navigation/draw
// primitives (top) and asset/color tools (bottom).
const TOOLS: ReadonlyArray<ToolEntry> = [
  { kind: "tool", id: "cursor", icon: "↖", label: "Select" },
  { kind: "tool", id: "marquee", icon: "▢", label: "Marquee" },
  { kind: "tool", id: "pencil", icon: "✎", label: "Pencil" },
  { kind: "tool", id: "hand", icon: "✋", label: "Pan" },
  { kind: "divider", id: "div-1" },
  { kind: "tool", id: "image", icon: "🖼", label: "Image" },
  { kind: "tool", id: "color", icon: "🎨", label: "Color" },
  { kind: "tool", id: "star", icon: "★", label: "Star" },
]

export function RightToolbar() {
  return (
    <div className="right-toolbar" role="toolbar" aria-label="Drawing tools (coming soon)">
      <div className="toolbar-strip">
        {TOOLS.map((t) =>
          t.kind === "divider" ? (
            <div key={t.id} className="toolbar-divider" aria-hidden="true" />
          ) : (
            <button
              key={t.id}
              className="toolbar-btn"
              disabled
              title={`${t.label} — coming soon`}
              aria-label={t.label}
            >
              <span aria-hidden="true">{t.icon}</span>
            </button>
          ),
        )}
      </div>
    </div>
  )
}
