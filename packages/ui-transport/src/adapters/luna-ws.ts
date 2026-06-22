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

  #ws: WebSocket | null = null
  #lastAttach: AttachResult | null = null
  #disposed = false

  // FIX 1: Broadcast helpers replace the queue/waiter arrays.
  readonly #descriptorBroadcast = new Broadcast<AttachResult>()
  readonly #connectionBroadcast = new Broadcast<ConnectionState>()

  // Pending hello resolution (set during attach())
  #helloResolve: ((result: AttachResult) => void) | null = null
  #helloReject: ((err: Error) => void) | null = null

  // FIX 4: Pending new-thread resolution.
  #pendingNewThread: {
    resolve: (threadId: string) => void
    reject: (err: Error) => void
  } | null = null

  // Session map — initialized before dispatchToSessions is ever called.
  readonly #sessions = new Map<string, SessionEntry>()

  constructor(
    route: RouteConfig,
    wsFactory?: WsFactory,
    /** Timeout in ms before handshake is considered failed. Default: 10_000. */
    handshakeTimeoutMs = 10_000,
  ) {
    this.routeKey = route.routeKey
    this.#route = route
    this.#wsFactory = wsFactory ?? defaultWsFactory
    this.#handshakeTimeoutMs = handshakeTimeoutMs
  }

  async attach(): Promise<AttachResult> {
    if (this.#disposed) throw new Error(`LunaWsAdapter(${this.routeKey}): disposed`)

    const url = this.#route.endpoints[0]
    if (!url) throw new Error(`LunaWsAdapter(${this.routeKey}): no endpoints configured`)

    // If already attached and socket is still open, return cached result.
    if (this.#lastAttach && this.#ws && this.#ws.readyState === this.#ws.OPEN) {
      return this.#lastAttach
    }

    return new Promise<AttachResult>((resolve, reject) => {
      this.#helloResolve = resolve
      this.#helloReject = reject

      // FIX 3: settled flag prevents double-resolve/reject after timeout.
      let settled = false

      const timeout = setTimeout(() => {
        if (settled) return
        settled = true
        // Close the socket so the server knows we gave up.
        if (this.#ws) {
          try { this.#ws.close() } catch { /* ignore */ }
          this.#ws = null
        }
        this.#connectionBroadcast.publish({ status: "handshake-timeout" })
        const err = new Error(`LunaWsAdapter(${this.routeKey}): handshake timeout after 10s`)
        if (this.#helloReject) {
          this.#helloReject(err)
          this.#helloResolve = null
          this.#helloReject = null
        }
      }, this.#handshakeTimeoutMs)

      this.#connectionBroadcast.publish({ status: "connecting" })

      // FIX 5: Token is already in the URL query string — no Bearer header.
      const sep = url.includes("?") ? "&" : "?"
      const tokenizedUrl = `${url}${sep}token=${encodeURIComponent(this.#route.tokenRef)}`

      let ws: WebSocket
      try {
        ws = this.#wsFactory(tokenizedUrl)
      } catch (e) {
        settled = true
        clearTimeout(timeout)
        reject(e instanceof Error ? e : new Error(String(e)))
        return
      }

      this.#ws = ws

      ws.addEventListener("open", () => {
        // Socket is open but waiting for hello — "connecting" already emitted.
      })

      ws.addEventListener("message", (ev) => {
        // FIX 3: guard against late messages after timeout.
        if (settled) {
          // Still dispatch to sessions for post-attach messages.
          let frame: ServerFrame
          try {
            frame = JSON.parse(String((ev as MessageEvent).data)) as ServerFrame
          } catch { return }
          this.#dispatchToSessions(frame)
          return
        }

        let frame: ServerFrame
        try {
          frame = JSON.parse(String((ev as MessageEvent).data)) as ServerFrame
        } catch {
          return // drop malformed frames
        }

        if (isHelloFrame(frame)) {
          settled = true
          clearTimeout(timeout)

          const result: AttachResult = frame.descriptor
            ? { descriptor: frame.descriptor, origin: "server-emitted" as const }
            : {
                descriptor: synthesizeLegacyDescriptor(this.#route),
                origin: "synthesized-legacy" as const,
              }

          this.#lastAttach = result
          this.#connectionBroadcast.publish({ status: "ready" })
          this.#descriptorBroadcast.publish(result)

          if (this.#helloResolve) {
            this.#helloResolve(result)
            this.#helloResolve = null
            this.#helloReject = null
          }
        }

        // Route message to open sessions (including thread-created).
        this.#dispatchToSessions(frame)
      })

      ws.addEventListener("close", (ev) => {
        // FIX 3: guard against double-settle.
        if (settled) {
          // Post-attach close: emit down state.
          const closeEv = ev as { code?: number; reason?: string }
          const reason = `code=${closeEv.code ?? 0} reason=${closeEv.reason ?? ""}`
          if ((closeEv.code ?? 0) === 1008) {
            this.#connectionBroadcast.publish({ status: "auth-failed", reason })
          } else {
            this.#connectionBroadcast.publish({ status: "down", reason })
          }
          return
        }
        settled = true
        clearTimeout(timeout)

        const closeEv = ev as { code?: number; reason?: string }
        const reason = `code=${closeEv.code ?? 0} reason=${closeEv.reason ?? ""}`

        // FIX 6: distinguish auth failures (1008) from other closes.
        if ((closeEv.code ?? 0) === 1008) {
          this.#connectionBroadcast.publish({ status: "auth-failed", reason })
        } else {
          this.#connectionBroadcast.publish({ status: "down", reason })
        }

        if (this.#helloReject) {
          this.#helloReject(
            new Error(`LunaWsAdapter(${this.routeKey}): socket closed before hello (${reason})`),
          )
          this.#helloResolve = null
          this.#helloReject = null
        }
      })

      ws.addEventListener("error", () => {
        // FIX 3: Do NOT settle here. In both browser WebSocket and the ws
        // package, an error event is always followed by a close event.
        // Let the close handler do the definitive settle so it can read the
        // close code (e.g. 1008 for auth-failed vs generic network error).
        // If settled is already true (e.g. after hello), ignore the error.
      })
    })
  }

  async describe(): Promise<AttachResult> {
    if (this.#lastAttach) return this.#lastAttach
    return this.attach()
  }

  // FIX 1: Wire getters to Broadcast.subscribe().
  get descriptorChanges(): AsyncIterable<AttachResult> {
    return { [Symbol.asyncIterator]: () => this.#descriptorBroadcast.subscribe() }
  }

  get connection(): AsyncIterable<ConnectionState> {
    return { [Symbol.asyncIterator]: () => this.#connectionBroadcast.subscribe() }
  }

  async openSession(opts: { readonly threadId?: string }): Promise<ChatSession> {
    if (!this.#lastAttach) await this.attach()
    const ws = this.#ws
    if (!ws) throw new Error(`LunaWsAdapter(${this.routeKey}): no active connection`)

    // FIX 4: If no threadId, use new-thread protocol to get a real thread ID.
    let threadId: string
    if (opts.threadId) {
      threadId = opts.threadId
    } else {
      threadId = await this.#createNewThread(ws)
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
      // FIX 2: dispose() calls this to cleanly terminate the message iterable.
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

    // FIX 2: Terminate all broadcast subscribers cleanly.
    this.#descriptorBroadcast.close()
    this.#connectionBroadcast.close()

    // FIX 2: Reject any in-flight hello promise.
    if (this.#helloReject) {
      this.#helloReject(new Error(`LunaWsAdapter(${this.routeKey}): disposed`))
      this.#helloResolve = null
      this.#helloReject = null
    }

    // FIX 2: Reject any pending new-thread creation.
    if (this.#pendingNewThread) {
      this.#pendingNewThread.reject(new Error(`LunaWsAdapter(${this.routeKey}): disposed`))
      this.#pendingNewThread = null
    }

    // FIX 2: Close all session message iterables cleanly.
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

  /**
   * FIX 4: Send new-thread and wait for thread-created / thread-create-error.
   */
  async #createNewThread(ws: WebSocket): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (this.#pendingNewThread) {
        reject(new Error(`LunaWsAdapter(${this.routeKey}): concurrent new-thread not supported`))
        return
      }
      this.#pendingNewThread = { resolve, reject }
      const frame: { type: string; model: string } = {
        type: "new-thread",
        model: "claude-sonnet-4-5",
      }
      ws.send(JSON.stringify(frame))
    })
  }

  // ── private session dispatch ─────────────────────────────────────────────

  #dispatchToSessions(frame: ServerFrame): void {
    // FIX 4: Intercept thread-created / thread-create-error for new-thread.
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
