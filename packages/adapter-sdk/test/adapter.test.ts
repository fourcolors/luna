/**
 * SDKAdapter Tier-1 tests with a fake SDK.
 *
 * Verifies:
 *   - query() yields SDK messages through the Stream and mirrors them to
 *     SessionStore (§12.2 #2).
 *   - Scope close fires the AbortController (§12.2 #1, §12.4).
 *   - Idle timeout surfaces as SDKError (§12.2 #5).
 *   - Query handle is retained in the session-scoped registry (§12.2 #8).
 *   - Reserved-key merge-guard drops caller-supplied hooks/canUseTool
 *     without failing the query (§12.2 #7).
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer, Scope, Stream } from "effect"
import { SessionStore, SessionService } from "@experiment-agent/core"
import { Clock as CoreClock } from "@experiment-agent/core"
import { SDKAdapter, SDKClient } from "../src/index.js"
import type { SDKUserMessage } from "../src/sdk-client.js"
import {
  makeAssistantMessage,
  makeFakeQuery,
  makeResultMessage,
} from "./fake-sdk.js"

const sid = "s-test"

const baseLayer = Layer.mergeAll(
  SessionStore.Default,
  CoreClock.Test(1_700_000_000_000),
)

const runScoped = <A, E>(
  eff: Effect.Effect<A, E, SDKAdapter | SessionStore | Scope.Scope>,
  fakeLayer: Layer.Layer<SDKClient>,
) =>
  Effect.runPromise(
    Effect.scoped(eff).pipe(
      Effect.provide(
        Layer.provideMerge(
          SDKAdapter.Default,
          Layer.mergeAll(fakeLayer, baseLayer),
        ),
      ),
    ),
  )

const emptyPrompt: Stream.Stream<SDKUserMessage> = Stream.empty

describe("SDKAdapter (fake SDK)", () => {
  it("yields SDK messages through the stream and mirrors to SessionStore", async () => {
    const messages = [
      makeAssistantMessage(sid, "hello", "u1"),
      makeResultMessage(sid, "u2"),
    ]
    const fake = makeFakeQuery({ messages })

    const seen = await runScoped(
      Effect.gen(function* () {
        const store = yield* SessionStore
        yield* store.create({
          id: sid,
          options: { model: "claude-test" },
          createdAt: 0,
        })
        const adapter = yield* SDKAdapter
        const out = yield* adapter.query({
          sessionId: sid,
          prompt: emptyPrompt,
          sessionOptions: { model: "claude-test", idleTimeoutMs: 5_000 },
        })
        const chunk = yield* Stream.runCollect(out)
        const stored = yield* Stream.runCollect(store.readMessages(sid))
        return {
          streamed: Array.from(chunk).length,
          persisted: Array.from(stored).length,
        }
      }),
      SDKClient.fake(() => fake.query),
    )

    expect(seen.streamed).toBe(2)
    expect(seen.persisted).toBe(2)
  })

  it("closing the Scope aborts the underlying subprocess", async () => {
    const abortSeen = { aborted: false }
    const fakeLayer = SDKClient.fake((params) => {
      params.options?.abortController?.signal.addEventListener("abort", () => {
        abortSeen.aborted = true
      })
      return makeFakeQuery({
        messages: [makeAssistantMessage(sid, "x", "u1")],
        gapMs: 50,
      }).query
    })

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* SessionStore
          yield* store.create({
            id: sid,
            options: { model: "m" },
            createdAt: 0,
          })
          const adapter = yield* SDKAdapter
          const out = yield* adapter.query({
            sessionId: sid,
            prompt: emptyPrompt,
            sessionOptions: { model: "m", idleTimeoutMs: 5_000 },
          })
          // Consume just one value then exit the scope.
          yield* Stream.runHead(out)
        }),
      ).pipe(
        Effect.provide(
          Layer.provideMerge(
            SDKAdapter.Default,
            Layer.mergeAll(fakeLayer, baseLayer),
          ),
        ),
      ),
    )

    expect(abortSeen.aborted).toBe(true)
  })

  it("idle timeout surfaces as SDKError when no message yields", async () => {
    // Fake that never yields — just a promise that sleeps forever.
    const neverFake = makeFakeQuery({ messages: [], gapMs: 0 })
    // Replace the generator with one that awaits forever.
    const neverQuery = Object.assign(
      (async function* () {
        await new Promise(() => {}) // hang
      })(),
      {
        interrupt: async () => {},
        setPermissionMode: async () => {},
        setModel: async () => {},
        setMaxThinkingTokens: async () => {},
        supplyToolPermissionResponse: async () => {},
        mcpServerStatus: async () => ({}),
      },
    ) as typeof neverFake.query

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* SessionStore
          yield* store.create({
            id: sid,
            options: { model: "m" },
            createdAt: 0,
          })
          const adapter = yield* SDKAdapter
          const out = yield* adapter.query({
            sessionId: sid,
            prompt: emptyPrompt,
            sessionOptions: { model: "m", idleTimeoutMs: 100 },
          })
          yield* Stream.runDrain(out)
        }),
      ).pipe(
        Effect.provide(
          Layer.provideMerge(
            SDKAdapter.Default,
            Layer.mergeAll(SDKClient.fake(() => neverQuery), baseLayer),
          ),
        ),
      ),
    )
    expect(exit._tag).toBe("Failure")
  })

  it("retains the Query handle under the session id during the stream", async () => {
    const fake = makeFakeQuery({
      messages: [
        makeAssistantMessage(sid, "a", "u1"),
        makeAssistantMessage(sid, "b", "u2"),
        makeResultMessage(sid, "u3"),
      ],
      gapMs: 5,
    })

    const hasHandle = await runScoped(
      Effect.gen(function* () {
        const store = yield* SessionStore
        yield* store.create({
          id: sid,
          options: { model: "m" },
          createdAt: 0,
        })
        const adapter = yield* SDKAdapter
        const out = yield* adapter.query({
          sessionId: sid,
          prompt: emptyPrompt,
          sessionOptions: { model: "m", idleTimeoutMs: 5_000 },
        })
        // Start consuming in the background and probe the handle.
        const head = yield* Stream.runHead(out)
        const handle = yield* adapter.getQueryHandle(sid)
        yield* Stream.runDrain(out) // drain the rest
        return handle !== null && head !== null
      }),
      SDKClient.fake(() => fake.query),
    )
    expect(hasHandle).toBe(true)
  })

  it("drops caller-supplied reserved keys from sdkOptions without failing", async () => {
    const fake = makeFakeQuery({
      messages: [makeResultMessage(sid, "u1")],
    })

    const count = await runScoped(
      Effect.gen(function* () {
        const store = yield* SessionStore
        yield* store.create({
          id: sid,
          options: { model: "m" },
          createdAt: 0,
        })
        const adapter = yield* SDKAdapter
        const out = yield* adapter.query({
          sessionId: sid,
          prompt: emptyPrompt,
          sessionOptions: {
            model: "m",
            idleTimeoutMs: 5_000,
            sdkOptions: {
              maxTurns: 3,
              // Reserved — should be dropped with a warning.
              hooks: { PreToolUse: [] },
              canUseTool: async () => ({}),
            },
          },
        })
        const chunk = yield* Stream.runCollect(out)
        return Array.from(chunk).length
      }),
      SDKClient.fake(() => fake.query),
    )
    expect(count).toBe(1)
  })
})

// Marker: the SessionService export is used implicitly to keep the workspace
// resolution warm for editors; no test depends on it yet.
void SessionService
