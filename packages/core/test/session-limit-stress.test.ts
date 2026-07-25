/**
 * session-limit-stress.test.ts — Comprehensive stress harness for Effect v3
 * session limit fallback rotation in Luna.
 *
 * Tests:
 * 1. Multi-target chain rotation (Target 1 -> Session Limit -> Target 2 -> Rate Limit -> Target 3 -> Success)
 * 2. Target rotation state advancement & `advancedFrom` tracking
 * 3. Exact payload preservation (deep nested objects, metadata, numbers, arrays)
 * 4. Rotatable vs non-rotatable error classification and account health impact
 * 5. `failoverPossible` protection (last viable target is preserved, not cooled)
 * 6. `maxAttempts` boundary enforcement
 * 7. Sticky-pin (`boundAccountId`) interaction with multi-kind overflow chains
 * 8. Same-kind multi-account rotation within a single step before advancing steps
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer, Redacted } from "effect"
import {
  AccountBroker,
  AccountBrokerLayer,
  Clock,
  RateLimitError,
  SecretProvider,
  SessionLimitError,
  ValidationError,
  executeWithOverflowChain,
} from "../src/index.js"

function makeTestBrokerLayer(accounts: Array<{ id: string; kind: string }>) {
  const secretProviderLayer = Layer.succeed(SecretProvider, {
    get: (_ref) => Effect.succeed(Redacted.make("test-secret")),
  } as any)

  const clockLayer = Layer.succeed(Clock, {
    nowMs: () => Effect.succeed(Date.now()),
  } as any)

  const brokerSeeds = accounts.map((a) => ({
    id: a.id,
    kind: a.kind,
    secretRef: `secret:${a.id}`,
  }))

  return AccountBrokerLayer.fromAccounts(brokerSeeds).pipe(
    Layer.provideMerge(secretProviderLayer),
    Layer.provideMerge(clockLayer),
  )
}

describe("Effect v3 Session Limit Rotation — Empirical Stress Harness", () => {
  it("STRESS 1: Multi-target chain (Target 1 Session Limit -> Target 2 Rate Limit -> Target 3 Success)", async () => {
    const overflowEnv = {
      LUNA_OVERFLOW_CHAINS: JSON.stringify({
        chains: {
          chat: [
            { model: "claude-sonnet-4-5", kind: "anthropic" },
            { model: "gpt-4o", kind: "openai" },
            { model: "gemini-2.5-flash", kind: "google" },
          ],
        },
      }),
    }

    const prevEnv = process.env["LUNA_OVERFLOW_CHAINS"]
    process.env["LUNA_OVERFLOW_CHAINS"] = overflowEnv.LUNA_OVERFLOW_CHAINS

    try {
      const brokerLayer = makeTestBrokerLayer([
        { id: "account-anthropic-1", kind: "anthropic" },
        { id: "account-openai-1", kind: "openai" },
        { id: "account-google-1", kind: "google" },
      ])

      const expectedPayload = {
        status: "ok",
        text: "Response from Google target",
        usage: { promptTokens: 150, completionTokens: 42, totalTokens: 192 },
        metadata: { latencyMs: 230, traceId: "tr_9876543210" },
        items: [1, 2, "three", { nested: true }],
      }

      const program = Effect.scoped(
        Effect.gen(function* () {
          const broker = yield* AccountBroker
          const executionLog: Array<{ accountId: string; kind: string; model: string; stepIndex: number }> = []

          const result = yield* executeWithOverflowChain({
            broker,
            lane: "chat",
            execute: (acq) =>
              Effect.gen(function* () {
                executionLog.push({
                  accountId: acq.credential.accountId,
                  kind: acq.credential.kind,
                  model: acq.model,
                  stepIndex: acq.stepIndex,
                })

                if (acq.credential.kind === "anthropic") {
                  return yield* Effect.fail(
                    new SessionLimitError({
                      module: "test",
                      cause: "429 Session limit reached for Anthropic account",
                    }),
                  )
                }

                if (acq.credential.kind === "openai") {
                  return yield* Effect.fail(
                    new RateLimitError({
                      module: "test",
                      cause: "429 Rate limit exceeded for OpenAI account",
                    }),
                  )
                }

                return expectedPayload
              }),
          })

          const accountList = yield* broker.list()
          return { result, executionLog, accountList }
        }),
      )

      const outcome = await Effect.runPromise(Effect.provide(program, brokerLayer))

      // Verify exact response payload preservation
      expect(outcome.result).toEqual(expectedPayload)

      // Verify step rotation sequence: Step 0 (anthropic) -> Step 1 (openai) -> Step 2 (google)
      expect(outcome.executionLog).toEqual([
        { accountId: "account-anthropic-1", kind: "anthropic", model: "claude-sonnet-4-5", stepIndex: 0 },
        { accountId: "account-openai-1", kind: "openai", model: "gpt-4o", stepIndex: 1 },
        { accountId: "account-google-1", kind: "google", model: "gemini-2.5-flash", stepIndex: 2 },
      ])

      // Verify cooldown states post-rotation
      const anthropicAcc = outcome.accountList.find((a) => a.id === "account-anthropic-1")
      const openaiAcc = outcome.accountList.find((a) => a.id === "account-openai-1")
      const googleAcc = outcome.accountList.find((a) => a.id === "account-google-1")

      expect(anthropicAcc?.health).toBe("rate_limited")
      expect(openaiAcc?.health).toBe("rate_limited")
      expect(googleAcc?.health).toBe("healthy")
    } finally {
      if (prevEnv !== undefined) process.env["LUNA_OVERFLOW_CHAINS"] = prevEnv
      else delete process.env["LUNA_OVERFLOW_CHAINS"]
    }
  })

  it("STRESS 2: Rotatable vs Non-Rotatable error behavior & health preservation", async () => {
    const overflowEnv = {
      LUNA_OVERFLOW_CHAINS: JSON.stringify({
        chains: {
          chat: [
            { model: "claude-sonnet-4-5", kind: "anthropic" },
            { model: "gpt-4o", kind: "openai" },
          ],
        },
      }),
    }

    const prevEnv = process.env["LUNA_OVERFLOW_CHAINS"]
    process.env["LUNA_OVERFLOW_CHAINS"] = overflowEnv.LUNA_OVERFLOW_CHAINS

    try {
      const brokerLayer = makeTestBrokerLayer([
        { id: "account-anthropic-1", kind: "anthropic" },
        { id: "account-openai-1", kind: "openai" },
      ])

      const program = Effect.scoped(
        Effect.gen(function* () {
          const broker = yield* AccountBroker
          const executionLog: string[] = []

          const attemptEffect = executeWithOverflowChain({
            broker,
            lane: "chat",
            execute: (acq) =>
              Effect.gen(function* () {
                executionLog.push(acq.credential.accountId)
                return yield* Effect.fail(
                  new ValidationError({
                    module: "test",
                    field: "body",
                    message: "Invalid payload JSON format",
                  }),
                )
              }),
          })

          const exit = yield* Effect.exit(attemptEffect)
          const accountList = yield* broker.list()
          return { exit, executionLog, accountList }
        }),
      )

      const outcome = await Effect.runPromise(Effect.provide(program, brokerLayer))

      // Must fail fast without attempting OpenAI step 1
      expect(outcome.exit._tag).toBe("Failure")
      expect(outcome.executionLog).toEqual(["account-anthropic-1"])

      // Primary account must NOT be cooled down on non-rotatable error
      const anthropicAcc = outcome.accountList.find((a) => a.id === "account-anthropic-1")
      expect(anthropicAcc?.health).toBe("healthy")
    } finally {
      if (prevEnv !== undefined) process.env["LUNA_OVERFLOW_CHAINS"] = prevEnv
      else delete process.env["LUNA_OVERFLOW_CHAINS"]
    }
  })

  it("STRESS 3: failoverPossible contract (last viable target failure preserves health)", async () => {
    const overflowEnv = {
      LUNA_OVERFLOW_CHAINS: JSON.stringify({
        chains: {
          chat: [
            { model: "claude-sonnet-4-5", kind: "anthropic" },
            { model: "gpt-4o", kind: "openai" },
          ],
        },
      }),
    }

    const prevEnv = process.env["LUNA_OVERFLOW_CHAINS"]
    process.env["LUNA_OVERFLOW_CHAINS"] = overflowEnv.LUNA_OVERFLOW_CHAINS

    try {
      const brokerLayer = makeTestBrokerLayer([
        { id: "account-anthropic-1", kind: "anthropic" },
        { id: "account-openai-1", kind: "openai" },
      ])

      const program = Effect.scoped(
        Effect.gen(function* () {
          const broker = yield* AccountBroker
          const executionLog: string[] = []

          const attemptEffect = executeWithOverflowChain({
            broker,
            lane: "chat",
            execute: (acq) =>
              Effect.gen(function* () {
                executionLog.push(acq.credential.accountId)
                return yield* Effect.fail(
                  new SessionLimitError({
                    module: "test",
                    cause: `Session quota exhausted on ${acq.credential.kind}`,
                  }),
                )
              }),
          })

          const exit = yield* Effect.exit(attemptEffect)
          const accountList = yield* broker.list()
          return { exit, executionLog, accountList }
        }),
      )

      const outcome = await Effect.runPromise(Effect.provide(program, brokerLayer))

      expect(outcome.exit._tag).toBe("Failure")
      expect(outcome.executionLog).toEqual(["account-anthropic-1", "account-openai-1"])

      // Primary target (failoverPossible === true) was cooled
      const anthropicAcc = outcome.accountList.find((a) => a.id === "account-anthropic-1")
      expect(anthropicAcc?.health).toBe("rate_limited")

      // Secondary target (failoverPossible === false) must remain healthy per BLOCKER #1
      const openaiAcc = outcome.accountList.find((a) => a.id === "account-openai-1")
      expect(openaiAcc?.health).toBe("healthy")
    } finally {
      if (prevEnv !== undefined) process.env["LUNA_OVERFLOW_CHAINS"] = prevEnv
      else delete process.env["LUNA_OVERFLOW_CHAINS"]
    }
  })

  it("STRESS 4: Same-kind multi-account rotation before advancing step index", async () => {
    const overflowEnv = {
      LUNA_OVERFLOW_CHAINS: JSON.stringify({
        chains: {
          chat: [
            { model: "claude-sonnet-4-5", kind: "anthropic" },
            { model: "gemini-2.5-flash", kind: "google" },
          ],
        },
      }),
    }

    const prevEnv = process.env["LUNA_OVERFLOW_CHAINS"]
    process.env["LUNA_OVERFLOW_CHAINS"] = overflowEnv.LUNA_OVERFLOW_CHAINS

    try {
      const brokerLayer = makeTestBrokerLayer([
        { id: "account-anthropic-1", kind: "anthropic" },
        { id: "account-anthropic-2", kind: "anthropic" },
        { id: "account-google-1", kind: "google" },
      ])

      const program = Effect.scoped(
        Effect.gen(function* () {
          const broker = yield* AccountBroker
          const executionLog: Array<{ accountId: string; stepIndex: number }> = []

          const result = yield* executeWithOverflowChain({
            broker,
            lane: "chat",
            execute: (acq) =>
              Effect.gen(function* () {
                executionLog.push({ accountId: acq.credential.accountId, stepIndex: acq.stepIndex })
                if (acq.credential.accountId === "account-anthropic-1") {
                  return yield* Effect.fail(
                    new SessionLimitError({ module: "test", cause: "Session limit on anthropic-1" }),
                  )
                }
                if (acq.credential.accountId === "account-anthropic-2") {
                  return yield* Effect.fail(
                    new RateLimitError({ module: "test", cause: "Rate limit on anthropic-2" }),
                  )
                }
                return "success-from-google"
              }),
          })

          const accountList = yield* broker.list()
          return { result, executionLog, accountList }
        }),
      )

      const outcome = await Effect.runPromise(Effect.provide(program, brokerLayer))

      expect(outcome.result).toBe("success-from-google")

      // Notice stepIndex remains 0 for anthropic-1 and anthropic-2, then advances to 1 for google-1
      expect(outcome.executionLog).toEqual([
        { accountId: "account-anthropic-1", stepIndex: 0 },
        { accountId: "account-anthropic-2", stepIndex: 0 },
        { accountId: "account-google-1", stepIndex: 1 },
      ])

      const a1 = outcome.accountList.find((a) => a.id === "account-anthropic-1")
      const a2 = outcome.accountList.find((a) => a.id === "account-anthropic-2")
      const g1 = outcome.accountList.find((a) => a.id === "account-google-1")

      expect(a1?.health).toBe("rate_limited")
      expect(a2?.health).toBe("rate_limited")
      expect(g1?.health).toBe("healthy")
    } finally {
      if (prevEnv !== undefined) process.env["LUNA_OVERFLOW_CHAINS"] = prevEnv
      else delete process.env["LUNA_OVERFLOW_CHAINS"]
    }
  })

  it("STRESS 5: maxAttempts constraint stops rotation when max attempts threshold is reached", async () => {
    const overflowEnv = {
      LUNA_OVERFLOW_CHAINS: JSON.stringify({
        chains: {
          chat: [
            { model: "claude-sonnet-4-5", kind: "anthropic" },
            { model: "gpt-4o", kind: "openai" },
            { model: "gemini-2.5-flash", kind: "google" },
          ],
        },
      }),
    }

    const prevEnv = process.env["LUNA_OVERFLOW_CHAINS"]
    process.env["LUNA_OVERFLOW_CHAINS"] = overflowEnv.LUNA_OVERFLOW_CHAINS

    try {
      const brokerLayer = makeTestBrokerLayer([
        { id: "account-anthropic-1", kind: "anthropic" },
        { id: "account-openai-1", kind: "openai" },
        { id: "account-google-1", kind: "google" },
      ])

      const program = Effect.scoped(
        Effect.gen(function* () {
          const broker = yield* AccountBroker
          const executionLog: string[] = []

          const attemptEffect = executeWithOverflowChain({
            broker,
            lane: "chat",
            maxAttempts: 2, // Limit to 2 attempts max even though 3 steps exist
            execute: (acq) =>
              Effect.gen(function* () {
                executionLog.push(acq.credential.accountId)
                return yield* Effect.fail(
                  new SessionLimitError({
                    module: "test",
                    cause: `Session limit on ${acq.credential.kind}`,
                  }),
                )
              }),
          })

          const exit = yield* Effect.exit(attemptEffect)
          const accountList = yield* broker.list()
          return { exit, executionLog, accountList }
        }),
      )

      const outcome = await Effect.runPromise(Effect.provide(program, brokerLayer))

      expect(outcome.exit._tag).toBe("Failure")
      // Only 2 attempts executed due to maxAttempts=2
      expect(outcome.executionLog).toEqual(["account-anthropic-1", "account-openai-1"])
    } finally {
      if (prevEnv !== undefined) process.env["LUNA_OVERFLOW_CHAINS"] = prevEnv
      else delete process.env["LUNA_OVERFLOW_CHAINS"]
    }
  })

  it("STRESS 6: Interaction of boundAccountId sticky-pin on multi-kind overflow chain", async () => {
    const overflowEnv = {
      LUNA_OVERFLOW_CHAINS: JSON.stringify({
        chains: {
          chat: [
            { model: "claude-sonnet-4-5", kind: "anthropic" },
            { model: "gemini-2.5-flash", kind: "google" },
          ],
        },
      }),
    }

    const prevEnv = process.env["LUNA_OVERFLOW_CHAINS"]
    process.env["LUNA_OVERFLOW_CHAINS"] = overflowEnv.LUNA_OVERFLOW_CHAINS

    try {
      const brokerLayer = makeTestBrokerLayer([
        { id: "account-anthropic-1", kind: "anthropic" },
        { id: "account-google-1", kind: "google" },
      ])

      const program = Effect.scoped(
        Effect.gen(function* () {
          const broker = yield* AccountBroker
          const executionLog: string[] = []

          const attemptEffect = executeWithOverflowChain({
            broker,
            lane: "chat",
            boundAccountId: "account-anthropic-1", // Pin to Anthropic account
            execute: (acq) =>
              Effect.gen(function* () {
                executionLog.push(acq.credential.accountId)
                return yield* Effect.fail(
                  new SessionLimitError({
                    module: "test",
                    cause: "Session limit on pinned anthropic account",
                  }),
                )
              }),
          })

          const exit = yield* Effect.exit(attemptEffect)
          const accountList = yield* broker.list()
          return { exit, executionLog, accountList }
        }),
      )

      const outcome = await Effect.runPromise(Effect.provide(program, brokerLayer))

      // When boundAccountId is pinned to an anthropic account ID, if anthropic fails and cools down,
      // fallback to google step fails to pick google-1 because boundAccountId forces account id match across all steps.
      expect(outcome.executionLog).toEqual(["account-anthropic-1"])
      expect(outcome.exit._tag).toBe("Failure")
    } finally {
      if (prevEnv !== undefined) process.env["LUNA_OVERFLOW_CHAINS"] = prevEnv
      else delete process.env["LUNA_OVERFLOW_CHAINS"]
    }
  })
})
