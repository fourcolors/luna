/**
 * useLunaData — the single data hub that feeds the ported Final design its
 * real Luna data, shaped EXACTLY like the design's mock so the studio
 * components (ThreadsApp, ThreadChat) render unchanged.
 *
 * It owns the transport + reducer store, auto-connects from the persisted
 * config, maps Luna's thread/message model onto the design's thread shape,
 * and exposes the handlers final-app threads into its `ctx`:
 *   - openThread(id)  -> select + subscribe
 *   - newThread()     -> new-thread frame
 *   - appendMsg(id,m) -> user turn = real user-message frame; assistant turns
 *                        are no-ops (real replies stream in from the server)
 *
 * Impedance match: reducer ThreadView { summary, messages[], inFlight } ->
 * design thread { id, name, tint, brain, status, note, msgs[{who,text}] }.
 */
import { useCallback, useEffect, useMemo, useRef } from "react"
import {
  type ChatMessage,
  type ClientFrame,
  type ConnectionStatus,
  type ServerFrame,
  type SessionSummary,
  type ThreadView,
  type TransportHandle,
  type UIState,
} from "@luna/ui-shared/core"
import { loadConfig } from "./config"
import { useUiStore } from "./useUiStore"
import { useTransport } from "./useTransport"

export type StudioStatus = "needs" | "active" | "running" | "quiet" | "done"

export interface StudioMsg {
  readonly who: "user" | "luna"
  readonly brain?: string
  readonly text: string
}

export interface StudioThread {
  readonly id: string
  readonly name: string
  readonly tint: string
  readonly brain: string
  readonly status: StudioStatus
  readonly unread?: number
  readonly note: string
  readonly msgs: StudioMsg[]
  /** true while an assistant turn is streaming — drives the typing indicator. */
  readonly awaiting: boolean
}

const WASHES = [
  "var(--wash-0)",
  "var(--wash-1)",
  "var(--wash-2)",
  "var(--wash-3)",
  "var(--wash-4)",
] as const

/** Stable tint per thread id (deterministic hash → palette wash). */
function tintFor(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
  return WASHES[Math.abs(h) % WASHES.length] ?? "var(--wash-2)"
}

function mapThread(
  summary: SessionSummary,
  view: ThreadView | undefined,
  selectedId: string | null,
): StudioThread {
  const awaiting = view?.inFlight != null
  const msgs: StudioMsg[] = (view?.messages ?? []).map((m: ChatMessage) => ({
    who: m.role === "assistant" ? "luna" : "user",
    text: m.text,
  }))
  // Live streaming text for the in-flight turn (not yet a finalized message).
  if (view?.inFlight && view.inFlight.text) {
    msgs.push({ who: "luna", text: view.inFlight.text })
  }
  const status: StudioStatus = awaiting
    ? "running"
    : summary.id === selectedId
      ? "active"
      : "quiet"
  return {
    id: summary.id,
    name: summary.title ?? "new thread",
    tint: tintFor(summary.id),
    brain: "luna",
    status,
    note: summary.lastMessagePreview ?? "",
    msgs,
    awaiting,
  }
}

const CLIENT_INFO = { name: "luna-web", version: "0.0.1", platform: "browser" } as const

export interface LunaData {
  readonly status: ConnectionStatus
  readonly connected: boolean
  readonly threads: StudioThread[]
  readonly activeThread: string | null
  readonly openThread: (id: string) => void
  readonly newThread: () => void
  readonly appendMsg: (threadId: string, msg: StudioMsg) => void
  readonly threadNote: (id: string, patch: unknown) => void
}

export function useLunaData(): LunaData {
  const { state, dispatch } = useUiStore()
  const cfgRef = useRef(loadConfig())

  // Latest send in a ref so onFrame (stable) can request a fresh list-threads.
  const sendRef = useRef<(f: ClientFrame) => void>(() => {})

  const onFrame = useCallback(
    (frame: ServerFrame): void => {
      dispatch(frame)
      // Sidebar freshness: server orders threads by lastMessageAt, so re-list
      // after any frame that mutates a thread's last-message metadata.
      if (
        frame.type === "thread-created" ||
        frame.type === "assistant-done" ||
        frame.type === "user-accepted"
      ) {
        sendRef.current({ type: "list-threads" })
      }
    },
    [dispatch],
  )

  const onOpen = useCallback((handle: TransportHandle): void => {
    handle.send({ type: "list-threads" })
  }, [])

  const { status, connect, send } = useTransport({ onFrame, onOpen })
  sendRef.current = send

  // Auto-connect on mount when a usable token is present.
  useEffect(() => {
    const cfg = cfgRef.current
    if (cfg.token && cfg.token.length >= 16) connect(cfg.url, cfg.token)
  }, [connect])

  // Bootstrap: once open, select+subscribe the first thread, or mint one if the
  // list is empty (idle threads auto-archive server-side, so a fresh boot may
  // have none — ThreadChat needs an active thread to render).
  const mintedRef = useRef(false)
  useEffect(() => {
    if (status.kind !== "open") return
    if (state.selectedThreadId) return
    const first = state.threadList[0]
    if (first) {
      dispatch({ tag: "select-thread", threadId: first.id })
      send({ type: "subscribe", threadId: first.id })
    } else if (!mintedRef.current) {
      mintedRef.current = true
      send({ type: "new-thread", model: cfgRef.current.model })
    }
  }, [status.kind, state.threadList, state.selectedThreadId, dispatch, send])

  // Subscribe whenever the selection lands on an unsubscribed thread (covers
  // server auto-select on thread-created). Idempotent server-side.
  const subscribedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const id = state.selectedThreadId
    if (id && status.kind === "open" && !subscribedRef.current.has(id)) {
      subscribedRef.current.add(id)
      send({ type: "subscribe", threadId: id })
    }
  }, [state.selectedThreadId, status.kind, send])

  const threads = useMemo<StudioThread[]>(
    () =>
      state.threadList.map((s: SessionSummary) =>
        mapThread(s, state.threads.get(s.id), state.selectedThreadId),
      ),
    [state.threadList, state.threads, state.selectedThreadId],
  )

  const openThread = useCallback(
    (id: string): void => {
      dispatch({ tag: "select-thread", threadId: id })
      send({ type: "subscribe", threadId: id })
    },
    [dispatch, send],
  )

  const newThread = useCallback((): void => {
    send({ type: "new-thread", model: cfgRef.current.model })
  }, [send])

  const appendMsg = useCallback(
    (threadId: string, msg: StudioMsg): void => {
      // Only user turns are sent; assistant replies stream back from the server.
      if (msg.who !== "user") return
      send({ type: "user-message", threadId, text: msg.text, client: CLIENT_INFO })
    },
    [send],
  )

  const threadNote = useCallback((_id: string, _patch: unknown): void => {
    // Status/notes are derived from server state; local notes are a no-op.
  }, [])

  return {
    status,
    connected: status.kind === "open",
    threads,
    activeThread: state.selectedThreadId,
    openThread,
    newThread,
    appendMsg,
    threadNote,
  }
}

// Keep UIState referenced for the type-only import above (documentation aid).
export type { UIState }
