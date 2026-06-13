/**
 * Solid migration — chunk 10/13: full App shell.
 *
 * Mirrors apps/ui-web/src/App.tsx top-level component (line 98+):
 *   - persisted config (URL, token, model, enterToSend) in localStorage
 *   - createUiStore (reducer-backed) holds all chat/obs state
 *   - createTransport drives the WebSocket; onFrame → store.dispatch
 *   - settings panel auto-opens when not connected
 *   - Chat pane: Sidebar + ChatPanel (+ ArtifactPanel when artifacts)
 *   - Obs pane: ObsPanel (kind chips, drop banner, event log)
 *
 * Reactivity contract:
 *   - cfg + selectedKinds + pane + settingsOpen are signals
 *   - store.state is a Solid store proxy — reading any field tracks it
 *   - createMemo wraps derived bools (isConnected, chatEnabled, etc.)
 *     so JSX reads them without re-running the whole effect
 *
 * Differences from React:
 *   - useReducer → createUiStore (reconcile-patched store.state)
 *   - useRef<TransportHandle> → composable owns the live handle internally
 *   - useEffect cleanup on unmount is implicit via composable.onCleanup
 */
import { type Component, For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import {
  filterEvents,
  type ClientFrame,
  type ChatAttachment,
  type SuggestedActionStatus,
} from "@luna/ui-shared/core"
import {
  AccountSwitcher,
  ActionsPanel,
  ArtifactPanel,
  ChatPanel,
  ConnectionSummary,
  ConnectorsPanel,
  ObsPanel,
  Sidebar,
  SkillsPanel,
  VaultPanel,
  WorkflowGallery,
  buildNewThreadFrame,
  clampEffortToModel,
  createTransport,
  createUiStore,
  type EffortLevel,
  type SlashCommand,
  type VaultStatusAck,
} from "@luna/ui-shared-solid"
import { SetupTerminal, b64ToBytes } from "./SetupTerminal"
import {
  getAppearance,
  setAppearance,
  onAppearanceChange,
  PALETTES,
  PALETTE_SWATCHES,
  FONTS,
  FONT_SIZES,
  FONT_LABELS,
  FONT_SIZE_LABELS,
} from "./appearance.js"
import { createBoard, EDGE_MARGIN, SNAP_GAP, TOP_MIN } from "./board/createBoard.js"
import { Board, FavoritesGrid, Shelf, type BoardPanelDef } from "./board/Board.jsx"

const CONTROL_URL = "http://127.0.0.1:4754/trpc"

/** Call control.restart mutation via raw fetch (tRPC v11: mutations = POST).
 *  The control server is loopback-bound and bearer-gated by the same token as
 *  the WS connection, so we attach it here. */
async function restartServer(token: string): Promise<void> {
  await fetch(`${CONTROL_URL}/control.restart`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ json: null }),
  })
}

/** Call control.status query via raw fetch (tRPC v11: queries = GET). */
async function fetchServerStatus(token: string): Promise<{ uptime: number; startedAt: string; version: string } | null> {
  try {
    const res = await fetch(
      `${CONTROL_URL}/control.status?input=${encodeURIComponent(JSON.stringify({ json: null }))}`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const json = await res.json() as { result?: { data?: { uptime: number; startedAt: string; version: string } } }
    return json.result?.data ?? null
  } catch {
    return null
  }
}

const STORAGE_KEY = "ui-ws.config"
const DEFAULT_URL = "ws://127.0.0.1:4753/ui"
const DEFAULT_MODEL = "claude-opus-4-8"

const MODEL_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "claude-opus-4-8", label: "Opus 4.8 — most capable (default)" },
  { value: "claude-opus-4-7", label: "Opus 4.7 — prior gen" },
  { value: "claude-sonnet-4-6", label: "Sonnet 4.6 — balanced" },
  { value: "claude-haiku-4-5", label: "Haiku 4.5 — fastest" },
  { value: "claude-opus-4-6", label: "Opus 4.6 — prior gen" },
  { value: "claude-sonnet-4-5", label: "Sonnet 4.5 — prior gen" },
]

interface PersistedConfig {
  url: string
  token: string
  model: string
  /**
   * Persisted effort level for new threads. Optional — absent on older
   * configs. `| undefined` so a model switch can clear a now-invalid value
   * in one assignment (review F11); JSON.stringify drops undefined keys, so
   * the persisted localStorage form never carries an explicit null/undefined.
   */
  effort?: EffortLevel | undefined
  /** When true, plain Enter sends; Shift+Enter newline. Default false. */
  enterToSend: boolean
  /** Last-selected account id. null = use default broker rotation. */
  selectedAccountId: string | null
}

const VALID_EFFORTS: ReadonlySet<string> = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
])

const loadConfig = (): PersistedConfig => {
  const envToken =
    (import.meta.env["VITE_UI_WS_TOKEN"] as string | undefined) ?? ""
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PersistedConfig>
      const parsedEffort =
        typeof parsed.effort === "string" && VALID_EFFORTS.has(parsed.effort)
          ? (parsed.effort as EffortLevel)
          : undefined
      return {
        url: parsed.url ?? DEFAULT_URL,
        token:
          parsed.token && parsed.token.length >= 16 ? parsed.token : envToken,
        model: parsed.model ?? DEFAULT_MODEL,
        ...(parsedEffort !== undefined ? { effort: parsedEffort } : {}),
        enterToSend: parsed.enterToSend ?? false,
        selectedAccountId: parsed.selectedAccountId ?? null,
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
    selectedAccountId: null,
  }
}

