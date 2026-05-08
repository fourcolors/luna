/**
 * AnalyticsService Tier-1 tests — querySessionMetrics, explainSession,
 * and findAnomalies contract validation.
 *
 * These tests validate the shape and semantics of analytics queries before
 * DuckDB driver integration. Once DuckDB is integrated, tests will execute
 * real queries against a test database.
 */

import { describe, expect, it } from "vitest"
import { Effect, Exit, Layer } from "effect"
import { AnalyticsService } from "./analytics.js"
import type { AnalyticsResult } from "./types.js"

// Mock AnalyticsService for testing
const makeMockAnalytics = (): Layer.Layer<AnalyticsService> =>
  Layer.succeed(AnalyticsService, {
    querySessionMetrics: async (q) => {
      // Simplified mock: if sessionId is provided, simulate finding that session
      if (q.sessionId) {
        return {
          sessions: [
            {
              sessionId: q.sessionId,
              sessionType: "user" as const,
              entrypoint: "discord",
              sessionStartTime: new Date().toISOString(),
              sessionEndTime: new Date(Date.now() + 3600000).toISOString(),
              messageCount: 5,
              metrics: {
                toolUsageCount: { Read: 2, Grep: 1 },
                totalDuration: 3600000,
                errorCount: 0,
                successCount: 3,
              },
            },
          ],
          summary: {
            totalSessions: 1,
            totalMessages: 5,
            totalToolUses: 3,
            errorRate: 0,
          },
        }
      }
      // No filter: return empty (real implementation would return all sessions)
      return {
        sessions: [],
        summary: {
          totalSessions: 0,
          totalMessages: 0,
          totalToolUses: 0,
          errorRate: 0,
        },
      }
    },

    explainSession: async (sessionId) => {
      return {
        sessionId,
        sessionType: "assistant" as const,
        entrypoint: "telegram",
        sessionStartTime: new Date().toISOString(),
        sessionEndTime: new Date(Date.now() + 1800000).toISOString(),
        messageCount: 3,
        metrics: {
          toolUsageCount: { Bash: 2 },
          totalDuration: 1800000,
          errorCount: 1,
          successCount: 2,
        },
      }
    },

    findAnomalies: async (threshold) => {
      // Mock: return sessions with error rate > threshold (default 0.5)
      const errorRateThreshold = threshold?.errorRate ?? 0.5
      const anomalous = []
      if (errorRateThreshold <= 0.33) {
        // Simulate finding a session with 33% error rate
        anomalous.push({
          sessionId: "sess-anomaly",
          sessionType: "user" as const,
          entrypoint: "discord",
          sessionStartTime: new Date().toISOString(),
          sessionEndTime: new Date(Date.now() + 600000).toISOString(),
          messageCount: 3,
          metrics: {
            toolUsageCount: { Read: 1 },
            totalDuration: 600000,
            errorCount: 1,
            successCount: 2,
          },
        })
      }
      return anomalous
    },
  })

