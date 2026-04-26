import type { ConnectionStatus } from "@experiment-agent/ui-shared"
import type { PersistedConfig } from "../App.js"

export function SettingsPanel({
  cfg,
  onChange,
  status,
  onConnect,
  onDisconnect,
}: {
  cfg: PersistedConfig
  onChange: (next: PersistedConfig) => void
  status: ConnectionStatus
  onConnect: () => void
  onDisconnect: () => void
}) {
  const isLive = status.kind === "open" || status.kind === "connecting"
  return (
    <div className="settings-panel">
      <label>
        URL
        <input
          value={cfg.url}
          onChange={(e) => onChange({ ...cfg, url: e.target.value })}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
      </label>
      <label>
        Token
        <input
          type="password"
          value={cfg.token}
          onChange={(e) => onChange({ ...cfg, token: e.target.value })}
          placeholder="≥16 chars"
        />
      </label>
      <label>
        Model
        <input
          value={cfg.model}
          onChange={(e) => onChange({ ...cfg, model: e.target.value })}
          spellCheck={false}
        />
      </label>
      {isLive ? (
        <button onClick={onDisconnect}>Disconnect</button>
      ) : (
        <button
          onClick={onConnect}
          disabled={!cfg.token || cfg.token.length < 16}
        >
          Connect
        </button>
      )}
    </div>
  )
}
