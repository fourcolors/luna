/**
 * gather.test.ts — Loop B (Dream v2 Phase 1 integration): gatherInputs must
 * return DISTILLED sessions, not raw {summary, messages} bags.
 *
 * This is the RED half of the integration slice: distill.ts (Loop A, pure)
 * already exists and is unit-tested in distill.test.ts. This file specs the
 * INTEGRATION — gatherInputs (dream.ts) wiring each in-window session's
 * messages through distillSession(summary, messages, {watermark, now},
 * DEFAULT_DISTILL_OPTIONS) before handing them to the reasoner.
 *
 * Wiring mirrors dream.test.ts: SessionStore.Default (real in-memory store,
 * not faked — we need real appendMessage/lastMessageAt bookkeeping) + a
 * Ref-backed FakeMemory double for MemoryRouterTag.
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer, Ref, Stream } from "effect"
import { MemoryRouterTag } from "@luna/memory"
import type { MemoryRecord } from "@luna/memory"
import { SessionStore } from "../session/session-store.js"
import { gatherInputs } from "./dream.js"
import type { DistilledSession } from "./distill.js"

// ── fakes ────────────────────────────────────────────────────────────────

// Ref-backed MemoryRouter double whose `query` actually replays the seeded
// records (dream.test.ts's FakeMemory stubs `query` to Stream.empty since it
// never exercises gatherInputs' memory read; S3d here needs it to work).
const FakeMemory = (initial: ReadonlyArray<MemoryRecord> = []) =>
  Layer.effect(
    MemoryRouterTag,
    Effect.gen(function* () {
      const store = yield* Ref.make<ReadonlyArray<MemoryRecord>>(initial)
      return {
        put: (r: MemoryRecord) => Ref.update(store, (recs) => [...recs, r]),
        get: () => Effect.succeed(null),
        delete: () => Effect.succeed(false),
        query: () => Stream.unwrap(Ref.get(store).pipe(Effect.map(Stream.fromIterable))),
        search: () => {
          throw new Error("unused")
        },
      } as never
    }),
  )

const run = <A>(
  eff: Effect.Effect<A, unknown, SessionStore | typeof MemoryRouterTag>,
  memories: ReadonlyArray<MemoryRecord> = [],
) =>
  Effect.runPromise(
    eff.pipe(
      Effect.provide(SessionStore.Default),
      Effect.provide(FakeMemory(memories)),
    ) as Effect.Effect<A, unknown, never>,
  )

const textPayload = (role: "user" | "assistant", content: string) => ({
  message: { role, content },
})

const memRecord = (id: string): MemoryRecord => ({
  id,
  namespace: "operator",
  kind: "note",
  content: { id },
  schemaVersion: 1,
  createdAt: 0,
  updatedAt: 0,
  tags: [],
})

// ── S3 ───────────────────────────────────────────────────────────────────

describe("gatherInputs — distilled sessions (Loop B integration)", () => {
  it("S3a: distills user/assistant text into one DistilledSession, dropping noise-kind payloads from the excerpt", async () => {
    const out = await run(
      Effect.gen(function* () {
        const sessions = yield* SessionStore
        yield* sessions.create({ id: "s-1", options: { model: "test" }, createdAt: 0 })
        yield* sessions.appendMessage({
          sessionId: "s-1", messageId: "m-1", ts: 10, parentId: null,
          kind: "user", payload: textPayload("user", "what is the weather"),
        })
        yield* sessions.appendMessage({
          sessionId: "s-1", messageId: "m-2", ts: 11, parentId: null,
          kind: "stream_event", payload: { delta: "STREAM_NOISE_SENTINEL" },
        })
        yield* sessions.appendMessage({
          sessionId: "s-1", messageId: "m-3", ts: 12, parentId: null,
          kind: "system", payload: { note: "SYSTEM_NOISE_SENTINEL" },
        })
        yield* sessions.appendMessage({
          sessionId: "s-1", messageId: "m-4", ts: 13, parentId: null,
          kind: "assistant", payload: textPayload("assistant", "it is sunny"),
        })
        return yield* gatherInputs(0, 100)
      }),
    )
    expect(out.sessions).toHaveLength(1)
    const distilled = out.sessions[0] as unknown as DistilledSession
    expect(distilled.excerpt).toContain("what is the weather")
    expect(distilled.excerpt).toContain("it is sunny")
    expect(distilled.excerpt).not.toContain("STREAM_NOISE_SENTINEL")
    expect(distilled.excerpt).not.toContain("SYSTEM_NOISE_SENTINEL")
  })

  it("S3b: message-granularity windowing — excerpt contains ONLY the in-window message; messageCount is total, windowMessageCount is windowed-only", async () => {
    const out = await run(
      Effect.gen(function* () {
        const sessions = yield* SessionStore
        yield* sessions.create({ id: "s-1", options: { model: "test" }, createdAt: 0 })
        // Both predate the watermark (10).
        yield* sessions.appendMessage({
          sessionId: "s-1", messageId: "m-1", ts: 5, parentId: null,
          kind: "user", payload: textPayload("user", "too old to include"),
        })
        yield* sessions.appendMessage({
          sessionId: "s-1", messageId: "m-2", ts: 6, parentId: null,
          kind: "assistant", payload: textPayload("assistant", "also too old"),
        })
        // The only in-window message.
        yield* sessions.appendMessage({
          sessionId: "s-1", messageId: "m-3", ts: 50, parentId: null,
          kind: "user", payload: textPayload("user", "the only in window message"),
        })
        return yield* gatherInputs(10, 100)
      }),
    )
    expect(out.sessions).toHaveLength(1)
    const distilled = out.sessions[0] as unknown as DistilledSession
    expect(distilled.excerpt).toBe("[user] the only in window message")
    expect(distilled.messageCount).toBe(3)
    expect(distilled.windowMessageCount).toBe(1)
  })

  it("S3c: sessions whose lastMessageAt falls outside (watermark, now] are absent entirely (existing behavior preserved)", async () => {
    const out = await run(
      Effect.gen(function* () {
        const sessions = yield* SessionStore
        // lastMessageAt <= watermark(10) → excluded.
        yield* sessions.create({ id: "s-old", options: { model: "test" }, createdAt: 0 })
        yield* sessions.appendMessage({
          sessionId: "s-old", messageId: "m-1", ts: 5, parentId: null,
          kind: "user", payload: textPayload("user", "old session"),
        })
        // lastMessageAt > now(100) → excluded.
        yield* sessions.create({ id: "s-future", options: { model: "test" }, createdAt: 0 })
        yield* sessions.appendMessage({
          sessionId: "s-future", messageId: "m-1", ts: 500, parentId: null,
          kind: "user", payload: textPayload("user", "future session"),
        })
        // In (10, 100] → included.
        yield* sessions.create({ id: "s-in", options: { model: "test" }, createdAt: 0 })
        yield* sessions.appendMessage({
          sessionId: "s-in", messageId: "m-1", ts: 50, parentId: null,
          kind: "user", payload: textPayload("user", "in window session"),
        })
        return yield* gatherInputs(10, 100)
      }),
    )
    const ids = out.sessions.map((s) => (s as unknown as DistilledSession).summary.id)
    expect(ids).toEqual(["s-in"])
  })

  it("S3d: memories are returned unchanged", async () => {
    const seeded = [memRecord("mem-1"), memRecord("mem-2")]
    const out = await run(
      Effect.gen(function* () {
        return yield* gatherInputs(0, 100)
      }),
      seeded,
    )
    expect(out.memories).toEqual(seeded)
  })
})
