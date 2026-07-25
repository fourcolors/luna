/**
 * session-limit-rotation.test.ts — Core multi-tree rotation fallback tests
 * verifying Effect v3 session limit error classification and account broker target selection.
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer, Redacted } from "effect"
import {
  AccountBroker,
  AccountBrokerLayer,
  AllAccountsExhaustedError,
  Clock,
  SessionLimitError,
  SecretProvider,
  ValidationError,
  defaultIsRotatableError,
  executeWithOverflowChain,
  readOverflowConfig,
} from "../src/index.js"

function makeTestBrokerLayer(accounts: Array<{ id: string; kind: string }>) {
  const secretProviderLayer = Layer.succeed(SecretProvider, {
    get: (ref) => Effect.succeed(Redacted.make("test-secret")),
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

describe("Effect v3 Session Limit Rotation — executeWithOverflowChain", () => {
  it("classifies error with message 'maximum sessions reached' as rotatable error", () => {
    expect(defaultIsRotatableError(new Error("maximum sessions reached"))).toBe(true)
    expect(defaultIsRotatableError({ message: "Maximum sessions reached for account" })).toBe(true)
    expect(defaultIsRotatableError("maximum sessions reached")).toBe(true)
  })

  it("rotates seamlessly from primary Anthropic target to secondary Google target on session limit error", async () => {
    // Environment setup: overflow chain configured for lane "chat"
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

    // Set process.env temporarily for readOverflowConfig
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

          const result = yield* executeWithOverflowChain({
            broker,
            lane: "chat",
            execute: (acq) =>
              Effect.gen(function* () {
                executionLog.push(`${acq.credential.accountId}:${acq.credential.kind}:${acq.model}`)
                if (acq.credential.kind === "anthropic") {
                  return yield* Effect.fail(
                    new SessionLimitError({
                      module: "test",
                      cause: "429 Session limit reached for subscription tier",
                    }),
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
      expect(outcome.executionLog).toEqual([
        "account-anthropic-1:anthropic:claude-sonnet-4-5",
        "account-google-1:google:gemini-2.5-flash",
      ])

      // Verify Anthropic account entered rate_limited / cooldown state
      const anthropicAcc = outcome.accountList.find((a) => a.id === "account-anthropic-1")
      expect(anthropicAcc?.health).toBe("rate_limited")

      // Verify Google account remains healthy
      const googleAcc = outcome.accountList.find((a) => a.id === "account-google-1")
      expect(googleAcc?.health).toBe("healthy")
    } finally {
      if (prevEnv !== undefined) {
        process.env["LUNA_OVERFLOW_CHAINS"] = prevEnv
      } else {
        delete process.env["LUNA_OVERFLOW_CHAINS"]
      }
    }
  })

  it("rotates seamlessly when error message contains 'maximum sessions reached'", async () => {
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

          const result = yield* executeWithOverflowChain({
            broker,
            lane: "chat",
            execute: (acq) =>
              Effect.gen(function* () {
                executionLog.push(`${acq.credential.accountId}:${acq.credential.kind}:${acq.model}`)
                if (acq.credential.kind === "anthropic") {
                  return yield* Effect.fail({
                    message: "Maximum sessions reached for account",
                  })
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
      expect(outcome.executionLog).toEqual([
        "account-anthropic-1:anthropic:claude-sonnet-4-5",
        "account-google-1:google:gemini-2.5-flash",
      ])

      // Verify Anthropic account entered rate_limited state (session limit reported)
      const anthropicAcc = outcome.accountList.find((a) => a.id === "account-anthropic-1")
      expect(anthropicAcc?.health).toBe("rate_limited")

      // Verify Google account remains healthy
      const googleAcc = outcome.accountList.find((a) => a.id === "account-google-1")
      expect(googleAcc?.health).toBe("healthy")
    } finally {
      if (prevEnv !== undefined) {
        process.env["LUNA_OVERFLOW_CHAINS"] = prevEnv
      } else {
        delete process.env["LUNA_OVERFLOW_CHAINS"]
      }
    }
  })

  it("fails fast on non-rotatable error without cooling account or attempting rotation", async () => {
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
            execute: (acq) =>
              Effect.gen(function* () {
                executionLog.push(`${acq.credential.accountId}:${acq.credential.kind}`)
                return yield* Effect.fail(
                  new ValidationError({
                    module: "test",
                    field: "prompt",
                    message: "Invalid input prompt payload",
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
      expect(outcome.executionLog).toEqual(["account-anthropic-1:anthropic"])

      // Account must remain healthy (not cooled down on validation error)
      const anthropicAcc = outcome.accountList.find((a) => a.id === "account-anthropic-1")
      expect(anthropicAcc?.health).toBe("healthy")
    } finally {
      if (prevEnv !== undefined) {
        process.env["LUNA_OVERFLOW_CHAINS"] = prevEnv
      } else {
        delete process.env["LUNA_OVERFLOW_CHAINS"]
      }
    }
  })

  it("surfaces error when all targets in chain encounter session limit failures", async () => {
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
            execute: (acq) =>
              Effect.gen(function* () {
                executionLog.push(`${acq.credential.accountId}:${acq.credential.kind}`)
                return yield* Effect.fail(
                  new SessionLimitError({
                    module: "test",
                    cause: `Session limit reached on ${acq.credential.kind}`,
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
      expect(outcome.executionLog).toEqual([
        "account-anthropic-1:anthropic",
        "account-google-1:google",
      ])

      // Primary target (failoverPossible === true) is cooled; last target (failoverPossible === false) is preserved per BLOCKER #1
      const anthropicAcc = outcome.accountList.find((a) => a.id === "account-anthropic-1")
      const googleAcc = outcome.accountList.find((a) => a.id === "account-google-1")
      expect(anthropicAcc?.health).toBe("rate_limited")
      expect(googleAcc?.health).toBe("healthy")
    } finally {
      if (prevEnv !== undefined) {
        process.env["LUNA_OVERFLOW_CHAINS"] = prevEnv
      } else {
        delete process.env["LUNA_OVERFLOW_CHAINS"]
      }
    }
  })

  it("continues rotation pipeline even if broker.report fails (fire-and-forget fault tolerance)", async () => {
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
          const rawBroker = yield* AccountBroker
          const brokerWithFailingReport = {
            ...rawBroker,
            report: (params: any) =>
              rawBroker.report(params).pipe(
                Effect.zipRight(Effect.fail(new Error("Broker storage error during report"))),
              ),
          }

          const executionLog: string[] = []

          const result = yield* executeWithOverflowChain({
            broker: brokerWithFailingReport as any,
            lane: "chat",
            execute: (acq) =>
              Effect.gen(function* () {
                executionLog.push(`${acq.credential.accountId}:${acq.credential.kind}:${acq.model}`)
                if (acq.credential.kind === "anthropic") {
                  return yield* Effect.fail(
                    new SessionLimitError({
                      module: "test",
                      cause: "429 Session limit reached",
                    }),
                  )
                }
                return "success-from-google"
              }),
          })

          return { result, executionLog }
        }),
      )

      const outcome = await Effect.runPromise(Effect.provide(program, brokerLayer))

      expect(outcome.result).toBe("success-from-google")
      expect(outcome.executionLog).toEqual([
        "account-anthropic-1:anthropic:claude-sonnet-4-5",
        "account-google-1:google:gemini-2.5-flash",
      ])
    } finally {
      if (prevEnv !== undefined) {
        process.env["LUNA_OVERFLOW_CHAINS"] = prevEnv
      } else {
        delete process.env["LUNA_OVERFLOW_CHAINS"]
      }
    }
  })
})
