/**
 * DevChat Elite — canvas-first UI shell.
 *
 * Composition only. State lives here, layout regions are their own
 * components in ./components/. Per the advisor's guidance: don't repeat
 * the 861-line App.tsx mistake from ui-web — decompose at scaffold time.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react"
import {
  browserWebSocketTransport,
  initialState,
  reduce,
  type Action,
  type ClientFrame,
  type ConnectionStatus,
  type ThreadView,
  type TransportHandle,
} from "@experiment-agent/ui-shared"
import { TopHeader } from "./components/TopHeader.js"
import { LeftRail } from "./components/LeftRail.js"
import { MainCanvas } from "./components/MainCanvas.js"
import { RightToolbar } from "./components/RightToolbar.js"
import { BottomComposer } from "./components/BottomComposer.js"
import { SettingsPanel } from "./components/SettingsPanel.js"

const STORAGE_KEY = "ui-canvas.config"
const DEFAULT_URL = "ws://127.0.0.1:4753/ui"
const DEFAULT_MODEL = "claude-sonnet-4-5"

export interface PersistedConfig {
  url: string
  token: string
  model: string
}

const loadConfig = (): PersistedConfig => {
  // Env token wins as a *fallback* — if the user pasted their own token
  // it stays. But if localStorage has no token (or no entry at all), the
  // dev env token seeds it so we can auto-connect.
  const envToken =
    (import.meta.env["VITE_UI_WS_TOKEN"] as string | undefined) ?? ""
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PersistedConfig>
      return {
        url: parsed.url ?? DEFAULT_URL,
        token: parsed.token && parsed.token.length > 0 ? parsed.token : envToken,
        model: parsed.model ?? DEFAULT_MODEL,
      }
    }
  } catch {
    // ignore
  }
  return { url: DEFAULT_URL, token: envToken, model: DEFAULT_MODEL }
}

const saveConfig = (cfg: PersistedConfig) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg))
  } catch {
    // ignore
  }
}

export function App() {
  const [cfg, setCfg] = useState<PersistedConfig>(loadConfig())
  const [status, setStatus] = useState<ConnectionStatus>({ kind: "idle" })
  const [state, dispatch] = useReducer(
    reduce as (s: typeof initialState, a: Action) => typeof initialState,
    initialState,
  )
  const [settingsOpen, setSettingsOpen] = useState(false)
  const handleRef = useRef<TransportHandle | null>(null)

  // Persist edits as they happen.
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
    handleRef.current = browserWebSocketTransport.connect({
      url: cfg.url,
      token: cfg.token,
      onFrame: (f) => {
        dispatch(f)
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
        if (s.kind === "open") {
          handleRef.current?.send({ type: "list-threads" })
          setSettingsOpen(false)
        }
      },
    })
  }, [cfg])

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

  // Auto-connect when we have a usable token and we're idle. The hook
  // re-fires whenever `status.kind` returns to "idle" (e.g. after the
  // user clicks Disconnect, or after a transient close), so a failed
  // first attempt isn't fatal. We do NOT auto-reconnect from "closed"
  // or "error" — that's the user's call (Reconnect chip in the banner).
  useEffect(() => {
    if (cfg.token && cfg.token.length >= 16 && status.kind === "idle") {
      onConnect()
    }
  }, [cfg.token, status.kind, onConnect])

  const isConnected = status.kind === "open"
  const chatEnabled = isConnected && state.capabilities.chat

  // First-run UX: only surface settings if user opens them, OR there's
  // no usable token at all. With a seeded token we should jump straight
  // into the canvas while connection establishes.
  const hasUsableToken = cfg.token.length >= 16
  const showSettings =
    settingsOpen ||
    (!hasUsableToken && !isConnected && status.kind !== "connecting")

  // Pick the first thread automatically once we have a list.
  useEffect(() => {
    if (state.selectedThreadId === null && state.threadList.length > 0) {
      const first = state.threadList[0]!
      dispatch({ tag: "select-thread", threadId: first.id })
      send({ type: "subscribe", threadId: first.id })
    }
  }, [state.selectedThreadId, state.threadList, send])

  const selectedThread: ThreadView | null = useMemo(() => {
    return state.selectedThreadId !== null
      ? state.threads.get(state.selectedThreadId) ?? null
      : null
  }, [state.selectedThreadId, state.threads])

  const newThread = useCallback(() => {
    send({ type: "new-thread", model: cfg.model })
  }, [send, cfg.model])

  const sendUserMessage = useCallback(
    (text: string) => {
      if (!selectedThread) {
        // No active thread — start one. The thread-created frame will
        // auto-select it; we'll need to re-send. Simpler: if there's no
        // thread, create one first; the user clicks send again.
        send({ type: "new-thread", model: cfg.model })
        return
      }
      send({
        type: "user-message",
        threadId: selectedThread.summary.id,
        text,
      })
    },
    [send, selectedThread, cfg.model],
  )

  const interrupt = useCallback(() => {
    if (!selectedThread) return
    send({ type: "interrupt", threadId: selectedThread.summary.id })
  }, [send, selectedThread])

  // Banner: only show in "interesting" failure states, and use neutral
  // styling unless it's an actual error. Plain "closed" on first load is
  // boring; we don't shout about it.
  const bannerKind: "error" | "info" | null =
    state.closeReason !== null
      ? "error"
      : status.kind === "error"
        ? "error"
        : null
  const closeBanner =
    state.closeReason !== null
      ? `closed by server: ${state.closeReason}`
      : status.kind === "error"
        ? `connection error: ${status.message}`
        : null

  return (
    <div className="canvas-app">
      <TopHeader
        status={status}
        model={cfg.model}
        onSettingsToggle={() => setSettingsOpen((v) => !v)}
        onNewThread={chatEnabled ? newThread : null}
      />
      {showSettings && (
        <SettingsPanel
          cfg={cfg}
          onChange={setCfg}
          status={status}
          onConnect={onConnect}
          onDisconnect={onDisconnect}
        />
      )}
      {closeBanner && (
        <div className={`banner ${bannerKind ?? "info"}`}>
          <span>{closeBanner}</span>
          <button
            className="chip"
            onClick={onConnect}
            disabled={!cfg.token || cfg.token.length < 16}
          >
            Reconnect
          </button>
        </div>
      )}
      <div className="canvas-body">
        <LeftRail
          threads={state.threadList}
          threadViews={state.threads}
          selectedId={state.selectedThreadId}
          selectedThread={selectedThread}
          onSelect={(id) => {
            dispatch({ tag: "select-thread", threadId: id })
            send({ type: "subscribe", threadId: id })
          }}
          onNew={chatEnabled ? newThread : null}
        />
        <MainCanvas thread={selectedThread} />
        <RightToolbar />
      </div>
      <BottomComposer
        onSend={sendUserMessage}
        onInterrupt={interrupt}
        inFlight={selectedThread?.inFlight ?? null}
        disabled={!chatEnabled}
        model={cfg.model}
      />
    </div>
  )
}
