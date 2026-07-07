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
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  type ChatMessage,
  type ClientFrame,
  type ConnectionStatus,
  type ObsEvent,
  type PinnedArtifactItem,
  type ServerFrame,
  type SessionSummary,
  type SuggestedActionStatus,
  type SuggestedActionWire,
  type ThreadView,
  type TransportHandle,
  type UIState,
  type VaultDeleteFrame,
  type VaultPutFrame,
  type VaultSyncConfigFrame,
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

/**
 * Threads carrying this tag are hub-internal (e.g. useLunaInbox's inbox-sync
 * thread) — never a user conversation. Filtered out of the design's thread
 * list/sidebar and never auto-selected as the "first" thread on a fresh boot.
 * Keep in sync with data/useLunaInbox.ts's SYSTEM_THREAD_TAG.
 */
const SYSTEM_THREAD_TAG = "system"
const isSystemThread = (s: SessionSummary): boolean => s.tags.includes(SYSTEM_THREAD_TAG)

/**
 * P4 vibe-coded widgets — the board panels this web client can summon by
 * `kind` (the agent's open_widget tool). Scoped to the seams that are
 * actually real today — chat/threads/inbox are wired to live server data;
 * the rest of final-app.jsx's DEFS (map/task/timer/…) stays summonable only
 * from inside the app until it carries real state. Mirrors
 * apps/ui-web/src/App.tsx's WEB_WIDGET_DIRECTORY (Solid).
 */
const WIDGET_DIRECTORY: ReadonlyArray<{
  readonly kind: string
  readonly title: string
  readonly description: string
}> = [
  { kind: "chat", title: "Chat", description: "The active conversation with Luna" },
  { kind: "threads", title: "Threads", description: "The conversation/thread list" },
  { kind: "inbox", title: "Inbox", description: "Delegated items awaiting a brain" },
  { kind: "vault", title: "Vault", description: "Credential registry and 1Password sync settings" },
]

/** requestId-correlated vault mutation ack. `vault-status` is deliberately a
 *  reducer no-op (acks are per-consumer, matched by requestId, and the
 *  follow-up vault-list already refreshes the store), so the ack is surfaced
 *  through the onServerFrame side-channel into local hook state instead. */
type VaultStatusAck = {
  readonly requestId: string
  readonly ok: boolean
  readonly message: string
}

/** requestId-keyed pending MCP relay promise, settled by the matching
 *  mcp-resource-result / mcp-tool-result frame (or a local timeout). */
type McpPendingResolver = (r: {
  ok: boolean
  mimeType?: string
  text?: string
  result?: unknown
  message?: string
}) => void

/** The web client's MCP relay, handed to a kind="mcp-app" WidgetFrame.
 *  Present only once the server advertises `capabilities.mcpApps`. */
export interface WebMcpRelay {
  readonly readResource: (
    uri: string,
  ) => Promise<{ ok: boolean; mimeType?: string; text?: string; message?: string }>
  readonly callTool: (
    appUri: string,
    tool: string,
    args: unknown,
  ) => Promise<{ ok: boolean; result?: unknown; message?: string }>
}

/** An agent-driven "open this artifact as a widget" signal (open-artifact-
 *  widget frame — fired on widget_write/mcp_app_write create, or a reopen
 *  ask). The nonce forces re-focus even when the same id is opened twice. */
export interface FocusArtifactSignal {
  readonly id: string
  readonly nonce: number
}

