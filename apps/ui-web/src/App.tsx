import { lazy, Suspense, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react"
import { initialState, reduce, filterEvents, type Action } from "./reducer.js"

const MarkdownView = lazy(() => import("./MarkdownView.js"))
import {
  browserWebSocketTransport,
  type ConnectionStatus,
  type TransportHandle,
} from "./transport.js"
import type { Artifact, ChatMessage, ClientFrame, SessionSummary } from "./wire.js"

const STORAGE_KEY = "ui-ws.config"
const DEFAULT_URL = "ws://127.0.0.1:4753/ui"
const DEFAULT_MODEL = "claude-sonnet-4-5"

interface PersistedConfig {
  url: string
  token: string
  model: string
}

const loadConfig = (): PersistedConfig => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PersistedConfig>
      return {
        url: parsed.url ?? DEFAULT_URL,
        token: parsed.token ?? "",
        model: parsed.model ?? DEFAULT_MODEL,
      }
    }
  } catch {
    // ignore
  }
  const envToken =
    (import.meta.env["VITE_UI_WS_TOKEN"] as string | undefined) ?? ""
  return { url: DEFAULT_URL, token: envToken, model: DEFAULT_MODEL }
}

const saveConfig = (cfg: PersistedConfig) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg))
  } catch {
    // ignore
  }
}

type Pane = "chat" | "obs"

