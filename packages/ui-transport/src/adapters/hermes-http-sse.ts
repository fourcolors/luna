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

// ── Types for Hermes HTTP responses ──────────────────────────────────────────

/** Shape returned by GET /v1/capabilities — field names assumed, MUST-CONFIRM vs live Hermes. */
interface HermesCapabilities {
  readonly version?: string // ⚠️ ASSUMPTION: version field name unconfirmed — check live /v1/capabilities
  readonly [key: string]: unknown
}

/** Shape returned by GET /health. */
interface HermesHealth {
  readonly status?: "ok" | "error" | string
  readonly [key: string]: unknown
}

/** A single OpenAI-compatible SSE chunk's delta. */
interface OpenAIDelta {
  readonly role?: "assistant" | "user" | string
  readonly content?: string | null
}

/** An OpenAI-compatible streaming choice. */
interface OpenAIChoice {
  readonly index: number
  readonly delta: OpenAIDelta
  readonly finish_reason?: string | null
}

/** An OpenAI-compatible SSE data chunk. */
interface OpenAIChunk {
  readonly id?: string
  readonly choices?: readonly OpenAIChoice[]
}

// ── fetch injection type ──────────────────────────────────────────────────────

export type FetchFn = typeof fetch

// ── projectHermesDescriptor ───────────────────────────────────────────────────

/**
 * Pure function: projects a client-side ServerDescriptor from Hermes API responses.
 *
 * Hermes does NOT emit a Luna-style descriptor/handshake — the adapter builds one
 * from /v1/capabilities + /health (dual-origin: client-projected, not server-emitted).
 *
 * Key differentiator vs Luna: update.revertible = false (conservative default —
 * ⚠️ ASSUMPTION: `hermes update` reversibility is UNCONFIRMED per design doc §7 note (a))
 */
export function projectHermesDescriptor(
  capabilities: HermesCapabilities,
  health: HermesHealth,
  routeKey: string,
  port?: number,
): ServerDescriptor {
  // ⚠️ ASSUMPTION: field carrying Hermes version in /v1/capabilities is unconfirmed.
  // Using `capabilities.version` as a placeholder; verify against a live instance.
  const version = (capabilities.version as string | undefined) ?? "unknown"

  const healthOk = health.status === "ok"

  return {
    descriptorSchema: 1,
    generation: 1,
    issuedAt: new Date().toISOString(),
    negotiation: { agreed: 1 },
    identity: {
      name: routeKey,
      kind: "hermes",
      displayName: "Hermes (Nous agent)",
      version,
    },
    runtimeSummary: {
      category: "host-process",
      live: healthOk,
    },
    capabilities: [
      {
        operation: "interact",
        available: true,
        title: "Chat",
        authz: { allowed: true, scope: "write" },
        detail: {
          openaiCompatible: true,
          streaming: "sse",
          endpoint: "/v1/chat/completions",
        },
      },
      {
        operation: "inspect",
        available: true,
        title: "Status",
        authz: { allowed: true, scope: "read" },
        detail: {
          health: "/health",
          capabilities: "/v1/capabilities",
          models: "/v1/models",
        },
      },
      {
        operation: "administer",
        available: true,
        title: "Manage runs",
        authz: { allowed: true, scope: "admin" },
        detail: {
          runs: "/v1/runs",
        },
      },
      {
        operation: "update",
        available: true,
        title: "Update Hermes",
        authz: {
          allowed: true,
          scope: "write",
          requiresElevation: true,
          reason: "`hermes update` runs on the Hermes host, not over the API",
        },
        detail: {
          // ⚠️ ASSUMPTION: forwardOnly is conservatively set — reversibility UNCONFIRMED (§7 note (a))
          forwardOnly: true,
          mechanism: "hermes update",
        },
      },
    ],
    health: {
      status: healthOk ? ("normal" as const) : ("error" as const),
      credentialOk: true as const,
      ...(port !== undefined ? { port } : {}),
      checks: [{ name: "/health", ok: healthOk }] as const,
      checkedAt: new Date().toISOString(),
    },
    update: {
      driverKind: "hermes",
      currentVersion: version,
      // ⚠️ ASSUMPTION: revertible:false is the CONSERVATIVE default — no source confirms
      // `hermes update` reversibility (design doc §7 note (a) MUST-CONFIRM). NOT a sourced fact.
      // Contrast with LunaWsAdapter where update.revertible:true (Luna has rollback support).
      revertible: false,
      // ⚠️ ASSUMPTION: forward-only is conservatively set — per-channel reversibility unconfirmed.
      forwardOnly: true,
    },
  }
}

