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
import { afterAll, afterEach, describe, expect, it } from "vitest"
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
const obsJsonlPath = join(
  tmpdir(),
  `luna-ui-ws-chat-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
)

afterAll(() => {
  try { unlinkSync(obsJsonlPath) } catch { /* ignore */ }
})

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
    applyFlagSettings: async () => {},
    setMaxThinkingTokens: async () => {},
    supplyToolPermissionResponse: async () => {},
    mcpServerStatus: async () => ({}),
  } as Partial<Query>) as Query
}

// ── runtime wiring ──────────────────────────────────────────────────────

// No-op MemoryRouter: chat routing tests never exercise searchMemory; they
// just need the MemoryRouterTag to be present in the layer graph because
// ChatService.Default requires it.
const noopMemoryRouter: MemoryRouter = {
  search: () => Stream.empty as ReturnType<MemoryRouter["search"]>,
  put: () => Effect.die("noopMemoryRouter.put"),
  get: () => Effect.die("noopMemoryRouter.get"),
  query: () => Stream.die("noopMemoryRouter.query"),
  delete: () => Effect.die("noopMemoryRouter.delete"),
  backendFor: () => { throw new Error("noopMemoryRouter.backendFor") },
  exportAll: () => Effect.die("noopMemoryRouter.exportAll"),
}

const baseLayer = (() => {
  const clockL = CoreClock.Test(1_700_000_000_000)
  const obsL = ObservabilityService.makeLayer({
    logToConsole: false,
    jsonlPath: obsJsonlPath,
  }).pipe(
    Layer.provide(clockL),
  )
  const telemetryL = TelemetryService.makeLayer().pipe(
    Layer.provide(clockL),
  )
  const uiL = UIService.makeLayer().pipe(
    Layer.provide(obsL),
    Layer.provide(clockL),
  )
  const storeL = SessionStore.Default
  const memoryL = Layer.succeed(MemoryRouterTag, noopMemoryRouter)
  return Layer.mergeAll(uiL, obsL, telemetryL, clockL, storeL, memoryL)
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
class ServerHandle extends Context.Service<
  ServerHandle,
  { readonly port: number; readonly host: string }
>()("test/ChatServerHandle") {}

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
  // Optional early-resolve predicate. When provided, the sequence resolves as
  // soon as a frame matches it (after all steps have fired), independent of the
  // exact frame count - robust when a driven turn emits a variable number of
  // interleaved obs frames.
  resolveWhen?: (f: ServerFrame, all: ReadonlyArray<ServerFrame>) => boolean,
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

        const done =
          resolveWhen !== undefined
            ? stepIdx >= steps.length && out.some((f) => resolveWhen(f, out))
            : out.length >= totalFrames
        if (done) {
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
  }, 15_000) // Bun #14946: httpServer.close(cb) may delay after WS upgrades; allow extra time

  it("hello frame advertises chat capabilities when ChatService is bound", async () => {
    rig = await startChatRig()
    const frames = await collectFrames(rig.url, 1)
    expect(frames[0]?.type).toBe("hello")
    if (frames[0]?.type === "hello") {
      expect(frames[0].capabilities.chat).toBe(true)
      expect(frames[0].capabilities.streamingDeltas).toBe(true)
      // setup-mode is OFF when a chat service is bound (chat !== null).
      expect(frames[0].capabilities.setup).toBe(false)
      // turn-complete is emitted whenever chat is bound (gates the moon's
      // grouped activity timeline on older-server fallback).
      expect(frames[0].capabilities.turnComplete).toBe(true)
      // subagents: chat threads expose the SDK Task tool and tool frames may
      // carry the additive parentToolUseId linkage.
      expect(frames[0].capabilities.subagents).toBe(true)
    }
  })

  it("new-thread → thread-created → snapshot follows (auto-subscribe)", async () => {
    rig = await startChatRig()
    const allFrames = await driveSequence(
      rig.url,
      [
        {
          waitFor: (f) => f.type === "hello",
          thenSend: () => [
            { type: "new-thread", model: "claude-test", title: "t1" },
          ],
        },
      ],
      // hello + thread-created + thread-snapshot + possible SessionStart obs event
      4,
    )
    // Filter out obs `event` frames — they can interleave with chat frames
    // now that ChatService emits SessionStart on createThread.
    const frames = allFrames.filter((f) => f.type !== "event" && f.type !== "smart-bar")
    expect(frames.map((f) => f.type)).toEqual([
      "hello",
      "thread-created",
      "thread-snapshot",
    ])
    const snap = frames.find((f) => f.type === "thread-snapshot")
    if (snap?.type === "thread-snapshot") {
      expect(snap.messages).toHaveLength(0)
      expect(snap.throughSeq).toBe(-1)
    }
  })

  it("user-message round-trip emits user-accepted then assistant-done", async () => {
    rig = await startChatRig((t) => `echo:${t}`)
    const allFrames = await driveSequence(
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
      // hello + thread-created + thread-snapshot + user-accepted + assistant-done
      // + up to 3 obs event frames (SessionStart, CostAccrued, SessionEnd)
      8,
    )
    // Filter out obs `event` frames — they interleave with chat frames now
    // that ChatService emits SessionStart/CostAccrued/SessionEnd.
    const frames = allFrames.filter((f) => f.type !== "event" && f.type !== "smart-bar")
    expect(frames.map((f) => f.type)).toEqual([
      "hello",
      "thread-created",
      "thread-snapshot",
      "user-accepted",
      "assistant-done",
      "turn-complete",
    ])
    const done = frames.find((f) => f.type === "assistant-done")
    if (done?.type === "assistant-done") {
      // Round-tripped through fake responseFor.
      // The projected ChatMessage carries the assistant text as
      // .text; assert the echo prefix is present.
      expect(done.message.text.startsWith("echo:")).toBe(true)
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
          // A thread is not a real conversation (and stays out of the sidebar
          // list) until the user types, so send a first user-message before
          // listing. The explicit "alpha" title still wins over any derived one.
          waitFor: (f) => f.type === "thread-snapshot",
          thenSend: (snap) => {
            if (snap.type !== "thread-snapshot") return []
            return [{ type: "user-message", threadId: snap.threadId, text: "hi" }]
          },
        },
        {
          // user-accepted is published only after the user message is persisted
          // to the SessionStore, so by now the thread has a top-level user
          // message and will survive the sidebar's empty-thread filter.
          waitFor: (f) => f.type === "user-accepted",
          thenSend: () => [{ type: "list-threads" }],
        },
      ],
      // Frame count is not deterministic (a driven turn interleaves obs frames),
      // so resolve as soon as the thread-list frame arrives.
      64,
      5000,
      (f) => f.type === "thread-list",
    )
    // thread-list can arrive amid obs `event` frames — search by type.
    const list = frames.find((f) => f.type === "thread-list")
    expect(list).toBeDefined()
    if (list?.type === "thread-list") {
      expect(list.threads.length).toBeGreaterThanOrEqual(1)
      expect(list.threads.some((t) => t.title === "alpha")).toBe(true)
    }
  })

  it("user-message to unknown thread surfaces assistant-error kind:'unknown-thread'", async () => {
    rig = await startChatRig()
    // ChatService emits a ChatUnknownThread obs event on the same path as
    // the wire assistant-error; take enough frames that the error is present
    // even when the obs `event` wins the race for slot 1.
    const frames = await collectFrames(
      rig.url,
      3, // hello + (event | assistant-error) + the other
      [
        { type: "user-message", threadId: "thr_does_not_exist", text: "hi" },
      ],
    )
    expect(frames[0]?.type).toBe("hello")
    const err = frames.find((f) => f.type === "assistant-error")
    expect(err).toBeDefined()
    if (err?.type === "assistant-error") {
      expect(err.error.kind).toBe("unknown-thread")
      expect(err.threadId).toBe("thr_does_not_exist")
    }
  })

  it("re-subscribe without unsubscribe re-emits a thread-snapshot (Moon switcher A→B→A)", async () => {
    // Moon never unsubscribes on thread switch. The live fiber stays in the
    // map, so a pure no-op re-subscribe left the client with a cleared
    // transcript and no snapshot. Re-entry must re-paint.
    rig = await startChatRig()
    let threadA = ""
    let threadB = ""
    const frames = await driveSequence(
      rig.url,
      [
        {
          waitFor: (f) => f.type === "hello",
          thenSend: () => [{ type: "new-thread", model: "claude-test" }],
        },
        {
          waitFor: (f) => f.type === "thread-snapshot",
          thenSend: (snap, all) => {
            if (snap.type !== "thread-snapshot") return []
            const created = all.find((x) => x.type === "thread-created")
            if (created?.type !== "thread-created") return []
            threadA = created.thread.id
            return [{ type: "new-thread", model: "claude-test" }]
          },
        },
        {
          waitFor: (f, all) =>
            f.type === "thread-snapshot" &&
            all.filter((x) => x.type === "thread-snapshot").length >= 2,
          thenSend: (_snap, all) => {
            const created = all
              .filter((x) => x.type === "thread-created")
              .at(-1)
            if (created?.type !== "thread-created") return []
            threadB = created.thread.id
            // Re-enter A without unsubscribe — the switcher path.
            return [{ type: "subscribe", threadId: threadA }]
          },
        },
        {
          waitFor: (f, all) =>
            f.type === "thread-snapshot" &&
            f.threadId === threadA &&
            all.filter(
              (x) => x.type === "thread-snapshot" && x.threadId === threadA,
            ).length >= 2,
          thenSend: () => [],
        },
      ],
      // hello + 2×thread-created + 3×thread-snapshot (+ optional obs events)
      10,
      8000,
    )
    const chatFrames = frames.filter((f) => f.type !== "event")
    const snapsA = chatFrames.filter(
      (f) => f.type === "thread-snapshot" && f.threadId === threadA,
    )
    const snapsB = chatFrames.filter(
      (f) => f.type === "thread-snapshot" && f.threadId === threadB,
    )
    expect(snapsA.length).toBeGreaterThanOrEqual(2)
    expect(snapsB.length).toBeGreaterThanOrEqual(1)
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
      // hello + thread-created + snapshot1 + snapshot2 + user-accepted + assistant-done
      // + up to 3 obs `event` frames (SessionStart, CostAccrued, SessionEnd)
      9,
      8000,
    )
    // Filter obs event frames before asserting — they interleave with chat frames.
    const types = frames.filter((f) => f.type !== "event").map((f) => f.type)
    expect(types.filter((t) => t === "thread-snapshot").length).toBe(2)
    expect(types).toContain("user-accepted")
    expect(types).toContain("assistant-done")
  })

  it("new-thread systemPrompt round-trip: systemPrompt reaches SDK options", async () => {
    // Build a rig that captures the QueryParams the fake SDK receives.
    // This tests the §2.3 dead-letter path: new-thread → createThread →
    // buildSessionOptions → sdkOptions.systemPrompt → adapter.query → SDKClient.
    let capturedOptions: Record<string, unknown> | undefined
    const fakeLayer = SDKClient.fake((p) => {
      capturedOptions = p.options as Record<string, unknown> | undefined
      return makeChatLoopQuery({
        prompt: p.prompt as AsyncIterable<SDKUserMessage>,
        sessionId: (p as { sessionId?: string }).sessionId ?? "thr-?",
        responseFor: (t) => `echo:${t}`,
      })
    })
    const baseChatLayer = fullLayer(fakeLayer)
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
    ).pipe(Layer.provide(baseChatLayer))
    const runtime = ManagedRuntime.make(Layer.mergeAll(serverLayer, baseChatLayer))
    const handle = await runtime.runPromise(ServerHandle)
    rig = {
      url: `ws://127.0.0.1:${handle.port}/ui`,
      shutdown: async () => { await runtime.dispose() },
    }

    // Send new-thread with systemPrompt; wait for thread-created to confirm
    // the SDK was invoked (the fake query is started lazily, so we also need
    // to trigger the first user turn to flush the adapter.query call).
    // However, createThread itself starts the SDK query eagerly via
    // adapter.query() — the fake build function runs at query() time, i.e.
    // before any user message. So thread-created is sufficient confirmation.
    await driveSequence(
      rig.url,
      [
        {
          waitFor: (f) => f.type === "hello",
          thenSend: () => [
            {
              type: "new-thread",
              model: "claude-test",
              systemPrompt: "Z-IDENTITY-Z",
            },
          ],
        },
        {
          waitFor: (f) => f.type === "thread-created",
          thenSend: () => [],
        },
      ],
      // hello + thread-created + thread-snapshot (minimum guaranteed set)
      3,
    )

    expect(capturedOptions?.systemPrompt).toBe("Z-IDENTITY-Z")
  })

  it("new-thread agent field: roster-validated (known files, unknown/no-roster drops)", async () => {
    // Agent sidebar S2: the `agent` field is client input and is validated
    // against the bound agentRoster before filing. Three cases through one
    // rig shape: known name → summary carries agentName; unknown name →
    // dropped; roster absent → dropped (fail-closed).
    const buildRig = async (withRoster: boolean) => {
      const fakeLayer = SDKClient.fake((p) =>
        makeChatLoopQuery({
          prompt: p.prompt as AsyncIterable<SDKUserMessage>,
          sessionId: (p as { sessionId?: string }).sessionId ?? "thr-?",
          responseFor: (t) => `echo:${t}`,
        }),
      )
      const baseChatLayer = fullLayer(fakeLayer)
      const serverLayer = Layer.effect(
        ServerHandle,
        Effect.gen(function* () {
          const chat = yield* ChatService
          return yield* startUIWebSocketServer({
            port: 0,
            token: TOKEN,
            pingIntervalMs: 0,
            chatService: chat,
            ...(withRoster
              ? {
                  agentRoster: {
                    list: () =>
                      Effect.succeed([{ name: "advisor", description: "d" }]),
                  },
                }
              : {}),
          })
        }),
      ).pipe(Layer.provide(baseChatLayer))
      const runtime = ManagedRuntime.make(Layer.mergeAll(serverLayer, baseChatLayer))
      const handle = await runtime.runPromise(ServerHandle)
      return {
        url: `ws://127.0.0.1:${handle.port}/ui`,
        shutdown: async () => { await runtime.dispose() },
      }
    }

    const createdAgent = async (
      rigUrl: string,
      agent: string,
    ): Promise<string | undefined> => {
      const frames = await driveSequence(
        rigUrl,
        [
          {
            waitFor: (f) => f.type === "hello",
            thenSend: () => [{ type: "new-thread", model: "claude-test", agent }],
          },
          { waitFor: (f) => f.type === "thread-created", thenSend: () => [] },
        ],
        3,
      )
      const created = frames.find((f) => f.type === "thread-created")
      return created?.type === "thread-created"
        ? created.thread.agentName
        : undefined
    }

    rig = await buildRig(true)
    expect(await createdAgent(rig.url, "advisor")).toBe("advisor")
    expect(await createdAgent(rig.url, "not-in-roster")).toBeUndefined()
    await rig.shutdown()

    rig = await buildRig(false)
    expect(await createdAgent(rig.url, "advisor")).toBeUndefined()
  })

  it("new-thread with effort field: effortSelection capability is true", async () => {
    // When ChatService is bound, effortSelection must be advertised as true
    // so clients know they can send set-thread-config frames.
    rig = await startChatRig()
    const frames = await collectFrames(rig.url, 1)
    expect(frames[0]?.type).toBe("hello")
    if (frames[0]?.type === "hello") {
      expect(frames[0].capabilities?.effortSelection).toBe(true)
    }
  })

  it("new-thread with effort field: thread-created frame reflects the thread id", async () => {
    // new-thread carries effort — the server must not drop the thread if
    // effort is present. Verify thread-created arrives cleanly.
    rig = await startChatRig()
    const allFrames = await driveSequence(
      rig.url,
      [
        {
          waitFor: (f) => f.type === "hello",
          thenSend: () => [
            {
              type: "new-thread",
              model: "claude-sonnet-4-6",
              effort: "high",
              title: "effort-thread",
            },
          ],
        },
      ],
      // hello + thread-created + thread-snapshot + possible obs event frames
      4,
    )
    const created = allFrames.find((f) => f.type === "thread-created")
    expect(created).toBeDefined()
    if (created?.type === "thread-created") {
      expect(typeof created.thread.id).toBe("string")
      expect(created.thread.id.length).toBeGreaterThan(0)
    }
  })

  it("new-thread haiku+max: the per-model clamp drops effort before it reaches SDK options", async () => {
    // Full-path proof of the defensive server clamp (plan §5): a stale or
    // hand-rolled client sends new-thread with model=haiku + effort=max.
    // haiku takes no effort parameter — chat-service's createThread clamp
    // must drop it, so the SDK options never carry an `effort` key.
    let capturedOptions: Record<string, unknown> | undefined
    const fakeLayer = SDKClient.fake((p) => {
      capturedOptions = p.options as Record<string, unknown> | undefined
      return makeChatLoopQuery({
        prompt: p.prompt as AsyncIterable<SDKUserMessage>,
        sessionId: (p as { sessionId?: string }).sessionId ?? "thr-?",
        responseFor: (t) => `echo:${t}`,
      })
    })
    const baseChatLayer = fullLayer(fakeLayer)
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
    ).pipe(Layer.provide(baseChatLayer))
    const runtime = ManagedRuntime.make(Layer.mergeAll(serverLayer, baseChatLayer))
    const handle = await runtime.runPromise(ServerHandle)
    rig = {
      url: `ws://127.0.0.1:${handle.port}/ui`,
      shutdown: async () => { await runtime.dispose() },
    }

    await driveSequence(
      rig.url,
      [
        {
          waitFor: (f) => f.type === "hello",
          thenSend: () => [
            {
              type: "new-thread",
              model: "claude-haiku-4-5",
              effort: "max",
            },
          ],
        },
        {
          waitFor: (f) => f.type === "thread-created",
          thenSend: () => [],
        },
      ],
      // hello + thread-created + thread-snapshot (minimum guaranteed set)
      3,
    )

    expect(capturedOptions).toBeDefined()
    // The model went through …
    expect(capturedOptions?.["model"]).toBe("claude-haiku-4-5")
    // … but the invalid effort was clamped out — the key must be ABSENT.
    expect(Object.prototype.hasOwnProperty.call(capturedOptions!, "effort")).toBe(false)
  })

  it("set-thread-config → thread-config ack is emitted", async () => {
    // Full round-trip: create a thread, then send set-thread-config with
    // effort=high. The server must respond with a thread-config frame
    // listing "effort" in applied.
    rig = await startChatRig()
    const allFrames = await driveSequence(
      rig.url,
      [
        {
          waitFor: (f) => f.type === "hello",
          thenSend: () => [
            { type: "new-thread", model: "claude-sonnet-4-6", title: "config-test" },
          ],
        },
        {
          // Wait for thread-snapshot (confirms auto-subscribe is ready).
          waitFor: (f) => f.type === "thread-snapshot",
          thenSend: (snap) => {
            if (snap.type !== "thread-snapshot") return []
            return [
              {
                type: "set-thread-config",
                threadId: snap.threadId,
                effort: "medium",
              },
            ]
          },
        },
      ],
      // hello + thread-created + thread-snapshot + thread-config + possible obs event
      5,
    )
    const configFrame = allFrames.find((f) => f.type === "thread-config")
    expect(configFrame).toBeDefined()
    if (configFrame?.type === "thread-config") {
      expect(configFrame.applied).toContain("effort")
      expect(configFrame.effort).toBe("medium")
    }
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
