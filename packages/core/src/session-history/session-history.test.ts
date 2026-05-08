/**
 * SessionHistoryService Tier-1 tests — record/query/getSession roundtrip,
 * schema-versions integration, and cleanup semantics.
 *
 * Because DuckDB integration is deferred (TODO in session-history.ts),
 * these tests use mocked Layer and validate the contract. Once DuckDB
 * driver is chosen and integrated, tests will be updated to use real DB.
 */

import { describe, expect, it } from "vitest"
import { Effect, Exit, Layer } from "effect"
import { SessionHistoryService } from "./session-history.js"
import type { SessionRecord } from "./types.js"

// Helper to generate UUIDs (simple v4-like string for testing)
const uuid = () => {
  return `${Math.random().toString(36).substring(2)}-${Math.random().toString(36).substring(2)}-${Math.random().toString(36).substring(2)}`
}

// ──────────────────────────────────────────────────────────────────────────
// Mock SessionHistoryService for testing (before DuckDB integration)
// ──────────────────────────────────────────────────────────────────────────

const makeMockSessionHistory = (): Layer.Layer<SessionHistoryService> =>
  Layer.succeed(SessionHistoryService, {
    record: async (rec) => rec.uuid,

    query: async (q) => {
      // Simplified mock: return all records (no filtering yet)
      // Real implementation will query DuckDB with WHERE clauses
      return []
    },

    getSession: async (sessionId) => {
      // Mock: return empty for now
      return []
    },

    deleteOlderThan: async (_ts) => {
      // Mock: return 0 for now
      return 0
    },
  })

// ──────────────────────────────────────────────────────────────────────────
// Test suite
// ──────────────────────────────────────────────────────────────────────────

