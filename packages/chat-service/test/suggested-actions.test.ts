/**
 * Suggested Actions ↔ ChatService integration (P3).
 *
 * Proves the frame-agnostic bridge: a mutation on the shared SuggestedActions
 * service (what the `suggest_action` tool and Dream call) surfaces as a
 * `suggested-action-update` ChatFrame on the OWNING thread's subscribe stream.
 *
 * Mirrors the harness in chat-service.sim.test.ts, with SuggestedActions
 * (+ Memory store) merged into the layer so ChatService's serviceOption wires
 * the changes-consumer.
 */
import { describe, expect, it } from "vitest"
import { Effect, Fiber, Layer, Scope, Stream } from "effect"
import {
  SessionStore,
  Clock as CoreClock,
  ObservabilityService,
  TelemetryService,
  SuggestedActions,
  SuggestedActionsStore,
} from "@luna/core"
import { SDKAdapter, SDKClient } from "@luna/adapter-sdk"
import { MemoryRouterTag, type MemoryRouter } from "@luna/memory"
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { ChatService, type ChatFrame } from "../src/index.js"

const noopMemoryRouter: MemoryRouter = {
  search: () => Stream.empty as ReturnType<MemoryRouter["search"]>,
  put: () => Effect.die("noop.put"),
  get: () => Effect.die("noop.get"),
  query: () => Stream.die("noop.query"),
  delete: () => Effect.die("noop.delete"),
  backendFor: () => { throw new Error("noop.backendFor") },
  exportAll: () => Effect.die("noop.exportAll"),
}

const testClock = CoreClock.Test(1_700_000_000_000)
const obsLayer = ObservabilityService.makeLayer({ logToConsole: false }).pipe(
  Layer.provide(testClock),
)
const telemetryLayer = TelemetryService.makeLayer().pipe(Layer.provide(testClock))

const baseLayer = Layer.mergeAll(
  SessionStore.Default,
  testClock,
  obsLayer,
  telemetryLayer,
  Layer.succeed(MemoryRouterTag, noopMemoryRouter),
)

// SuggestedActions (+ Memory store) provided so ChatService's serviceOption
// finds it and forks the changes-consumer.
const saLayer = SuggestedActions.layer.pipe(
  Layer.provide(SuggestedActionsStore.Memory),
  Layer.provide(testClock),
)

// An idle fake SDK — we never call chat.send in these tests, so the query
// never needs to yield anything.
const idleQuery = (prompt: AsyncIterable<SDKUserMessage>) => {
  async function* gen(): AsyncGenerator<SDKMessage, void> {
    for await (const _u of prompt) {
      // no-op — no turns are driven here
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
  }) as unknown as ReturnType<Parameters<typeof SDKClient.fake>[0]>
}

const fakeLayer = SDKClient.fake((p) => idleQuery(p.prompt as AsyncIterable<SDKUserMessage>))

const fullLayer = Layer.provideMerge(
  ChatService.Default,
  Layer.mergeAll(
    Layer.provideMerge(SDKAdapter.Default, Layer.mergeAll(fakeLayer, baseLayer)),
    saLayer,
  ),
)

const runScoped = <A, E>(
  eff: Effect.Effect<
    A,
    E,
    ChatService | SuggestedActions | SessionStore | CoreClock
    | ObservabilityService | TelemetryService | Scope.Scope
  >,
) => Effect.runPromise(Effect.scoped(eff).pipe(Effect.provide(fullLayer)))

