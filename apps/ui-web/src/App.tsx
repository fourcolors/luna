import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react"
import { initialState, reduce, filterEvents } from "./reducer.js"
import { browserWebSocketTransport, type ConnectionStatus } from "./transport.js"

const STORAGE_KEY = "ui-ws.config"
const DEFAULT_URL = "ws://127.0.0.1:4753/ui"

interface PersistedConfig {
  url: string
  token: string
}

const loadConfig = (): PersistedConfig => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw) as PersistedConfig
  } catch {
    // ignore
  }
  // Fall back to Vite-injected env (set in .env.local for dev convenience).
  const envToken =
    (import.meta.env["VITE_UI_WS_TOKEN"] as string | undefined) ?? ""
  return { url: DEFAULT_URL, token: envToken }
}

const saveConfig = (cfg: PersistedConfig) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg))
  } catch {
    // ignore
  }
}

export function App() {
  const [{ url, token }, setCfg] = useState<PersistedConfig>(loadConfig())
  const [status, setStatus] = useState<ConnectionStatus>({ kind: "idle" })
  const [state, dispatch] = useReducer(reduce, initialState)
  const [selectedKinds, setSelectedKinds] = useState<ReadonlySet<string>>(
    new Set(),
  )
  const disconnectRef = useRef<(() => void) | null>(null)

  const onConnect = useCallback(() => {
    if (disconnectRef.current) {
      disconnectRef.current()
      disconnectRef.current = null
    }
    saveConfig({ url, token })
    disconnectRef.current = browserWebSocketTransport.connect({
      url,
      token,
      onFrame: dispatch,
      onStatus: setStatus,
    })
  }, [url, token])

  const onDisconnect = useCallback(() => {
    if (disconnectRef.current) {
      disconnectRef.current()
      disconnectRef.current = null
      setStatus({ kind: "idle" })
    }
  }, [])

  // Disconnect on unmount.
  useEffect(() => {
    return () => {
      if (disconnectRef.current) disconnectRef.current()
    }
  }, [])

  const allKinds = useMemo(() => {
    // Union of advertised + seen.
    const set = new Set<string>(state.advertisedKinds)
    for (const k of state.seenKinds) set.add(k)
    return Array.from(set).sort()
  }, [state.advertisedKinds, state.seenKinds])

  const filtered = useMemo(
    () => filterEvents(state.events, selectedKinds),
    [state.events, selectedKinds],
  )

  const toggleKind = (kind: string) => {
    const next = new Set(selectedKinds)
    if (next.has(kind)) next.delete(kind)
    else next.add(kind)
    setSelectedKinds(next)
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="row">
          <label>
            URL{" "}
            <input
              value={url}
              onChange={(e) => setCfg((c) => ({ ...c, url: e.target.value }))}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
          </label>
          <label>
            Token{" "}
            <input
              type="password"
              value={token}
              onChange={(e) => setCfg((c) => ({ ...c, token: e.target.value }))}
              placeholder="≥16 chars"
            />
          </label>
          {status.kind === "open" || status.kind === "connecting" ? (
            <button onClick={onDisconnect}>Disconnect</button>
          ) : (
            <button onClick={onConnect} disabled={!token || token.length < 16}>
              Connect
            </button>
          )}
          <StatusPill status={status} />
        </div>
        <div className="row chips">
          {allKinds.length === 0 && (
            <span className="muted">no kinds yet — connect to see events</span>
          )}
          {allKinds.map((k) => {
            const active = selectedKinds.has(k)
            return (
              <button
                key={k}
                className={`chip ${active ? "active" : ""}`}
                onClick={() => toggleKind(k)}
              >
                {k}
              </button>
            )
          })}
          {selectedKinds.size > 0 && (
            <button
              className="chip clear"
              onClick={() => setSelectedKinds(new Set())}
            >
              clear
            </button>
          )}
        </div>
        {state.lastDrop && (
          <div className="banner drop">
            ⚠ dropped {state.droppedTotal} event(s) total · most recent burst:{" "}
            {state.lastDrop.n} since {state.lastDrop.since}
          </div>
        )}
        {state.closeReason && (
          <div className="banner closed">closed by server: {state.closeReason}</div>
        )}
      </header>
      <main className="log">
        <div className="meta">
          {filtered.length} / {state.events.length} event(s) shown
          {state.lastPingAt && (
            <span className="muted"> · last ping {state.lastPingAt}</span>
          )}
        </div>
        {filtered.map((ev, i) => (
          <EventRow key={`${ev.ts}-${i}`} event={ev} />
        ))}
      </main>
    </div>
  )
}

function StatusPill({ status }: { status: ConnectionStatus }) {
  const label = status.kind
  const detail =
    status.kind === "closed"
      ? `code ${status.code}${status.reason ? ` · ${status.reason}` : ""}`
      : status.kind === "error"
        ? status.message
        : ""
  return (
    <span className={`pill pill-${label}`} title={detail}>
      {label}
    </span>
  )
}

function EventRow({ event }: { event: import("./wire.js").ObsEvent }) {
  const [open, setOpen] = useState(false)
  const summary = useMemo(() => {
    // Show kind + a few interesting top-level fields when collapsed.
    const { ts, kind, level, ...rest } = event
    void ts
    void level
    const keys = Object.keys(rest).slice(0, 3)
    const preview = keys.map((k) => `${k}=${formatVal(rest[k])}`).join(" ")
    return preview || kind
  }, [event])
  return (
    <div className={`row event level-${event.level}`} onClick={() => setOpen((o) => !o)}>
      <span className="ts">{event.ts.slice(11, 23)}</span>
      <span className={`kind kind-${event.kind}`}>{event.kind}</span>
      <span className="summary">{summary}</span>
      {open && (
        <pre className="json">{JSON.stringify(event, null, 2)}</pre>
      )}
    </div>
  )
}

function formatVal(v: unknown): string {
  if (v === null || v === undefined) return ""
  if (typeof v === "string") return v.length > 30 ? v.slice(0, 30) + "…" : v
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  return JSON.stringify(v).slice(0, 30)
}
