/**
 * UIWebSocketServer idle-reap recovery E2E (owner bug repro).
 *
 * Reproduces the exact Luna Moon flow behind "⚠️ Error: unknown thread:
 * thr_…": a Moon window sits OPEN on a thread (WebSocket never drops, so
 * no re-subscribe fires), the idle reaper evicts the thread's runtime
 * after the quiet window, then the user types another message on the SAME
 * connection. The thread must transparently resume (ThreadRegistry Case A)
 * and — critically — the reply must still reach the ALREADY-SUBSCRIBED
 * client. Two historical failure modes are pinned here:
 *
 *   1. `send()` rejecting the evicted thread with "unknown thread"
 *      (fixed by ensureThreadLive, PR #242).
 *   2. The per-thread PubSub being recreated on recovery, orphaning the
 *      connection's pre-reap forwarder so user-accepted/assistant-done
 *      never arrive on the wire (the client hangs, no error, no reply).
 *
 * Wiring mirrors server.chat.test.ts (real ChatService over a fake SDK)
 * plus ThreadRegistryService.Memory (recovery needs the registry) and the
 * REAL wall clock: LUNA_CHAT_THREAD_IDLE_MS=1 makes any real elapsed
 * millisecond idle-eligible, so the test drives reapIdleThreadsOnce()
 * deterministically instead of waiting on the background sweep.
 */
