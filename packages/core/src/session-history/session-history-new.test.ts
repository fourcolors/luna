/**
 * SessionHistoryService — Task 8 real-implementation tests.
 *
 * All tests use `SessionHistoryService.Memory` (Ref-backed ephemeral layer)
 * so no SQLite dependency is required. The Memory layer exercises the same
 * API contract as the SQLite layer.
 *
 * Test coverage:
 *  1.  record returns a non-empty uuid
 *  2.  record stores all fields (full roundtrip via getSession)
 *  3.  query with sessionId filter returns only that session
 *  4.  query with type filter returns only matching type
 *  5.  query with limit respects the cap
 *  6.  getSession returns entries in timestamp ASC order
 *  7.  deleteOlderThan removes entries older than cutoff
 *  8.  deleteOlderThan returns count of deleted rows
 *  9.  empty query returns empty array
 * 10.  two sessions don't bleed — getSession(A) returns only A's entries
 */

import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { Clock } from "../clock.js"
import { SessionHistoryService } from "./session-history.js"
import type { SessionRecordInput } from "./types.js"

// ── Helpers ───────────────────────────────────────────────────────────────────

const TestLayer = SessionHistoryService.Memory.pipe(
  // Provide a real clock (wall time is fine for tests)
  // Memory layer requires Clock.
)

/** Run an Effect with Memory + real Clock, asserting success. */
const run = <A>(
  eff: Effect.Effect<A, unknown, SessionHistoryService | Clock>,
): Promise<A> =>
  Effect.runPromise(
    eff.pipe(
      Effect.provide(SessionHistoryService.Memory),
      Effect.provide(Clock.Default),
    ),
  )

