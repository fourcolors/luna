import type { ConnectionStatus } from "@experiment-agent/ui-shared"

export function TopHeader({
  status,
  model,
  onSettingsToggle,
  onNewThread,
}: {
  status: ConnectionStatus
  model: string
  onSettingsToggle: () => void
  onNewThread: (() => void) | null
}) {
  // Closed/idle = neutral grey (not red). Only error gets the bad
  // colour — disconnect is a normal state in a dev rig.
  const dot =
    status.kind === "open"
      ? "dot ok"
      : status.kind === "connecting"
        ? "dot pending"
        : status.kind === "error"
          ? "dot bad"
          : "dot idle"
  return (
    <header className="top-header">
      <div className="header-left">
        <button
          className="icon-btn"
          onClick={onSettingsToggle}
          title="Menu / settings"
          aria-label="menu"
        >
          ☰
        </button>
        <div className="brand-block">
          <strong className="brand-name">DevChat Elite</strong>
          <span className={dot} title={status.kind} />
        </div>
      </div>
      <div className="header-right">
        <span className="header-chip muted" title={`status: ${status.kind}`}>
          {status.kind === "open"
            ? "live"
            : status.kind === "connecting"
              ? "connecting…"
              : "offline"}
        </span>
        <button
          className="header-btn"
          onClick={onNewThread ?? undefined}
          disabled={onNewThread === null}
          title={onNewThread === null ? "Connect first" : "New thread"}
        >
          ▶ New
        </button>
        <button className="header-btn ghost" disabled title="Coming soon">
          ⤴ Export
        </button>
        <button className="header-btn ghost" disabled title="Coming soon">
          ⇪ Share
        </button>
        <div className="avatar" title="You">S</div>
      </div>
    </header>
  )
}
