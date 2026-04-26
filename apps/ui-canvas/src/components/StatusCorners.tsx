import type { ConnectionStatus } from "@experiment-agent/ui-shared"

export function StatusCorners({ status }: { status: ConnectionStatus }) {
  const cloudLabel =
    status.kind === "open"
      ? "☁ live"
      : status.kind === "connecting"
        ? "☁ …"
        : "☁ offline"
  return (
    <>
      <div className="corner left">
        <button className="corner-btn ghost" disabled title="Agent log (coming soon)">
          ⌥ Agent log
        </button>
      </div>
      <div className="corner right">
        <span className="corner-pill" title={`status: ${status.kind}`}>
          {cloudLabel}
        </span>
        <span className="corner-pill" title="Zoom level">100%</span>
        <button className="corner-btn ghost" disabled title="Help (coming soon)">
          ?
        </button>
      </div>
    </>
  )
}