export interface LunaData {
  readonly status: ConnectionStatus
  readonly connected: boolean
  readonly threads: StudioThread[]
  readonly activeThread: string | null
  readonly openThread: (id: string) => void
  readonly newThread: () => void
  readonly appendMsg: (threadId: string, msg: StudioMsg) => void
  readonly threadNote: (id: string, patch: unknown) => void
  /**
   * The active thread's suggested actions (Luna proposes an action inline;
   * PRD "Suggested Actions"), with optimistic status overrides applied so an
   * Accept/Dismiss click flips the chip immediately rather than waiting on
   * the server's suggested-action-update round-trip. Empty on older servers
   * (no `suggestedActions` hello capability) — the reducer's map is simply
   * never populated, so this stays `[]`.
   */
  readonly suggestedActions: ReadonlyArray<SuggestedActionWire>
  /** Accept (auto-executes server-side) or dismiss one suggested action. */
  readonly respondToAction: (actionId: string, decision: "accept" | "dismiss") => void
  /**
   * Escape hatch for seams that need the raw reducer state or to send a
   * frame type this hub doesn't wrap (e.g. useLunaInbox minting its own
   * system thread + turn). Prefer the narrow handlers above where they exist.
   */
  readonly state: UIState
  readonly send: (frame: ClientFrame) => void
  /** Vault state plus send helpers. The secret value exists only in the caller
   *  long enough to build the vault-put frame. `lastStatus` is tracked here
   *  (via the onServerFrame side-channel) because `vault-status` is
   *  deliberately a reducer no-op: mutation acks are per-consumer concerns,
   *  matched by requestId, not shared store state. */
  readonly vault: {
    readonly items: UIState["vaultItems"]
    readonly sync: UIState["vaultSync"]
    readonly storage: UIState["vaultStorage"]
    readonly lastStatus: VaultStatusAck | null
    readonly disabled: boolean
    readonly onPut: (params: Omit<VaultPutFrame, "type">) => void
    readonly onDelete: (params: Omit<VaultDeleteFrame, "type">) => void
    readonly onSyncConfig: (params: Omit<VaultSyncConfigFrame, "type">) => void
  }
  /** Subscribe to every raw ServerFrame as it arrives, in addition to the
   *  reducer dispatch. For frame types the reducer intentionally no-ops
   *  (e.g. `turn-complete`, the only true end-of-agentic-turn signal) this is
   *  the only way to observe them without a second socket. Returns unsubscribe. */
  readonly onServerFrame: (listener: (frame: ServerFrame) => void) => () => void
  /** The default model new threads are created with (persisted config). */
  readonly model: string

  /**
   * P4 vibe-coded widgets — durable pinned artifacts (agent-authored `widget`/
   * `mcp-app` kinds are the ones final-app renders as board panels; `code`/
   * `html`/`markdown` kinds are content previews it doesn't summon here). The
   * server resends this after every hello, so rebuilding a widget panel from
   * it on each connect is what makes a summoned widget survive a reload —
   * nothing is cached client-side; the server's artifact store IS the
   * persistence.
   */
  readonly pinnedArtifacts: ReadonlyArray<PinnedArtifactItem>
  /** The MCP Apps relay for kind="mcp-app" widgets — undefined until the
   *  server advertises `capabilities.mcpApps` (WidgetFrame then falls back to
   *  a static source view instead of a dead iframe). */
  readonly mcp: WebMcpRelay | undefined
  /** Live obs-event stream, forwarded (cap-gated) into a kind="widget"
   *  iframe's luna.subscribe() callers. */
  readonly obsEvents: ReadonlyArray<ObsEvent>
  /** An `open-artifact-widget` frame landed (widget_write/mcp_app_write just
   *  created one, or the user asked to reopen one) — final-app spawns/focuses
   *  a widget panel for it. Nonce forces re-focus on a repeat open. */
  readonly focusArtifact: FocusArtifactSignal | null
  /** A `widget-open` frame named one of WIDGET_DIRECTORY's kinds — final-app
   *  switches workspace and brings that panel to front. */
  readonly widgetOpen: { readonly kind: string; readonly nonce: number } | null
}

