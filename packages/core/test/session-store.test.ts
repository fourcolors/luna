/**
 * SessionStore — in-memory layer tests.
 * Verifies: creation uniqueness, monotonic seq, list filters, status transitions.
 */
import { describe, expect, it } from "vitest"
import { Effect, Stream } from "effect"
import { SessionStore } from "../src/session/session-store.js"

const makeMsg = (sid: string, text: string) => ({
  type: "user" as const,
  session_id: sid,
  message: { role: "user" as const, content: text },
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
          kind: "user" as const,
          payload: makeMsg("s", "a"),
        })
        const b = yield* store.appendMessage({
          sessionId: "s",
          messageId: "m2",
          ts: 2,
          parentId: null,
          kind: "user" as const,
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
          kind: "user" as const,
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

  it("list hasUserMessage filters empty threads BEFORE the limit", async () => {
    const ids = await program(
      Effect.gen(function* () {
        const store = yield* SessionStore
        // A real thread created FIRST (oldest), then empty probes that sort
        // ahead of it by createdAt.
        yield* store.create({ id: "real", options: { model: "m" }, createdAt: 1 })
        yield* store.appendMessage({
          sessionId: "real",
          messageId: "u1",
          ts: 1,
          parentId: null,
          kind: "user",
          payload: { text: "hi" },
        })
        // Only a parented (subagent-internal) user message → still empty.
        yield* store.create({ id: "nested", options: { model: "m" }, createdAt: 2 })
        yield* store.appendMessage({
          sessionId: "nested",
          messageId: "u2",
          ts: 2,
          parentId: "p",
          kind: "user",
          payload: { text: "sub" },
        })
        for (let i = 0; i < 5; i++) {
          yield* store.create({
            id: `empty-${i}`,
            options: { model: "m" },
            createdAt: 10 + i,
          })
        }
        const chunk = yield* Stream.runCollect(
          store.list({ orderBy: "lastMessageAt", limit: 2, hasUserMessage: true }),
        )
        return Array.from(chunk).map((s) => s.id)
      }),
    )
    expect(ids).toEqual(["real"])
  })

  it("list excludeIds drops excluded sessions BEFORE the limit (no under-fill)", async () => {
    const ids = await program(
      Effect.gen(function* () {
        const store = yield* SessionStore
        // A real thread created FIRST (oldest), then excluded threads that sort
        // ahead of it by createdAt and would eat the limit slots if excluded
        // only after the limit.
        yield* store.create({ id: "keep", options: { model: "m" }, createdAt: 1 })
        yield* store.appendMessage({
          sessionId: "keep",
          messageId: "k1",
          ts: 1,
          parentId: null,
          kind: "user",
          payload: { text: "hi" },
        })
        for (let i = 0; i < 5; i++) {
          const id = `drop-${i}`
          yield* store.create({ id, options: { model: "m" }, createdAt: 10 + i })
          yield* store.appendMessage({
            sessionId: id,
            messageId: `d${i}`,
            ts: 10 + i,
            parentId: null,
            kind: "user",
            payload: { text: "x" },
          })
        }
        const chunk = yield* Stream.runCollect(
          store.list({
            orderBy: "lastMessageAt",
            limit: 2,
            excludeIds: ["drop-0", "drop-1", "drop-2", "drop-3", "drop-4"],
          }),
        )
        return Array.from(chunk).map((s) => s.id)
      }),
    )
    // 'keep' survives even though 5 excluded threads sorted ahead of it.
    expect(ids).toEqual(["keep"])
  })

  it("sidebar metadata: append updates lastMessageAt + preview for text turns", async () => {
    const summary = await program(
      Effect.gen(function* () {
        const store = yield* SessionStore
        yield* store.create({
          id: "side",
          options: { model: "m" },
          createdAt: 0,
        })
        yield* store.appendMessage({
          sessionId: "side",
          messageId: "u1",
          ts: 1000,
          parentId: null,
          kind: "user" as const,
          payload: makeMsg("side", "hello   sidebar"),
        })
        yield* store.appendMessage({
          sessionId: "side",
          messageId: "a1",
          ts: 2000,
          parentId: null,
          kind: "assistant" as const,
          payload: {
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "hi back" }],
            },
          },
        })
        const got = yield* store.get("side")
        return got!
      }),
    )
    expect(summary.lastMessageAt).toBe(2000)
    expect(summary.lastMessagePreview).toBe("hi back")
  })

  it("sidebar metadata: result/system messages bump ts but not preview", async () => {
    const summary = await program(
      Effect.gen(function* () {
        const store = yield* SessionStore
        yield* store.create({
          id: "side2",
          options: { model: "m" },
          createdAt: 0,
        })
        yield* store.appendMessage({
          sessionId: "side2",
          messageId: "u1",
          ts: 1000,
          parentId: null,
          kind: "user" as const,
          payload: makeMsg("side2", "ask"),
        })
        yield* store.appendMessage({
          sessionId: "side2",
          messageId: "r1",
          ts: 5000,
          parentId: null,
          kind: "result" as const,
          payload: { result: "ok" },
        })
        const got = yield* store.get("side2")
        return got!
      }),
    )
    expect(summary.lastMessageAt).toBe(5000)
    expect(summary.lastMessagePreview).toBe("ask")
  })

  it("sidebar metadata: parented (subagent-internal) messages bump ts but never the preview", async () => {
    // A Task spawn forwards the subagent's seed prompt as a parented user
    // message — without the parentId gate it would overwrite the sidebar
    // with internal prompt text.
    const summary = await program(
      Effect.gen(function* () {
        const store = yield* SessionStore
        yield* store.create({
          id: "side3",
          options: { model: "m" },
          createdAt: 0,
        })
        yield* store.appendMessage({
          sessionId: "side3",
          messageId: "u1",
          ts: 1000,
          parentId: null,
          kind: "user" as const,
          payload: makeMsg("side3", "real user text"),
        })
        yield* store.appendMessage({
          sessionId: "side3",
          messageId: "seed1",
          ts: 2000,
          parentId: "agent_call_1",
          kind: "user" as const,
          payload: makeMsg("side3", "You are a subagent. Do the thing."),
        })
        const got = yield* store.get("side3")
        return got!
      }),
    )
    expect(summary.lastMessageAt).toBe(2000)
    expect(summary.lastMessagePreview).toBe("real user text")
  })

  it("orderBy: lastMessageAt sorts active threads ahead of older-but-fresh-created", async () => {
    const ids = await program(
      Effect.gen(function* () {
        const store = yield* SessionStore
        // older session, but it gets a recent message
        yield* store.create({
          id: "old-active",
          options: { model: "m" },
          createdAt: 100,
        })
        // newer session, no messages
        yield* store.create({
          id: "new-quiet",
          options: { model: "m" },
          createdAt: 500,
        })
        yield* store.appendMessage({
          sessionId: "old-active",
          messageId: "u",
          ts: 1000,
          parentId: null,
          kind: "user" as const,
          payload: makeMsg("old-active", "fresh"),
        })
        const chunk = yield* Stream.runCollect(
          store.list({ orderBy: "lastMessageAt" }),
        )
        return Array.from(chunk).map((s) => s.id)
      }),
    )
    expect(ids).toEqual(["old-active", "new-quiet"])
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
          kind: "user" as const,
          payload: makeMsg("nope", "x"),
        })
      }).pipe(Effect.provide(SessionStore.Default)),
    )
    expect(exit._tag).toBe("Failure")
  })

  it("setOptions merges a patch into existing options", async () => {
    const result = await program(
      Effect.gen(function* () {
        const store = yield* SessionStore
        yield* store.create({
          id: "opts",
          options: { model: "claude-sonnet-4-6", title: "Original" },
          createdAt: 0,
        })
        yield* store.setOptions("opts", { sdkOptions: { effort: "high" } })
        return yield* store.getOptions("opts")
      }),
    )
    // Patch merges: original model/title are preserved, sdkOptions added.
    expect(result?.model).toBe("claude-sonnet-4-6")
    expect(result?.title).toBe("Original")
    expect((result?.sdkOptions as Record<string, unknown>)?.["effort"]).toBe("high")
  })

  it("setOptions does not wipe fields not included in the patch", async () => {
    const result = await program(
      Effect.gen(function* () {
        const store = yield* SessionStore
        yield* store.create({
          id: "patch",
          options: { model: "claude-sonnet-4-6", tags: ["keep-me"] },
          createdAt: 0,
        })
        // Patch only sdkOptions — tags must survive.
        yield* store.setOptions("patch", { sdkOptions: { effort: "low" } })
        return yield* store.getOptions("patch")
      }),
    )
    expect(result?.tags).toEqual(["keep-me"])
  })

  it("setOptions is a no-op for an unknown session id", async () => {
    // Must not throw — the thread may have been evicted.
    await expect(
      program(
        Effect.gen(function* () {
          const store = yield* SessionStore
          yield* store.setOptions("ghost", { sdkOptions: { effort: "max" } })
        }),
      ),
    ).resolves.toBeUndefined()
  })

  it("setOptions with a model patch updates the summary model (mid-thread switch)", async () => {
    const result = await program(
      Effect.gen(function* () {
        const store = yield* SessionStore
        yield* store.create({
          id: "switch",
          options: { model: "claude-sonnet-5" },
          createdAt: 0,
        })
        // The setThreadConfig persist path: model + sdkOptions in one patch.
        yield* store.setOptions("switch", {
          model: "claude-opus-4-8",
          sdkOptions: { model: "claude-opus-4-8" },
        })
        return yield* store.get("switch")
      }),
    )
    // The denormalized summary model must follow the switch — a stale value
    // here is what made thread-list report the creation model forever.
    expect(result?.model).toBe("claude-opus-4-8")
  })

  it("summary surfaces effort from sdkOptions (and ultracode from settings)", async () => {
    const result = await program(
      Effect.gen(function* () {
        const store = yield* SessionStore
        yield* store.create({
          id: "eff",
          options: { model: "m", sdkOptions: { effort: "high" } },
          createdAt: 0,
        })
        yield* store.create({
          id: "ultra",
          options: {
            model: "m",
            sdkOptions: { settings: { ultracode: true, enableWorkflows: true } },
          },
          createdAt: 0,
        })
        yield* store.create({ id: "none", options: { model: "m" }, createdAt: 0 })
        return {
          eff: yield* store.get("eff"),
          ultra: yield* store.get("ultra"),
          none: yield* store.get("none"),
        }
      }),
    )
    expect(result.eff?.effort).toBe("high")
    expect(result.ultra?.effort).toBe("ultracode")
    expect(result.none?.effort).toBeUndefined()
  })

  it("readMessages with { limit } returns only the most recent N messages, still in insertion order", async () => {
    const ids = await program(
      Effect.gen(function* () {
        const store = yield* SessionStore
        yield* store.create({ id: "bounded", options: { model: "m" }, createdAt: 0 })
        for (let i = 0; i < 10; i++) {
          yield* store.appendMessage({
            sessionId: "bounded",
            messageId: `m${i}`,
            ts: i,
            parentId: null,
            kind: "user" as const,
            payload: makeMsg("bounded", `t${i}`),
          })
        }
        const all = yield* Stream.runCollect(store.readMessages("bounded"))
        const bounded = yield* Stream.runCollect(
          store.readMessages("bounded", { limit: 3 }),
        )
        return {
          all: Array.from(all).map((m) => m.id),
          bounded: Array.from(bounded).map((m) => m.id),
        }
      }),
    )
    expect(ids.all).toEqual(["m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9"])
    expect(ids.bounded).toEqual(["m7", "m8", "m9"])
  })
})
