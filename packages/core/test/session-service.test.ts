/**
 * SessionService — lifecycle tests: open/resume/fork/close + openScoped.
 *
 * The openScoped tests stub SDKAdapter inline (brief §5) — just enough to
 * exercise the Scope plumbing + finalizer cascade. No real SDK subprocess.
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer, Queue, Ref, Scope, Stream } from "effect"
import { Clock } from "../src/clock.js"
import {
  SDKAdapter,
  SessionService,
  type SDKAdapterLike,
} from "../src/session/session-service.js"
import { SessionStore } from "../src/session/session-store.js"

const TestLayer = Layer.provideMerge(
  SessionService.Default,
  Layer.merge(SessionStore.Default, Clock.Test(1_700_000_000_000)),
)

const run = <A, E>(
  eff: Effect.Effect<A, E, SessionService | SessionStore | Clock>,
) => Effect.runPromise(eff.pipe(Effect.provide(TestLayer)))

describe("SessionService", () => {
  it("open creates an active session with a generated id", async () => {
    const s = await run(
      Effect.gen(function* () {
        const svc = yield* SessionService
        return yield* svc.open({ model: "claude-sonnet-4-5", title: "hello" })
      }),
    )
    expect(s.status).toBe("active")
    expect(s.title).toBe("hello")
    expect(s.id.startsWith("ses_")).toBe(true)
  })

  it("close transitions status and is idempotent", async () => {
    const result = await run(
      Effect.gen(function* () {
        const svc = yield* SessionService
        const store = yield* SessionStore
        const s = yield* svc.open({ model: "m" })
        yield* svc.close(s.id)
        yield* svc.close(s.id) // idempotent
        return yield* store.get(s.id)
      }),
    )
    expect(result?.status).toBe("closed")
    expect(result?.endedAt).toBe(1_700_000_000_000)
  })

  it("resume reactivates a closed session", async () => {
    const out = await run(
      Effect.gen(function* () {
        const svc = yield* SessionService
        const s = yield* svc.open({ model: "m" })
        yield* svc.close(s.id)
        return yield* svc.resume(s.id)
      }),
    )
    expect(out.status).toBe("active")
  })

  it("close after resume closes again (does not silently no-op)", async () => {
    // Regression: `close` guards on an in-process `closedIds` set; `resume`
    // reactivates the store but must also clear the guard, else a resumed
    // session can never be closed again and leaks as "active" forever.
    const result = await run(
      Effect.gen(function* () {
        const svc = yield* SessionService
        const store = yield* SessionStore
        const s = yield* svc.open({ model: "m" })
        yield* svc.close(s.id)
        yield* svc.resume(s.id)
        yield* svc.close(s.id) // must take effect, not no-op on the stale guard
        return yield* store.get(s.id)
      }),
    )
    expect(result?.status).toBe("closed")
    expect(result?.endedAt).toBe(1_700_000_000_000)
  })

  it("fork creates child with parentSessionId link", async () => {
    const child = await run(
      Effect.gen(function* () {
        const svc = yield* SessionService
        const parent = yield* svc.open({ model: "m", title: "parent" })
        return yield* svc.fork(parent.id, { title: "child" })
      }),
    )
    expect(child.title).toBe("child")
    expect(child.parentId).toBeTruthy()
  })

  it("fork threads the resolved model into sdkOptions.model (GAP#3)", async () => {
    // The SDK adapter routes the broker + SDK on sdkOptions.model, NOT the
    // top-level SessionOptions.model. fork() must copy the resolved child model
    // into sdkOptions or a forked thread silently routes to the default
    // provider. Override wins over the parent's model.
    const opts = await run(
      Effect.gen(function* () {
        const svc = yield* SessionService
        const store = yield* SessionStore
        const parent = yield* svc.open({ model: "claude-sonnet-4-5" })
        const child = yield* svc.fork(parent.id, { model: "gemini-2.5-flash" })
        return yield* store.getOptions(child.id)
      }),
    )
    expect(opts?.model).toBe("gemini-2.5-flash")
    expect((opts?.sdkOptions as { model?: string } | undefined)?.model).toBe(
      "gemini-2.5-flash",
    )
  })

  it("fork inherits the parent model into sdkOptions.model when no override (GAP#3)", async () => {
    const opts = await run(
      Effect.gen(function* () {
        const svc = yield* SessionService
        const store = yield* SessionStore
        const parent = yield* svc.open({ model: "claude-sonnet-4-5" })
        const child = yield* svc.fork(parent.id, { title: "child" })
        return yield* store.getOptions(child.id)
      }),
    )
    expect((opts?.sdkOptions as { model?: string } | undefined)?.model).toBe(
      "claude-sonnet-4-5",
    )
  })

  it("resume of missing session fails with IntegrityError", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const svc = yield* SessionService
        yield* svc.resume("does-not-exist")
      }).pipe(Effect.provide(TestLayer)),
    )
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const cause = exit.cause
      const str = JSON.stringify(cause)
      expect(str).toContain("session_exists")
    }
  })

  it("fork of missing parent fails with IntegrityError", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const svc = yield* SessionService
        yield* svc.fork("does-not-exist")
      }).pipe(Effect.provide(TestLayer)),
    )
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const str = JSON.stringify(exit.cause)
      expect(str).toContain("fork_parent_exists")
    }
  })

  it("genId: two sequential opens under a fixed Clock produce different ids", async () => {
    // Fixed-ms Clock would collide on the timestamp portion; the Ref-backed
    // seq suffix MUST differ. Proves we replaced module-level `let _seq`.
    const ids = await run(
      Effect.gen(function* () {
        const svc = yield* SessionService
        const a = yield* svc.open({ model: "m" })
        const b = yield* svc.open({ model: "m" })
        return [a.id, b.id] as const
      }),
    )
    expect(ids[0]).not.toBe(ids[1])
    // Split `ses_<ts>_<seq>_<rand>` — the seq segment should differ.
    const segA = ids[0].split("_")
    const segB = ids[1].split("_")
    expect(segA[1]).toBe(segB[1]) // same ts (Clock.Test is fixed)
    expect(segA[2]).not.toBe(segB[2]) // seq increments
  })
})

/**
 * Inline SDKAdapter stub. Captures the prompt queue + abort signal so tests
 * can assert interruption cascade. Yields from a Ref-backed mailbox of
 * pre-seeded replies so we can simulate the streaming surface.
 */
