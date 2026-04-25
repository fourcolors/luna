/**
 * UIWebSocketServer chat-routing tests.
 *
 * Mounts a real ChatService (over a fake SDK that loops user→assistant)
 * into the ws server via `config.chatService` and exercises the wire
 * protocol end-to-end:
 *   - hello capabilities flip to `{ chat: true, streamingDeltas: true }`
 *   - new-thread → ThreadCreatedFrame, auto-subscribe, snapshot follows
 *   - user-message → user-accepted then assistant-done frames
 *   - list-threads → ThreadListFrame with the created session
 *   - user-message to unknown thread → AssistantErrorFrame kind:"unknown-thread"
 *   - subscribe to a known thread receives a thread-snapshot frame
 *
 * The chat-service.sim test covers ChatService internals; this file is
 * thin and only verifies the WS layer's frame mapping + routing.
 */
import { afterEach, describe, expect, it } from "vitest"
import {
  Effect,
  Layer,
  ManagedRuntime,
} from "effect"
import { WebSocket } from "ws"
import {
  Clock as CoreClock,
  ObservabilityService,
  SessionStore,
  UIService,
} from "@experiment-agent/core"
import { SDKAdapter, SDKClient } from "@experiment-agent/adapter-sdk"
import { ChatService } from "@experiment-agent/chat-service"
import type {
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"
import { startUIWebSocketServer } from "../src/server.js"
import type { ClientFrame, ServerFrame } from "../src/protocol.js"

const TOKEN = "test-token-1234567890" // ≥16 chars

// Fake SDK assistant/result message builders (same shapes as
// chat-service.sim.test.ts; duplicated because adapter-sdk doesn't
// export the fake helpers).
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
    setMaxThinkingTokens: async () => {},
    supplyToolPermissionResponse: async () => {},
    mcpServerStatus: async () => ({}),
  } as Partial<Query>) as Query
}

// ── runtime wiring ──────────────────────────────────────────────────────

const baseLayer = (() => {
  const clockL = CoreClock.Test(1_700_000_000_000)
  const obsL = ObservabilityService.makeLayer({ logToConsole: false }).pipe(
    Layer.provide(clockL),
  )
  const uiL = UIService.makeLayer().pipe(
    Layer.provide(obsL),
    Layer.provide(clockL),
  )
  const storeL = SessionStore.Default
  return Layer.mergeAll(uiL, obsL, clockL, storeL)
})()

const fullLayer = (fakeLayer: Layer.Layer<SDKClient>) =>
  Layer.mergeAll(
    Layer.provideMerge(
      ChatService.Default,
      Layer.provideMerge(
        SDKAdapter.Default,
        Layer.mergeAll(fakeLayer, baseLayer),
      ),
    ),
    baseLayer,
  )

interface ChatRig {
  readonly url: string
  readonly shutdown: () => Promise<void>
}

// Service tag for the running server handle, so we can compose the
// scoped server start as a Layer with the rest of the runtime — the
// Layer scope owns the server's lifetime, dispose() shuts it down.
class ServerHandle extends Effect.Tag("test/ChatServerHandle")<
  ServerHandle,
  { readonly port: number; readonly host: string }
>() {}

const startChatRig = async (
  responseFor: (text: string) => string = (t) => `echo:${t}`,
): Promise<ChatRig> => {
  const fakeLayer = SDKClient.fake((p) =>
    makeChatLoopQuery({
      prompt: p.prompt as AsyncIterable<SDKUserMessage>,
      sessionId: (p as { sessionId?: string }).sessionId ?? "thr-?",
      responseFor,
    }),
  )
  const baseChatLayer = fullLayer(fakeLayer)

  // Server layer reads ChatService from its env, then passes the
  // resolved handle to startUIWebSocketServer via config. This keeps
  // the server's own requirement set narrow (no ChatService dep on
  // the server effect itself).
  const serverLayer = Layer.scoped(
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
  ).pipe(Layer.provide(baseChatLayer))

  const runtime = ManagedRuntime.make(Layer.mergeAll(serverLayer, baseChatLayer))
  const handle = await runtime.runPromise(ServerHandle)

  return {
    url: `ws://127.0.0.1:${handle.port}/ui`,
    shutdown: async () => {
      await runtime.dispose()
    },
  }
}

// ── helpers ────────────────────────────────────────────────────────────

