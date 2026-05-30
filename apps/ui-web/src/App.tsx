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
import { type Component, For, Show, createEffect, createMemo, createSignal, onMount } from "solid-js"
import {
  filterEvents,
  type ClientFrame,
  type ChatAttachment,
} from "@luna/ui-shared/core"
import {
  AccountSwitcher,
  ArtifactPanel,
  ChatPanel,
  ConnectionSummary,
  ObsPanel,
  Sidebar,
  createTransport,
  createUiStore,
  type SlashCommand,
} from "@luna/ui-shared-solid"
import { SetupTerminal, b64ToBytes } from "./SetupTerminal"

const CONTROL_URL = "http://127.0.0.1:4754/trpc"

/** Call control.restart mutation via raw fetch (tRPC v11: mutations = POST). */
async function restartServer(): Promise<void> {
  await fetch(`${CONTROL_URL}/control.restart`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ json: null }),
  })
}

/** Call control.status query via raw fetch (tRPC v11: queries = GET). */
async function fetchServerStatus(): Promise<{ uptime: number; startedAt: string; version: string } | null> {
  try {
    const res = await fetch(`${CONTROL_URL}/control.status?input=${encodeURIComponent(JSON.stringify({ json: null }))}`)
    const json = await res.json() as { result?: { data?: { uptime: number; startedAt: string; version: string } } }
    return json.result?.data ?? null
  } catch {
    return null
  }
}

const STORAGE_KEY = "ui-ws.config"
const DEFAULT_URL = "ws://127.0.0.1:4753/ui"
const DEFAULT_MODEL = "claude-sonnet-4-6"

const MODEL_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "claude-opus-4-7", label: "Opus 4.7 — most capable" },
  { value: "claude-sonnet-4-6", label: "Sonnet 4.6 — balanced (default)" },
  { value: "claude-haiku-4-5", label: "Haiku 4.5 — fastest" },
  { value: "claude-opus-4-6", label: "Opus 4.6 — prior gen" },
  { value: "claude-sonnet-4-5", label: "Sonnet 4.5 — prior gen" },
]

interface PersistedConfig {
  url: string
  token: string
  model: string
  /** When true, plain Enter sends; Shift+Enter newline. Default false. */
  enterToSend: boolean
  /** Last-selected account id. null = use default broker rotation. */
  selectedAccountId: string | null
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
        token:
          parsed.token && parsed.token.length >= 16 ? parsed.token : envToken,
        model: parsed.model ?? DEFAULT_MODEL,
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

type Pane = "chat" | "obs"

export const App: Component = () => {
  const [cfg, setCfg] = createSignal<PersistedConfig>(loadConfig())
  const [pane, setPane] = createSignal<Pane>("chat")
  const [selectedKinds, setSelectedKinds] = createSignal<ReadonlySet<string>>(
    new Set(),
  )
  const [settingsOpen, setSettingsOpen] = createSignal(false)
  const [restarting, setRestarting] = createSignal(false)

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
      // On open, request the thread list immediately so the sidebar
      // populates without a manual click. Also collapse settings if it
      // was left open from the disconnected state.
      handle.send({ type: "list-threads" })
      setSettingsOpen(false)
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

  const newThread = (): void => {
    send({
      type: "new-thread",
      model: cfg().model,
      ...(store.state.selectedAccountId !== null
        ? { accountId: store.state.selectedAccountId }
        : {}),
    })
  }

  const sendUserMessage = (
    threadId: string,
    text: string,
    attachments?: ReadonlyArray<ChatAttachment>,
  ): void => {
    send({
      type: "user-message",
      threadId,
      text,
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
        // Open a new thread on the same model. The `thread-created` server
        // frame triggers auto-subscribe; the reducer selects the new thread
        // once `thread-created` arrives (handled in onFrame above).
        send({
          type: "new-thread",
          model: cfg().model,
          ...(store.state.selectedAccountId !== null
            ? { accountId: store.state.selectedAccountId }
            : {}),
        })
        break
      }
    }
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
  const selectedThread = createMemo(() =>
    store.state.selectedThreadId !== null
      ? (store.state.threads.get(store.state.selectedThreadId) ?? null)
      : null,
  )

  // Show settings panel automatically when not yet connected (so the
  // first-run experience surfaces URL/Token), or when explicitly toggled.
  const showSettings = createMemo(
    () => settingsOpen() || (!isConnected() && !isConnecting()),
  )

  const isCustomModel = createMemo(
    () => !MODEL_OPTIONS.some((o) => o.value === cfg().model),
  )

  return (
    <div class="app">
      <header class="topbar">
        <div class="row">
          <strong class="brand">⚡ Agent Chat</strong>
          <ConnectionSummary
            status={transport.status()}
            url={cfg().url}
            model={cfg().model}
            chatCap={store.state.capabilities.chat}
          />
          <span style={{ flex: 1 }} />
          <Show when={isConnected()}>
            <button
              class={`chip ${settingsOpen() ? "active" : ""}`}
              onClick={() => setSettingsOpen((v) => !v)}
              title="Connection settings"
            >
              ⚙ Settings
            </button>
          </Show>
          <Show when={!setupMode()}>
            <button
              class={`chip ${pane() === "chat" ? "active" : ""}`}
              onClick={() => setPane("chat")}
            >
              Chat
            </button>
            <button
              class={`chip ${pane() === "obs" ? "active" : ""}`}
              onClick={() => setPane("obs")}
            >
              Events
            </button>
          </Show>
        </div>
        <Show when={showSettings()}>
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
                <For each={MODEL_OPTIONS}>
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
                  await restartServer()
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
        </Show>
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

      <Show
        when={setupMode()}
        fallback={
          <Show
            when={pane() === "chat"}
            fallback={
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
            }
          >
            <div
              class={`chat-layout${
                selectedThread() && selectedThread()!.artifacts.length > 0
                  ? " with-artifacts"
                  : ""
              }`}
            >
              <Sidebar
                threads={store.state.threadList}
                threadViews={store.state.threads}
                selectedId={store.state.selectedThreadId}
                onSelect={selectThread}
                onNew={chatEnabled() ? newThread : null}
              />
              <ChatPanel
                thread={selectedThread()}
                onSend={sendUserMessage}
                onInterrupt={interrupt}
                onCommand={handleCommand}
                disabled={!chatEnabled()}
                enterToSend={cfg().enterToSend}
              />
              <Show
                when={
                  selectedThread() && selectedThread()!.artifacts.length > 0
                }
              >
                <ArtifactPanel artifacts={selectedThread()!.artifacts} />
              </Show>
            </div>
          </Show>
        }
      >
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
    </div>
  )
}
