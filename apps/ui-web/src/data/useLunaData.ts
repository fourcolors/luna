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
  type ClientFrame,
  type ConnectionStatus,
  type ServerFrame,
  type SuggestedActionStatus,
  type SuggestedActionWire,
  type TransportHandle,
  type UIState,
} from "@luna/ui-shared/core"
import { loadConfig, saveConfig, type PersistedConfig } from "./config"
import {
  DEEP_LINK_CONFIRM_GRACE_MS,
  deepLinkShieldDecision,
  onDeepLinkThread,
  takeLaunchThreadId,
} from "./deep-link"
import { loadNativeLocalConnection, shouldHydrateNativeLocal } from "./native-connection"
import { isSystemThread } from "./studio-thread-projection"
import { useUiSelector, useUiStore, type UiStore } from "./useUiStore"
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

const CLIENT_INFO = { name: "luna-web", version: "0.0.1", platform: "browser" } as const
const selectThreadList = (state: UIState) => state.threadList
const selectSelectedThreadId = (state: UIState) => state.selectedThreadId
const selectSuggestedActions = (state: UIState) => state.suggestedActions
const selectMcpCapable = (state: UIState): boolean => state.capabilities.mcpApps === true

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
]

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

export class RestartRefusedError extends Error {
  override readonly name = "RestartRefusedError"
}

export interface LunaData {
  /** Selector-capable reducer store. Live panels subscribe to owned slices
   *  instead of receiving the entire UIState through the Studio board. */
  readonly store: UiStore
  readonly status: ConnectionStatus
  readonly connected: boolean
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
  readonly send: (frame: ClientFrame) => void
  /** Subscribe to every raw ServerFrame as it arrives, in addition to the
   *  reducer dispatch. For frame types the reducer intentionally no-ops
   *  (e.g. `turn-complete`, the only true end-of-agentic-turn signal) this is
   *  the only way to observe them without a second socket. Returns unsubscribe. */
  readonly onServerFrame: (listener: (frame: ServerFrame) => void) => () => void
  /** Persisted connection config + mutators — the Settings panel's connect form. */
  readonly config: PersistedConfig
  readonly updateConfig: (patch: Partial<PersistedConfig>) => void
  readonly reconnect: () => void
  readonly disconnect: () => void
  readonly selectAccount: (id: string | null) => void
  readonly restartServer: () => Promise<void>
  /** The default model new threads are created with (persisted config). */
  readonly model: string

  /** The MCP Apps relay for kind="mcp-app" widgets — undefined until the
   *  server advertises `capabilities.mcpApps` (WidgetFrame then falls back to
   *  a static source view instead of a dead iframe). */
  readonly mcp: WebMcpRelay | undefined
  /** An `open-artifact-widget` frame landed (widget_write/mcp_app_write just
   *  created one, or the user asked to reopen one) — final-app spawns/focuses
   *  a widget panel for it. Nonce forces re-focus on a repeat open. */
  readonly focusArtifact: FocusArtifactSignal | null
  /** A `widget-open` frame named one of WIDGET_DIRECTORY's kinds — final-app
   *  switches workspace and brings that panel to front. */
  readonly widgetOpen: { readonly kind: string; readonly nonce: number } | null
  /** A `luna://thread/<id>` deep link fired (cold launch drain or warm
   *  `studio://deep-link` event). Selection/subscribe already happened in the
   *  bootstrap effect; final-app just surfaces the chat panel. The nonce forces
   *  a re-surface even when the same id is deep-linked twice. */
  readonly deepLinkThread: { readonly id: string; readonly nonce: number } | null
  /** Route to a thread by id (#298 primitive): selects + subscribes via the
   *  bootstrap effect and fires deepLinkThread so final-app surfaces the chat
   *  panel. Used by useStudioNotifier's focus-regain + web-click routing. */
  readonly requestDeepLink: (id: string) => void
}