export function useLunaData(): LunaData {
  const { state, dispatch } = useUiStore()
  const cfgRef = useRef(loadConfig())

  // Latest send in a ref so onFrame (stable) can request a fresh list-threads.
  const sendRef = useRef<(f: ClientFrame) => void>(() => {})

  // Raw-frame side-channel (see LunaData.onServerFrame doc comment above).
  const frameListenersRef = useRef<Set<(frame: ServerFrame) => void>>(new Set())
  const onServerFrame = useCallback(
    (listener: (frame: ServerFrame) => void): (() => void) => {
      frameListenersRef.current.add(listener)
      return () => frameListenersRef.current.delete(listener)
    },
    [],
  )

  // ── P4 vibe-coded widgets ──────────────────────────────────────────────
  // Agent-driven focus/open signals (open-artifact-widget / widget-open) are
  // side-effect only — the reducer's default arm no-ops both (no store state
  // backs them; see reducer.ts's "widget-open"/"open-artifact-widget" case).
  // Surfaced as plain state via the onServerFrame side-channel above (rather
  // than editing onFrame) so final-app.jsx can react to them in a useEffect.
  const focusNonceRef = useRef(0)
  const [focusArtifact, setFocusArtifact] = useState<FocusArtifactSignal | null>(null)
  const widgetOpenNonceRef = useRef(0)
  const [widgetOpen, setWidgetOpen] = useState<{ kind: string; nonce: number } | null>(null)
  const [vaultLastStatus, setVaultLastStatus] = useState<VaultStatusAck | null>(null)

  // MCP Apps relay: a kind="mcp-app" WidgetFrame asks for resources/tools;
  // stamp a requestId, send the WS frame, and resolve when the matching
  // mcp-resource-result / mcp-tool-result frame arrives (settled below via
  // onServerFrame). Bounded by a timeout so a dropped result can't leak a
  // pending promise forever.
  const mcpReqSeqRef = useRef(0)
  const mcpPendingRef = useRef<Map<string, McpPendingResolver>>(new Map())

  function mcpRequest<T>(requestId: string, frame: ClientFrame, timeoutMs = 30000): Promise<T> {
    return new Promise((resolve) => {
      const done: McpPendingResolver = (r) => {
        if (!mcpPendingRef.current.has(requestId)) return
        mcpPendingRef.current.delete(requestId)
        clearTimeout(timer)
        resolve(r as T)
      }
      const timer = setTimeout(
        () => done({ ok: false, message: "MCP request timed out" }),
        timeoutMs,
      )
      mcpPendingRef.current.set(requestId, done)
      sendRef.current(frame)
    })
  }

  const mcpReadResource = useCallback(
    (uri: string): Promise<{ ok: boolean; mimeType?: string; text?: string; message?: string }> => {
      const requestId = `mr${++mcpReqSeqRef.current}`
      return mcpRequest(requestId, { type: "mcp-resource-read", requestId, uri })
    },
    [],
  )

  const mcpCallTool = useCallback(
    (appUri: string, tool: string, args: unknown): Promise<{ ok: boolean; result?: unknown; message?: string }> => {
      const requestId = `mt${++mcpReqSeqRef.current}`
      return mcpRequest(requestId, { type: "mcp-tool-call", requestId, appUri, tool, args })
    },
    [],
  )

  // Settle the widget/mcp side-effect frames via the onServerFrame side-
  // channel above, instead of editing onFrame.
  useEffect(
    () =>
      onServerFrame((frame) => {
        if (frame.type === "open-artifact-widget") {
          setFocusArtifact({ id: frame.artifactId, nonce: ++focusNonceRef.current })
        } else if (frame.type === "widget-open") {
          if (WIDGET_DIRECTORY.some((w) => w.kind === frame.kind)) {
            setWidgetOpen({ kind: frame.kind, nonce: ++widgetOpenNonceRef.current })
          }
        } else if (frame.type === "mcp-resource-result" || frame.type === "mcp-tool-result") {
          mcpPendingRef.current.get(frame.requestId)?.(frame)
        } else if (frame.type === "vault-status") {
          setVaultLastStatus({
            requestId: frame.requestId,
            ok: frame.ok,
            message: frame.message,
          })
        }
      }),
    [onServerFrame],
  )

  const onFrame = useCallback(
    (frame: ServerFrame): void => {
      dispatch(frame)
      frameListenersRef.current.forEach((listener) => listener(frame))
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

  // Announce this client as a widget host once per connection (the server
  // "replaces any previously announced directory for this connection") — a
  // separate effect on status.kind rather than folding into onOpen, so a
  // reconnect re-announces without touching the hello handshake above.
  const widgetDirSentRef = useRef(false)
  useEffect(() => {
    if (status.kind !== "open") {
      widgetDirSentRef.current = false
      return
    }
    if (widgetDirSentRef.current) return
    widgetDirSentRef.current = true
    send({ type: "widget-directory", widgets: WIDGET_DIRECTORY })
  }, [status.kind, send])

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
    // Skip hub-internal threads (e.g. useLunaInbox's inbox-sync thread) —
    // they must never become the auto-selected "active" conversation.
    const first = state.threadList.find((s) => !isSystemThread(s))
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

  // Selection guard: the reducer auto-selects ANY newly-created thread, incl.
  // useLunaInbox's hidden "system" inbox-sync thread — which would hijack the
  // user's active conversation (chat title reverts, respondToAction targets the
  // wrong thread). Whenever selection lands on a system thread, restore the
  // last real selection (or the first real thread). Records the last real
  // selection so a hijack can be undone.
  const lastUserThreadRef = useRef<string | null>(null)
  useEffect(() => {
    const id = state.selectedThreadId
    if (!id) return
    const summary = state.threadList.find((s) => s.id === id)
    if (!summary) return
    if (isSystemThread(summary)) {
      const prev = lastUserThreadRef.current
      const restore =
        prev && state.threadList.some((s) => s.id === prev && !isSystemThread(s))
          ? prev
          : (state.threadList.find((s) => !isSystemThread(s))?.id ?? null)
      if (restore && restore !== id) dispatch({ tag: "select-thread", threadId: restore })
    } else {
      lastUserThreadRef.current = id
    }
  }, [state.selectedThreadId, state.threadList, dispatch])

  const threads = useMemo<StudioThread[]>(
    () =>
      state.threadList
        .filter((s: SessionSummary) => !isSystemThread(s))
        .map((s: SessionSummary) => mapThread(s, state.threads.get(s.id), state.selectedThreadId)),
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

  // ── Suggested actions: optimistic Accept/Dismiss ──────────────────────
  // Mirrors apps/ui-web (Solid)'s optimisticStatuses pattern: clicking Accept
  // or Dismiss flips the chip's status immediately; the authoritative
  // suggested-action-update reconciles (clears the override) once the server
  // answers. A timeout rollback guards against a lost-race respond() (cross-
  // thread/unknown actionId, dropped frame) so the chip never sticks forever.
  const OPTIMISTIC_ROLLBACK_MS = 8000
  const [optimisticActions, setOptimisticActions] = useState<
    ReadonlyMap<string, SuggestedActionStatus>
  >(new Map())

  useEffect(() => {
    setOptimisticActions((overrides) => {
      if (overrides.size === 0) return overrides
      const next = new Map(overrides)
      let changed = false
      for (const [id] of overrides) {
        let found = false
        for (const actions of state.suggestedActions.values()) {
          const action = actions.find((a) => a.id === id)
          if (action) {
            found = true
            if (action.status !== "proposed") next.delete(id)
            break
          }
        }
        if (!found) next.delete(id)
        if (!next.has(id)) changed = true
      }
      return changed ? next : overrides
    })
  }, [state.suggestedActions])

  const suggestedActions = useMemo<ReadonlyArray<SuggestedActionWire>>(() => {
    const threadId = state.selectedThreadId
    if (!threadId) return []
    const actions = state.suggestedActions.get(threadId) ?? []
    if (optimisticActions.size === 0) return actions
    return actions.map((a) => {
      const override = optimisticActions.get(a.id)
      return override !== undefined ? { ...a, status: override } : a
    })
  }, [state.selectedThreadId, state.suggestedActions, optimisticActions])

  const respondToAction = useCallback(
    (actionId: string, decision: "accept" | "dismiss"): void => {
      const threadId = state.selectedThreadId
      if (!threadId) return
      const optimistic: SuggestedActionStatus = decision === "accept" ? "accepted" : "dismissed"
      setOptimisticActions((prev) => new Map(prev).set(actionId, optimistic))
      send({ type: "suggested-action-respond", threadId, actionId, decision })
      setTimeout(() => {
        setOptimisticActions((prev) => {
          if (!prev.has(actionId)) return prev // already reconciled
          const next = new Map(prev)
          next.delete(actionId)
          return next
        })
      }, OPTIMISTIC_ROLLBACK_MS)
    },
    [state.selectedThreadId, send],
  )

  const vaultPut = useCallback(
    (params: Omit<VaultPutFrame, "type">): void => {
      send({ type: "vault-put", ...params })
    },
    [send],
  )

  const vaultDelete = useCallback(
    (params: Omit<VaultDeleteFrame, "type">): void => {
      send({ type: "vault-delete", ...params })
    },
    [send],
  )

  const vaultSyncConfig = useCallback(
    (params: Omit<VaultSyncConfigFrame, "type">): void => {
      send({ type: "vault-sync-config", ...params })
    },
    [send],
  )

  const mcpCapable = state.capabilities.mcpApps === true
  const mcp = useMemo<WebMcpRelay | undefined>(
    () => (mcpCapable ? { readResource: mcpReadResource, callTool: mcpCallTool } : undefined),
    [mcpCapable, mcpReadResource, mcpCallTool],
  )

  return {
    status,
    connected: status.kind === "open",
    threads,
    activeThread: state.selectedThreadId,
    openThread,
    newThread,
    appendMsg,
    threadNote,
    suggestedActions,
    respondToAction,
    state,
    send,
    vault: {
      items: state.vaultItems,
      sync: state.vaultSync,
      storage: state.vaultStorage,
      lastStatus: vaultLastStatus,
      disabled: status.kind !== "open",
      onPut: vaultPut,
      onDelete: vaultDelete,
      onSyncConfig: vaultSyncConfig,
    },
    onServerFrame,
    model: cfgRef.current.model,
    pinnedArtifacts: state.pinnedArtifacts,
    mcp,
    obsEvents: state.events,
    focusArtifact,
    widgetOpen,
  }
}

// Keep UIState referenced for the type-only import above (documentation aid).
export type { UIState }
