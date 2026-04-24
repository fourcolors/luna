/**
 * SessionService — lifecycle tests: open/resume/fork/close.
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { Clock } from "../src/clock.js"
import { SessionService } from "../src/session/session-service.js"
import { SessionStore } from "../src/session/session-store.js"

const TestLayer = Layer.provideMerge(
  SessionService.Default,
  Layer.merge(SessionStore.Default, Clock.Test(1_700_000_000_000)),
)

const run = <A, E>(eff: Effect.Effect<A, E, SessionService | SessionStore | Clock>) =>
  Effect.runPromise(eff.pipe(Effect.provide(TestLayer)))

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

  it("resume of missing session fails with IntegrityError", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const svc = yield* SessionService
        yield* svc.resume("does-not-exist")
      }).pipe(Effect.provide(TestLayer)),
    )
    expect(exit._tag).toBe("Failure")
  })
})