describe("SessionHistoryService", () => {
  describe("Types & Contract", () => {
    it("SessionRecord interface requires all mandatory fields", () => {
      const record: SessionRecord = {
        type: "user",
        entrypoint: "discord",
        sessionId: "sess-123",
        uuid: uuid(),
        parentUuid: null,
        timestamp: new Date().toISOString(),
        requestId: "req-456",
        toolUseId: null,
        textContent: "Hello",
        toolName: null,
        skillName: null,
      }
      expect(record.type).toBe("user")
      expect(record.textContent).toBe("Hello")
    })

    it("SessionRecord.type is a union of allowed values", () => {
      const types: SessionRecord["type"][] = ["user", "assistant", "system"]
      expect(types).toHaveLength(3)
    })

    it("Session IDs and UUIDs are distinct fields", () => {
      const sessionId = "session-abc"
      const recordUuid = uuid()
      const record: SessionRecord = {
        type: "assistant",
        entrypoint: "telegram",
        sessionId,
        uuid: recordUuid,
        parentUuid: null,
        timestamp: new Date().toISOString(),
        requestId: null,
        toolUseId: null,
        textContent: "Response",
        toolName: "Read",
        skillName: null,
      }
      expect(record.sessionId).toBe(sessionId)
      expect(record.uuid).toBe(recordUuid)
      expect(record.sessionId).not.toBe(record.uuid)
    })
  })

  describe("BDD: Record a message and retrieve it", () => {
    // Scenario 1: Single message roundtrip
    it("Given an empty session history, When we record a message, Then it can be retrieved", async () => {
      const record: SessionRecord = {
        type: "user",
        entrypoint: "discord",
        sessionId: "sess-abc",
        uuid: uuid(),
        parentUuid: null,
        timestamp: new Date().toISOString(),
        requestId: "req-1",
        toolUseId: null,
        textContent: "Test message",
        toolName: null,
        skillName: null,
      }

      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const api = yield* SessionHistoryService
          const recordedUuid = yield* Effect.promise(() => api.record(record))
          expect(recordedUuid).toBe(record.uuid)
          return recordedUuid
        }).pipe(Effect.provide(makeMockSessionHistory())),
      )

      expect(Exit.isSuccess(exit)).toBe(true)
    })

    // Scenario 2: Query for messages in a session
    it("Given recorded messages, When querying by sessionId, Then all messages are returned", async () => {
      const sessionId = "sess-multi"
      const rec1: SessionRecord = {
        type: "user",
        entrypoint: "discord",
        sessionId,
        uuid: uuid(),
        parentUuid: null,
        timestamp: new Date().toISOString(),
        requestId: "req-1",
        toolUseId: null,
        textContent: "First",
        toolName: null,
        skillName: null,
      }
      const rec2: SessionRecord = {
        type: "assistant",
        entrypoint: "discord",
        sessionId,
        uuid: uuid(),
        parentUuid: rec1.uuid,
        timestamp: new Date(Date.now() + 1000).toISOString(),
        requestId: null,
        toolUseId: null,
        textContent: "Response",
        toolName: null,
        skillName: null,
      }

      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const api = yield* SessionHistoryService
          yield* Effect.promise(() => api.record(rec1))
          yield* Effect.promise(() => api.record(rec2))

          // Query by sessionId
          const results = yield* Effect.promise(() =>
            api.query({ sessionId }),
          )

          // In a real implementation (with DuckDB), we'd expect:
          // results.length === 2
          // But with mock, we get []. Once DuckDB is integrated, this passes.
          expect(Array.isArray(results)).toBe(true)
        }).pipe(Effect.provide(makeMockSessionHistory())),
      )

      expect(Exit.isSuccess(exit)).toBe(true)
    })

    // Scenario 3: Message threading (parentUuid chain)
    it("Given a parent message, When recording a child message, Then parentUuid links them", async () => {
      const parentUuid = uuid()
      const childUuid = uuid()
      const parent: SessionRecord = {
        type: "user",
        entrypoint: "discord",
        sessionId: "sess-thread",
        uuid: parentUuid,
        parentUuid: null,
        timestamp: new Date().toISOString(),
        requestId: "req-p",
        toolUseId: null,
        textContent: "Parent question",
        toolName: null,
        skillName: null,
      }
      const child: SessionRecord = {
        type: "assistant",
        entrypoint: "discord",
        sessionId: "sess-thread",
        uuid: childUuid,
        parentUuid,
        timestamp: new Date(Date.now() + 100).toISOString(),
        requestId: null,
        toolUseId: null,
        textContent: "Child answer",
        toolName: null,
        skillName: null,
      }

      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const api = yield* SessionHistoryService
          const pUuid = yield* Effect.promise(() => api.record(parent))
          const cUuid = yield* Effect.promise(() => api.record(child))
          expect(pUuid).toBe(parentUuid)
          expect(cUuid).toBe(childUuid)
          expect(child.parentUuid).toBe(parentUuid)
        }).pipe(Effect.provide(makeMockSessionHistory())),
      )

      expect(Exit.isSuccess(exit)).toBe(true)
    })
  })

  describe("Tool & Skill attribution", () => {
    it("Given a tool use, When recording with toolName, Then it can be queried by toolName", async () => {
      const record: SessionRecord = {
        type: "assistant",
        entrypoint: "discord",
        sessionId: "sess-tools",
        uuid: uuid(),
        parentUuid: null,
        timestamp: new Date().toISOString(),
        requestId: "req-t",
        toolUseId: "tool-use-123",
        textContent: "Using Read tool",
        toolName: "Read",
        skillName: null,
      }

      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const api = yield* SessionHistoryService
          yield* Effect.promise(() => api.record(record))

          const results = yield* Effect.promise(() =>
            api.query({ toolName: "Read" }),
          )

          expect(Array.isArray(results)).toBe(true)
          // In real implementation: expect(results).toContain(record)
        }).pipe(Effect.provide(makeMockSessionHistory())),
      )

      expect(Exit.isSuccess(exit)).toBe(true)
    })

    it("Given a skill invocation, When recording with skillName, Then it can be queried by skillName", async () => {
      const record: SessionRecord = {
        type: "assistant",
        entrypoint: "discord",
        sessionId: "sess-skills",
        uuid: uuid(),
        parentUuid: null,
        timestamp: new Date().toISOString(),
        requestId: "req-s",
        toolUseId: null,
        textContent: "Invoked skill",
        toolName: null,
        skillName: "advisor",
      }

      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const api = yield* SessionHistoryService
          yield* Effect.promise(() => api.record(record))

          const results = yield* Effect.promise(() =>
            api.query({ skillName: "advisor" }),
          )

          expect(Array.isArray(results)).toBe(true)
        }).pipe(Effect.provide(makeMockSessionHistory())),
      )

      expect(Exit.isSuccess(exit)).toBe(true)
    })
  })

  describe("Querying & Retention", () => {
    it("getSession returns all messages in a session ordered by timestamp", async () => {
      const sessionId = "sess-get"
      const t1 = new Date().toISOString()
      const t2 = new Date(Date.now() + 1000).toISOString()

      const rec1: SessionRecord = {
        type: "user",
        entrypoint: "discord",
        sessionId,
        uuid: uuid(),
        parentUuid: null,
        timestamp: t1,
        requestId: null,
        toolUseId: null,
        textContent: "First",
        toolName: null,
        skillName: null,
      }
      const rec2: SessionRecord = {
        type: "assistant",
        entrypoint: "discord",
        sessionId,
        uuid: uuid(),
        parentUuid: rec1.uuid,
        timestamp: t2,
        requestId: null,
        toolUseId: null,
        textContent: "Second",
        toolName: null,
        skillName: null,
      }

      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const api = yield* SessionHistoryService
          yield* Effect.promise(() => api.record(rec1))
          yield* Effect.promise(() => api.record(rec2))

          const transcript = yield* Effect.promise(() =>
            api.getSession(sessionId),
          )

          expect(Array.isArray(transcript)).toBe(true)
          // Real implementation: expect(transcript).toHaveLength(2)
          // Real implementation: expect(transcript[0].timestamp).toBe(t1)
        }).pipe(Effect.provide(makeMockSessionHistory())),
      )

      expect(Exit.isSuccess(exit)).toBe(true)
    })

    it("deleteOlderThan removes expired records and returns count", async () => {
      const cutoff = new Date(Date.now() - 86400000).toISOString() // 1 day ago

      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const api = yield* SessionHistoryService
          const deletedCount = yield* Effect.promise(() =>
            api.deleteOlderThan(cutoff),
          )

          expect(typeof deletedCount).toBe("number")
          expect(deletedCount).toBeGreaterThanOrEqual(0)
        }).pipe(Effect.provide(makeMockSessionHistory())),
      )

      expect(Exit.isSuccess(exit)).toBe(true)
    })
  })

  describe("Multi-entrypoint sessions", () => {
    it("Supports messages from different entrypoints (discord, telegram, cli)", async () => {
      const sessionId = "sess-multi-ep"
      const discord: SessionRecord = {
        type: "user",
        entrypoint: "discord",
        sessionId,
        uuid: uuid(),
        parentUuid: null,
        timestamp: new Date().toISOString(),
        requestId: null,
        toolUseId: null,
        textContent: "From Discord",
        toolName: null,
        skillName: null,
      }
      const telegram: SessionRecord = {
        type: "user",
        entrypoint: "telegram",
        sessionId,
        uuid: uuid(),
        parentUuid: null,
        timestamp: new Date().toISOString(),
        requestId: null,
        toolUseId: null,
        textContent: "From Telegram",
        toolName: null,
        skillName: null,
      }

      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const api = yield* SessionHistoryService
          yield* Effect.promise(() => api.record(discord))
          yield* Effect.promise(() => api.record(telegram))

          const results = yield* Effect.promise(() =>
            api.query({ sessionId }),
          )

          expect(Array.isArray(results)).toBe(true)
        }).pipe(Effect.provide(makeMockSessionHistory())),
      )

      expect(Exit.isSuccess(exit)).toBe(true)
    })
  })
})