const saveConfig = (cfg: PersistedConfig): void => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg))
  } catch {
    // ignore
  }
}

/**
 * The board panels this web client can summon by `kind` — announced to the
 * server (widget-directory) so the agent's open_widget tool can land on the
 * first guess. Mirrors the board panel ids in createBoard's defaults; the
 * server validates open_widget against this list (open-artifact-widget for
 * CONTENT artifacts bypasses it). Capability-gated panels (workflows/actions)
 * are announced too — summoning one the server didn't enable is a harmless
 * no-op (board.summon ignores an unknown/empty panel).
 */
const WEB_WIDGET_DIRECTORY: ReadonlyArray<{
  kind: string
  title: string
  description: string
}> = [
  { kind: "artifacts", title: "Artifacts", description: "Pinned artifacts, code, docs and previews" },
  { kind: "settings", title: "Settings", description: "Connection, appearance and account settings" },
  { kind: "threads", title: "Threads", description: "The conversation/thread list" },
  { kind: "events", title: "Events", description: "The live observability event stream" },
  { kind: "workflows", title: "Workflows", description: "Saved workflows and their run history" },
  { kind: "actions", title: "Actions", description: "Suggested actions Luna has proposed" },
  { kind: "favorites", title: "Favorites", description: "Your favorited panels" },
]