const collectFrames = (
  url: string,
  takeN: number,
  send: ReadonlyArray<ClientFrame> = [],
  sendAfterMs = 100,
  timeoutMs = 4000,
): Promise<ServerFrame[]> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    const out: ServerFrame[] = []
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error(`timeout: got ${out.length}/${takeN} frames`))
    }, timeoutMs)
    ws.on("open", () => {
      if (send.length > 0) {
        setTimeout(() => {
          for (const f of send) {
            if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(f))
          }
        }, sendAfterMs)
      }
    })
    ws.on("error", (err) => {
      clearTimeout(timer)
      reject(err)
    })
    ws.on("message", (raw) => {
      try {
        const frame = JSON.parse(raw.toString()) as ServerFrame
        out.push(frame)
        if (out.length >= takeN) {
          clearTimeout(timer)
          ws.close()
          resolve(out)
        }
      } catch (e) {
        clearTimeout(timer)
        reject(e)
      }
    })
  })

// Two-stage helper: open one ws, send a frame, wait for a server frame
// matching a predicate, then send the next batch. Used for "create
// thread, then send to its returned id".
const driveSequence = (
  url: string,
  steps: ReadonlyArray<{
    waitFor: (f: ServerFrame, all: ReadonlyArray<ServerFrame>) => boolean
    thenSend?: (
      lastMatching: ServerFrame,
      all: ReadonlyArray<ServerFrame>,
    ) => ReadonlyArray<ClientFrame>
  }>,
  totalFrames: number,
  timeoutMs = 5000,
): Promise<ServerFrame[]> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    const out: ServerFrame[] = []
    let stepIdx = 0
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error(`timeout at step ${stepIdx}, got ${out.length} frames`))
    }, timeoutMs)
    ws.on("error", (err) => {
      clearTimeout(timer)
      reject(err)
    })
    ws.on("message", (raw) => {
      try {
        const frame = JSON.parse(raw.toString()) as ServerFrame
        out.push(frame)

        while (stepIdx < steps.length) {
          const step = steps[stepIdx]!
          const match = out.find((f) => step.waitFor(f, out))
          if (!match) break
          stepIdx += 1
          const send = step.thenSend?.(match, out) ?? []
          for (const cf of send) {
            if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(cf))
          }
        }

        if (out.length >= totalFrames) {
          clearTimeout(timer)
          ws.close()
          resolve(out)
        }
      } catch (e) {
        clearTimeout(timer)
        reject(e)
      }
    })
  })

// ── tests ──────────────────────────────────────────────────────────────