export function useLunaData(): LunaData {
  const store = useUiStore()
  const threadList = useUiSelector(store, selectThreadList)
  const selectedThreadId = useUiSelector(store, selectSelectedThreadId)
  const suggestedActionsByThread = useUiSelector(store, selectSuggestedActions)
  const mcpCapable = useUiSelector(store, selectMcpCapable)
  const dispatch = store.dispatch
  // Reactive persisted config (the Settings panel edits url/token/model/account);
  // cfgRef mirrors it so the stable newThread()/bootstrap closures read the latest.
  const [config, setConfig] = useState<PersistedConfig>(loadConfig)
  const cfgRef = useRef(config)
  cfgRef.current = config
  const updateConfig = useCallback(
    (patch: Partial<PersistedConfig>): void =>
      setConfig((prev) => {
        const next = { ...prev, ...patch }
        saveConfig(next)
        return next
      }),
    [],
  )

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

  // ── Deep links (luna://thread/<id>) ────────────────────────────────────
  // A deep link routes through the bootstrap effect (which owns select +
  // subscribe + activeThreadId), not directly. pendingDeepLinkRef carries the
  // target into that effect; deepLinkNonce forces the effect to re-run since a
  // ref mutation alone would not. routedDeepLinkRef records the id we routed to
  // so the stale-selection guard never yanks a deep-linked thread that lives
  // beyond the 50-thread list window — but only after a thread-snapshot
  // confirms the thread exists. deepLinkConfirmedRef / graceUntil cover the
  // missing-thread case (deleted, wrong server, never existed) so selection
  // is not stranded forever. deepLinkThread is the surface signal final-app
  // watches to bring the chat panel to front.
  const pendingDeepLinkRef = useRef<string | null>(null)
  const routedDeepLinkRef = useRef<string | null>(null)
  const deepLinkConfirmedRef = useRef(false)
  const deepLinkGraceUntilRef = useRef(0)
  const deepLinkGraceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dlNonce = useRef(0)
  const [deepLinkNonce, setDeepLinkNonce] = useState(0)
  const [deepLinkDrained, setDeepLinkDrained] = useState(false)
  const [deepLinkThread, setDeepLinkThread] = useState<{ id: string; nonce: number } | null>(null)
  const requestDeepLink = useCallback((id: string): void => {
    pendingDeepLinkRef.current = id
    setDeepLinkThread({ id, nonce: ++dlNonce.current })
    setDeepLinkNonce((n) => n + 1)
  }, [])

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
        } else if (
          frame.type === "thread-snapshot" &&
          routedDeepLinkRef.current !== null &&
          frame.threadId === routedDeepLinkRef.current
        ) {
          // Deep-linked thread is real (subscribe always snapshots known ids).
          // Clear the grace timer — the top-50 list shield may stay forever.
          deepLinkConfirmedRef.current = true
          if (deepLinkGraceTimerRef.current !== null) {
            clearTimeout(deepLinkGraceTimerRef.current)
            deepLinkGraceTimerRef.current = null
          }
        }
      }),
    [onServerFrame],
  )

  // Drop the grace timer on unmount so a late fire cannot touch a dead store.
  useEffect(
    () => () => {
      if (deepLinkGraceTimerRef.current !== null) {
        clearTimeout(deepLinkGraceTimerRef.current)
        deepLinkGraceTimerRef.current = null
      }
    },
    [],
  )

  // Latched true once any thread-list frame has arrived; the bootstrap effect
  // refuses to select/mint until then (an empty pre-load list must not be
  // mistaken for a truly empty account).
  const listReceivedRef = useRef(false)

  const onFrame = useCallback(
    (frame: ServerFrame): void => {
      if (frame.type === "thread-list") listReceivedRef.current = true
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

  const { status, connect, send, disconnect } = useTransport({ onFrame, onOpen })
  sendRef.current = send

  // Native first-run: the local server installer already owns the credential
  // in ~/.luna/.env. Provision it into Studio when the loopback config has no
  // usable token, then connect immediately. Browser Studio has no Tauri invoke
  // surface and keeps the manual Settings flow.
  useEffect(() => {
    const current = cfgRef.current
    if (!shouldHydrateNativeLocal(current)) return
    let cancelled = false
    void loadNativeLocalConnection().then((native) => {
      if (cancelled || native === null) return
      updateConfig(native)
      connect(native.url, native.token)
    })
    return () => {
      cancelled = true
    }
  }, [connect, updateConfig])

  // Connection controls for the Settings panel.
  const reconnect = useCallback(
    (): void => connect(cfgRef.current.url, cfgRef.current.token),
    [connect],
  )
  const selectAccount = useCallback(
    (id: string | null): void => {
      dispatch({ tag: "select-account", accountId: id })
      updateConfig({ selectedAccountId: id })
    },
    [dispatch, updateConfig],
  )
  const restartServer = useCallback(async (): Promise<void> => {
    const ctrl = cfgRef.current.url.replace(/^ws/, "http").replace(/:4753\/ui$/, ":4754/trpc")
    const res = await fetch(ctrl + "/control.restart", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + cfgRef.current.token,
      },
      body: JSON.stringify({ json: null }),
    })
    // control.restart can now REFUSE (ok:false — e.g. no supervisor detected
    // on the server side); a refused restart must not look like a silent
    // success to the operator.
    let refusal: string | undefined
    try {
      const body = (await res.json()) as {
        result?: { data?: { json?: { ok?: boolean; message?: string } } }
      }
      const payload = body.result?.data?.json
      if (payload?.ok === false) {
        refusal = payload.message ?? "restart refused by server"
      }
    } catch {
      // Non-JSON / transport oddities: keep prior fire-and-forget behavior.
    }
    if (refusal !== undefined) throw new RestartRefusedError(refusal)
  }, [])
  // Seed the reducer's selected account from persisted config once on mount.
  useEffect(() => {
    if (config.selectedAccountId !== null) {
      dispatch({ tag: "select-account", accountId: config.selectedAccountId })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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

  // Deep-link wiring: subscribe to warm activations and drain the cold-launch
  // URL. deepLinkDrained latches once the cold drain settles so the bootstrap
  // effect can hold its fallback selection until then (kills the cold-launch
  // flash of the wrong thread). In the browser build both bridge fns no-op, so
  // takeLaunchThreadId resolves null immediately and the gate opens at once.
  useEffect(() => {
    const un = onDeepLinkThread(requestDeepLink)
    takeLaunchThreadId()
      .then((id) => {
        if (id) requestDeepLink(id)
      })
      .finally(() => setDeepLinkDrained(true))
    return () => un()
  }, [requestDeepLink])

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
    // A pending deep link wins over every other selection rule: select +
    // subscribe the exact thread even if it is absent from the (windowed)
    // thread-list, and persist it as the active thread so a reload lands back
    // here. routedDeepLinkRef then shields it from the stale-selection guard.
    const deepId = pendingDeepLinkRef.current
    if (deepId) {
      pendingDeepLinkRef.current = null
      routedDeepLinkRef.current = deepId
      deepLinkConfirmedRef.current = false
      deepLinkGraceUntilRef.current = Date.now() + DEEP_LINK_CONFIRM_GRACE_MS
      if (deepLinkGraceTimerRef.current !== null) clearTimeout(deepLinkGraceTimerRef.current)
      // Re-run bootstrap after grace so an unconfirmed (missing) deep link
      // falls through instead of shielding forever.
      deepLinkGraceTimerRef.current = setTimeout(() => {
        deepLinkGraceTimerRef.current = null
        setDeepLinkNonce((n) => n + 1)
      }, DEEP_LINK_CONFIRM_GRACE_MS)
      dispatch({ tag: "select-thread", threadId: deepId })
      send({ type: "subscribe", threadId: deepId })
      if (cfgRef.current.activeThreadId !== deepId) updateConfig({ activeThreadId: deepId })
      return
    }
    // Never decide before the first thread-list frame: an empty pre-load list
    // would mint a spurious thread and shadow the saved activeThreadId.
    if (!listReceivedRef.current) return
    // Hold the fallback selection until the cold-launch deep-link drain settles
    // so a native launch never flashes the wrong thread first. Browser resolves
    // this immediately (both bridge fns no-op).
    if (!deepLinkDrained) return
    // A real, non-system selection stands. A selection MISSING from a received
    // list is stale (its thread was archived/removed while we were away - the
    // transport reconnects across long outages), and a system-thread selection
    // is a hijack; both fall through to pick/mint a real conversation.
    if (selectedThreadId) {
      // Deep-link shield: keep while confirmed (or grace still open). Clear
      // and fall through when the grace expired with no thread-snapshot —
      // that thread does not exist on this server.
      const shield = deepLinkShieldDecision({
        selectedThreadId,
        routedDeepLinkId: routedDeepLinkRef.current,
        confirmed: deepLinkConfirmedRef.current,
        nowMs: Date.now(),
        graceUntilMs: deepLinkGraceUntilRef.current,
      })
      if (shield.action === "keep") return
      if (shield.action === "clear-and-fallthrough") {
        routedDeepLinkRef.current = null
        deepLinkConfirmedRef.current = false
        // Drop any pending grace timer so a late fire cannot bump deepLinkNonce
        // and re-run bootstrap after we already fell through.
        if (deepLinkGraceTimerRef.current !== null) {
          clearTimeout(deepLinkGraceTimerRef.current)
          deepLinkGraceTimerRef.current = null
        }
        deepLinkGraceUntilRef.current = 0
        // Fall through to saved/first/mint below (do not early-return).
      } else {
        const summary = threadList.find((s) => s.id === selectedThreadId)
        if (summary && !isSystemThread(summary)) return
      }
    }
    // Prefer the last thread the user actively opened (persisted activeThreadId),
    // then fall back to the first real thread. Skip hub-internal threads (e.g.
    // useLunaInbox's inbox-sync thread) - they must never auto-select.
    const savedId = cfgRef.current.activeThreadId
    const first =
      (savedId != null
        ? threadList.find((s) => s.id === savedId && !isSystemThread(s))
        : undefined) ?? threadList.find((s) => !isSystemThread(s))
    if (first) {
      dispatch({ tag: "select-thread", threadId: first.id })
      send({ type: "subscribe", threadId: first.id })
    } else if (!mintedRef.current) {
      mintedRef.current = true
      send({ type: "new-thread", model: cfgRef.current.model })
    }
  }, [
    status.kind,
    threadList,
    selectedThreadId,
    dispatch,
    send,
    deepLinkNonce,
    deepLinkDrained,
    updateConfig,
  ])

  // Subscribe whenever the selection lands on an unsubscribed thread (covers
  // server auto-select on thread-created). Idempotent server-side. The set is
  // per-connection state — the server scopes subscriptions to the socket, so
  // it must clear whenever the connection leaves "open" (mirrors
  // widgetDirSentRef) or a transparent reconnect would leave the active
  // thread unsubscribed and assistant output would never render.
  const subscribedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (status.kind !== "open") {
      subscribedRef.current.clear()
      return
    }
    const id = selectedThreadId
    if (id && !subscribedRef.current.has(id)) {
      subscribedRef.current.add(id)
      send({ type: "subscribe", threadId: id })
    }
  }, [selectedThreadId, status.kind, send])

  // Selection guard: the reducer auto-selects ANY newly-created thread, incl.
  // useLunaInbox's hidden "system" inbox-sync thread — which would hijack the
  // user's active conversation (chat title reverts, respondToAction targets the
  // wrong thread). Whenever selection lands on a system thread, restore the
  // last real selection (or the first real thread). Records the last real
  // selection so a hijack can be undone.
  const lastUserThreadRef = useRef<string | null>(null)
  useEffect(() => {
    const id = selectedThreadId
    if (!id) return
    const summary = threadList.find((candidate) => candidate.id === id)
    if (!summary) return
    if (isSystemThread(summary)) {
      const prev = lastUserThreadRef.current
      const restore =
        prev && threadList.some((candidate) => candidate.id === prev && !isSystemThread(candidate))
          ? prev
          : (threadList.find((candidate) => !isSystemThread(candidate))?.id ?? null)
      if (restore && restore !== id) dispatch({ tag: "select-thread", threadId: restore })
    } else {
      lastUserThreadRef.current = id
    }
  }, [selectedThreadId, threadList, dispatch])

  const openThread = useCallback(
    (id: string): void => {
      dispatch({ tag: "select-thread", threadId: id })
      send({ type: "subscribe", threadId: id })
      // Last-thread restore: persist ONLY explicit user opens so a reload lands
      // back here. System-thread hijacks never call openThread, so this can
      // never persist a hub-internal thread. Skip the write when re-selecting
      // the already-persisted thread.
      if (cfgRef.current.activeThreadId !== id) updateConfig({ activeThreadId: id })
    },
    [dispatch, send, updateConfig],
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
        for (const actions of suggestedActionsByThread.values()) {
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
  }, [suggestedActionsByThread])

  const suggestedActions = useMemo<ReadonlyArray<SuggestedActionWire>>(() => {
    const threadId = selectedThreadId
    if (!threadId) return []
    const actions = suggestedActionsByThread.get(threadId) ?? []
    if (optimisticActions.size === 0) return actions
    return actions.map((a) => {
      const override = optimisticActions.get(a.id)
      return override !== undefined ? { ...a, status: override } : a
    })
  }, [selectedThreadId, suggestedActionsByThread, optimisticActions])

  const respondToAction = useCallback(
    (actionId: string, decision: "accept" | "dismiss"): void => {
      const threadId = selectedThreadId
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
    [selectedThreadId, send],
  )

  const mcp = useMemo<WebMcpRelay | undefined>(
    () => (mcpCapable ? { readResource: mcpReadResource, callTool: mcpCallTool } : undefined),
    [mcpCapable, mcpReadResource, mcpCallTool],
  )

  return {
    store,
    status,
    connected: status.kind === "open",
    openThread,
    newThread,
    appendMsg,
    threadNote,
    suggestedActions,
    respondToAction,
    send,
    onServerFrame,
    config,
    updateConfig,
    reconnect,
    disconnect,
    selectAccount,
    restartServer,
    model: cfgRef.current.model,
    mcp,
    focusArtifact,
    widgetOpen,
    deepLinkThread,
    requestDeepLink,
  }
}