export function App() {
  const [cfg, setCfg] = useState<PersistedConfig>(loadConfig())
  const { url, token, model } = cfg
  const [status, setStatus] = useState<ConnectionStatus>({ kind: "idle" })
  const [state, dispatch] = useReducer(
    reduce as (s: typeof initialState, a: Action) => typeof initialState,
    initialState,
  )
  const [pane, setPane] = useState<Pane>("chat")
  const [selectedKinds, setSelectedKinds] = useState<ReadonlySet<string>>(
    new Set(),
  )
  const handleRef = useRef<TransportHandle | null>(null)

  const send = useCallback((frame: ClientFrame) => {
    handleRef.current?.send(frame)
  }, [])

  const onConnect = useCallback(() => {
    if (handleRef.current) {
      handleRef.current.disconnect()
      handleRef.current = null
    }
    saveConfig(cfg)
    handleRef.current = browserWebSocketTransport.connect({
      url,
      token,
      onFrame: (f) => {
        dispatch(f)
        // Sidebar freshness: any frame that mutates a thread's
        // last-message metadata (created, accepted user msg, finalized
        // assistant turn) should refresh the list. Server orders by
        // lastMessageAt, so the active thread bubbles to the top.
        if (
          f.type === "thread-created" ||
          f.type === "assistant-done" ||
          f.type === "user-accepted"
        ) {
          handleRef.current?.send({ type: "list-threads" })
        }
      },
      onStatus: (s) => {
        setStatus(s)
        // On open, request the thread list immediately so the sidebar
        // is populated without a manual click.
        if (s.kind === "open") {
          handleRef.current?.send({ type: "list-threads" })
        }
      },
    })
  }, [cfg, url, token])

  const onDisconnect = useCallback(() => {
    if (handleRef.current) {
      handleRef.current.disconnect()
      handleRef.current = null
      setStatus({ kind: "idle" })
    }
  }, [])

  // Disconnect on unmount.
  useEffect(() => {
    return () => {
      if (handleRef.current) handleRef.current.disconnect()
    }
  }, [])

  const allKinds = useMemo(() => {
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

  const selectThread = useCallback(
    (id: string) => {
      dispatch({ tag: "select-thread", threadId: id })
      // Subscribe (idempotent server-side) to ensure live frames arrive
      // even if this is a thread the server didn't auto-subscribe us to.
      send({ type: "subscribe", threadId: id })
    },
    [send],
  )

  const newThread = useCallback(() => {
    send({ type: "new-thread", model })
  }, [send, model])

  const sendUserMessage = useCallback(
    (threadId: string, text: string) => {
      send({ type: "user-message", threadId, text })
    },
    [send],
  )

  const interrupt = useCallback(
    (threadId: string) => {
      send({ type: "interrupt", threadId })
    },
    [send],
  )

  const isConnected = status.kind === "open"
  const chatEnabled = isConnected && state.capabilities.chat
  const selectedThread =
    state.selectedThreadId !== null
      ? state.threads.get(state.selectedThreadId) ?? null
      : null

  return (
    <div className="app">
      <header className="topbar">
        <div className="row">
          <label>
            URL{" "}
            <input
              value={url}
              onChange={(e) =>
                setCfg((c) => ({ ...c, url: e.target.value }))
              }
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
              onChange={(e) =>
                setCfg((c) => ({ ...c, token: e.target.value }))
              }
              placeholder="≥16 chars"
            />
          </label>
          <label>
            Model{" "}
            <input
              value={model}
              onChange={(e) =>
                setCfg((c) => ({ ...c, model: e.target.value }))
              }
              spellCheck={false}
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
          <span className="muted">
            chat: {state.capabilities.chat ? "✓" : "✗"} · streaming:{" "}
            {state.capabilities.streamingDeltas ? "✓" : "✗"}
          </span>
          <span style={{ flex: 1 }} />
          <button
            className={`chip ${pane === "chat" ? "active" : ""}`}
            onClick={() => setPane("chat")}
          >
            Chat
          </button>
          <button
            className={`chip ${pane === "obs" ? "active" : ""}`}
            onClick={() => setPane("obs")}
          >
            Obs
          </button>
        </div>
        {state.closeReason && (
          <div className="banner closed">closed by server: {state.closeReason}</div>
        )}
      </header>

      {pane === "chat" ? (
        <div
          className={
            "chat-layout" +
            (selectedThread && selectedThread.artifacts.length > 0
              ? " with-artifacts"
              : "")
          }
        >
          <Sidebar
            threads={state.threadList}
            selectedId={state.selectedThreadId}
            onSelect={selectThread}
            onNew={chatEnabled ? newThread : null}
          />
          <ChatPanel
            thread={selectedThread}
            onSend={sendUserMessage}
            onInterrupt={interrupt}
            disabled={!chatEnabled}
          />
          {selectedThread && selectedThread.artifacts.length > 0 && (
            <ArtifactPanel artifacts={selectedThread.artifacts} />
          )}
        </div>
      ) : (
        <ObsPanel
          allKinds={allKinds}
          selectedKinds={selectedKinds}
          toggleKind={toggleKind}
          clearKinds={() => setSelectedKinds(new Set())}
          filtered={filtered}
          totalEvents={state.events.length}
          lastDrop={state.lastDrop}
          droppedTotal={state.droppedTotal}
          lastPingAt={state.lastPingAt}
        />
      )}
    </div>
  )
}

/* -------------------------------------------------------------------- */
/* Sidebar                                                              */
/* -------------------------------------------------------------------- */

function Sidebar({
  threads,
  selectedId,
  onSelect,
  onNew,
}: {
  threads: ReadonlyArray<SessionSummary>
  selectedId: string | null
  onSelect: (id: string) => void
  onNew: (() => void) | null
}) {
  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span>Threads</span>
        <button
          onClick={() => onNew?.()}
          disabled={onNew === null}
          title={onNew === null ? "connect first" : "new thread"}
        >
          + New
        </button>
      </div>
      <div className="sidebar-list">
        {threads.length === 0 && (
          <div className="muted sidebar-empty">no threads yet</div>
        )}
        {threads.map((t) => (
          <button
            key={t.id}
            className={`thread-row ${selectedId === t.id ? "selected" : ""}`}
            onClick={() => onSelect(t.id)}
          >
            <div className="thread-title">
              {t.title ?? <em className="muted">untitled</em>}
            </div>
            {t.lastMessagePreview && (
              <div className="thread-preview">{t.lastMessagePreview}</div>
            )}
            <div className="thread-meta">
              <span className="muted">{t.model || "—"}</span>
              {t.lastMessageAt !== null && (
                <span className="muted">{relativeTime(t.lastMessageAt)}</span>
              )}
            </div>
          </button>
        ))}
      </div>
    </aside>
  )
}

const relativeTime = (ms: number): string => {
  const diff = Date.now() - ms
  if (diff < 60_000) return "just now"
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`
  return `${Math.floor(diff / 86_400_000)}d`
}

/* -------------------------------------------------------------------- */
/* Chat panel                                                           */
/* -------------------------------------------------------------------- */

function ChatPanel({
  thread,
  onSend,
  onInterrupt,
  disabled,
}: {
  thread: import("./reducer.js").ThreadView | null
  onSend: (threadId: string, text: string) => void
  onInterrupt: (threadId: string) => void
  disabled: boolean
}) {
  const [draft, setDraft] = useState("")
  const transcriptRef = useRef<HTMLDivElement>(null)

  // Auto-scroll on new messages or in-flight delta updates.
  useEffect(() => {
    if (!transcriptRef.current) return
    transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight
  }, [thread?.messages.length, thread?.inFlight?.text])

  if (!thread) {
    return (
      <main className="chat-panel">
        <div className="empty-state">
          <p className="muted">
            {disabled
              ? "connect to a chat-capable server, then start a thread"
              : "select a thread or start a new one"}
          </p>
        </div>
      </main>
    )
  }

  const submit = () => {
    const t = draft.trim()
    if (!t) return
    onSend(thread.summary.id, t)
    setDraft("")
  }

  return (
    <main className="chat-panel">
      <div className="chat-head">
        <div className="chat-title">
          {thread.summary.title ?? <em>untitled</em>}
        </div>
        <div className="muted small">
          {thread.summary.model || "—"} · {thread.messages.length} msg
        </div>
      </div>
      <div className="transcript" ref={transcriptRef}>
        {thread.messages.map((m) => (
          <MessageBubble key={`${m.id}-${m.seq}`} message={m} />
        ))}
        {thread.inFlight && (
          <div className="bubble assistant in-flight">
            <div className="bubble-role">assistant</div>
            <div className="bubble-text">{thread.inFlight.text}</div>
            <div className="muted small">streaming…</div>
          </div>
        )}
        {thread.lastError && (
          <div className="banner closed">
            error ({thread.lastError.kind}): {thread.lastError.message}
          </div>
        )}
      </div>
      <div className="composer">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={
            disabled ? "disconnected" : "Type a message — ⌘/Ctrl+Enter to send"
          }
          disabled={disabled}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault()
              submit()
            }
          }}
        />
        <div className="composer-actions">
          {thread.inFlight ? (
            <button onClick={() => onInterrupt(thread.summary.id)}>
              Stop
            </button>
          ) : (
            <button onClick={submit} disabled={disabled || !draft.trim()}>
              Send
            </button>
          )}
        </div>
      </div>
    </main>
  )
}

function MessageBubble({ message }: { message: ChatMessage }) {
  // Assistant messages get GFM markdown + Shiki-highlighted fences. User
  // bubbles stay as plain text — they're never markdown anyway and we
  // skip the Shiki cost. Suspense fallback keeps text visible while the
  // MarkdownView chunk is loading on first assistant turn.
  const body =
    message.role === "assistant" ? (
      <Suspense fallback={<div className="bubble-text">{message.text}</div>}>
        <MarkdownView text={message.text} />
      </Suspense>
    ) : (
      <div className="bubble-text">{message.text}</div>
    )
  return (
    <div className={`bubble ${message.role}`}>
      <div className="bubble-role">{message.role}</div>
      {body}
      {message.toolUses.length > 0 && (
        <div className="tool-uses">
          {message.toolUses.map((tu) => (
            <span className="tool-chip" key={tu.id}>
              🛠 {tu.name}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------- */
/* Artifact panel — files & substantial code blocks pinned beside chat  */
/* -------------------------------------------------------------------- */

function ArtifactPanel({
  artifacts,
}: {
  artifacts: ReadonlyArray<Artifact>
}) {
  const [selectedId, setSelectedId] = useState<string | null>(
    artifacts[0]?.id ?? null,
  )
  // Auto-select newest when artifacts grow.
  useEffect(() => {
    if (artifacts.length > 0) {
      const last = artifacts[artifacts.length - 1]!
      setSelectedId((cur) => cur ?? last.id)
    }
  }, [artifacts.length])

  const selected =
    artifacts.find((a) => a.id === selectedId) ??
    artifacts[artifacts.length - 1] ??
    null

  return (
    <aside className="artifact-panel">
      <div className="artifact-head">
        <span>Artifacts</span>
        <span className="muted small">{artifacts.length}</span>
      </div>
      <div className="artifact-list">
        {artifacts.map((a) => (
          <button
            key={a.id}
            className={
              "artifact-row" + (a.id === selected?.id ? " selected" : "")
            }
            onClick={() => setSelectedId(a.id)}
          >
            <div className="artifact-title">
              {a.source === "tool-write" ? "📄" : "📝"} {a.title}
            </div>
            <div className="artifact-meta muted small">
              {a.source === "tool-write" ? a.path : a.lang ?? "code"} ·{" "}
              {a.content.length} chars
            </div>
          </button>
        ))}
      </div>
      {selected && (
        <div className="artifact-view">
          <div className="artifact-view-head">
            <span className="small">{selected.path ?? selected.title}</span>
            <button
              className="chip clear"
              onClick={() => {
                navigator.clipboard?.writeText(selected.content).catch(() => {
                  // ignore
                })
              }}
            >
              copy
            </button>
          </div>
          <pre className="artifact-content">
            <code>{selected.content}</code>
          </pre>
        </div>
      )}
    </aside>
  )
}

/* -------------------------------------------------------------------- */
/* Obs panel (existing event log, factored into a component)            */
/* -------------------------------------------------------------------- */

function ObsPanel({
  allKinds,
  selectedKinds,
  toggleKind,
  clearKinds,
  filtered,
  totalEvents,
  lastDrop,
  droppedTotal,
  lastPingAt,
}: {
  allKinds: ReadonlyArray<string>
  selectedKinds: ReadonlySet<string>
  toggleKind: (k: string) => void
  clearKinds: () => void
  filtered: ReadonlyArray<import("./wire.js").ObsEvent>
  totalEvents: number
  lastDrop: { n: number; since: string } | null
  droppedTotal: number
  lastPingAt: string | null
}) {
  return (
    <>
      <div className="topbar" style={{ borderTop: "1px solid #222" }}>
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
            <button className="chip clear" onClick={clearKinds}>
              clear
            </button>
          )}
        </div>
        {lastDrop && (
          <div className="banner drop">
            ⚠ dropped {droppedTotal} event(s) total · most recent burst:{" "}
            {lastDrop.n} since {lastDrop.since}
          </div>
        )}
      </div>
      <main className="log">
        <div className="meta">
          {filtered.length} / {totalEvents} event(s) shown
          {lastPingAt && (
            <span className="muted"> · last ping {lastPingAt}</span>
          )}
        </div>
        {filtered.map((ev, i) => (
          <EventRow key={`${ev.ts}-${i}`} event={ev} />
        ))}
      </main>
    </>
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
    const { ts, kind, level, ...rest } = event
    void ts
    void level
    void kind
    const keys = Object.keys(rest).slice(0, 3)
    const preview = keys.map((k) => `${k}=${formatVal(rest[k])}`).join(" ")
    return preview || event.kind
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