describe("UIWebSocketServer (chat routing)", () => {
  let rig: ChatRig

  afterEach(async () => {
    if (rig) await rig.shutdown()
  })

  it("hello frame advertises chat capabilities when ChatService is bound", async () => {
    rig = await startChatRig()
    const frames = await collectFrames(rig.url, 1)
    expect(frames[0]?.type).toBe("hello")
    if (frames[0]?.type === "hello") {
      expect(frames[0].capabilities.chat).toBe(true)
      expect(frames[0].capabilities.streamingDeltas).toBe(true)
    }
  })

  it("new-thread → thread-created → snapshot follows (auto-subscribe)", async () => {
    rig = await startChatRig()
    const frames = await driveSequence(
      rig.url,
      [
        {
          waitFor: (f) => f.type === "hello",
          thenSend: () => [
            { type: "new-thread", model: "claude-test", title: "t1" },
          ],
        },
      ],
      3, // hello + thread-created + thread-snapshot
    )
    expect(frames.map((f) => f.type)).toEqual([
      "hello",
      "thread-created",
      "thread-snapshot",
    ])
    if (frames[2]?.type === "thread-snapshot") {
      expect(frames[2].messages).toHaveLength(0)
      expect(frames[2].throughSeq).toBe(-1)
    }
  })

  it("user-message round-trip emits user-accepted then assistant-done", async () => {
    rig = await startChatRig((t) => `echo:${t}`)
    const frames = await driveSequence(
      rig.url,
      [
        {
          waitFor: (f) => f.type === "hello",
          thenSend: () => [
            { type: "new-thread", model: "claude-test" },
          ],
        },
        {
          // Wait for the thread-snapshot (the auto-subscribe completion
          // signal — guarantees the per-thread forwarder is attached
          // before we send the user-message).
          waitFor: (f) => f.type === "thread-snapshot",
          thenSend: (snap) => {
            if (snap.type !== "thread-snapshot") return []
            return [
              { type: "user-message", threadId: snap.threadId, text: "hi" },
            ]
          },
        },
      ],
      5, // hello + thread-created + thread-snapshot + user-accepted + assistant-done
    )
    expect(frames.map((f) => f.type)).toEqual([
      "hello",
      "thread-created",
      "thread-snapshot",
      "user-accepted",
      "assistant-done",
    ])
    if (frames[4]?.type === "assistant-done") {
      // Round-tripped through fake responseFor.
      // The projected ChatMessage carries the assistant text as
      // .text; assert the echo prefix is present.
      expect(frames[4].message.text.startsWith("echo:")).toBe(true)
    }
  })

  it("list-threads returns the threads in a thread-list frame", async () => {
    rig = await startChatRig()
    const frames = await driveSequence(
      rig.url,
      [
        {
          waitFor: (f) => f.type === "hello",
          thenSend: () => [
            { type: "new-thread", model: "claude-test", title: "alpha" },
          ],
        },
        {
          waitFor: (f) => f.type === "thread-snapshot",
          thenSend: () => [{ type: "list-threads" }],
        },
      ],
      4, // hello + thread-created + thread-snapshot + thread-list
    )
    const list = frames.find((f) => f.type === "thread-list")
    expect(list).toBeDefined()
    if (list?.type === "thread-list") {
      expect(list.threads.length).toBeGreaterThanOrEqual(1)
      expect(list.threads.some((t) => t.title === "alpha")).toBe(true)
    }
  })

  it("user-message to unknown thread surfaces assistant-error kind:'unknown-thread'", async () => {
    rig = await startChatRig()
    const frames = await collectFrames(
      rig.url,
      2, // hello + assistant-error
      [
        { type: "user-message", threadId: "thr_does_not_exist", text: "hi" },
      ],
    )
    expect(frames[0]?.type).toBe("hello")
    expect(frames[1]?.type).toBe("assistant-error")
    if (frames[1]?.type === "assistant-error") {
      expect(frames[1].error.kind).toBe("unknown-thread")
      expect(frames[1].threadId).toBe("thr_does_not_exist")
    }
  })

  it("unsubscribe + resubscribe under the same threadId keeps the new forwarder alive", async () => {
    // Regression for the observer CAS bug: without identity-based delete,
    // the observer for fiber A (which completes when the client
    // unsubscribes) could evict fiber B (the post-resubscribe forwarder)
    // from the chatFibers map, leaving B unreachable for a subsequent
    // unsubscribe and silently leaking until ws close.
    rig = await startChatRig()
    const frames = await driveSequence(
      rig.url,
      [
        {
          waitFor: (f) => f.type === "hello",
          thenSend: () => [{ type: "new-thread", model: "claude-test" }],
        },
        {
          // First snapshot — auto-subscribe lifecycle. Now unsubscribe,
          // then immediately resubscribe.
          waitFor: (f) => f.type === "thread-snapshot",
          thenSend: (snap) => {
            if (snap.type !== "thread-snapshot") return []
            return [
              { type: "unsubscribe", threadId: snap.threadId },
              { type: "subscribe", threadId: snap.threadId },
            ]
          },
        },
        {
          // After resubscribe we expect a SECOND thread-snapshot. If the
          // CAS bug were present, the observer for the unsubscribed
          // fiber A could land between us installing fiber B and the
          // snapshot being sent, evicting B and leaving us with no
          // second snapshot — but B's fiber would have already pushed
          // the snapshot before being dropped from the map, so the
          // wire visible failure mode is actually with a third user-
          // message — exercise that to make the test bite.
          waitFor: (f, all) =>
            f.type === "thread-snapshot" &&
            all.filter((x) => x.type === "thread-snapshot").length >= 2,
          thenSend: (_snap, all) => {
            const created = all.find((x) => x.type === "thread-created")
            if (created?.type !== "thread-created") return []
            return [
              {
                type: "user-message",
                threadId: created.thread.id,
                text: "post-resub",
              },
            ]
          },
        },
      ],
      6, // hello + thread-created + snapshot1 + snapshot2 + user-accepted + assistant-done
    )
    const types = frames.map((f) => f.type)
    expect(types.filter((t) => t === "thread-snapshot").length).toBe(2)
    expect(types).toContain("user-accepted")
    expect(types).toContain("assistant-done")
  })

  it("malformed JSON inbound frame does not crash the connection", async () => {
    rig = await startChatRig()
    // Open ws, blast garbage, then send a valid list-threads — the
    // connection MUST stay alive and respond.
    const frames = await new Promise<ServerFrame[]>((resolve, reject) => {
      const ws = new WebSocket(rig.url, {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
      const out: ServerFrame[] = []
      const timer = setTimeout(() => {
        ws.close()
        reject(new Error(`timeout, got ${out.length} frames`))
      }, 3000)
      ws.on("open", () => {
        // Garbage.
        ws.send("not json {{{")
        // Unknown type.
        ws.send(JSON.stringify({ type: "no-such-frame" }))
        // Valid frame — connection should still be alive.
        setTimeout(() => {
          ws.send(JSON.stringify({ type: "list-threads" }))
        }, 50)
      })
      ws.on("error", (err) => {
        clearTimeout(timer)
        reject(err)
      })
      ws.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as ServerFrame
        out.push(frame)
        if (out.length >= 2) {
          clearTimeout(timer)
          ws.close()
          resolve(out)
        }
      })
    })
    expect(frames[0]?.type).toBe("hello")
    expect(frames[1]?.type).toBe("thread-list")
  })
})