// ── HermesHttpSseAdapter ──────────────────────────────────────────────────────

/**
 * Hermes HTTP+SSE adapter. Implements ClientTransportAdapter for
 * http:// / https:// routes pointing at the Nous Research Hermes Agent harness
 * (OpenAI-compatible API, default port 8642, Bearer token auth).
 *
 * Unlike Luna (which emits a descriptor in the `hello` WS frame), Hermes has NO
 * native Luna-style handshake — the descriptor is CLIENT-PROJECTED from
 * GET /health + GET /v1/capabilities (dual-origin pattern, design doc §9.1).
 *
 * The optional `fetchFn` parameter exists for testability — tests inject a custom
 * fetch that routes to the stub server.
 */
export class HermesHttpSseAdapter implements ClientTransportAdapter {
  readonly routeKey: string
  readonly transportKind = "hermes-http-sse" as const

  readonly #route: RouteConfig
  readonly #fetch: FetchFn

  /**
   * Optional injected resolver: turns route.tokenRef (env:/file:/op:/none) into
   * a concrete bearer token. When absent, the literal route.tokenRef is used
   * (backward compat). Resolution is lazy + cached (resolve once).
   */
  readonly #tokenResolver: TokenResolver | undefined
  #resolvedToken: string | null = null

  #lastAttach: AttachResult | null = null
  #disposed = false

  readonly #descriptorBroadcast = new Broadcast<AttachResult>()
  readonly #connectionBroadcast = new Broadcast<ConnectionState>()

  /** Active AbortControllers for in-flight SSE fetches (one per open session). */
  readonly #sessionAborts = new Map<string, AbortController>()

  /** Drain functions for open sessions (called on dispose() to unblock parked iterables). */
  readonly #sessionDrains = new Map<string, () => void>()

  constructor(
    route: RouteConfig,
    fetchFn?: FetchFn,
    /**
     * Optional resolver for route.tokenRef → bearer token. When omitted, the
     * literal route.tokenRef is used (backward compat). Resolved lazily, once.
     */
    tokenResolver?: TokenResolver,
  ) {
    this.routeKey = route.routeKey
    this.#route = route
    this.#fetch = fetchFn ?? globalThis.fetch.bind(globalThis)
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

  // ── Public: ClientTransportAdapter ─────────────────────────────────────────

  async attach(): Promise<AttachResult> {
    if (this.#disposed) throw new Error(`HermesHttpSseAdapter(${this.routeKey}): disposed`)

    const baseUrl = this.#baseUrl()

    this.#connectionBroadcast.publish({ status: "connecting" })

    // Resolve the bearer token BEFORE the first fetch. If an injected resolver
    // rejects (op:// fail-closed, env unset, Tauri command error), fail closed:
    // no fetch is issued with an empty/garbage token. We also transition the
    // connection stream to a terminal "down" state (so a consumer subscribed
    // SOLELY to `connection` is not pinned at "connecting") and re-throw to
    // preserve the rejected-attach contract callers already await.
    let token: string
    try {
      token = await this.#resolveToken()
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      this.#connectionBroadcast.publish({ status: "down", reason })
      throw err
    }

    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      }

      // Probe /health first
      const healthRes = await this.#fetch(`${baseUrl}/health`, { headers })
      if (healthRes.status === 401) {
        this.#connectionBroadcast.publish({ status: "auth-failed", reason: "401 from /health" })
        throw new Error(`HermesHttpSseAdapter(${this.routeKey}): auth failed (401 on /health)`)
      }
      if (!healthRes.ok) {
        this.#connectionBroadcast.publish({
          status: "down",
          reason: `HTTP ${healthRes.status} from /health`,
        })
        throw new Error(
          `HermesHttpSseAdapter(${this.routeKey}): /health returned ${healthRes.status}`,
        )
      }
      const health = (await healthRes.json()) as HermesHealth

