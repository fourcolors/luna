import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { WebSocketServer } from "ws"
import WebSocket from "ws"
import type { ServerDescriptor } from "../src/contract.js"
import { LunaWsAdapter } from "../src/adapters/luna-ws.js"
import type { WsFactory } from "../src/adapters/luna-ws.js"

// ── Test server helpers ────────────────────────────────────────────────────

function makeTestDescriptor(
  overrides?: Partial<ServerDescriptor["identity"]>,
): ServerDescriptor {
  return {
    descriptorSchema: 1,
    generation: 1,
    issuedAt: new Date().toISOString(),
    negotiation: { agreed: 2 },
    identity: {
      name: "test-server",
      kind: "luna-chat-server",
      version: "0.0.1-test",
      ...overrides,
    },
    runtimeSummary: { category: "host-process", live: true },
    capabilities: [
      { operation: "interact", available: true, authz: { allowed: true } },
    ],
    health: { status: "normal", credentialOk: true },
  }
}

interface TestServer {
  url: string
  close(): Promise<void>
}

async function startTestServer(opts: {
  token: string
  sendDescriptor?: boolean
  rejectAuth?: boolean
  /** If true, accepts WS connection but never sends hello (for timeout test). */
  silentConnect?: boolean
  /** If set, the server handles new-thread and responds with thread-created. */
  handleNewThread?: boolean
}): Promise<TestServer> {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ port: 0 })
    wss.on("error", reject)
    wss.on("listening", () => {
      const addr = wss.address()
      const port = typeof addr === "object" && addr ? addr.port : 0


      wss.on("connection", (ws, req) => {
        if (opts.rejectAuth) {
          ws.close(1008, "Unauthorized")
          return
        }

        // Silent connect: accept the connection but never send hello.
        if (opts.silentConnect) {
          return
        }

        // Extract token from query string or Authorization header
        const rawUrl = req.url ?? ""
        const tokenMatch = rawUrl.match(/[?&]token=([^&]*)/)
        const queryToken = tokenMatch ? decodeURIComponent(tokenMatch[1] ?? "") : ""
        const authHeader = req.headers.authorization ?? ""
        const bearerToken = authHeader.startsWith("Bearer ")
          ? authHeader.slice("Bearer ".length)
          : ""
        const token = bearerToken || queryToken

        if (token !== opts.token) {
          ws.close(1008, "Unauthorized")
          return
        }

        const hello: Record<string, unknown> = {
          type: "hello",
          protocolVersion: 2,
          kinds: [],
          capabilities: {
            chat: true,
            streamingDeltas: true,
            localShell: false,
            setup: false,
            turnComplete: true,
          },
        }
        if (opts.sendDescriptor !== false) {
          hello.descriptor = makeTestDescriptor()
        }
        ws.send(JSON.stringify(hello))

        // Handle new-thread protocol if requested.
        if (opts.handleNewThread) {
          ws.on("message", (data) => {
            let frame: Record<string, unknown>
            try {
              frame = JSON.parse(String(data)) as Record<string, unknown>
            } catch { return }

            if (frame["type"] === "new-thread") {
              // Send back a thread-created response.
              const threadCreated = {
                type: "thread-created",
                thread: {
                  id: "thread-abc",
                  parentId: null,
                  title: null,
                  tags: [],
                  createdAt: Date.now(),
                  endedAt: null,
                  model: "claude-sonnet-4-5",
                  status: "active",
                  lastMessageAt: null,
                  lastMessageExcerpt: null,
                },
              }
              ws.send(JSON.stringify(threadCreated))

              // Also send a thread-snapshot so the subscription is primed.
              setTimeout(() => {
                const snapshot = {
                  type: "thread-snapshot",
                  threadId: "thread-abc",
                  throughSeq: 0,
                  messages: [],
                }
                if (ws.readyState === ws.OPEN) {
                  ws.send(JSON.stringify(snapshot))
                }
              }, 10)
            }
          })
        }
      })

      resolve({
        url: `ws://127.0.0.1:${port}/ui`,
        close: () =>
          // Close with a 500ms timeout to avoid hanging if underlying HTTP
          // server keeps-alive prevent immediate shutdown.
          Promise.race([
            new Promise<void>((res, rej) => wss.close((e) => (e ? rej(e) : res()))),
            new Promise<void>((res) => setTimeout(res, 500)),
          ]),
      })
    })
  })
}