interface StubHandle {
  readonly adapter: SDKAdapterLike
  readonly state: {
    aborted: boolean
    querySessionId: string | null
    readonly replies: Queue.Queue<unknown>
  }
}

const makeStubAdapter = (): Effect.Effect<StubHandle> =>
  Effect.gen(function* () {
    const replies = yield* Queue.unbounded<unknown>()
    const state = {
      aborted: false,
      querySessionId: null as string | null,
      replies,
    }
    const adapter: SDKAdapterLike = {
      query: (req) =>
        Effect.gen(function* () {
          state.querySessionId = req.sessionId
          // Finalize on Scope close to record interruption.
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              state.aborted = true
            }),
          )
          // Drive the reply Stream off the replies Queue.
          const stream: Stream.Stream<unknown, unknown> = Stream.fromQueue(
            replies,
          )
          return stream
        }),
    }
    return { adapter, state }
  })

describe("SessionService.openScoped", () => {
  const scopedLayer = (adapter: SDKAdapterLike) =>
    Layer.provideMerge(
      SessionService.Default,
      Layer.mergeAll(
        SessionStore.Default,
        Clock.Test(1_700_000_000_000),
        Layer.succeed(SDKAdapter, adapter),
      ),
    )

  it("happy path: open, stream reply, Scope close flips status to closed", async () => {
    const stubHandle = await Effect.runPromise(makeStubAdapter())
    const layer = scopedLayer(stubHandle.adapter)

    // Seed one reply.
    await Effect.runPromise(
      Queue.offer(stubHandle.state.replies, { type: "assistant", text: "hi" }),
    )

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* SessionService
        const store = yield* SessionStore

        // Capture id + observe stored status AFTER Scope closes.
        const id = yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* svc.openScoped({ model: "m" })
            yield* session.send({ type: "user", content: "ping" })
            // Pull one reply (bounded — don't hang).
            const head = yield* Stream.runHead(
              session.replies.pipe(Stream.take(1)),
            )
            expect(head._tag).toBe("Some")
            return session.id
          }),
        )

        const row = yield* store.get(id)
        return { id, status: row?.status, aborted: stubHandle.state.aborted }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.status).toBe("closed")
    expect(result.aborted).toBe(true)
  })

  it("cascade: closing the Scope interrupts the adapter query", async () => {
    const stubHandle = await Effect.runPromise(makeStubAdapter())
    const layer = scopedLayer(stubHandle.adapter)

    // No replies seeded — the stream will just wait. We close the Scope
    // before pulling, and the adapter-query finalizer must run.
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const svc = yield* SessionService
          yield* svc.openScoped({ model: "m" })
          // Scope closes when this block exits.
        }),
      ).pipe(Effect.provide(layer)),
    )

    expect(stubHandle.state.aborted).toBe(true)
  })

  it("session mirrored to store: sessionId matches what adapter.query saw", async () => {
    // We're not re-testing §12.2 #2 (the adapter already mirrors messages —
    // verified in adapter-sdk's tests). Here we just verify the adapter
    // received the same session id we created in the store — so any future
    // mirror hits the correct row.
    const stubHandle = await Effect.runPromise(makeStubAdapter())
    const layer = scopedLayer(stubHandle.adapter)

    const id = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const svc = yield* SessionService
          const session = yield* svc.openScoped({ model: "m" })
          return session.id
        }),
      ).pipe(Effect.provide(layer)),
    )

    expect(stubHandle.state.querySessionId).toBe(id)
  })

  // Silence unused-import warning: Ref/Scope stay imported for clarity of
  // the scoped-lifetime story even though this file uses them implicitly.
  void Ref
  void Scope
})