      // Fetch /v1/capabilities
      const capsRes = await this.#fetch(`${baseUrl}/v1/capabilities`, { headers })
      if (capsRes.status === 401) {
        this.#connectionBroadcast.publish({
          status: "auth-failed",
          reason: "401 from /v1/capabilities",
        })
        throw new Error(
          `HermesHttpSseAdapter(${this.routeKey}): auth failed (401 on /v1/capabilities)`,
        )
      }

      // 404 → gracefully degrade (endpoint may not exist on all Hermes builds)
      // 5xx → surface as connection error (server is broken, not just missing the endpoint)
      let capabilities: HermesCapabilities
      if (capsRes.ok) {
        capabilities = (await capsRes.json()) as HermesCapabilities
      } else if (capsRes.status === 404) {
        capabilities = {}
      } else {
        this.#connectionBroadcast.publish({
          status: "down",
          reason: `HTTP ${capsRes.status} from /v1/capabilities`,
        })
        throw new Error(
          `HermesHttpSseAdapter(${this.routeKey}): /v1/capabilities returned ${capsRes.status}`,
        )
      }

      // Extract port from base URL
      const urlObj = new URL(baseUrl)
      const port = urlObj.port ? parseInt(urlObj.port, 10) : undefined

      const descriptor = projectHermesDescriptor(capabilities, health, this.routeKey, port)
      const result: AttachResult = { descriptor, origin: "client-projected" as const }

      this.#lastAttach = result
      this.#connectionBroadcast.publish({ status: "ready" })
      this.#descriptorBroadcast.publish(result)

      return result
    } catch (err) {
      // Re-throw auth/down errors (already broadcast above)
      if (err instanceof Error && err.message.includes("HermesHttpSseAdapter")) {
        throw err
      }
      // Network-level failure
      this.#connectionBroadcast.publish({
        status: "down",
        reason: err instanceof Error ? err.message : String(err),
      })
      throw new Error(
        `HermesHttpSseAdapter(${this.routeKey}): attach failed — ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  /** Idempotent re-fetch: always re-probes /health + /v1/capabilities. */
  async describe(): Promise<AttachResult> {
    // Re-project on every call (health may have changed)
    return this.attach()
  }

  get descriptorChanges(): AsyncIterable<AttachResult> {
    return { [Symbol.asyncIterator]: () => this.#descriptorBroadcast.subscribe() }
  }

  get connection(): AsyncIterable<ConnectionState> {
    return { [Symbol.asyncIterator]: () => this.#connectionBroadcast.subscribe() }
  }

  /**
   * Opens a chat session via POST /v1/chat/completions (stream:true).
   *
   * The SSE stream is parsed and mapped to the normalized ChatSession.messages shape:
   * - OpenAI delta chunks → { t:"delta", messageId, text }
   * - finish_reason present → { t:"done", messageId }
   * - [DONE] sentinel → ends the async iterable
   *
   * This makes the UI backend-agnostic: the same for-await loop works for both
   * LunaWsAdapter and HermesHttpSseAdapter.
   */
  async openSession(opts: { readonly threadId?: string; readonly model?: string }): Promise<ChatSession> {
    if (this.#disposed) throw new Error(`HermesHttpSseAdapter(${this.routeKey}): disposed`)
    if (!this.#lastAttach) await this.attach()

    // opts.model is intentionally ignored: Hermes selects the model server-side
    // via its own configuration (unlike LunaWsAdapter which threads model through
    // the new-thread frame). This asymmetry is by design, not an oversight.
    const threadId = opts.threadId ?? `hermes-${Date.now()}`
    const sessionId = `${threadId}-${Date.now()}`

    const abortController = new AbortController()
    this.#sessionAborts.set(sessionId, abortController)

    // Per-session async queue — same pattern as LunaWsAdapter
    const frameQueue: Array<ChatFrame> = []
    const frameWaiters: Array<(v: IteratorResult<ChatFrame>) => void> = []
    let closed = false
    let turnInFlight = false

    function pushFrame(frame: ChatFrame): void {
      if (closed) return
      const waiter = frameWaiters.shift()
      if (waiter) {
        waiter({ value: frame, done: false })
      } else {
        frameQueue.push(frame)
      }
    }

    function drainClose(): void {
      closed = true
      for (const w of frameWaiters.splice(0)) {
        w({ value: undefined as unknown as ChatFrame, done: true })
      }
    }

    this.#sessionDrains.set(sessionId, drainClose)

    // We keep a reference to the pending message ID for delta/done correlation
    let currentMessageId = `msg-${Date.now()}`

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

    /** Internal: start an SSE fetch and pump frames into the queue. */
    const startStream = async (userText: string): Promise<void> => {
      const baseUrl = this.#baseUrl()
      // Reuse the token resolved at attach() (cached). openSession() calls
      // attach() first if not yet attached, so this never re-prompts op://.
      const token = await this.#resolveToken()

      // Assign a new messageId for this turn
      currentMessageId = `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`

      let doneEmitted = false
      let res: Response
      try {
        res = await this.#fetch(`${baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          body: JSON.stringify({
            model: "hermes",
            stream: true,
            messages: [{ role: "user", content: userText }],
          }),
          signal: abortController.signal,
        })
      } catch (err) {
        if (!closed) {
          pushFrame({
            t: "error",
            code: "fetch-failed",
            message: err instanceof Error ? err.message : String(err),
          })
          drainClose()
        }
        return
      }

      if (!res.ok) {
        if (!closed) {
          pushFrame({
            t: "error",
            code: `http-${res.status}`,
            message: `POST /v1/chat/completions returned ${res.status}`,
          })
          drainClose()
        }
        return
      }

      // Parse the SSE stream line-by-line
      const body = res.body
      if (!body) {
        drainClose()
        return
      }

      const reader = body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split("\n")
          buffer = lines.pop() ?? ""

          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed || trimmed.startsWith(":")) continue // empty or SSE comment

            if (trimmed.startsWith("data:")) {
              const data = trimmed.slice(5).trim()

              // [DONE] sentinel — stream is complete
              if (data === "[DONE]") {
                if (!closed && !doneEmitted) {
                  doneEmitted = true
                  pushFrame({ t: "done", messageId: currentMessageId })
                }
                drainClose()
                reader.cancel().catch(() => { /* ignore */ })
                return
              }

              // Parse OpenAI delta chunk
              let chunk: OpenAIChunk
              try {
                chunk = JSON.parse(data) as OpenAIChunk
              } catch {
                continue // skip malformed JSON
              }

              const choice = chunk.choices?.[0]
              if (!choice) continue

              const deltaText = choice.delta.content
              if (deltaText) {
                if (!closed) {
                  pushFrame({ t: "delta", messageId: currentMessageId, text: deltaText })
                }
              }

              // finish_reason present on the final chunk (before [DONE])
              if (choice.finish_reason && !closed && !doneEmitted) {
                doneEmitted = true
                pushFrame({ t: "done", messageId: currentMessageId, stopReason: choice.finish_reason })
              }
            }
          }
        }
      // Process any residual buffer (handles final line without trailing newline)
      const residual = buffer.trim()
      if (residual) {
        if (residual.startsWith("data:")) {
          const data = residual.slice(5).trim()
          if (data === "[DONE]") {
            if (!closed && !doneEmitted) {
              doneEmitted = true
              pushFrame({ t: "done", messageId: currentMessageId })
            }
            drainClose()
            reader.cancel().catch(() => { /* ignore */ })
            return
          }
          let chunk: OpenAIChunk
          try {
            chunk = JSON.parse(data) as OpenAIChunk
          } catch {
            chunk = { choices: [] }
          }
          const choice = chunk.choices?.[0]
          if (choice) {
            const deltaText = choice.delta.content
            if (deltaText && !closed) {
              pushFrame({ t: "delta", messageId: currentMessageId, text: deltaText })
            }
            if (choice.finish_reason && !closed && !doneEmitted) {
              doneEmitted = true
              pushFrame({ t: "done", messageId: currentMessageId, stopReason: choice.finish_reason })
            }
          }
        }
      }
      } catch (err) {
        if (!closed && !(err instanceof DOMException && err.name === "AbortError")) {
          pushFrame({
            t: "error",
            code: "stream-error",
            message: err instanceof Error ? err.message : String(err),
          })
        }
      } finally {
        reader.releaseLock()
        if (!closed) {
          drainClose()
        }
      }
    }

    const adapter = this

    const session: ChatSession = {
      threadId,
      messages,
      async send(input: ChatInput): Promise<void> {
        if (adapter.#disposed || closed) {
          throw new Error("Cannot send: session is closed")
        }
        if (turnInFlight) {
          throw new Error("Cannot send: a turn is already in flight for this session (one-turn-at-a-time)")
        }
        turnInFlight = true
        startStream(input.text).catch(() => { /* errors pushed as error frames */ }).finally(() => {
          turnInFlight = false
        })
      },
      async stop(): Promise<void> {
        abortController.abort()
      },
      close(): void {
        abortController.abort()
        drainClose()
        adapter.#sessionAborts.delete(sessionId)
        adapter.#sessionDrains.delete(sessionId)
      },
    }

    return session
  }

  async dispose(): Promise<void> {
    this.#disposed = true

    // Abort all in-flight SSE fetches
    for (const [, ctrl] of this.#sessionAborts) {
      ctrl.abort()
    }
    this.#sessionAborts.clear()

    for (const [, drain] of this.#sessionDrains) {
      drain()
    }
    this.#sessionDrains.clear()

    // Close broadcast channels
    this.#descriptorBroadcast.close()
    this.#connectionBroadcast.close()
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  #baseUrl(): string {
    const endpoint = this.#route.endpoints[0]
    if (!endpoint) {
      throw new Error(`HermesHttpSseAdapter(${this.routeKey}): no endpoints configured`)
    }
    // Strip trailing slash for consistent URL construction
    return endpoint.replace(/\/$/, "")
  }
}