/** Node-compatible wsFactory that uses the `ws` package (supports headers). */
function makeNodeWsFactory(): WsFactory {
  return (url, options) => {
    const ws = new WebSocket(url, { headers: options?.headers ?? {} })
    return ws as unknown as globalThis.WebSocket
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("LunaWsAdapter", () => {
  let server: TestServer | undefined
  const TOKEN = "test-token-abc"

  afterEach(async () => {
    if (server) {
      await server.close()
      server = undefined
    }
  })

  describe("attach() — server sends descriptor", () => {
    beforeEach(async () => {
      server = await startTestServer({ token: TOKEN, sendDescriptor: true })
    })

    it("resolves with origin=server-emitted and correct identity.kind", async () => {
      const adapter = new LunaWsAdapter(
        {
          routeKey: "test-route",
          endpoints: [server.url],
          tokenRef: TOKEN,
        },
        makeNodeWsFactory(),
      )

      const result = await adapter.attach()
      expect(result.origin).toBe("server-emitted")
      expect(result.descriptor.identity.kind).toBe("luna-chat-server")
      expect(result.descriptor.descriptorSchema).toBe(1)

      await adapter.dispose()
    })

    it("describe() returns same result without re-connecting", async () => {
      const adapter = new LunaWsAdapter(
        { routeKey: "test-route", endpoints: [server.url], tokenRef: TOKEN },
        makeNodeWsFactory(),
      )

      const r1 = await adapter.attach()
      const r2 = await adapter.describe()
      expect(r1).toBe(r2) // same reference

      await adapter.dispose()
    })
  })

  describe("attach() — legacy server (no descriptor)", () => {
    beforeEach(async () => {
      server = await startTestServer({ token: TOKEN, sendDescriptor: false })
    })

    it("synthesizes a descriptor with origin=synthesized-legacy", async () => {
      const adapter = new LunaWsAdapter(
        { routeKey: "legacy-route", endpoints: [server.url], tokenRef: TOKEN },
        makeNodeWsFactory(),
      )

      const result = await adapter.attach()
      expect(result.origin).toBe("synthesized-legacy")
      expect(result.descriptor.identity.kind).toBe("unknown")
      expect(result.descriptor.identity.synthesized).toBe(true)
      expect(result.descriptor.identity.name).toBe("legacy-route")

      await adapter.dispose()
    })
  })

  describe("connection states", () => {
    beforeEach(async () => {
      server = await startTestServer({ token: TOKEN, sendDescriptor: true })
    })

    it("emits connecting then ready states during attach", async () => {
      const adapter = new LunaWsAdapter(
        { routeKey: "state-test", endpoints: [server.url], tokenRef: TOKEN },
        makeNodeWsFactory(),
      )

      const states: string[] = []
      const iter = adapter.connection[Symbol.asyncIterator]()

      // Start attach in parallel with collecting states
      const attachPromise = adapter.attach()

      // Collect two states (connecting, ready)
      const s1 = await iter.next()
      states.push(s1.value.status)
      const s2 = await iter.next()
      states.push(s2.value.status)

      await attachPromise

      expect(states).toContain("connecting")
      expect(states).toContain("ready")

      await adapter.dispose()
    })
  })

  describe("dispose()", () => {
    beforeEach(async () => {
      server = await startTestServer({ token: TOKEN, sendDescriptor: true })
    })

    it("closes the connection cleanly", async () => {
      const adapter = new LunaWsAdapter(
        { routeKey: "dispose-test", endpoints: [server.url], tokenRef: TOKEN },
        makeNodeWsFactory(),
      )

      await adapter.attach()
      // Should not throw
      await expect(adapter.dispose()).resolves.toBeUndefined()
    })

    it("throws if attach is called after dispose", async () => {
      const adapter = new LunaWsAdapter(
        { routeKey: "disposed-route", endpoints: [server.url], tokenRef: TOKEN },
        makeNodeWsFactory(),
      )

      await adapter.dispose()
      await expect(adapter.attach()).rejects.toThrow("disposed")
    })
  })

  describe("selectAdapter factory", () => {
    it("returns LunaWsAdapter for ws:// endpoints", async () => {
      const { selectAdapter } = await import("../src/factory.js")
      const adapter = selectAdapter({
        routeKey: "ws-route",
        endpoints: ["ws://localhost:4753/ui"],
        tokenRef: "tok",
      })
      expect(adapter.transportKind).toBe("luna-ws")
      await adapter.dispose()
    })

    it("returns LunaWsAdapter for wss:// endpoints", async () => {
      const { selectAdapter } = await import("../src/factory.js")
      const adapter = selectAdapter({
        routeKey: "wss-route",
        endpoints: ["wss://example.com/ui"],
        tokenRef: "tok",
      })
      expect(adapter.transportKind).toBe("luna-ws")
      await adapter.dispose()
    })

    it("throws for http:// endpoints (Chunk 3)", async () => {
      const { selectAdapter } = await import("../src/factory.js")
      expect(() =>
        selectAdapter({
          routeKey: "http-route",
          endpoints: ["http://localhost:8642/v1/chat"],
          tokenRef: "tok",
        }),
      ).toThrow("hermes-http-sse adapter not yet implemented")
    })
  })

  // ── Adversarial cases ──────────────────────────────────────────────────

  describe("adversarial cases", () => {
    it("handshake-timeout: rejects when server never sends hello", async () => {
      server = await startTestServer({ token: TOKEN, silentConnect: true })

      // Use a very short timeout (50ms) so the test runs fast with real timers.
      const adapter = new LunaWsAdapter(
        { routeKey: "timeout-test", endpoints: [server.url], tokenRef: TOKEN },
        makeNodeWsFactory(),
        50, // handshakeTimeoutMs — injected for test speed
      )

      const states: string[] = []
      const connIter = adapter.connection[Symbol.asyncIterator]()

      // Collect states concurrently so we don't miss any (last-value-wins
      // means we must consume each value before the next publish overwrites it).
      const stateCollection = (async () => {
        for await (const s of { [Symbol.asyncIterator]: () => connIter }) {
          states.push(s.status)
          // Stop after handshake-timeout (the terminal state before dispose).
          if (s.status === "handshake-timeout") break
        }
      })()

      // Kick off attach (will reject after 50ms when no hello arrives).
      const attachPromise = adapter.attach()

      // attach() must reject with handshake-timeout.
      await expect(attachPromise).rejects.toThrow("handshake timeout after 10s")

      await stateCollection

      expect(states).toContain("connecting")
      expect(states).toContain("handshake-timeout")

      // Clean up (socket already closed by timeout path, dispose is safe).
      await adapter.dispose()
    }, 5_000)

    it("close-before-hello: attach rejects and connection emits a failure state", async () => {
      server = await startTestServer({ token: TOKEN, rejectAuth: true })

      const adapter = new LunaWsAdapter(
        { routeKey: "auth-fail-test", endpoints: [server.url], tokenRef: TOKEN },
        makeNodeWsFactory(),
      )

      const states: string[] = []
      const connIter = adapter.connection[Symbol.asyncIterator]()

      // Start collecting states before attach so we don't miss connecting.
      const stateCollection = (async () => {
        for await (const s of { [Symbol.asyncIterator]: () => connIter }) {
          states.push(s.status)
          // auth-failed (code=1008) or down (code=1006 in some runtimes): both valid
          if (s.status === "auth-failed" || s.status === "down") break
        }
      })()

      await expect(adapter.attach()).rejects.toThrow()

      await stateCollection

      // attach() must reject and emit a terminal failure state before hello.
      // The exact status depends on runtime WS stack: "auth-failed" when the
      // close code 1008 is preserved, "down" when normalised to 1006.
      expect(states).toContain("connecting")
      const hasFailureState = states.some((s) => s === "auth-failed" || s === "down")
      expect(hasFailureState).toBe(true)
      // Must not be stuck in "connecting" or "ready" after failure.
      expect(states.at(-1)).not.toBe("connecting")
      expect(states.at(-1)).not.toBe("ready")

      await adapter.dispose()
    })

    it("dispose-mid-stream: in-flight for-await on connection terminates cleanly", async () => {
      server = await startTestServer({ token: TOKEN, sendDescriptor: true })

      const adapter = new LunaWsAdapter(
        { routeKey: "dispose-stream-test", endpoints: [server.url], tokenRef: TOKEN },
        makeNodeWsFactory(),
      )

      await adapter.attach()

      let loopDone = false
      const loopPromise = (async () => {
        // Consume one state then loop forever waiting for more.
        for await (const _s of adapter.connection) {
          // Just keep consuming — the loop should terminate when disposed.
        }
        loopDone = true
      })()

      // Give the loop a tick to enter the iterator.
      await new Promise((r) => setTimeout(r, 10))

      // Dispose should cause the for-await to terminate.
      await adapter.dispose()

      // Wait up to 2s for the loop to exit.
      await Promise.race([
        loopPromise,
        new Promise<void>((_, rej) =>
          setTimeout(() => rej(new Error("for-await loop did not terminate within 2s")), 2000),
        ),
      ])

      expect(loopDone).toBe(true)
    })

    it("multi-consumer fan-out: both connection iterators receive the same states", async () => {
      server = await startTestServer({ token: TOKEN, sendDescriptor: true })

      const adapter = new LunaWsAdapter(
        { routeKey: "fanout-test", endpoints: [server.url], tokenRef: TOKEN },
        makeNodeWsFactory(),
      )

      // Create two independent iterators BEFORE attach so they both see "connecting".
      const iter1 = adapter.connection[Symbol.asyncIterator]()
      const iter2 = adapter.connection[Symbol.asyncIterator]()

      // Start attach to trigger state emission.
      const attachPromise = adapter.attach()

      // Both consumers should receive the "connecting" state.
      const [r1, r2] = await Promise.all([iter1.next(), iter2.next()])

      expect(r1.value.status).toBe("connecting")
      expect(r2.value.status).toBe("connecting")

      await attachPromise

      // Both should also see "ready".
      const [r3, r4] = await Promise.all([iter1.next(), iter2.next()])
      expect(r3.value.status).toBe("ready")
      expect(r4.value.status).toBe("ready")

      await adapter.dispose()
    })

    it("openSession new-thread: sends new-thread, gets real threadId from server", async () => {
      server = await startTestServer({
        token: TOKEN,
        sendDescriptor: true,
        handleNewThread: true,
      })

      const adapter = new LunaWsAdapter(
        { routeKey: "new-thread-test", endpoints: [server.url], tokenRef: TOKEN },
        makeNodeWsFactory(),
      )

      await adapter.attach()

      // openSession with no threadId must use new-thread protocol.
      const session = await adapter.openSession({})

      // The session must have the threadId returned by the server, not "new".
      expect(session.threadId).toBe("thread-abc")
      expect(session.threadId).not.toBe("new")

      session.close()
      await adapter.dispose()
    })
  })
})