/** Minimal valid SessionRecordInput. Spread to override individual fields. */
const base: SessionRecordInput = {
  type: "user",
  entrypoint: "discord",
  sessionId: "sess-default",
  timestamp: new Date("2025-01-01T00:00:00.000Z").toISOString(),
  textContent: "Hello world",
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("SessionHistoryService (Memory layer)", () => {
  it("1. record returns a non-empty uuid string", async () => {
    const uuid = await run(
      Effect.gen(function* () {
        const svc = yield* SessionHistoryService
        return yield* svc.record(base)
      }),
    )
    expect(typeof uuid).toBe("string")
    expect(uuid.length).toBeGreaterThan(0)
  })

  it("2. record stores all fields — roundtrip via getSession", async () => {
    const input: SessionRecordInput = {
      type: "assistant",
      entrypoint: "telegram",
      sessionId: "sess-fields",
      parentUuid: "parent-uuid-abc",
      timestamp: new Date("2025-03-15T12:00:00.000Z").toISOString(),
      requestId: "req-1",
      toolUseId: "tu-1",
      textContent: "Full field test",
      toolName: "Read",
      skillName: "advisor",
    }

    const rows = await run(
      Effect.gen(function* () {
        const svc = yield* SessionHistoryService
        yield* svc.record(input)
        return yield* svc.getSession("sess-fields")
      }),
    )

    expect(rows).toHaveLength(1)
    const r = rows[0]!
    expect(r.type).toBe("assistant")
    expect(r.entrypoint).toBe("telegram")
    expect(r.sessionId).toBe("sess-fields")
    expect(r.parentUuid).toBe("parent-uuid-abc")
    expect(r.timestamp).toBe(input.timestamp)
    expect(r.requestId).toBe("req-1")
    expect(r.toolUseId).toBe("tu-1")
    expect(r.textContent).toBe("Full field test")
    expect(r.toolName).toBe("Read")
    expect(r.skillName).toBe("advisor")
    // Generated fields
    expect(typeof r.uuid).toBe("string")
    expect(r.uuid.length).toBeGreaterThan(0)
    expect(typeof r.created_at).toBe("string")
    expect(r.created_at.length).toBeGreaterThan(0)
  })

  it("3. query with sessionId filter returns only that session", async () => {
    const rows = await run(
      Effect.gen(function* () {
        const svc = yield* SessionHistoryService
        yield* svc.record({ ...base, sessionId: "sess-A", textContent: "A1" })
        yield* svc.record({ ...base, sessionId: "sess-A", textContent: "A2" })
        yield* svc.record({ ...base, sessionId: "sess-B", textContent: "B1" })
        return yield* svc.query({ sessionId: "sess-A" })
      }),
    )

    expect(rows).toHaveLength(2)
    for (const r of rows) expect(r.sessionId).toBe("sess-A")
  })

  it("4. query with type filter returns only matching type", async () => {
    const rows = await run(
      Effect.gen(function* () {
        const svc = yield* SessionHistoryService
        yield* svc.record({ ...base, type: "user", textContent: "u1" })
        yield* svc.record({ ...base, type: "assistant", textContent: "a1" })
        yield* svc.record({ ...base, type: "assistant", textContent: "a2" })
        yield* svc.record({ ...base, type: "system", textContent: "s1" })
        return yield* svc.query({ type: "assistant" })
      }),
    )

    expect(rows).toHaveLength(2)
    for (const r of rows) expect(r.type).toBe("assistant")
  })

  it("5. query with limit respects the cap", async () => {
    const rows = await run(
      Effect.gen(function* () {
        const svc = yield* SessionHistoryService
        // Insert 5 entries
        for (let i = 0; i < 5; i++) {
          yield* svc.record({ ...base, textContent: `msg-${i}` })
        }
        return yield* svc.query({ limit: 3 })
      }),
    )

    expect(rows).toHaveLength(3)
  })

  it("6. getSession returns entries in timestamp ASC order", async () => {
    const t1 = new Date("2025-01-01T10:00:00.000Z").toISOString()
    const t2 = new Date("2025-01-01T11:00:00.000Z").toISOString()
    const t3 = new Date("2025-01-01T12:00:00.000Z").toISOString()

    const rows = await run(
      Effect.gen(function* () {
        const svc = yield* SessionHistoryService
        // Insert in reverse order to verify sorting
        yield* svc.record({ ...base, sessionId: "sess-order", timestamp: t3, textContent: "C" })
        yield* svc.record({ ...base, sessionId: "sess-order", timestamp: t1, textContent: "A" })
        yield* svc.record({ ...base, sessionId: "sess-order", timestamp: t2, textContent: "B" })
        return yield* svc.getSession("sess-order")
      }),
    )

    expect(rows).toHaveLength(3)
    expect(rows[0]!.timestamp).toBe(t1)
    expect(rows[1]!.timestamp).toBe(t2)
    expect(rows[2]!.timestamp).toBe(t3)
    expect(rows[0]!.textContent).toBe("A")
    expect(rows[1]!.textContent).toBe("B")
    expect(rows[2]!.textContent).toBe("C")
  })

  it("7. deleteOlderThan removes entries older than cutoff", async () => {
    const old = new Date("2020-01-01T00:00:00.000Z").toISOString()
    const recent = new Date("2030-01-01T00:00:00.000Z").toISOString()
    const cutoffMs = new Date("2025-01-01T00:00:00.000Z").getTime()

    const remaining = await run(
      Effect.gen(function* () {
        const svc = yield* SessionHistoryService
        yield* svc.record({ ...base, sessionId: "sess-del", timestamp: old, textContent: "old" })
        yield* svc.record({ ...base, sessionId: "sess-del", timestamp: recent, textContent: "recent" })
        yield* svc.deleteOlderThan(cutoffMs)
        return yield* svc.getSession("sess-del")
      }),
    )

    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.textContent).toBe("recent")
  })

  it("8. deleteOlderThan returns count of deleted rows", async () => {
    const old1 = new Date("2020-01-01T00:00:00.000Z").toISOString()
    const old2 = new Date("2021-06-15T00:00:00.000Z").toISOString()
    const recent = new Date("2030-01-01T00:00:00.000Z").toISOString()
    const cutoffMs = new Date("2025-01-01T00:00:00.000Z").getTime()

    const count = await run(
      Effect.gen(function* () {
        const svc = yield* SessionHistoryService
        yield* svc.record({ ...base, timestamp: old1, textContent: "old1" })
        yield* svc.record({ ...base, timestamp: old2, textContent: "old2" })
        yield* svc.record({ ...base, timestamp: recent, textContent: "new" })
        return yield* svc.deleteOlderThan(cutoffMs)
      }),
    )

    expect(count).toBe(2)
  })

  it("9. empty query returns empty array when store is empty", async () => {
    const rows = await run(
      Effect.gen(function* () {
        const svc = yield* SessionHistoryService
        return yield* svc.query({})
      }),
    )

    expect(rows).toHaveLength(0)
  })

  it("10. two sessions don't bleed — getSession(A) returns only A's entries", async () => {
    const result = await run(
      Effect.gen(function* () {
        const svc = yield* SessionHistoryService
        // Insert 3 for A, 2 for B
        yield* svc.record({ ...base, sessionId: "sess-bleed-A", textContent: "A1" })
        yield* svc.record({ ...base, sessionId: "sess-bleed-B", textContent: "B1" })
        yield* svc.record({ ...base, sessionId: "sess-bleed-A", textContent: "A2" })
        yield* svc.record({ ...base, sessionId: "sess-bleed-B", textContent: "B2" })
        yield* svc.record({ ...base, sessionId: "sess-bleed-A", textContent: "A3" })
        const a = yield* svc.getSession("sess-bleed-A")
        const b = yield* svc.getSession("sess-bleed-B")
        return { a, b }
      }),
    )

    expect(result.a).toHaveLength(3)
    expect(result.b).toHaveLength(2)
    for (const r of result.a) expect(r.sessionId).toBe("sess-bleed-A")
    for (const r of result.b) expect(r.sessionId).toBe("sess-bleed-B")
  })
})