describe("SuggestedActions ↔ ChatService bridge", () => {
  it("propose surfaces a suggested-action-update frame on the owning thread", async () => {
    const frames = await runScoped(
      Effect.gen(function* () {
        const chat = yield* ChatService
        const sa = yield* SuggestedActions
        const t = yield* chat.createThread({ model: "claude-test", title: "T" })

        const sub = chat.subscribe(t.id)
        const fiber = yield* Effect.forkChild(
          Stream.runCollect(Stream.take(sub, 2)), // snapshot + update
        )
        yield* Effect.sleep("30 millis") // let the subscriber attach
        yield* sa.propose({
          threadId: t.id,
          source: "agent",
          actionType: "research",
          title: "Look into X",
          payload: { prompt: "go research X" },
        })
        const chunk = yield* Fiber.join(fiber)
        return Array.from(chunk) as ChatFrame[]
      }),
    )

    const update = frames.find((f) => f.type === "suggested-action-update")
    expect(update).toBeDefined()
    if (update && update.type === "suggested-action-update") {
      expect(update.action.title).toBe("Look into X")
      expect(update.action.status).toBe("proposed")
      expect(update.action.actionType).toBe("research")
      // wire-safe: payload must NOT cross the boundary
      expect("payload" in update.action).toBe(false)
    }
  })

  it("dismiss (respond) surfaces a status delta on the thread", async () => {
    const statuses = await runScoped(
      Effect.gen(function* () {
        const chat = yield* ChatService
        const sa = yield* SuggestedActions
        const t = yield* chat.createThread({ model: "claude-test", title: "T" })

        const sub = chat.subscribe(t.id)
        const fiber = yield* Effect.forkChild(
          Stream.runCollect(Stream.take(sub, 3)), // snapshot + proposed + dismissed
        )
        yield* Effect.sleep("30 millis")
        const row = yield* sa.propose({
          threadId: t.id,
          source: "agent",
          actionType: "task",
          title: "Do thing",
          payload: { prompt: "do" },
        })
        yield* sa.respond({ threadId: t.id, actionId: row.id, decision: "dismiss" })
        const chunk = yield* Fiber.join(fiber)
        return Array.from(chunk)
          .filter((f): f is Extract<ChatFrame, { type: "suggested-action-update" }> =>
            f.type === "suggested-action-update",
          )
          .map((f) => f.action.status)
      }),
    )
    expect(statuses).toContain("proposed")
    expect(statuses).toContain("dismissed")
  })

  it("replay-on-subscribe surfaces existing proposed actions as a set frame", async () => {
    const frames = await runScoped(
      Effect.gen(function* () {
        const chat = yield* ChatService
        const sa = yield* SuggestedActions
        const t = yield* chat.createThread({ model: "claude-test", title: "T" })
        // Propose BEFORE subscribing — simulates an offline Dream proposal or a
        // suggestion made in a prior session.
        yield* sa.propose({
          threadId: t.id,
          source: "dream",
          actionType: "research",
          title: "Earlier idea",
          payload: { prompt: "x" },
        })
        // A fresh subscribe should replay it after the snapshot.
        const sub = chat.subscribe(t.id)
        const chunk = yield* Stream.runCollect(Stream.take(sub, 2))
        return Array.from(chunk) as ChatFrame[]
      }),
    )
    expect(frames[0]?.type).toBe("snapshot")
    const set = frames.find((f) => f.type === "suggested-action-set")
    expect(set).toBeDefined()
    if (set && set.type === "suggested-action-set") {
      expect(set.actions.map((a) => a.title)).toContain("Earlier idea")
      expect(set.actions[0]?.status).toBe("proposed")
    }
  })

  it("does not emit for a thread with no live entry (offline → replay handles it)", async () => {
    const frames = await runScoped(
      Effect.gen(function* () {
        const chat = yield* ChatService
        const sa = yield* SuggestedActions
        const t = yield* chat.createThread({ model: "claude-test", title: "T" })

        // Propose for a DIFFERENT, never-created thread id — no live pubsub.
        const sub = chat.subscribe(t.id)
        const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(sub, 2)))
        yield* Effect.sleep("30 millis")
        yield* sa.propose({
          threadId: "thr_offline",
          source: "dream",
          actionType: "research",
          title: "Offline idea",
          payload: { prompt: "later" },
        })
        // Then a real one for t so the take(2) completes deterministically.
        yield* sa.propose({
          threadId: t.id,
          source: "agent",
          actionType: "research",
          title: "Live idea",
          payload: { prompt: "now" },
        })
        const chunk = yield* Fiber.join(fiber)
        return Array.from(chunk) as ChatFrame[]
      }),
    )
    const updates = frames.filter((f) => f.type === "suggested-action-update")
    // Only the live-thread proposal reached this thread's stream.
    expect(updates).toHaveLength(1)
    if (updates[0] && updates[0].type === "suggested-action-update") {
      expect(updates[0].action.title).toBe("Live idea")
    }
  })
})
