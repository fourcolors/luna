import { lazy, Suspense, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react"
import {
  CodeBlock,
  CodeBlockFallback,
  browserWebSocketTransport,
  canonLang,
  countLines,
  deriveTitle,
  filterEvents,
  formatBytes,
  initialState,
  reduce,
  type Action,
  type Artifact,
  type ChatMessage,
  type ClientFrame,
  type ConnectionStatus,
  type SessionSummary,
  type ThreadView,
  type TransportHandle,
} from "@experiment-agent/ui-shared"

const MarkdownView = lazy(() =>
  import("@experiment-agent/ui-shared").then((m) => ({ default: m.MarkdownView })),
)

const STORAGE_KEY = "ui-ws.config"
const DEFAULT_URL = "ws://127.0.0.1:4753/ui"
const DEFAULT_MODEL = "claude-sonnet-4-6"

/** Models the dropdown offers. Keep this in sync with what the SDK accepts.
 *  Free-form input is preserved as a fallback (any value not in the list
 *  still works — the input falls back to a text field if the user picks
 *  "custom"). */
const MODEL_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "claude-opus-4-7",    label: "Opus 4.7 — most capable" },
  { value: "claude-sonnet-4-6",  label: "Sonnet 4.6 — balanced (default)" },
  { value: "claude-haiku-4-5",   label: "Haiku 4.5 — fastest" },
  { value: "claude-opus-4-6",    label: "Opus 4.6 — prior gen" },
  { value: "claude-sonnet-4-5",  label: "Sonnet 4.5 — prior gen" },
]

interface PersistedConfig {
  url: string
  token: string
  model: string
  /** When true, plain Enter sends; Shift+Enter inserts newline.
   *  Default false preserves the original ⌘/Ctrl+Enter contract. */
  enterToSend: boolean
}

