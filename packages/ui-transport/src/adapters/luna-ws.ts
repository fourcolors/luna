import type {
  AssistantDeltaFrame,
  AssistantDoneFrame,
  AssistantErrorFrame,
  HelloFrame,
  ServerFrame,
  ThreadCreatedFrame,
  ThreadSnapshotFrame,
} from "@luna/ui-shared/core"
import type {
  AttachResult,
  ChatFrame,
  ChatInput,
  ChatSession,
  ClientTransportAdapter,
  ConnectionState,
  RouteConfig,
} from "../contract.js"
import type { ServerDescriptor } from "../contract.js"
import type { TokenResolver } from "../token-resolver.js"
import { Broadcast } from "../internal/broadcast.js"

/** WebSocket-compatible constructor signature used for testability. */
export type WsFactory = (
  url: string,
  options?: { headers?: Record<string, string> },
) => WebSocket

function defaultWsFactory(url: string): WebSocket {
  // Browser: WebSocket doesn't accept headers — use ?token= query string.
  return new WebSocket(url)
}

function synthesizeLegacyDescriptor(route: RouteConfig): ServerDescriptor {
  return {
    descriptorSchema: 1,
    generation: 0,
    issuedAt: new Date().toISOString(),
    negotiation: { agreed: 2 },
    identity: {
      name: route.routeKey,
      kind: "unknown",
      version: "unknown",
      synthesized: true,
    },
    runtimeSummary: { category: "unknown" },
    capabilities: [],
    health: { status: "normal" },
  }
}

function isHelloFrame(frame: ServerFrame): frame is HelloFrame {
  return frame.type === "hello"
}

function isThreadSnapshotFrame(frame: ServerFrame): frame is ThreadSnapshotFrame {
  return frame.type === "thread-snapshot"
}

function isAssistantDeltaFrame(frame: ServerFrame): frame is AssistantDeltaFrame {
  return frame.type === "assistant-delta"
}

function isAssistantDoneFrame(frame: ServerFrame): frame is AssistantDoneFrame {
  return frame.type === "assistant-done"
}

function isAssistantErrorFrame(frame: ServerFrame): frame is AssistantErrorFrame {
  return frame.type === "assistant-error"
}

function isThreadCreatedFrame(frame: ServerFrame): frame is ThreadCreatedFrame {
  return frame.type === "thread-created"
}

function isThreadCreateErrorFrame(
  frame: ServerFrame,
): frame is { type: "thread-create-error"; message: string } {
  return frame.type === "thread-create-error"
}

/**
 * Luna WebSocket adapter. Implements ClientTransportAdapter for
 * ws:// / wss:// routes (Luna chat-server protocol).
 *
 * The optional `wsFactory` parameter exists for testability — Node.js tests
 * inject the `ws` package's WebSocket (which supports `headers`) while the
 * browser path uses the default global WebSocket factory.
 */
export class LunaWsAdapter implements ClientTransportAdapter {
  readonly routeKey: string
  readonly transportKind = "luna-ws" as const

  readonly #route: RouteConfig
  readonly #wsFactory: WsFactory
  readonly #handshakeTimeoutMs: number

  /**
   * Optional injected resolver: turns route.tokenRef (env:/file:/op:/none) into
   * a concrete bearer token. When absent, the literal route.tokenRef is used as
   * the token (backward compat). Resolution is lazy + cached (resolve once).
   */
  readonly #tokenResolver: TokenResolver | undefined
  #resolvedToken: string | null = null

  #ws: WebSocket | null = null
  #lastAttach: AttachResult | null = null
  #disposed = false

  readonly #descriptorBroadcast = new Broadcast<AttachResult>()
  readonly #connectionBroadcast = new Broadcast<ConnectionState>()

  // Synchronous callback sets for raw frame and connection state subscriptions.
  readonly #frameCallbacks = new Set<(frame: ServerFrame) => void>()
  readonly #stateCallbacks = new Set<(state: ConnectionState) => void>()

  // Set by #connectWs so dispose() can abort an in-flight connect.
  #helloReject: ((err: Error) => void) | null = null