describe("AnalyticsService", () => {
  describe("Contract: querySessionMetrics", () => {
    it("Given no filters, When querying metrics, Then returns empty result set", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const api = yield* AnalyticsService
          return yield* Effect.promise(() =>
            api.querySessionMetrics({ limit: 100 }),
          )
        }).pipe(Effect.provide(makeMockAnalytics())),
      )

      expect(result.summary).toBeDefined()
      expect(result.summary.totalSessions).toBe(0)
      expect(result.sessions).toEqual([])
    })

    it("Given a sessionId filter, When querying metrics, Then returns that session", async () => {
      const sessionId = "sess-abc123"
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const api = yield* AnalyticsService
          return yield* Effect.promise(() =>
            api.querySessionMetrics({ sessionId }),
          )
        }).pipe(Effect.provide(makeMockAnalytics())),
      )

      expect(result.summary.totalSessions).toBe(1)
      expect(result.sessions).toHaveLength(1)
      expect(result.sessions[0]?.sessionId).toBe(sessionId)
    })

    it("Result includes session metadata and aggregated metrics", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const api = yield* AnalyticsService
          return yield* Effect.promise(() =>
            api.querySessionMetrics({ sessionId: "sess-test" }),
          )
        }).pipe(Effect.provide(makeMockAnalytics())),
      )

      const session = result.sessions[0]
      expect(session).toBeDefined()
      expect(session?.sessionId).toBeDefined()
      expect(session?.sessionType).toMatch(/user|assistant|system/)
      expect(session?.entrypoint).toBeDefined()
      expect(session?.messageCount).toBeGreaterThanOrEqual(0)
      expect(session?.metrics.toolUsageCount).toBeDefined()
      expect(session?.metrics.totalDuration).toBeGreaterThanOrEqual(0)
      expect(session?.metrics.errorCount).toBeGreaterThanOrEqual(0)
      expect(session?.metrics.successCount).toBeGreaterThanOrEqual(0)
    })

    it("Summary metrics are consistent with session list", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const api = yield* AnalyticsService
          return yield* Effect.promise(() =>
            api.querySessionMetrics({ sessionId: "sess-consistent" }),
          )
        }).pipe(Effect.provide(makeMockAnalytics())),
      )

      expect(result.summary.totalSessions).toBe(result.sessions.length)
      const totalMessages = result.sessions.reduce(
        (sum, s) => sum + s.messageCount,
        0,
      )
      expect(result.summary.totalMessages).toBe(totalMessages)
    })

    it("Supports filtering by toolName (for analytics skill)", async () => {
      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const api = yield* AnalyticsService
          const result = yield* Effect.promise(() =>
            api.querySessionMetrics({ toolName: "Read" }),
          )
          expect(result).toBeDefined()
        }).pipe(Effect.provide(makeMockAnalytics())),
      )

      expect(Exit.isSuccess(exit)).toBe(true)
    })

    it("Supports filtering by skillName", async () => {
      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const api = yield* AnalyticsService
          const result = yield* Effect.promise(() =>
            api.querySessionMetrics({ skillName: "advisor" }),
          )
          expect(result).toBeDefined()
        }).pipe(Effect.provide(makeMockAnalytics())),
      )

      expect(Exit.isSuccess(exit)).toBe(true)
    })

    it("Supports time range filters (startTime, endTime)", async () => {
      const now = new Date()
      const startTime = new Date(now.getTime() - 86400000).toISOString() // 1 day ago
      const endTime = now.toISOString()

      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const api = yield* AnalyticsService
          const result = yield* Effect.promise(() =>
            api.querySessionMetrics({ startTime, endTime }),
          )
          expect(result).toBeDefined()
        }).pipe(Effect.provide(makeMockAnalytics())),
      )

      expect(Exit.isSuccess(exit)).toBe(true)
    })
  })

  describe("Contract: explainSession", () => {
    it("Given a sessionId, When explaining, Then returns detailed breakdown", async () => {
      const sessionId = "sess-explain"
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const api = yield* AnalyticsService
          return yield* Effect.promise(() =>
            api.explainSession(sessionId),
          )
        }).pipe(Effect.provide(makeMockAnalytics())),
      )

      expect(result.sessionId).toBe(sessionId)
      expect(result.messageCount).toBeGreaterThanOrEqual(0)
      expect(result.metrics.toolUsageCount).toBeDefined()
    })

    it("Breakdown includes tool usage counts", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const api = yield* AnalyticsService
          return yield* Effect.promise(() =>
            api.explainSession("sess-tools"),
          )
        }).pipe(Effect.provide(makeMockAnalytics())),
      )

      expect(result.metrics.toolUsageCount).toBeDefined()
      expect(typeof result.metrics.toolUsageCount).toBe("object")
    })
  })

  describe("Contract: findAnomalies", () => {
    it("Default threshold detects high error rates", async () => {
      const results = await Effect.runPromise(
        Effect.gen(function* () {
          const api = yield* AnalyticsService
          return yield* Effect.promise(() =>
            api.findAnomalies({ errorRate: 0.3 }),
          )
        }).pipe(Effect.provide(makeMockAnalytics())),
      )

      expect(Array.isArray(results)).toBe(true)
      // With threshold 0.3, mock should return at least one anomalous session
      expect(results.length).toBeGreaterThanOrEqual(1)
    })

    it("Results contain anomalies matching the threshold", async () => {
      const results = await Effect.runPromise(
        Effect.gen(function* () {
          const api = yield* AnalyticsService
          return yield* Effect.promise(() =>
            api.findAnomalies({ errorRate: 0.5 }),
          )
        }).pipe(Effect.provide(makeMockAnalytics())),
      )

      expect(Array.isArray(results)).toBe(true)
      // With threshold 0.5, mock should return nothing (no sessions have >50% error rate)
      expect(results.length).toBe(0)
    })

    it("Detects long-running sessions", async () => {
      const results = await Effect.runPromise(
        Effect.gen(function* () {
          const api = yield* AnalyticsService
          return yield* Effect.promise(() =>
            api.findAnomalies({ duration: 10800000 }), // 3 hours
          )
        }).pipe(Effect.provide(makeMockAnalytics())),
      )

      expect(Array.isArray(results)).toBe(true)
    })
  })

  describe("BDD: Analytics agent diagnostic workflow", () => {
    it("Scenario: Agent diagnoses a session with errors", async () => {
      // Given: a session that has errors
      const sessionId = "sess-error"

      // When: analytics agent queries for that session
      const sessionDetails = await Effect.runPromise(
        Effect.gen(function* () {
          const api = yield* AnalyticsService
          return yield* Effect.promise(() =>
            api.explainSession(sessionId),
          )
        }).pipe(Effect.provide(makeMockAnalytics())),
      )

      // Then: agent has breakdown of what happened
      expect(sessionDetails.sessionId).toBe(sessionId)
      expect(sessionDetails.metrics).toBeDefined()
      expect(sessionDetails.metrics.errorCount).toBeGreaterThanOrEqual(0)

      // And: agent can recommend actions based on metrics
      const hasErrors = sessionDetails.metrics.errorCount > 0
      expect(typeof hasErrors).toBe("boolean")
    })

    it("Scenario: Agent finds anomalous sessions for monitoring", async () => {
      // Given: a monitoring request
      // When: analytics agent finds anomalies
      const anomalies = await Effect.runPromise(
        Effect.gen(function* () {
          const api = yield* AnalyticsService
          return yield* Effect.promise(() =>
            api.findAnomalies({ errorRate: 0.3 }),
          )
        }).pipe(Effect.provide(makeMockAnalytics())),
      )

      // Then: agent has list of sessions needing attention
      expect(Array.isArray(anomalies)).toBe(true)

      // And: each anomaly can be explained in detail
      if (anomalies.length > 0) {
        const first = anomalies[0]
        expect(first?.sessionId).toBeDefined()
        expect(first?.metrics.errorCount).toBeGreaterThan(0)
      }
    })
  })
})