import { afterEach, describe, expect, it } from "vitest"
import { Context, Effect, Layer, ManagedRuntime, Stream } from "effect"
import { MemoryRouterTag, type MemoryRouter } from "@luna/memory"
import { unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { WebSocket } from "ws"
import {
  Clock as CoreClock,
  ObservabilityService,
  SessionStore,
  TelemetryService,
  ThreadRegistryService,
  UIService,
} from "@luna/core"
import { SDKAdapter, SDKClient } from "@luna/adapter-sdk"
import { ChatService } from "@luna/chat-service"
import type {
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"
import { startUIWebSocketServer } from "../src/server.js"
import type { ClientFrame, ServerFrame } from "../src/protocol.js"

const TOKEN = "test-token-1234567890" // ≥16 chars
const SDK_SID = "sdk-reap-e2e-sid"

const obsJsonlPath = join(
  tmpdir(),
  `luna-ui-ws-reap-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
)

// Fake SDK message builders (same shapes as server.chat.test.ts).
const makeAssistantMessage = (
  sessionId: string,
  text: string,
  uuid: string,
): SDKMessage =>
  ({
    type: "assistant",
    session_id: sessionId,
    uuid,
    parent_tool_use_id: null,
    message: {
      id: uuid,
      role: "assistant",
      model: "claude-test",
      content: [{ type: "text", text }],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  }) as unknown as SDKMessage

const makeResultMessage = (sessionId: string, uuid: string): SDKMessage =>
  ({
    type: "result",
    subtype: "success",
    session_id: sessionId,
    uuid,
    is_error: false,
    duration_ms: 10,
    duration_api_ms: 5,
    num_turns: 1,
    result: "ok",
  }) as unknown as SDKMessage

const makeChatLoopQuery = (params: {
  readonly prompt: AsyncIterable<SDKUserMessage>
  readonly sessionId: string
  readonly responseFor: (userText: string) => string
}): Query => {
  let turnIdx = 0
  async function* gen(): AsyncGenerator<SDKMessage, void> {
    for await (const u of params.prompt) {
      turnIdx += 1
      const userText =
        typeof u.message.content === "string"
          ? u.message.content
          : "(structured)"
      yield makeAssistantMessage(
        params.sessionId,
        params.responseFor(userText),
        `assistant-${turnIdx}`,
      )
      yield makeResultMessage(params.sessionId, `result-${turnIdx}`)
    }
  }
  const it = gen()
  return Object.assign(it, {
    interrupt: async () => {},
    setPermissionMode: async () => {},
    setModel: async () => {},
    applyFlagSettings: async () => {},
    setMaxThinkingTokens: async () => {},
    supplyToolPermissionResponse: async () => {},
    mcpServerStatus: async () => ({}),
  } as Partial<Query>) as Query
}

const noopMemoryRouter: MemoryRouter = {
  search: () => Stream.empty as ReturnType<MemoryRouter["search"]>,
  put: () => Effect.die("noopMemoryRouter.put"),
  get: () => Effect.die("noopMemoryRouter.get"),
  query: () => Stream.die("noopMemoryRouter.query"),
  delete: () => Effect.die("noopMemoryRouter.delete"),
  backendFor: () => { throw new Error("noopMemoryRouter.backendFor") },
  exportAll: () => Effect.die("noopMemoryRouter.exportAll"),
}

class ServerHandle extends Context.Service<
  ServerHandle,
  { readonly port: number; readonly host: string }
>()("test/ReapChatServerHandle") {}

interface ReapRig {
  readonly url: string
  readonly runPromise: <A, E>(
    eff: Effect.Effect<A, E, ChatService | ThreadRegistryService | SessionStore>,
  ) => Promise<A>
  readonly shutdown: () => Promise<void>
}

/**
 * Boot the ws server over a real ChatService with ThreadRegistry wired and
 * a REAL clock (idle eligibility needs wall-time to advance past the 1ms
 * window). Returns a runPromise escape hatch bound to the SAME memoized
 * layer instances so the test can drive reapIdleThreadsOnce() and inspect
 * the registry server-side, exactly like an operator would.
 */
const startReapRig = async (params: {
  readonly responseFor: (text: string) => string
  readonly onQuery?: (opts: Record<string, unknown>) => void
}): Promise<ReapRig> => {
  const clockL = CoreClock.Default
  const obsL = ObservabilityService.makeLayer({
    logToConsole: false,
    jsonlPath: obsJsonlPath,
  }).pipe(Layer.provide(clockL))
  const telemetryL = TelemetryService.makeLayer().pipe(Layer.provide(clockL))
  const uiL = UIService.makeLayer().pipe(
    Layer.provide(obsL),
    Layer.provide(clockL),
  )
  const registryL = ThreadRegistryService.Memory.pipe(Layer.provide(clockL))
  const baseLayer = Layer.mergeAll(
    uiL,
    obsL,
    telemetryL,
    clockL,
    SessionStore.Default,
    Layer.succeed(MemoryRouterTag, noopMemoryRouter),
    registryL,
  )
  const fakeLayer = SDKClient.fake((p) => {
    params.onQuery?.((p.options ?? {}) as Record<string, unknown>)
    return makeChatLoopQuery({
      prompt: p.prompt as AsyncIterable<SDKUserMessage>,
      sessionId: SDK_SID,
      responseFor: params.responseFor,
    })
  })
  const chatLayer = Layer.mergeAll(
    Layer.provideMerge(
      ChatService.Default,
      Layer.provideMerge(SDKAdapter.Default, Layer.mergeAll(fakeLayer, baseLayer)),
    ),
    baseLayer,
  )
  const serverLayer = Layer.effect(
    ServerHandle,
    Effect.gen(function* () {
      const chat = yield* ChatService
      return yield* startUIWebSocketServer({
        port: 0,
        token: TOKEN,
        pingIntervalMs: 0,
        chatService: chat,
      })
    }),
  ).pipe(Layer.provide(chatLayer))

  const runtime = ManagedRuntime.make(Layer.mergeAll(serverLayer, chatLayer))
  const handle = await runtime.runPromise(ServerHandle)

  return {
    url: `ws://127.0.0.1:${handle.port}/ui`,
    runPromise: (eff) => runtime.runPromise(eff),
    shutdown: async () => {
      await runtime.dispose()
    },
  }
}

/**
 * Long-lived ws client: one connection for the whole scenario (the point of
 * the repro is that the SAME connection outlives the reap), with awaitable
 * frame predicates over the accumulated frame log.
 */
class WsClient {
  private readonly frames: ServerFrame[] = []
  private waiters: Array<{
    pred: (f: ServerFrame) => boolean
    resolve: (f: ServerFrame) => void
  }> = []
  private constructor(private readonly ws: WebSocket) {}

  static open(url: string): Promise<WsClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
      const client = new WsClient(ws)
      ws.on("open", () => resolve(client))
      ws.on("error", reject)
      ws.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as ServerFrame
        client.frames.push(frame)
        client.waiters = client.waiters.filter((w) => {
          if (!w.pred(frame)) return true
          w.resolve(frame)
          return false
        })
      })
    })
  }

  send(frame: ClientFrame): void {
    this.ws.send(JSON.stringify(frame))
  }

  /** Resolve with the first frame (past or future) matching pred. */
  waitFor(
    pred: (f: ServerFrame) => boolean,
    label: string,
    timeoutMs = 4000,
  ): Promise<ServerFrame> {
    const seen = this.frames.find(pred)
    if (seen) return Promise.resolve(seen)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== wrapped)
        reject(
          new Error(
            `timeout waiting for ${label}; frames seen: ${this.frames
              .map((f) => f.type)
              .join(", ")}`,
          ),
        )
      }, timeoutMs)
      const wrapped = (f: ServerFrame) => {
        clearTimeout(timer)
        resolve(f)
      }
      this.waiters.push({ pred, resolve: wrapped })
    })
  }

  /** All frames received so far (snapshot copy). */
  received(): ReadonlyArray<ServerFrame> {
    return [...this.frames]
  }

  close(): void {
    this.ws.close()
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("UIWebSocketServer — idle-reap recovery over a live connection", () => {
  let rig: ReapRig | undefined
  let client: WsClient | undefined

  afterEach(async () => {
    client?.close()
    client = undefined
    if (rig) await rig.shutdown()
    rig = undefined
    try { unlinkSync(obsJsonlPath) } catch { /* ignore */ }
  }, 15_000)

  it(
    "moon flow: thread reaped mid-connection resumes on next user-message and the reply reaches the pre-reap subscriber",
    async () => {
      const prevIdleMs = process.env["LUNA_CHAT_THREAD_IDLE_MS"]
      process.env["LUNA_CHAT_THREAD_IDLE_MS"] = "1"
      const queryOptions: Array<Record<string, unknown>> = []
      try {
        rig = await startReapRig({
          responseFor: (t) => `echo:${t}`,
          onQuery: (opts) => queryOptions.push(opts),
        })
      } finally {
        if (prevIdleMs === undefined) delete process.env["LUNA_CHAT_THREAD_IDLE_MS"]
        else process.env["LUNA_CHAT_THREAD_IDLE_MS"] = prevIdleMs
      }

      client = await WsClient.open(rig.url)
      await client.waitFor((f) => f.type === "hello", "hello")

      // Turn 1: create the thread and complete a normal round-trip. The
      // new-thread path auto-subscribes this connection (same as Moon).
      client.send({ type: "new-thread", model: "claude-test", title: "reap-e2e" })
      const created = await client.waitFor(
        (f) => f.type === "thread-created",
        "thread-created",
      )
      const threadId = created.type === "thread-created" ? created.thread.id : ""
      expect(threadId).not.toBe("")
      await client.waitFor((f) => f.type === "thread-snapshot", "thread-snapshot")

      client.send({ type: "user-message", threadId, text: "first" })
      await client.waitFor(
        (f) => f.type === "turn-complete" && f.threadId === threadId,
        "turn 1 turn-complete",
      )

      // The adapter reports the SDK session id from the first streamed
      // message; chat-service persists it to the registry via a forked
      // fiber. Poll until it lands — this is the real Case-A precondition.
      const registryRig = rig
      let sid: string | null = null
      for (let i = 0; i < 100 && sid === null; i++) {
        sid = await registryRig.runPromise(
          Effect.gen(function* () {
            const reg = yield* ThreadRegistryService
            const row = yield* reg.get(threadId)
            return row?.sdkSessionId ?? null
          }),
        )
        if (sid === null) await sleep(20)
      }
      expect(sid).toBe(SDK_SID)

      // Idle window (1ms) elapses; drive the reaper sweep exactly like the
      // background fiber would. The thread's runtime is now evicted while
      // the registry row (and this ws connection's subscription) remain.
      await sleep(10)
      const reaped = await registryRig.runPromise(
        Effect.gen(function* () {
          const chat = yield* ChatService
          return yield* chat.reapIdleThreadsOnce()
        }),
      )
      expect(reaped).toBeGreaterThanOrEqual(1)

      // Turn 2: the user comes back to the still-open window and types.
      // This must NOT produce assistant-error (kind "unknown-thread"), and
      // the recovered turn's frames must arrive on THIS connection.
      client.send({ type: "user-message", threadId, text: "after-idle" })
      await client.waitFor(
        (f) => f.type === "user-accepted" && f.threadId === threadId,
        "turn 2 user-accepted",
      )
      const done = await client.waitFor(
        (f) =>
          f.type === "assistant-done" &&
          f.threadId === threadId &&
          f.message.text === "echo:after-idle",
        "turn 2 assistant-done",
      )
      expect(done.type).toBe("assistant-done")

      // The owner's reported failure must not have occurred.
      const errors = client
        .received()
        .filter((f) => f.type === "assistant-error")
      expect(errors).toEqual([])

      // And the recovery went through the SDK resume path (Case A): the
      // second query carried the persisted session id as `resume`.
      const resumes = queryOptions
        .map((o) => o["resume"])
        .filter((r): r is string => typeof r === "string")
      expect(resumes).toContain(SDK_SID)
    },
    { timeout: 20_000 },
  )
})
