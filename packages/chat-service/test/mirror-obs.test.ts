/**
 * ChatService mirror-failure observability.
 *
 * The user-selected behavior for a SessionStore mirror append failure is
 * "log + obs event, keep the turn". adapter-sdk's adapter.test.ts proves the
 * onMirrorError SEAM fires on a real append failure and the stream survives.
 * This test proves ChatService WIRES an obs-emitting onMirrorError into its
 * adapter.query call — i.e. the loss reaches the ObservabilityService stream
 * (the Events tab), not just the logger.
 */
import { afterAll, describe, expect, it } from "vitest"
import { Effect, Fiber, Layer, Stream } from "effect"
import { unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  SessionStore,
  Clock as CoreClock,
  ObservabilityService,
  TelemetryService,
} from "@luna/core"
import { SDKAdapter } from "@luna/adapter-sdk"
import { MemoryRouterTag, type MemoryRouter } from "@luna/memory"
import { ChatService } from "../src/index.js"

const noopMemoryRouter: MemoryRouter = {
  search: () => Stream.empty as ReturnType<MemoryRouter["search"]>,
  put: () => Effect.die("noopMemoryRouter.put"),
  get: () => Effect.die("noopMemoryRouter.get"),
  query: () => Stream.die("noopMemoryRouter.query"),
  delete: () => Effect.die("noopMemoryRouter.delete"),
  backendFor: () => {
    throw new Error("noopMemoryRouter.backendFor")
  },
  exportAll: () => Effect.die("noopMemoryRouter.exportAll"),
}

const testClock = CoreClock.Test(1_700_000_000_000)
const obsJsonlPath = join(
  tmpdir(),
  `luna-chat-mirror-obs-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
)
afterAll(() => {
  try {
    unlinkSync(obsJsonlPath)
  } catch {
    /* ignore */
  }
})

const obsLayer = ObservabilityService.makeLayer({
  logToConsole: false,
  jsonlPath: obsJsonlPath,
}).pipe(Layer.provide(testClock))
const telemetryLayer = TelemetryService.makeLayer().pipe(Layer.provide(testClock))

// Fake adapter whose query() simulates a SessionStore mirror append failure by
// invoking the caller-supplied onMirrorError once, then ending the stream with
// no SDK messages.
const FAKE_MSG = { type: "assistant", uuid: "m1", session_id: "s" }
const failingMirrorAdapter = {
  query: (req: {
    onMirrorError?: (m: unknown, c: unknown) => Effect.Effect<void>
  }) =>
    Effect.succeed(
      Stream.fromEffect(
        req.onMirrorError
          ? req.onMirrorError(FAKE_MSG, new Error("mirror boom"))
          : Effect.void,
      ).pipe(Stream.drain),
    ),
  registerHook: () => Effect.void,
  setPermissionCallback: () => Effect.void,
  getQueryHandle: () => Effect.succeed(null),
}

const layer = Layer.provideMerge(
  ChatService.Default,
  Layer.mergeAll(
    Layer.succeed(SDKAdapter, failingMirrorAdapter as never),
    SessionStore.Default,
    testClock,
    obsLayer,
    telemetryLayer,
    Layer.succeed(MemoryRouterTag, noopMemoryRouter),
  ),
)

describe("ChatService mirror-failure observability", () => {
  it("emits an Error obs event when the adapter reports a mirror append failure", async () => {
    const seen = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const obs = yield* ObservabilityService
          const evStream = yield* obs.subscribeEvents
          const events: Array<{ kind: string; errorTag?: string }> = []
          const collector = yield* Effect.forkChild(
            evStream.pipe(
              Stream.runForEach((e) =>
                Effect.sync(() => {
                  events.push(e as { kind: string; errorTag?: string })
                }),
              ),
            ),
          )
          const chat = yield* ChatService
          // createThread starts the adapter.query consumer → the fake invokes
          // onMirrorError → ChatService should emit the obs Error event.
          yield* chat.createThread({ model: "claude-test", title: "mirror-obs" })
          yield* Effect.sleep("100 millis")
          yield* Fiber.interrupt(collector)
          return events
        }),
      ).pipe(Effect.provide(layer)),
    )

    const found = seen.some(
      (e) => e.kind === "Error" && e.errorTag === "ChatMirrorAppendFailed",
    )
    expect(found).toBe(true)
  })
})