  #pendingNewThread: {
    resolve: (threadId: string) => void
    reject: (err: Error) => void
  } | null = null

  // Session map — initialized before dispatchToSessions is ever called.
  readonly #sessions = new Map<string, SessionEntry>()

  // Reconnect state
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null
  #reconnectAttempts = 0
  static readonly #MAX_RECONNECT_ATTEMPTS = 6
  static readonly #BASE_RECONNECT_MS = 500
  static readonly #MAX_RECONNECT_MS = 15_000

  readonly #maxReconnectAttempts: number
  readonly #baseReconnectMs: number
  readonly #maxReconnectMs: number

  constructor(
    route: RouteConfig,
    wsFactory?: WsFactory,
    /** Timeout in ms before handshake is considered failed. Default: 10_000. */
    handshakeTimeoutMs = 10_000,
    /** For tests: override reconnect timing constants. */
    reconnectOpts?: { maxAttempts?: number; baseMs?: number; maxMs?: number },
    /**
     * Optional resolver for route.tokenRef → bearer token. When omitted, the
     * literal route.tokenRef is used (backward compat). Resolved lazily, once.
     */
    tokenResolver?: TokenResolver,
  ) {
    this.routeKey = route.routeKey
    this.#route = route
    this.#wsFactory = wsFactory ?? defaultWsFactory
    this.#handshakeTimeoutMs = handshakeTimeoutMs
    this.#maxReconnectAttempts = reconnectOpts?.maxAttempts ?? LunaWsAdapter.#MAX_RECONNECT_ATTEMPTS
    this.#baseReconnectMs = reconnectOpts?.baseMs ?? LunaWsAdapter.#BASE_RECONNECT_MS
    this.#maxReconnectMs = reconnectOpts?.maxMs ?? LunaWsAdapter.#MAX_RECONNECT_MS
    this.#tokenResolver = tokenResolver
  }

  /**
   * Resolve the bearer token for this route, lazily and cached. If a resolver
   * was injected, it is used (only for this route). Otherwise the literal
   * route.tokenRef is returned unchanged (backward compat). The resolved token
   * is held in memory only — never logged, never written back to disk.
   */
  async #resolveToken(): Promise<string> {
    if (this.#resolvedToken !== null) return this.#resolvedToken
    const token = this.#tokenResolver
      ? await this.#tokenResolver(this.#route.tokenRef)
      : this.#route.tokenRef
    this.#resolvedToken = token
    return token
  }

  /**
   * Register a callback to receive ALL raw server frames (including hello).
   * Returns an unsubscribe function. Safe to call before attach().
   *
   * MUTUALLY EXCLUSIVE with openSession: both paths receive every post-hello
   * frame, so a consumer using both will process each frame twice. Use one
   * or the other on a single adapter instance — not both.
   */
  subscribeFrames(cb: (frame: ServerFrame) => void): () => void {
    this.#frameCallbacks.add(cb)
    return () => this.#frameCallbacks.delete(cb)
  }

  /**
   * Register a callback for connection state transitions.
   * Returns an unsubscribe function.
   */
  subscribeConnection(cb: (state: ConnectionState) => void): () => void {
    this.#stateCallbacks.add(cb)
    return () => this.#stateCallbacks.delete(cb)
  }

  /**
   * Send a raw client frame to the server as JSON.
   * Drops silently if the socket is not currently open.
   */
  sendFrame(frame: unknown): void {
    if (this.#ws && this.#ws.readyState === this.#ws.OPEN) {
      this.#ws.send(JSON.stringify(frame))
    }
  }

  async attach(): Promise<AttachResult> {
    if (this.#disposed) throw new Error(`LunaWsAdapter(${this.routeKey}): disposed`)

    const url = this.#route.endpoints[0]
    if (!url) throw new Error(`LunaWsAdapter(${this.routeKey}): no endpoints configured`)

    // If already attached and socket is still open, return cached result.
    if (this.#lastAttach && this.#ws && this.#ws.readyState === this.#ws.OPEN) {
      return this.#lastAttach
    }

    this.#publishConnectionState({ status: "connecting" })

    // Resolve the bearer token BEFORE dialing. If an injected resolver rejects
    // (op:// fail-closed, env unset, Tauri command error), fail closed: no
    // empty/garbage token ever reaches the wire (the tokenized URL is never
    // built). We additionally transition the connection stream to a terminal
    // "down" state so a consumer subscribed SOLELY to `connection` does not see
    // it pinned at "connecting" — then re-throw to preserve the rejected-attach
    // contract that hosts already await.
    let token: string
    try {
      token = await this.#resolveToken()
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      this.#publishConnectionState({ status: "down", reason })
      throw err
    }
    const sep = url.includes("?") ? "&" : "?"
    const tokenizedUrl = `${url}${sep}token=${encodeURIComponent(token)}`

    const result = await this.#connectWs(tokenizedUrl)
    this.#lastAttach = result
    this.#publishConnectionState({ status: "ready" })
    this.#descriptorBroadcast.publish(result)
    return result
  }

  async describe(): Promise<AttachResult> {
    if (this.#lastAttach) return this.#lastAttach
    return this.attach()
  }

  get descriptorChanges(): AsyncIterable<AttachResult> {
    return { [Symbol.asyncIterator]: () => this.#descriptorBroadcast.subscribe() }
  }

  get connection(): AsyncIterable<ConnectionState> {
    return { [Symbol.asyncIterator]: () => this.#connectionBroadcast.subscribe() }
  }

  async openSession(opts: { readonly threadId?: string; readonly model?: string }): Promise<ChatSession> {
    if (!this.#lastAttach) await this.attach()
    const ws = this.#ws
    if (!ws) throw new Error(`LunaWsAdapter(${this.routeKey}): no active connection`)

    // If no threadId, use new-thread protocol to get a real thread ID.
    let threadId: string
    if (opts.threadId) {
      threadId = opts.threadId
    } else {
      threadId = await this.#createNewThread(ws, opts.model)
    }

    const sessionId = `${threadId}-${Date.now()}`

    // Subscribe to this thread on the server.
    const subscribeFrame = { type: "subscribe", threadId }
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(subscribeFrame))
    }

    // Build a per-session async queue that can be terminated on close/dispose.
    const frameQueue: Array<ChatFrame> = []
    const frameWaiters: Array<(v: IteratorResult<ChatFrame>) => void> = []
    let closed = false

    function drainClose(): void {
      closed = true
      for (const w of frameWaiters.splice(0)) {
        w({ value: undefined as unknown as ChatFrame, done: true })
      }
    }

    const sessionEntry: SessionEntry = {
      threadId,
      push: (frame: ChatFrame) => {
        if (closed) return
        const waiter = frameWaiters.shift()
        if (waiter) {
          waiter({ value: frame, done: false })
        } else {
          frameQueue.push(frame)
        }
      },
      close: drainClose,
    }
    this.#sessions.set(sessionId, sessionEntry)

    const messages: AsyncIterable<ChatFrame> = {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<ChatFrame>> {
            if (closed && frameQueue.length === 0) {
              return Promise.resolve({ value: undefined as unknown as ChatFrame, done: true })
            }
            const queued = frameQueue.shift()
            if (queued !== undefined) {
              return Promise.resolve({ value: queued, done: false })
            }
            if (closed) {
              return Promise.resolve({ value: undefined as unknown as ChatFrame, done: true })
            }
            return new Promise<IteratorResult<ChatFrame>>((resolve) => {
              frameWaiters.push(resolve)
            })
          },
          return(): Promise<IteratorResult<ChatFrame>> {
            drainClose()
            return Promise.resolve({ value: undefined as unknown as ChatFrame, done: true })
          },
        }
      },
    }

    const adapter = this
    const session: ChatSession = {
      threadId,
      messages,
      async send(input: ChatInput) {
        if (!ws || ws.readyState !== ws.OPEN) {
          throw new Error("Cannot send: connection not open")
        }
        ws.send(JSON.stringify({ type: "user-message", threadId, text: input.text }))
      },
      async stop() {
        if (ws && ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: "interrupt", threadId }))
        }
      },
      close() {
        drainClose()
        if (ws && ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: "unsubscribe", threadId }))
        }
        adapter.#sessions.delete(sessionId)
      },
    }

    return session
  }

  async dispose(): Promise<void> {
    this.#disposed = true

    // Cancel any pending reconnect timer.
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer)
      this.#reconnectTimer = null
    }

    // Terminate all broadcast subscribers cleanly.
    this.#descriptorBroadcast.close()
    this.#connectionBroadcast.close()

    // Clear synchronous callback sets.
    this.#frameCallbacks.clear()
    this.#stateCallbacks.clear()

    // Reject any in-flight hello promise.
    if (this.#helloReject) {
      this.#helloReject(new Error(`LunaWsAdapter(${this.routeKey}): disposed`))
      this.#helloReject = null
    }

    // Reject any pending new-thread creation.
    if (this.#pendingNewThread) {
      this.#pendingNewThread.reject(new Error(`LunaWsAdapter(${this.routeKey}): disposed`))
      this.#pendingNewThread = null
    }

    // Close all session message iterables cleanly.
    for (const [, entry] of this.#sessions) {
      entry.close()
    }
    this.#sessions.clear()

    // Close the socket.
    if (this.#ws) {
      try { this.#ws.close() } catch { /* ignore */ }
      this.#ws = null
    }
  }

  // ── private helpers ──────────────────────────────────────────────────────

  /** Publish a connection state to the broadcast AND all sync callbacks. */
  #publishConnectionState(state: ConnectionState): void {
    this.#connectionBroadcast.publish(state)
    for (const cb of this.#stateCallbacks) cb(state)
  }

  /**
   * Creates a WebSocket, wires up event handlers, and returns a Promise that
   * resolves with the AttachResult on hello or rejects on close-before-hello /
   * timeout. Also handles post-hello drops by scheduling a reconnect.
   */
  #connectWs(tokenizedUrl: string): Promise<AttachResult> {
    return new Promise<AttachResult>((resolve, reject) => {
      let settled = false

      // Expose reject so dispose() can abort an in-flight connect.
      this.#helloReject = (err: Error) => {
        if (settled) return
        settled = true
        this.#helloReject = null
        reject(err)
      }

      const timeout = setTimeout(() => {
        if (settled) return
        settled = true
        this.#helloReject = null
        if (this.#ws) {
          try { this.#ws.close() } catch { /* ignore */ }
          this.#ws = null
        }
        this.#publishConnectionState({ status: "handshake-timeout" })
        reject(new Error(`LunaWsAdapter(${this.routeKey}): handshake timeout after 10s`))
      }, this.#handshakeTimeoutMs)

      let ws: WebSocket
      try {
        ws = this.#wsFactory(tokenizedUrl)
      } catch (e) {
        settled = true
        this.#helloReject = null
        clearTimeout(timeout)
        reject(e instanceof Error ? e : new Error(String(e)))
        return
      }

      this.#ws = ws

      ws.addEventListener("open", () => {
        // Socket is open but waiting for hello — "connecting" already emitted.
      })

      ws.addEventListener("message", (ev) => {
        // Guard: ignore events from a superseded socket (after #doReconnect nulls #ws
        // and opens a fresh one). Without this, a late close re-fire on a dead socket
        // could call #scheduleReconnect() a second time.
        if (this.#ws !== ws) return
        let frame: ServerFrame
        try {
          frame = JSON.parse(String((ev as MessageEvent).data)) as ServerFrame
        } catch { return }

        // Notify all raw-frame subscribers synchronously (ALL frames, incl. hello).
        for (const cb of this.#frameCallbacks) cb(frame)

        if (!settled && isHelloFrame(frame)) {
          settled = true
          this.#helloReject = null
          clearTimeout(timeout)

          if (frame.descriptor) {
            // Server emitted a descriptor — normal path.
            resolve({ descriptor: frame.descriptor, origin: "server-emitted" as const })
            return
          }

          // No descriptor from server. Check if route is pinned.
          const isPinned =
            this.#route.expect != null &&
            Object.values(this.#route.expect).some((v) => v != null && v !== "")

          if (isPinned) {
            // PINNED route answered without a descriptor — downgrade attack / wrong server.
            const reason = `pinned route '${this.routeKey}' answered without a descriptor — refusing downgrade`
            this.#publishConnectionState({ status: "identity-failed", reason })
            ws.close(1008, "identity-failed")
            reject(new Error(`LunaWsAdapter(${this.routeKey}): ${reason}`))
            return
          }

          // Unpinned route — synthesize legacy descriptor (backward compat).
          resolve({
            descriptor: synthesizeLegacyDescriptor(this.#route),
            origin: "synthesized-legacy" as const,
          })
          return
        }

        if (settled) {
          this.#dispatchToSessions(frame)
        }
      })

      ws.addEventListener("close", (ev) => {
        if (this.#ws !== ws) return
        const closeEv = ev as { code?: number; reason?: string }
        const code = closeEv.code ?? 0
        const reason = `code=${code} reason=${closeEv.reason ?? ""}`

        if (!settled) {
          // Close before hello — reject the connect promise.
          settled = true
          this.#helloReject = null
          clearTimeout(timeout)

          if (code === 1008) {
            this.#publishConnectionState({ status: "auth-failed", reason })
          } else {
            this.#publishConnectionState({ status: "down", reason })
          }
          reject(new Error(`LunaWsAdapter(${this.routeKey}): socket closed before hello (${reason})`))
          return
        }

        // Post-hello close.
        if (this.#disposed) return

        if (code === 1008) {
          // Auth failure is terminal — no reconnect.
          this.#publishConnectionState({ status: "auth-failed", reason })
          return
        }

        // Transient drop: start reconnect loop.
        this.#publishConnectionState({ status: "recovering", reason })
        this.#scheduleReconnect()
      })

      ws.addEventListener("error", () => {
        if (this.#ws !== ws) return
        // In both browser WebSocket and the ws package, an error event is
        // always followed by a close event. Let the close handler do the
        // definitive settle so it can read the close code.
      })
    })
  }

  #scheduleReconnect(): void {
    if (this.#disposed) return
    if (this.#reconnectAttempts >= this.#maxReconnectAttempts) {
      this.#publishConnectionState({ status: "down", reason: "max reconnect attempts exceeded" })
      return
    }
    const delay =
      Math.min(
        this.#baseReconnectMs * Math.pow(2, this.#reconnectAttempts),
        this.#maxReconnectMs,
      ) + Math.random() * 200
    this.#reconnectAttempts++
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null
      void this.#doReconnect()
    }, delay)
  }

  async #doReconnect(): Promise<void> {
    if (this.#disposed) return

    const url = this.#route.endpoints[0]
    if (!url) return

    // Reuse the cached token from the initial attach (resolved once). On the
    // off-chance it is not yet cached (defensive), resolve again.
    const token = await this.#resolveToken()
    const sep = url.includes("?") ? "&" : "?"
    const tokenizedUrl = `${url}${sep}token=${encodeURIComponent(token)}`

    this.#ws = null

    try {
      const result = await this.#connectWs(tokenizedUrl)
      if (this.#disposed) return
      this.#reconnectAttempts = 0
      this.#lastAttach = result
      this.#publishConnectionState({ status: "ready" })
      this.#descriptorBroadcast.publish(result)
    } catch {
      if (!this.#disposed) {
        this.#publishConnectionState({ status: "recovering" })
        this.#scheduleReconnect()
      }
    }
  }

  /**
   * Send new-thread and wait for thread-created / thread-create-error.
   * Passes `model` to the server only if provided.
   */
  async #createNewThread(ws: WebSocket, model?: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (this.#pendingNewThread) {
        reject(new Error(`LunaWsAdapter(${this.routeKey}): concurrent new-thread not supported`))
        return
      }
      this.#pendingNewThread = { resolve, reject }
      const frame: { type: string; model?: string } = {
        type: "new-thread",
        ...(model ? { model } : {}),
      }
      ws.send(JSON.stringify(frame))
    })
  }

  // ── private session dispatch ─────────────────────────────────────────────

  #dispatchToSessions(frame: ServerFrame): void {
    // Intercept thread-created / thread-create-error for new-thread.
    if (isThreadCreatedFrame(frame)) {
      if (this.#pendingNewThread) {
        const pending = this.#pendingNewThread
        this.#pendingNewThread = null
        pending.resolve(frame.thread.id)
      }
      return
    }

    if (isThreadCreateErrorFrame(frame)) {
      if (this.#pendingNewThread) {
        const pending = this.#pendingNewThread
        this.#pendingNewThread = null
        pending.reject(new Error(`LunaWsAdapter(${this.routeKey}): thread-create-error: ${frame.message}`))
      }
      return
    }

    if (isThreadSnapshotFrame(frame)) {
      const { threadId, messages } = frame
      for (const [, session] of this.#sessions) {
        if (session.threadId === threadId) {
          session.push({
            t: "thread-snapshot",
            messages: messages.map((m) => ({
              id: m.id,
              role: m.role as "user" | "assistant" | "system",
              content: m.text,
            })),
          })
        }
      }
    } else if (isAssistantDeltaFrame(frame)) {
      const { threadId, turnId, text } = frame
      for (const [, session] of this.#sessions) {
        if (session.threadId === threadId) {
          session.push({ t: "delta", messageId: turnId, text })
        }
      }
    } else if (isAssistantDoneFrame(frame)) {
      const { threadId, turnId } = frame
      for (const [, session] of this.#sessions) {
        if (session.threadId === threadId) {
          session.push({ t: "done", messageId: turnId })
        }
      }
    } else if (isAssistantErrorFrame(frame)) {
      const { threadId, error } = frame
      for (const [, session] of this.#sessions) {
        if (session.threadId === threadId) {
          session.push({ t: "error", code: error.kind, message: error.message })
        }
      }
    }
  }
}

interface SessionEntry {
  threadId: string
  push(frame: ChatFrame): void
  close(): void
}