const loadConfig = (): PersistedConfig => {
  const envToken =
    (import.meta.env["VITE_UI_WS_TOKEN"] as string | undefined) ?? ""
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PersistedConfig>
      return {
        url: parsed.url ?? DEFAULT_URL,
        // Stored token wins, BUT fall back to env token if storage has
        // empty/missing — first-run on a new browser/device gets the
        // dev token from .env.local without any user action.
        token: parsed.token && parsed.token.length >= 16 ? parsed.token : envToken,
        model: parsed.model ?? DEFAULT_MODEL,
        enterToSend: parsed.enterToSend ?? false,
      }
    }
  } catch {
    // ignore
  }
  return {
    url: DEFAULT_URL,
    token: envToken,
    model: DEFAULT_MODEL,
    enterToSend: false,
  }
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
  const { url, token, model, enterToSend } = cfg
  const [status, setStatus] = useState<ConnectionStatus>({ kind: "idle" })
  const [state, dispatch] = useReducer(
    reduce as (s: typeof initialState, a: Action) => typeof initialState,
    initialState,
  )
  const [pane, setPane] = useState<Pane>("chat")
  const [selectedKinds, setSelectedKinds] = useState<ReadonlySet<string>>(
    new Set(),
  )
  const [settingsOpen, setSettingsOpen] = useState(false)
  const handleRef = useRef<TransportHandle | null>(null)

  // Persist config edits as they happen so reload doesn't lose tweaks
  // (e.g. enterToSend toggle).
  useEffect(() => {
    saveConfig(cfg)
  }, [cfg])

  const send = useCallback((frame: ClientFrame) => {
    handleRef.current?.send(frame)
  }, [])

  const onConnect = useCallback(() => {
    if (handleRef.current) {
      handleRef.current.disconnect()
      handleRef.current = null
    }
    // No explicit saveConfig here — the cfg-watching useEffect already
    // persists every edit, so this would be a redundant double-write.
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
        // is populated without a manual click. Also collapse the
        // settings panel if it was left open from the disconnected state.
        if (s.kind === "open") {
          handleRef.current?.send({ type: "list-threads" })
          setSettingsOpen(false)
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
  const isConnecting = status.kind === "connecting"
  const chatEnabled = isConnected && state.capabilities.chat
  const selectedThread =
    state.selectedThreadId !== null
      ? state.threads.get(state.selectedThreadId) ?? null
      : null

  // Show settings panel automatically when not yet connected (so the
  // first-run experience surfaces the URL/Token fields), or when the
  // user has explicitly toggled it open.
  const showSettings = settingsOpen || (!isConnected && !isConnecting)

  return (
    <div className="app">
      <header className="topbar">
        <div className="row">
          <strong className="brand">⚡ Agent Chat</strong>
          <ConnectionSummary
            status={status}
            url={url}
            model={model}
            chatCap={state.capabilities.chat}
          />
          <span style={{ flex: 1 }} />
          {isConnected && (
            <button
              className={`chip ${settingsOpen ? "active" : ""}`}
              onClick={() => setSettingsOpen((v) => !v)}
              title="Connection settings"
            >
              ⚙ Settings
            </button>
          )}
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
            Events
          </button>
        </div>
        {showSettings && (
          <div className="row settings-row">
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
              <select
                value={
                  MODEL_OPTIONS.some((o) => o.value === model)
                    ? model
                    : "__custom"
                }
                onChange={(e) => {
                  const v = e.target.value
                  if (v === "__custom") return // keep current value, show input
                  setCfg((c) => ({ ...c, model: v }))
                }}
              >
                {MODEL_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
                <option value="__custom">Custom…</option>
              </select>
            </label>
            {!MODEL_OPTIONS.some((o) => o.value === model) && (
              <label>
                Model ID{" "}
                <input
                  value={model}
                  onChange={(e) =>
                    setCfg((c) => ({ ...c, model: e.target.value }))
                  }
                  spellCheck={false}
                  placeholder="claude-…"
                />
              </label>
            )}
            <label className="toggle" title="When on, plain Enter sends; Shift+Enter inserts a newline">
              <input
                type="checkbox"
                checked={enterToSend}
                onChange={(e) =>
                  setCfg((c) => ({ ...c, enterToSend: e.target.checked }))
                }
              />
              <span>Enter to send</span>
            </label>
            {isConnected || isConnecting ? (
              <button onClick={onDisconnect}>Disconnect</button>
            ) : (
              <button onClick={onConnect} disabled={!token || token.length < 16}>
                Connect
              </button>
            )}
          </div>
        )}
        {state.closeReason && (
          <div className="banner closed">
            <span>closed by server: {state.closeReason}</span>
            <button
              className="chip"
              onClick={onConnect}
              disabled={!token || token.length < 16}
            >
              Reconnect
            </button>
          </div>
        )}
        {(status.kind === "closed" || status.kind === "error") && !state.closeReason && (
          <div className="banner closed">
            <span>
              {status.kind === "error"
                ? `connection error: ${status.message}`
                : `disconnected (code ${status.code}${status.reason ? ` · ${status.reason}` : ""})`}
            </span>
            <button
              className="chip"
              onClick={onConnect}
              disabled={!token || token.length < 16}
            >
              Reconnect
            </button>
          </div>
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
            threadViews={state.threads}
            selectedId={state.selectedThreadId}
            onSelect={selectThread}
            onNew={chatEnabled ? newThread : null}
          />
          <ChatPanel
            thread={selectedThread}
            onSend={sendUserMessage}
            onInterrupt={interrupt}
            disabled={!chatEnabled}
            enterToSend={enterToSend}
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
/* Connection summary — compact "● connected · model · host"           */
/* -------------------------------------------------------------------- */

function ConnectionSummary({
  status,
  url,
  model,
  chatCap,
}: {
  status: ConnectionStatus
  url: string
  model: string
  chatCap: boolean
}) {
  const host = useMemo(() => {
    try {
      return new URL(url).host || url
    } catch {
      return url
    }
  }, [url])

  const dotClass =
    status.kind === "open"
      ? "dot ok"
      : status.kind === "connecting"
        ? "dot pending"
        : status.kind === "error" || status.kind === "closed"
          ? "dot bad"
          : "dot idle"

  const label =
    status.kind === "open"
      ? `${model} · ${host}${chatCap ? "" : " · chat unavailable"}`
      : status.kind === "connecting"
        ? `connecting · ${host}`
        : status.kind === "error"
          ? `error · ${status.message}`
          : status.kind === "closed"
            ? `disconnected`
            : "not connected"

  return (
    <span className="conn-summary" title={url}>
      <span className={dotClass} />
      <span className="muted">{label}</span>
    </span>
  )
}

/* -------------------------------------------------------------------- */
/* Sidebar                                                              */
/* -------------------------------------------------------------------- */

function Sidebar({
  threads,
  threadViews,
  selectedId,
  onSelect,
  onNew,
}: {
  threads: ReadonlyArray<SessionSummary>
  threadViews: ReadonlyMap<string, ThreadView>
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
          <div className="sidebar-empty">
            <p className="muted">No threads yet.</p>
            {onNew !== null && (
              <button onClick={onNew} className="chip primary">
                Start your first thread
              </button>
            )}
          </div>
        )}
        {threads.map((t) => {
          const title = deriveTitle(t, threadViews.get(t.id))
          return (
            <button
              key={t.id}
              className={`thread-row ${selectedId === t.id ? "selected" : ""}`}
              onClick={() => onSelect(t.id)}
            >
              <div className="thread-title">
                {title ?? <em className="muted">untitled</em>}
              </div>
              {t.lastMessagePreview && title !== t.lastMessagePreview && (
                <div className="thread-preview">{t.lastMessagePreview}</div>
              )}
              <div className="thread-meta">
                <span className="muted">{t.model || "—"}</span>
                {t.lastMessageAt !== null && (
                  <span className="muted">{relativeTime(t.lastMessageAt)}</span>
                )}
              </div>
            </button>
          )
        })}
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
  enterToSend,
}: {
  thread: ThreadView | null
  onSend: (threadId: string, text: string) => void
  onInterrupt: (threadId: string) => void
  disabled: boolean
  enterToSend: boolean
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
              ? "Connect to a chat-capable server, then start a thread."
              : "Select a thread or start a new one."}
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

  const placeholder = disabled
    ? "Disconnected"
    : enterToSend
      ? "Type a message — Enter to send, Shift+Enter for newline"
      : "Type a message — ⌘/Ctrl+Enter to send"

  return (
    <main className="chat-panel">
      <div className="chat-head">
        <div className="chat-title">
          {deriveTitle(thread.summary, thread) ?? <em>untitled</em>}
        </div>
        <div className="muted small">
          {thread.summary.model || "—"} · {thread.messages.length} msg
        </div>
      </div>
      <div className="transcript" ref={transcriptRef}>
        {thread.messages.length === 0 && !thread.inFlight && (
          <div className="empty-state">
            <p className="muted">
              No messages yet — say hello to get started.
            </p>
          </div>
        )}
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
          placeholder={placeholder}
          disabled={disabled}
          onKeyDown={(e) => {
            // ⌘/Ctrl+Enter always submits (preserved alias).
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault()
              submit()
              return
            }
            // Plain Enter submits ONLY when enterToSend is on AND no
            // modifier is held. Shift+Enter falls through to insert a
            // newline (the textarea default).
            if (
              enterToSend &&
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.metaKey &&
              !e.ctrlKey &&
              !e.altKey
            ) {
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

const downloadArtifact = (a: Artifact) => {
  const filename =
    (a.path && a.path.split("/").pop()) ||
    (a.title && a.title.replace(/[^\w.\-]+/g, "_")) ||
    `artifact-${a.id}.txt`
  const blob = new Blob([a.content], { type: "text/plain;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  // Revoke on next tick so the download has time to start.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

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

  const selectedLang = selected ? canonLang(selected.lang) : null

  return (
    <aside className="artifact-panel">
      <div className="artifact-head">
        <span>Artifacts</span>
        <span className="muted small">{artifacts.length}</span>
      </div>
      <div className="artifact-list">
        {artifacts.map((a) => {
          const lines = countLines(a.content)
          return (
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
                {lines} {lines === 1 ? "line" : "lines"} ·{" "}
                {formatBytes(a.content.length)}
              </div>
            </button>
          )
        })}
      </div>
      {selected && (
        <div className="artifact-view">
          <div className="artifact-view-head">
            <span className="small" title={selected.path ?? undefined}>
              {selected.path ?? selected.title}
            </span>
            <span style={{ flex: 1 }} />
            <button
              className="chip"
              onClick={() => downloadArtifact(selected)}
              title="Download as file"
            >
              ⬇ download
            </button>
            <button
              className="chip"
              onClick={() => {
                navigator.clipboard?.writeText(selected.content).catch(() => {
                  // ignore
                })
              }}
              title="Copy to clipboard"
            >
              ⧉ copy
            </button>
          </div>
          <div className="artifact-content">
            {selectedLang ? (
              <CodeBlock lang={selectedLang} source={selected.content} />
            ) : (
              <CodeBlockFallback source={selected.content} />
            )}
          </div>
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
  filtered: ReadonlyArray<import("@experiment-agent/ui-shared").ObsEvent>
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

function EventRow({ event }: { event: import("@experiment-agent/ui-shared").ObsEvent }) {
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