export const App: Component = () => {
  const [cfg, setCfg] = createSignal<PersistedConfig>(loadConfig())
  const [selectedKinds, setSelectedKinds] = createSignal<ReadonlySet<string>>(
    new Set(),
  )
  const [restarting, setRestarting] = createSignal(false)
  // vault-status acks: not stored in the reducer (vault-list broadcast that
  // follows a successful mutation already updates the list). We keep the
  // last ack as a signal so VaultPanel can correlate its pending requestId.
  const [vaultLastStatus, setVaultLastStatus] = createSignal<VaultStatusAck | null>(null)

  // ── result-delivered toasts (#124) ───────────────────────────────────────
  // A background/job result was posted into a thread → show a transient
  // "Luna finished X" toast. This is a SIDE EFFECT in the app layer (like
  // widget-open / open-artifact-widget): the shared reducer intentionally
  // no-ops `result-delivered`, so toast state never lives in the store. Each
  // toast auto-dismisses after ~6s and is hand-dismissible. Keyed by an
  // increasing id so duplicate labels don't collide.
  interface ResultToast {
    readonly id: number
    readonly label: string
    readonly preview: string
  }
  const [toasts, setToasts] = createSignal<ReadonlyArray<ResultToast>>([])
  let toastSeq = 0
  const TOAST_TTL_MS = 6000
  const dismissToast = (id: number): void => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }
  const pushResultToast = (label: string, preview: string): void => {
    const id = ++toastSeq
    setToasts((prev) => [...prev, { id, label, preview }])
    setTimeout(() => dismissToast(id), TOAST_TTL_MS)
  }

  const store = createUiStore()

  // Restore persisted selectedAccountId into the reducer so the dropdown
  // is pre-selected on reconnect (before a fresh account-list arrives).
  if (cfg().selectedAccountId !== null) {
    store.dispatch({ tag: "select-account", accountId: cfg().selectedAccountId })
  }

  // Registered by the mounted SetupTerminal; receives raw pty bytes.
  // Kept outside signals — concurrent chunks in one tick must not be lost.
  let ptyWrite: ((bytes: Uint8Array) => void) | null = null
  // Pre-mount buffer: pty-output frames can arrive after setupMode flips true
  // but before SetupTerminal's onMount registers ptyWrite (the FIRST chunk is
  // the login URL). Buffer them and drain on register so nothing is dropped.
  let ptyWriteQueue: Uint8Array[] = []

  // Agent-driven artifact focus: an `open-artifact-widget` frame sets this so
  // the ArtifactPanel previews that artifact when the board summons it. The
  // nonce forces re-selection even if the SAME id is opened twice.
  let focusNonce = 0
  const [focusArtifact, setFocusArtifact] =
    createSignal<{ id: string; nonce: number } | null>(null)

  // MCP Apps relay: a kind="mcp-app" artifact iframe asks for resources/tools;
  // these helpers stamp a requestId, send the WS frame, and resolve when the
  // matching result frame arrives (routed in onFrame). Bounded so a dropped
  // result can't leak a pending promise forever.
  let mcpReqSeq = 0
  const mcpPending = new Map<
    string,
    (r: { ok: boolean; text?: string; result?: unknown; message?: string }) => void
  >()
  const mcpRequest = <T,>(
    requestId: string,
    frame: ClientFrame,
    timeoutMs = 30000,
  ): Promise<T> =>
    new Promise((resolve) => {
      const done = (r: unknown) => {
        if (!mcpPending.has(requestId)) return
        mcpPending.delete(requestId)
        clearTimeout(timer)
        resolve(r as T)
      }
      const timer = setTimeout(
        () => done({ ok: false, message: "MCP request timed out" }),
        timeoutMs,
      )
      mcpPending.set(requestId, done)
      transport.send(frame)
    })
  const mcpReadResource = (uri: string) => {
    const requestId = `mr${++mcpReqSeq}`
    return mcpRequest<{ ok: boolean; mimeType?: string; text?: string; message?: string }>(
      requestId,
      { type: "mcp-resource-read", requestId, uri },
    )
  }
  const mcpCallTool = (appUri: string, tool: string, args: unknown) => {
    const requestId = `mt${++mcpReqSeq}`
    return mcpRequest<{ ok: boolean; result?: unknown; message?: string }>(requestId, {
      type: "mcp-tool-call",
      requestId,
      appUri,
      tool,
      args,
    })
  }

  const transport = createTransport({
    onFrame: (frame) => {
      if (frame.type === "pty-output") {
        // Decode base64 → raw bytes; pass directly to xterm (Uint8Array).
        // Do NOT route through the store — the reducer intentionally ignores
        // pty-output and a signal would lose concurrent chunks in one tick.
        const bytes = b64ToBytes(frame.data)
        if (ptyWrite) ptyWrite(bytes)
        else ptyWriteQueue.push(bytes)
        return
      }
      // vault-status: intercepted BEFORE the reducer so VaultPanel can
      // correlate by requestId. The reducer is a no-op for this frame type
      // (the vault-list broadcast that follows a successful mutation is the
      // authoritative list update). We still dispatch it so the exhaustive
      // default arm in the reducer stays correct.
      if (frame.type === "vault-status") {
        setVaultLastStatus({ requestId: frame.requestId, ok: frame.ok, message: frame.message })
      }
      // Agent "open a panel" commands (the web client is a widget host — it
      // announces its directory on connect). open-artifact-widget pops the
      // artifacts panel and previews the named artifact; widget-open summons a
      // board panel by id. Side-effect only; still dispatched (the reducer
      // no-ops them) so the exhaustive default arm stays correct.
      if (frame.type === "open-artifact-widget") {
        board.summon("artifacts")
        setFocusArtifact({ id: frame.artifactId, nonce: ++focusNonce })
      } else if (frame.type === "widget-open") {
        board.summon(frame.kind)
      } else if (
        frame.type === "mcp-resource-result" ||
        frame.type === "mcp-tool-result"
      ) {
        // Settle the requestId-matched mcp-app relay promise. The reducer
        // no-ops these (no store state); we still dispatch for exhaustiveness.
        mcpPending.get(frame.requestId)?.(frame)
      } else if (frame.type === "result-delivered") {
        // A background job posted its result into a thread (#124). Surface a
        // global toast — visible even when that thread isn't on screen. The
        // message itself rides in via assistant-done/thread-snapshot (and
        // carries `message.delivery` for the inline chip). Side-effect only;
        // still dispatched below (the reducer no-ops it) for exhaustiveness.
        pushResultToast(frame.label, frame.preview)
      }
      store.dispatch(frame)
      // Sidebar freshness: any frame that mutates a thread's last-message
      // metadata should refresh the list. Server orders by lastMessageAt,
      // so the active thread bubbles to the top.
      if (
        frame.type === "thread-created" ||
        frame.type === "assistant-done" ||
        frame.type === "user-accepted"
      ) {
        transport.send({ type: "list-threads" })
      }
    },
    onOpen: (handle) => {
      // On open, request the thread list immediately so the threads panel
      // populates without a manual click. (The settings panel stays where
      // the user left it — on the board, closing it is a ✕ away.)
      handle.send({ type: "list-threads" })
      // Announce this client as a widget host so the agent's open_widget /
      // open_artifact tools can summon panels here (the server's summon bridge
      // registers the last announcer as the host). Content artifacts
      // (open-artifact-widget) bypass this directory; it gates open_widget.
      handle.send({ type: "widget-directory", widgets: WEB_WIDGET_DIRECTORY })
    },
  })

  // Persist config edits as they happen so reload doesn't lose tweaks.
  createEffect(() => {
    saveConfig(cfg())
  })

  // Persist selectedAccountId changes so reconnect restores the user's choice.
  createEffect(() => {
    const accountId = store.state.selectedAccountId
    saveConfig({ ...cfg(), selectedAccountId: accountId })
  })

  const send = (frame: ClientFrame): void => transport.send(frame)
  const onConnect = (): void => {
    const c = cfg()
    transport.connect(c.url, c.token)
  }
  const onDisconnect = (): void => transport.disconnect()

  // Auto-connect on mount if we have a valid token (>= 16 chars)
  onMount(() => {
    const c = cfg()
    if (c.token && c.token.length >= 16) {
      onConnect()
    }
  })

  const allKinds = createMemo(() => {
    const set = new Set<string>(store.state.advertisedKinds)
    for (const k of store.state.seenKinds) set.add(k)
    return Array.from(set).sort()
  })

  const filtered = createMemo(() =>
    filterEvents(store.state.events, selectedKinds()),
  )

  const toggleKind = (kind: string): void => {
    const next = new Set(selectedKinds())
    if (next.has(kind)) next.delete(kind)
    else next.add(kind)
    setSelectedKinds(next)
  }

  const selectThread = (id: string): void => {
    store.dispatch({ tag: "select-thread", threadId: id })
    // Subscribe (idempotent server-side) so live frames arrive.
    send({ type: "subscribe", threadId: id })
  }

  /**
   * Open a fresh thread on the persisted model + effort (review F5: effort
   * was previously dropped here, so new threads silently reverted to the
   * server default). buildNewThreadFrame includes `effort` only when the
   * server-advertised matrix lists it for the chosen model — never computed
   * client-side, and safely omitted against old servers (availableModels null).
   */
  const newThread = (): void => {
    send(
      buildNewThreadFrame({
        model: cfg().model,
        effort: cfg().effort,
        accountId: store.state.selectedAccountId,
        availableModels: store.state.availableModels,
      }),
    )
  }

  // Client-identity stamp so Luna can see which surface the operator is
  // typing through. Hardcoded here since detection at runtime in a browser
  // is unreliable; if we ever ship a build sha, fold it into `version`.
  const CLIENT_INFO = {
    name: "luna-web",
    version: "0.0.1",
    platform: "browser",
  } as const

  const sendUserMessage = (
    threadId: string,
    text: string,
    attachments?: ReadonlyArray<ChatAttachment>,
  ): void => {
    send({
      type: "user-message",
      threadId,
      text,
      client: CLIENT_INFO,
      ...(attachments ? { attachments } : {}),
    })
  }

  const interrupt = (threadId: string): void => {
    send({ type: "interrupt", threadId })
  }

  /**
   * Handle a recognised slash command from the composer.
   *
   * `/restart` — interrupt any in-flight turn on the current thread, then
   * open a fresh thread on the same model. The server auto-subscribes the
   * new thread (`new-thread` response carries auto-subscribe), so the UI
   * transitions cleanly without a manual subscribe round-trip.
   */
  const handleCommand = (threadId: string, command: SlashCommand): void => {
    switch (command) {
      case "restart": {
        // Best-effort interrupt — safe to fire even if no turn is in-flight.
        send({ type: "interrupt", threadId })
        // Open a new thread on the same model + effort (review F5 — this
        // site must match newThread(), clamped to the server matrix). The
        // `thread-created` server frame triggers auto-subscribe; the reducer
        // selects the new thread once `thread-created` arrives (handled in
        // onFrame above).
        send(
          buildNewThreadFrame({
            model: cfg().model,
            effort: cfg().effort,
            accountId: store.state.selectedAccountId,
            availableModels: store.state.availableModels,
          }),
        )
        break
      }
    }
  }

  /**
   * Handle a model change from the ChatPanel composer cluster.
   *
   * Persists to cfg() so the setting survives navigation, and sends
   * `set-thread-config` to the server when a thread is active.
   * The `thread-config` ack is a no-op in the shared reducer today —
   * the optimistic UI update (cfg persisted immediately) is sufficient.
   *
   * Review F11: a model switch can invalidate the persisted effort (e.g.
   * effort=max → a model whose server-computed `efforts` is empty). Clamp
   * against the server matrix and clear the stale value — undefined is
   * dropped by JSON.stringify on save, so the persisted config forgets it
   * (mirrors moon's `_selectModel` localStorage.removeItem('luna_effort')).
   */
  const handleModelChange = (threadId: string, model: string): void => {
    setCfg({
      ...cfg(),
      model,
      effort: clampEffortToModel(store.state.availableModels, model, cfg().effort),
    })
    send({ type: "set-thread-config", threadId, model })
  }

  /**
   * Handle an effort change from the ChatPanel composer cluster.
   *
   * Same optimistic pattern as handleModelChange — persist immediately,
   * fire set-thread-config for server-side application to the live session.
   * The `thread-config` ack is a no-op in the shared reducer today.
   */
  const handleEffortChange = (threadId: string, effort: EffortLevel): void => {
    setCfg({ ...cfg(), effort })
    send({ type: "set-thread-config", threadId, effort })
  }

  const isConnected = createMemo(() => transport.status().kind === "open")
  const isConnecting = createMemo(
    () => transport.status().kind === "connecting",
  )
  const chatEnabled = createMemo(
    () => isConnected() && store.state.capabilities.chat,
  )
  const setupMode = createMemo(
    () => isConnected() && store.state.capabilities.setup,
  )
  const vaultEnabled = createMemo(
    () => store.state.capabilities.vault === true,
  )
  const selectedThread = createMemo(() =>
    store.state.selectedThreadId !== null
      ? (store.state.threads.get(store.state.selectedThreadId) ?? null)
      : null,
  )

  // ── Optimistic action status overrides ───────────────────────────────────
  // When the user clicks Accept/Dismiss the chip/row flips immediately rather
  // than waiting for the server's suggested-action-update round-trip.
  // Keyed by actionId → optimistic status. Cleared when the authoritative
  // update arrives in store.state.suggestedActions.
  const [optimisticStatuses, setOptimisticStatuses] = createSignal<
    ReadonlyMap<string, SuggestedActionStatus>
  >(new Map())

  // Reconcile: when store.state.suggestedActions changes, drop any optimistic
  // overrides whose actionId is now present in the store with a terminal
  // (non-proposed) status — the server's answer has arrived.
  createEffect(() => {
    const allActions = store.state.suggestedActions
    const overrides = optimisticStatuses()
    if (overrides.size === 0) return
    const next = new Map(overrides)
    let changed = false
    for (const [id] of overrides) {
      // Scan all threads' action arrays for this id.
      let found = false
      for (const [, actions] of allActions) {
        const action = actions.find((a) => a.id === id)
        if (action && action.status !== "proposed") {
          next.delete(id)
          changed = true
          found = true
          break
        }
        if (action) { found = true; break }
      }
      if (!found) { next.delete(id); changed = true }
    }
    if (changed) setOptimisticStatuses(next)
  })

  /**
   * Return the active thread's suggested actions with optimistic status
   * overrides applied. The overlay only changes `status` for IDs the user
   * has clicked — everything else is authoritative from the store.
   */
  const activeThreadActions = createMemo(() => {
    const threadId = selectedThread()?.summary.id
    if (!threadId) return []
    const actions = store.state.suggestedActions.get(threadId) ?? []
    const overrides = optimisticStatuses()
    if (overrides.size === 0) return actions
    return actions.map((a) => {
      const os = overrides.get(a.id)
      return os !== undefined ? { ...a, status: os } : a
    })
  })

  /** Send a suggested-action-respond frame and set an optimistic status. The
   *  override is normally cleared by the authoritative update (reconcile effect
   *  above). But if the server emits NO update — a cross-thread/unknown
   *  actionId, or a lost-race respond() that returns null — nothing would clear
   *  it. A timeout rollback reverts the override so the row becomes actionable
   *  again and the user can retry, rather than the chip sticking forever. */
  const OPTIMISTIC_ROLLBACK_MS = 8000
  const respondToAction = (actionId: string, decision: "accept" | "dismiss"): void => {
    const threadId = selectedThread()?.summary.id
    if (!threadId) return
    const optimistic: SuggestedActionStatus = decision === "accept" ? "accepted" : "dismissed"
    setOptimisticStatuses((prev) => new Map([...prev, [actionId, optimistic]]))
    send({ type: "suggested-action-respond", threadId, actionId, decision })
    setTimeout(() => {
      setOptimisticStatuses((prev) => {
        if (!prev.has(actionId)) return prev // already reconciled by a server update
        const next = new Map(prev)
        next.delete(actionId)
        return next
      })
    }, OPTIMISTIC_ROLLBACK_MS)
  }

  /* ── Luna Studio board — floating panels on one canvas ─────────────────
     Engine ported from the design handoff's luna-app.jsx. Default layout:
     threads + settings stacked left, chat filling the rest; events /
     artifacts / workflows / favorites start closed (shelf chips). */
  const board = createBoard({
    defaults: (vw, vh) => {
      const leftW = 280
      const rightW = Math.min(380, Math.max(300, vw * 0.26))
      const chatX = EDGE_MARGIN + leftW + SNAP_GAP
      const chatW = Math.max(420, vw - chatX - EDGE_MARGIN)
      const colH = vh - TOP_MIN - EDGE_MARGIN
      const half = Math.max(160, (colH - SNAP_GAP) / 2)
      return {
        threads: { x: EDGE_MARGIN, y: TOP_MIN, w: leftW, h: half, closed: false, min: false },
        settings: { x: EDGE_MARGIN, y: TOP_MIN + half + SNAP_GAP, w: leftW, h: colH - half - SNAP_GAP, closed: false, min: false },
        chat: { x: chatX, y: TOP_MIN, w: chatW, h: colH, closed: false, min: false },
        events: { x: chatX + 40, y: TOP_MIN + 40, w: 620, h: 420, closed: true, min: false },
        artifacts: { x: vw - rightW - EDGE_MARGIN, y: TOP_MIN, w: rightW, h: half, closed: true, min: false },
        workflows: { x: vw - rightW - EDGE_MARGIN, y: TOP_MIN + half + SNAP_GAP, w: rightW, h: colH - half - SNAP_GAP, closed: true, min: false },
        actions: { x: vw - rightW - EDGE_MARGIN, y: TOP_MIN + half + SNAP_GAP, w: rightW, h: colH - half - SNAP_GAP, closed: true, min: false },
        favorites: { x: EDGE_MARGIN + 80, y: TOP_MIN + 70, w: 290, h: 300, closed: true, min: false },
      }
    },
  })

  // First-run experience: surface the connect form whenever we're not
  // connected (the old settings auto-open, board-shaped).
  createEffect(() => {
    if (!isConnected() && !isConnecting()) board.summon("settings")
  })

  // The old grid auto-opened the artifacts column when a thread had
  // artifacts. Board-shaped: summon the panel when the artifact count
  // INCREASES (a new artifact arrived) — closing it is respected until
  // the next one lands.
  let prevArtifactCount = 0
  createEffect(() => {
    const n = selectedThread()?.artifacts.length ?? 0
    if (n > prevArtifactCount) board.summon("artifacts")
    prevArtifactCount = n
  })

  /**
   * The active model list for the settings dropdown. When the server sends an
   * `availableModels` list in the `hello` frame we use that (so the operator's
   * LUNA_UI_MODELS overrides and any non-Anthropic models are surfaced). On
   * older servers that omit the field we fall back to the hardcoded
   * MODEL_OPTIONS list — graceful degradation, no user-visible breakage.
   *
   * Note: the mapping from {id, label} (wire shape) to {value, label} (local
   * shape) is done here so the dropdown JSX stays unchanged.
   */
  const activeModelOptions = createMemo((): ReadonlyArray<{ value: string; label: string }> => {
    const serverModels = store.state.availableModels
    if (serverModels !== null) {
      return serverModels.map((m) => ({ value: m.id, label: m.label }))
    }
    return MODEL_OPTIONS
  })

  /**
   * True when the persisted model id is not in the active model list. This
   * happens when the user typed a custom model id, OR when a server-advertised
   * list doesn't include the previously-persisted model. In both cases we
   * keep the model selected (show a custom value) rather than silently
   * switching — the user chose it deliberately.
   */
  const isCustomModel = createMemo(
    () => !activeModelOptions().some((o) => o.value === cfg().model),
  )

  const [appearance, setAppearanceState] = createSignal(getAppearance())
  onCleanup(onAppearanceChange((a) => setAppearanceState(a)))

  /**
   * Body of the floating settings panel — the former topbar settings rows
   * (connection, appearance, skills, connectors, vault), unchanged, in a
   * scrollable column.
   */
  const SettingsBody = () => (
    <div class="settings-scroll">
          <div class="row settings-row">
            <label>
              URL{" "}
              <input
                value={cfg().url}
                onInput={(e) =>
                  setCfg({ ...cfg(), url: e.currentTarget.value })
                }
                spellcheck={false}
                autocapitalize="off"
                autocorrect="off"
              />
            </label>
            <label>
              Token{" "}
              <input
                type="password"
                value={cfg().token}
                onInput={(e) =>
                  setCfg({ ...cfg(), token: e.currentTarget.value })
                }
                placeholder="≥16 chars"
              />
            </label>
            <label>
              Model{" "}
              <select
                value={isCustomModel() ? "__custom" : cfg().model}
                onChange={(e) => {
                  const v = e.currentTarget.value
                  if (v === "__custom") return
                  setCfg({ ...cfg(), model: v })
                }}
              >
                <For each={activeModelOptions()}>
                  {(o) => <option value={o.value}>{o.label}</option>}
                </For>
                <option value="__custom">Custom…</option>
              </select>
            </label>
            <Show when={isCustomModel()}>
              <label>
                Model ID{" "}
                <input
                  value={cfg().model}
                  onInput={(e) =>
                    setCfg({ ...cfg(), model: e.currentTarget.value })
                  }
                  spellcheck={false}
                  placeholder="claude-…"
                />
              </label>
            </Show>
            <AccountSwitcher
              accounts={store.state.accounts}
              selectedId={store.state.selectedAccountId}
              onSelect={(id) => store.dispatch({ tag: "select-account", accountId: id })}
              disabled={!isConnected()}
            />
            <label
              class="toggle"
              title="When on, plain Enter sends; Shift+Enter inserts a newline"
            >
              <input
                type="checkbox"
                checked={cfg().enterToSend}
                onChange={(e) =>
                  setCfg({ ...cfg(), enterToSend: e.currentTarget.checked })
                }
              />
              <span>Enter to send</span>
            </label>
            <Show
              when={isConnected() || isConnecting()}
              fallback={
                <button
                  onClick={onConnect}
                  disabled={!cfg().token || cfg().token.length < 16}
                >
                  Connect
                </button>
              }
            >
              <button onClick={onDisconnect}>Disconnect</button>
            </Show>
            <button
              class="chip"
              disabled={restarting()}
              title="Restart the Luna chat server (launchd auto-respawns)"
              onClick={async () => {
                setRestarting(true)
                try {
                  await restartServer(cfg().token)
                  // Disconnect WebSocket — server is going down.
                  // Auto-reconnect banner will appear after the server respawns.
                  transport.disconnect()
                } catch {
                  // Server may have gone down before responding — that's fine.
                  transport.disconnect()
                } finally {
                  // Give launchd ~3s to respawn, then attempt reconnect.
                  setTimeout(() => {
                    setRestarting(false)
                    onConnect()
                  }, 3000)
                }
              }}
            >
              {restarting() ? "⟳ Restarting…" : "↺ Restart Server"}
            </button>
          </div>
          {/* Appearance controls — palette, theme, chrome, grain. Purely
              client-side: NOT gated on isConnected. The settings panel
              auto-shows when disconnected, so appearance must work then too. */}
          <div class="row settings-row">
            <label>Appearance</label>
            <div class="swatch-row">
              <For each={PALETTES}>
                {(p) => (
                  <button
                    class={`swatch${appearance().palette === p ? " active" : ""}`}
                    title={p}
                    aria-label={p}
                    onClick={() => { setAppearance("palette", p); setAppearanceState(getAppearance()) }}
                  >
                    <For each={PALETTE_SWATCHES[p]}>
                      {(hex) => <span style={{ background: hex }} />}
                    </For>
                  </button>
                )}
              </For>
            </div>
            <For each={["light", "dark"] as const}>
              {(t) => (
                <button
                  class={`chip${appearance().theme === t ? " active" : ""}`}
                  onClick={() => { setAppearance("theme", t); setAppearanceState(getAppearance()) }}
                >
                  {t}
                </button>
              )}
            </For>
            <For each={[{ label: "soft wash", value: "wash" }, { label: "ink outline", value: "ink" }] as const}>
              {(c) => (
                <button
                  class={`chip${appearance().chrome === c.value ? " active" : ""}`}
                  onClick={() => { setAppearance("chrome", c.value); setAppearanceState(getAppearance()) }}
                >
                  {c.label}
                </button>
              )}
            </For>
            <label
              class="toggle"
              title="Add a subtle paper texture to the canvas"
            >
              <input
                type="checkbox"
                checked={appearance().grain}
                onChange={(e) => { setAppearance("grain", String(e.currentTarget.checked)); setAppearanceState(getAppearance()) }}
              />
              <span>Paper grain</span>
            </label>
            {/* Chat typeface + size — re-skins the chat reading/writing
                surfaces only (bubbles, markdown, composer) via --font-chat /
                --font-scale; UI chrome is untouched. */}
            <span class="muted small">Font</span>
            <For each={FONTS}>
              {(f) => (
                <button
                  class={`chip${appearance().font === f ? " active" : ""}`}
                  style={{ "font-family": `var(--font-${f === "sans" ? "body" : f})` }}
                  title={`Chat font: ${FONT_LABELS[f]}`}
                  onClick={() => { setAppearance("font", f); setAppearanceState(getAppearance()) }}
                >
                  {FONT_LABELS[f]}
                </button>
              )}
            </For>
            <span class="muted small">Text size</span>
            <For each={FONT_SIZES}>
              {(s) => (
                <button
                  class={`chip${appearance().fontSize === s ? " active" : ""}`}
                  title={`Chat text size: ${FONT_SIZE_LABELS[s]}`}
                  onClick={() => { setAppearance("fontSize", s); setAppearanceState(getAppearance()) }}
                >
                  {FONT_SIZE_LABELS[s]}
                </button>
              )}
            </For>
          </div>
          {/* PRD Part B §12 — gated on the additive hello capability: an
              older server never advertises `skills`, so the section simply
              doesn't exist against it. Gate on the capability ONLY (not
              isConnected): a transient disconnect must dim the toggles via
              `disabled`, not unmount the panel and discard the user's
              search/filter state (review finding). */}
          <Show when={store.state.capabilities.skills === true}>
            <div class="row settings-row">
              <SkillsPanel
                skills={store.state.skills}
                lastError={store.state.skillError}
                onToggle={(id, enabled) => send({ type: "skill-toggle", id, enabled })}
                disabled={!isConnected()}
              />
            </div>
          </Show>
          {/* PRD Part A §17 — gated on the additive connectors capability.
              The web client does the view + api-key connect + disconnect;
              the OAuth browser hop lives in the Moon app (a page can't bind
              a loopback). */}
          <Show when={store.state.capabilities.connectors === true}>
            <div class="row settings-row">
              <ConnectorsPanel
                catalog={store.state.connectorCatalog}
                instances={store.state.connectorInstances}
                lastError={store.state.connectorError}
                disabled={!isConnected()}
                onConnectApiKey={(definitionId, secretRef, capabilityIds, label) =>
                  send({
                    type: "connector-connect",
                    requestId: `conn_${Date.now()}`,
                    definitionId,
                    label: label ?? definitionId,
                    secretRef,
                    capabilityIds,
                  })
                }
                onDisconnect={(instanceId) =>
                  send({ type: "connector-disconnect", instanceId })
                }
                onSetClient={(definitionId, clientId, clientSecret) =>
                  send({ type: "connector-set-client", requestId: `setclient_${Date.now()}`, definitionId, clientId, ...(clientSecret ? { clientSecret } : {}) })
                }
              />
            </div>
          </Show>
          {/* Luna Vault (V1) — gated on the additive hello capability.
              An older server never advertises `vault`, so the section simply
              doesn't appear. Gate on the capability ONLY (not isConnected):
              a transient disconnect dims actions via `disabled` without
              unmounting the panel and losing the user's in-progress form. */}
          <Show when={vaultEnabled()}>
            <div class="row settings-row">
              <VaultPanel
                items={store.state.vaultItems}
                sync={store.state.vaultSync}
                disabled={!isConnected()}
                lastStatus={vaultLastStatus()}
                onPut={(params) => send({ type: "vault-put", ...params })}
                onDelete={(params) => send({ type: "vault-delete", ...params })}
                onSyncConfig={(params) => send({ type: "vault-sync-config", ...params })}
                onImport={(params) => send({ type: "vault-import", ...params })}
              />
            </div>
          </Show>
    </div>
  )

  /* Panel definitions for the board. STABLE objects (module-lifetime) — the
     reactive bits live inside render closures and `when` gates, so panel
     bodies never remount on state changes (see BoardPanelDef.when). */
  const panelDefs: BoardPanelDef[] = [
    {
      id: "chat",
      title: "luna",
      tint: 0,
      render: () => (
        <ChatPanel
          thread={selectedThread()}
          onSend={sendUserMessage}
          onInterrupt={interrupt}
          onCommand={handleCommand}
          disabled={!chatEnabled()}
          enterToSend={cfg().enterToSend}
          availableModels={store.state.availableModels}
          effortSelection={store.state.capabilities.effortSelection}
          model={cfg().model}
          effort={cfg().effort}
          onModelChange={handleModelChange}
          onEffortChange={handleEffortChange}
          {...(store.state.capabilities.suggestedActions === true
            ? {
                suggestedActions: activeThreadActions(),
                onAcceptSuggestion: (id: string) => respondToAction(id, "accept"),
                onDismissSuggestion: (id: string) => respondToAction(id, "dismiss"),
                onSeeAllSuggestions: () => board.summon("actions"),
              }
            : {})}
        />
      ),
    },
    {
      id: "threads",
      title: "threads",
      tint: 3,
      render: () => (
        <Sidebar
          threads={store.state.threadList}
          threadViews={store.state.threads}
          selectedId={store.state.selectedThreadId}
          onSelect={selectThread}
          onNew={chatEnabled() ? newThread : null}
        />
      ),
    },
    {
      id: "settings",
      title: "settings",
      tint: 2,
      render: () => <SettingsBody />,
    },
    {
      id: "events",
      title: "events",
      tint: 4,
      render: () => (
        <ObsPanel
          allKinds={allKinds()}
          selectedKinds={selectedKinds()}
          toggleKind={toggleKind}
          clearKinds={() => setSelectedKinds(new Set())}
          filtered={filtered()}
          totalEvents={store.state.events.length}
          lastDrop={store.state.lastDrop}
          droppedTotal={store.state.droppedTotal}
          lastPingAt={store.state.lastPingAt}
        />
      ),
    },
    {
      id: "artifacts",
      title: "artifacts",
      tint: 1,
      when: () =>
        store.state.capabilities.artifacts === true ||
        (selectedThread()?.artifacts.length ?? 0) > 0,
      render: () => (
        <ArtifactPanel
          artifacts={selectedThread()?.artifacts ?? []}
          pinned={store.state.pinnedArtifacts}
          artifactsCapable={store.state.capabilities.artifacts === true}
          focusSignal={focusArtifact()}
          obsEvents={store.state.events}
          mcp={
            store.state.capabilities.mcpApps === true
              ? { readResource: mcpReadResource, callTool: mcpCallTool }
              : undefined
          }
          onPin={(a) =>
            send({
              type: "artifact-pin",
              id: a.id,
              title: a.title,
              content: a.content,
              lang: a.lang,
              origin: a.path ?? selectedThread()?.summary.id ?? null,
            })
          }
          onUnpin={(id) => send({ type: "artifact-unpin", id })}
        />
      ),
    },
    {
      // PRD Part C / W3 — gated on the additive hello capability; an older
      // server never advertises `workflows` so the panel simply isn't on
      // the board.
      id: "workflows",
      title: "workflows",
      tint: 4,
      when: () => store.state.capabilities.workflows === true,
      render: () => (
        <WorkflowGallery
          workflows={store.state.workflows}
          runs={store.state.workflowRuns}
          onSelectRuns={(jobId) => send({ type: "workflow-runs-request", jobId })}
          onRefresh={() => send({ type: "workflow-refresh" })}
        />
      ),
    },
    {
      // Suggested Actions panel — gated on capabilities.suggestedActions;
      // older servers that don't advertise the cap hide this panel entirely.
      id: "actions",
      title: "actions",
      tint: 5,
      when: () => store.state.capabilities.suggestedActions === true,
      render: () => (
        <ActionsPanel
          actions={activeThreadActions()}
          disabled={!chatEnabled()}
          onAccept={(id) => respondToAction(id, "accept")}
          onDismiss={(id) => respondToAction(id, "dismiss")}
        />
      ),
    },
    {
      id: "favorites",
      title: "favorites",
      tint: 2,
      noStar: true,
      render: () => <FavoritesGrid board={board} defs={panelDefs} />,
    },
  ]

  const dateStr = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  })

  return (
    <div class="app">
      {/* Watercolor wobble filter — used by .wash-dot and painterly accents. */}
      <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
        <defs>
          <filter id="wc-wobble">
            <feTurbulence type="fractalNoise" baseFrequency="0.015" numOctaves="3" result="n" seed="7" />
            <feDisplacementMap in="SourceGraphic" in2="n" scale="6" xChannelSelector="R" yChannelSelector="G" />
          </filter>
        </defs>
      </svg>
      <div class="bg-blooms" aria-hidden="true"><div class="bloom b1" /><div class="bloom b2" /><div class="bloom b3" /></div>
      <header class="topbar">
        <div class="row">
          <span class="wordmark"><span class="name">Luna</span><span class="sub">studio</span></span>
          <ConnectionSummary
            status={transport.status()}
            url={cfg().url}
            model={cfg().model}
            chatCap={store.state.capabilities.chat}
          />
          <span style={{ flex: 1 }} />
          <Show when={!setupMode()}>
            <Shelf board={board} defs={panelDefs} />
            <div class="mode-toggle">
              <button classList={{ on: board.mode() === "board" }} onClick={() => board.setMode("board")}>
                board
              </button>
              <button classList={{ on: board.mode() === "stickies" }} onClick={() => board.setMode("stickies")}>
                stickies
              </button>
            </div>
            <span class="muted small">{dateStr}</span>
            <button class="chip" onClick={() => board.summon("settings")} title="Settings">
              ⚙
            </button>
          </Show>
        </div>
        <Show when={store.state.closeReason}>
          {(reason) => (
            <div class="banner closed">
              <span>closed by server: {reason()}</span>
              <button
                class="chip"
                onClick={onConnect}
                disabled={!cfg().token || cfg().token.length < 16}
              >
                Reconnect
              </button>
            </div>
          )}
        </Show>
        <Show
          when={
            (transport.status().kind === "closed" ||
              transport.status().kind === "error") &&
            !store.state.closeReason
          }
        >
          <div class="banner closed">
            <span>
              {(() => {
                const s = transport.status()
                if (s.kind === "error") return `connection error: ${s.message}`
                if (s.kind === "closed") {
                  return `disconnected (code ${s.code}${s.reason ? ` · ${s.reason}` : ""})`
                }
                return ""
              })()}
            </span>
            <button
              class="chip"
              onClick={onConnect}
              disabled={!cfg().token || cfg().token.length < 16}
            >
              Reconnect
            </button>
          </div>
        </Show>
      </header>

      <Show when={setupMode()} fallback={<Board board={board} defs={panelDefs} />}>
        <SetupTerminal
          send={send}
          registerWrite={(fn) => {
            ptyWrite = fn
            if (fn) {
              for (const b of ptyWriteQueue) fn(b)
              ptyWriteQueue = []
            }
          }}
        />
      </Show>

      {/* result-delivered toasts (#124) — fixed bottom-right stack, above the
          board. Auto-dismissed by pushResultToast's timer; the × dismisses
          early. aria-live=polite announces them to assistive tech. */}
      <Show when={toasts().length > 0}>
        <div class="toast-stack" role="status" aria-live="polite">
          <For each={toasts()}>
            {(t) => (
              <div class="toast">
                <button
                  class="toast-close"
                  title="Dismiss"
                  aria-label="Dismiss notification"
                  onClick={() => dismissToast(t.id)}
                >
                  ×
                </button>
                <div class="toast-title">Luna finished: {t.label}</div>
                <Show when={t.preview}>
                  <div class="toast-preview">{t.preview}</div>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}
