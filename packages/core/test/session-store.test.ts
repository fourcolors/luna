/**
 * SessionStore — in-memory layer tests.
 * Verifies: creation uniqueness, monotonic seq, list filters, status transitions.
 */
import { describe, expect, it } from "vitest"
import { Effect, Stream } from "effect"
import { SessionStore } from "../src/session/session-store.js"
import type { SDKUserMessage } from "../src/messages.js"

const makeMsg = (sid: string, text: string): SDKUserMessage => ({
  type: "user",
  session_id: sid,
  message: { role: "user", content: text },
})

const program = <A, E>(eff: Effect.Effect<A, E, SessionStore>) =>
  Effect.runPromise(eff.pipe(Effect.provide(SessionStore.Default)))

describe("SessionStore (in-memory)", () => {
  it("creates a session and retrieves it", async () => {
    const result = await program(
      Effect.gen(function* () {
        const store = yield* SessionStore
        const summary = yield* store.create({
          id: "s1",
          options: { model: "m", title: "t", tags: ["x"] },
          createdAt: 100,
        })
        const got = yield* store.get("s1")
        return { summary, got }
      }),
    )
    expect(result.summary.id).toBe("s1")
    expect(result.summary.status).toBe("active")
    expect(result.got?.title).toBe("t")
    expect(result.got?.tags).toEqual(["x"])
  })

  it("rejects duplicate session ids with IntegrityError", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const store = yield* SessionStore
        yield* store.create({
          id: "dup",
          options: { model: "m" },
          createdAt: 1,
        })
        yield* store.create({
          id: "dup",
          options: { model: "m" },
          createdAt: 2,
        })
      }).pipe(Effect.provide(SessionStore.Default)),
    )
    expect(exit._tag).toBe("Failure")
  })

  it("appendMessage assigns monotonic seq starting at 0", async () => {
    const seqs = await program(
      Effect.gen(function* () {
        const store = yield* SessionStore
        yield* store.create({
          id: "s",
          options: { model: "m" },
          createdAt: 0,
        })
        const a = yield* store.appendMessage({
          sessionId: "s",
          messageId: "m1",
          ts: 1,
          parentId: null,
          payload: makeMsg("s", "a"),
        })
        const b = yield* store.appendMessage({
          sessionId: "s",
          messageId: "m2",
          ts: 2,
          parentId: null,
          payload: makeMsg("s", "b"),
        })
        return [a.seq, b.seq]
      }),
    )
    expect(seqs).toEqual([0, 1])
  })

  it("readMessages streams in insertion order", async () => {
    const texts = await program(
      Effect.gen(function* () {
        const store = yield* SessionStore
        yield* store.create({
          id: "s",
          options: { model: "m" },
          createdAt: 0,
        })
        for (let i = 0; i < 3; i++) {
          yield* store.appendMessage({
            sessionId: "s",
            messageId: `m${i}`,
            ts: i,
            parentId: null,
            payload: makeMsg("s", `t${i}`),
          })
        }
        const chunk = yield* Stream.runCollect(store.readMessages("s"))
        return Array.from(chunk).map((m) => m.id)
      }),
    )
    expect(texts).toEqual(["m0", "m1", "m2"])
  })

  it("setStatus transitions + list filters by status", async () => {
    const ids = await program(
      Effect.gen(function* () {
        const store = yield* SessionStore
        yield* store.create({
          id: "a",
          options: { model: "m" },
          createdAt: 1,
        })
        yield* store.create({
          id: "b",
          options: { model: "m" },
          createdAt: 2,
        })
        yield* store.setStatus("a", "closed", 10)
        const chunk = yield* Stream.runCollect(store.list({ status: "active" }))
        return Array.from(chunk).map((s) => s.id)
      }),
    )
    expect(ids).toEqual(["b"])
  })

  it("appendMessage fails for unknown session", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const store = yield* SessionStore
        yield* store.appendMessage({
          sessionId: "nope",
          messageId: "m",
          ts: 0,
          parentId: null,
          payload: makeMsg("nope", "x"),
        })
      }).pipe(Effect.provide(SessionStore.Default)),
    )
    expect(exit._tag).toBe("Failure")
  })
})
