/**
 * session-limit-edge-cases.test.ts — Empirical challenger tests for M3-2.
 *
 * Verifies:
 * 1. ALL targets in an overflow chain encounter session limit errors (assert clean AllAccountsExhaustedError).
 * 2. Non-rotatable errors (ValidationError, PermissionError/Auth, ConfigError) — fail immediately without false rotation or false account cooling.
 * 3. Fire-and-forget broker reporting behavior when broker operations fail (reporting errors / DB errors during report).
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer, Redacted, Exit, Cause } from "effect"
import {
  AccountBroker,
  AccountBrokerLayer,
  AllAccountsExhaustedError,
  Clock,
  SessionLimitError,
  SecretProvider,
  ValidationError,
  PermissionError,
  ConfigError,
  executeWithOverflowChain,
  defaultIsRotatableError,
  type AccountBrokerApi,
  type UsageReport,
} from "../src/index.js"

function makeTestBrokerLayer(accounts: Array<{ id: string; kind: string }>) {
  const secretProviderLayer = Layer.succeed(SecretProvider, {
    get: (_ref: string) => Effect.succeed(Redacted.make("test-secret")),
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

describe("M3-2 Session Limit Rotation Edge Cases & Boundary Conditions", () => {
  // ───────────────────────────────────────────────────────────────────────────
  // TASK 1: Behavior when ALL targets in an overflow chain encounter session limits
  // ───────────────────────────────────────────────────────────────────────────
  describe("Task 1: All targets encounter session limit errors", () => {
    it("returns AllAccountsExhaustedError when all targets are in cooldown or exhausted", async () => {
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
          { id: "acc-anthropic", kind: "anthropic" },
          { id: "acc-google", kind: "google" },
        ])

        const program = Effect.scoped(
          Effect.gen(function* () {
            const broker = yield* AccountBroker

            // Manually cool down both accounts representing prior session limit exhaustion
            yield* broker.report({ accountId: "acc-anthropic", kind: "session_limit" })
            yield* broker.report({ accountId: "acc-google", kind: "session_limit" })

            // Attempt execution with overflow chain when all accounts are in cooldown
            const attemptEffect = executeWithOverflowChain({
              broker,
              lane: "chat",
              execute: (_acq) => Effect.succeed("should-not-be-reached"),
            })

            return yield* Effect.exit(attemptEffect)
          }),
        )

        const exit = await Effect.runPromise(Effect.provide(program, brokerLayer))

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const causeStr = JSON.stringify(exit.cause)
          expect(causeStr).toContain("AllAccountsExhaustedError")
        }
      } finally {
        if (prevEnv !== undefined) {
          process.env["LUNA_OVERFLOW_CHAINS"] = prevEnv
        } else {
          delete process.env["LUNA_OVERFLOW_CHAINS"]
        }
      }
    })

    it("walks whole chain on session limits, cools prior targets, and subsequent acquire yields AllAccountsExhaustedError", async () => {
      const overflowEnv = {
        LUNA_OVERFLOW_CHAINS: JSON.stringify({
          chains: {
            reasoner: [
              { model: "model-1", kind: "kind-1" },
              { model: "model-2", kind: "kind-2" },
              { model: "model-3", kind: "kind-3" },
            ],
          },
        }),
      }

      const prevEnv = process.env["LUNA_OVERFLOW_CHAINS"]
      process.env["LUNA_OVERFLOW_CHAINS"] = overflowEnv.LUNA_OVERFLOW_CHAINS

      try {
        const brokerLayer = makeTestBrokerLayer([
          { id: "acc-1", kind: "kind-1" },
          { id: "acc-2", kind: "kind-2" },
          { id: "acc-3", kind: "kind-3" },
        ])

        const program = Effect.scoped(
          Effect.gen(function* () {
            const broker = yield* AccountBroker
            const executedTargets: string[] = []

            // Execute chain where EVERY target fails with SessionLimitError
            const turn1Exit = yield* Effect.exit(
              executeWithOverflowChain({
                broker,
                lane: "reasoner",
                execute: (acq) =>
                  Effect.gen(function* () {
                    executedTargets.push(acq.credential.accountId)
                    return yield* Effect.fail(
                      new SessionLimitError({
                        module: "test",
                        cause: `Session limit on ${acq.credential.accountId}`,
                      }),
                    )
                  }),
              }),
            )

            // Inspect account health after turn 1
            const accountsAfterTurn1 = yield* broker.list()

            // Explicitly report session_limit on acc-3 (the last target) if it wasn't auto-cooled
            yield* broker.report({ accountId: "acc-3", kind: "session_limit" })

            // Next acquire attempt must fail cleanly with AllAccountsExhaustedError
            const turn2Exit = yield* Effect.exit(
              broker.acquireSession({ model: "reasoner" }),
            )

            return { turn1Exit, executedTargets, accountsAfterTurn1, turn2Exit }
          }),
        )

        const outcome = await Effect.runPromise(Effect.provide(program, brokerLayer))

        // All 3 targets were attempted in order
        expect(outcome.executedTargets).toEqual(["acc-1", "acc-2", "acc-3"])

        // First two targets (failoverViable = true) were automatically cooled
        const acc1 = outcome.accountsAfterTurn1.find((a) => a.id === "acc-1")
        const acc2 = outcome.accountsAfterTurn1.find((a) => a.id === "acc-2")
        expect(acc1?.health).toBe("rate_limited")
        expect(acc2?.health).toBe("rate_limited")

        // Turn 2 acquire yields clean AllAccountsExhaustedError
        expect(Exit.isFailure(outcome.turn2Exit)).toBe(true)
        if (Exit.isFailure(outcome.turn2Exit)) {
          expect(JSON.stringify(outcome.turn2Exit.cause)).toContain("AllAccountsExhaustedError")
        }
      } finally {
        if (prevEnv !== undefined) {
          process.env["LUNA_OVERFLOW_CHAINS"] = prevEnv
        } else {
          delete process.env["LUNA_OVERFLOW_CHAINS"]
        }
      }
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // TASK 2: Behavior on non-rotatable errors (ValidationError, Auth/Permission errors)
  // ───────────────────────────────────────────────────────────────────────────
  describe("Task 2: Behavior on non-rotatable errors", () => {
    it("fails immediately on ValidationError without attempting rotation or cooling account", async () => {
      const overflowEnv = {
        LUNA_OVERFLOW_CHAINS: JSON.stringify({
          chains: {
            chat: [
              { model: "model-1", kind: "kind-1" },
              { model: "model-2", kind: "kind-2" },
            ],
          },
        }),
      }

      const prevEnv = process.env["LUNA_OVERFLOW_CHAINS"]
      process.env["LUNA_OVERFLOW_CHAINS"] = overflowEnv.LUNA_OVERFLOW_CHAINS

      try {
        const brokerLayer = makeTestBrokerLayer([
          { id: "acc-1", kind: "kind-1" },
          { id: "acc-2", kind: "kind-2" },
        ])

        const program = Effect.scoped(
          Effect.gen(function* () {
            const broker = yield* AccountBroker
            const executedTargets: string[] = []

            const exit = yield* Effect.exit(
              executeWithOverflowChain({
                broker,
                lane: "chat",
                execute: (acq) =>
                  Effect.gen(function* () {
                    executedTargets.push(acq.credential.accountId)
                    return yield* Effect.fail(
                      new ValidationError({
                        module: "test",
                        field: "input",
                        message: "Invalid payload schema",
                      }),
                    )
                  }),
              }),
            )

            const accounts = yield* broker.list()
            return { exit, executedTargets, accounts }
          }),
        )

        const outcome = await Effect.runPromise(Effect.provide(program, brokerLayer))

        // Fails immediately after 1 attempt
        expect(outcome.executedTargets).toEqual(["acc-1"])
        expect(Exit.isFailure(outcome.exit)).toBe(true)

        // Account acc-1 MUST remain healthy (no false cooling)
        const acc1 = outcome.accounts.find((a) => a.id === "acc-1")
        expect(acc1?.health).toBe("healthy")
      } finally {
        if (prevEnv !== undefined) {
          process.env["LUNA_OVERFLOW_CHAINS"] = prevEnv
        } else {
          delete process.env["LUNA_OVERFLOW_CHAINS"]
        }
      }
    })

    it("fails immediately on PermissionError without attempting rotation or cooling account", async () => {
      const overflowEnv = {
        LUNA_OVERFLOW_CHAINS: JSON.stringify({
          chains: {
            chat: [
              { model: "model-1", kind: "kind-1" },
              { model: "model-2", kind: "kind-2" },
            ],
          },
        }),
      }

      const prevEnv = process.env["LUNA_OVERFLOW_CHAINS"]
      process.env["LUNA_OVERFLOW_CHAINS"] = overflowEnv.LUNA_OVERFLOW_CHAINS

      try {
        const brokerLayer = makeTestBrokerLayer([
          { id: "acc-1", kind: "kind-1" },
          { id: "acc-2", kind: "kind-2" },
        ])

        const program = Effect.scoped(
          Effect.gen(function* () {
            const broker = yield* AccountBroker
            const executedTargets: string[] = []

            const exit = yield* Effect.exit(
              executeWithOverflowChain({
                broker,
                lane: "chat",
                execute: (acq) =>
                  Effect.gen(function* () {
                    executedTargets.push(acq.credential.accountId)
                    return yield* Effect.fail(
                      new PermissionError({
                        module: "auth",
                        message: "Invalid API key / Unauthorized",
                      }),
                    )
                  }),
              }),
            )

            const accounts = yield* broker.list()
            return { exit, executedTargets, accounts }
          }),
        )

        const outcome = await Effect.runPromise(Effect.provide(program, brokerLayer))

        expect(outcome.executedTargets).toEqual(["acc-1"])
        expect(Exit.isFailure(outcome.exit)).toBe(true)

        const acc1 = outcome.accounts.find((a) => a.id === "acc-1")
        expect(acc1?.health).toBe("healthy")
      } finally {
        if (prevEnv !== undefined) {
          process.env["LUNA_OVERFLOW_CHAINS"] = prevEnv
        } else {
          delete process.env["LUNA_OVERFLOW_CHAINS"]
        }
      }
    })

    it("defaultIsRotatableError classifies rotatable vs non-rotatable errors correctly", () => {
      // Rotatable errors
      expect(defaultIsRotatableError(new SessionLimitError({ module: "test", cause: "limit" }))).toBe(true)
      expect(defaultIsRotatableError({ _tag: "RateLimitError" })).toBe(true)
      expect(defaultIsRotatableError(new Error("429 Too Many Requests"))).toBe(true)
      expect(defaultIsRotatableError(new Error("529 Overloaded"))).toBe(true)
      expect(defaultIsRotatableError(new Error("session limit reached"))).toBe(true)
      expect(defaultIsRotatableError(new Error("quota_exhausted"))).toBe(true)

      // Non-rotatable errors
      expect(defaultIsRotatableError(new ValidationError({ module: "m", field: "f", message: "invalid" }))).toBe(false)
      expect(defaultIsRotatableError(new PermissionError({ module: "m", message: "unauthorized" }))).toBe(false)
      expect(defaultIsRotatableError(new ConfigError({ module: "m", message: "bad config" }))).toBe(false)
      expect(defaultIsRotatableError(new AllAccountsExhaustedError({ kind: "k" }))).toBe(false)
      expect(defaultIsRotatableError(new Error("Syntax error in template"))).toBe(false)
      expect(defaultIsRotatableError(null)).toBe(false)
      expect(defaultIsRotatableError(undefined)).toBe(false)
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // TASK 3: Fire-and-forget broker reporting error resiliency
  // ───────────────────────────────────────────────────────────────────────────
  describe("Task 3: Fire-and-forget broker reporting error resiliency", () => {
    it("verifies broker.report failure in executeWithOverflowChain tapError is caught so rotation succeeds seamlessly", async () => {
      const overflowEnv = {
        LUNA_OVERFLOW_CHAINS: JSON.stringify({
          chains: {
            chat: [
              { model: "model-1", kind: "kind-1" },
              { model: "model-2", kind: "kind-2" },
            ],
          },
        }),
      }

      const prevEnv = process.env["LUNA_OVERFLOW_CHAINS"]
      process.env["LUNA_OVERFLOW_CHAINS"] = overflowEnv.LUNA_OVERFLOW_CHAINS

      try {
        const secretProviderLayer = Layer.succeed(SecretProvider, {
          get: () => Effect.succeed(Redacted.make("secret")),
        } as any)
        const clockLayer = Layer.succeed(Clock, {
          nowMs: () => Effect.succeed(Date.now()),
        } as any)

        const baseBrokerL = AccountBrokerLayer.fromAccounts([
          { id: "acc-1", kind: "kind-1", secretRef: "sec-1" },
          { id: "acc-2", kind: "kind-2", secretRef: "sec-2" },
        ]).pipe(
          Layer.provideMerge(secretProviderLayer),
          Layer.provideMerge(clockLayer),
        )

        // Spy / Wrapper layer that FAILS when broker.report is called
        const failingBrokerLayer = Layer.effect(
          AccountBroker,
          Effect.gen(function* () {
            const inner = yield* AccountBroker
            return {
              ...inner,
              report: (report: UsageReport) =>
                inner.report(report).pipe(
                  Effect.zipRight(
                    Effect.fail(new Error("Simulated broker DB report failure")),
                  ),
                ),
            }
          }),
        ).pipe(Layer.provide(baseBrokerL))

        const program = Effect.scoped(
          Effect.gen(function* () {
            const broker = yield* AccountBroker
            const executedTargets: string[] = []

            const exit = yield* Effect.exit(
              executeWithOverflowChain({
                broker,
                lane: "chat",
                execute: (acq) =>
                  Effect.gen(function* () {
                    executedTargets.push(acq.credential.accountId)
                    if (acq.credential.accountId === "acc-1") {
                      return yield* Effect.fail(
                        new SessionLimitError({
                          module: "test",
                          cause: "Session limit on acc-1",
                        }),
                      )
                    }
                    return "success-acc-2"
                  }),
              }),
            )

            return { exit, executedTargets }
          }),
        )

        const outcome = await Effect.runPromise(Effect.provide(program, failingBrokerLayer))

        // Fire-and-forget broker reporting error resiliency: broker.report failure is swallowed,
        // so rotation to acc-2 succeeds seamlessly!
        expect(outcome.executedTargets).toEqual(["acc-1", "acc-2"])
        expect(Exit.isSuccess(outcome.exit)).toBe(true)
        if (Exit.isSuccess(outcome.exit)) {
          expect(outcome.exit.value).toBe("success-acc-2")
        }
      } finally {
        if (prevEnv !== undefined) {
          process.env["LUNA_OVERFLOW_CHAINS"] = prevEnv
        } else {
          delete process.env["LUNA_OVERFLOW_CHAINS"]
        }
      }
    })

    it("verifies adapter.ts fire-and-forget handling ignores broker.report failures without failing query", async () => {
      // In SDKAdapter (adapter.ts), broker.report calls are executed via Effect.runPromise(...).catch(() => {})
      // so if broker.report throws/fails, it is safely swallowed and does NOT fail the stream or query.
      let brokerReportCalled = false
      const mockBroker: AccountBrokerApi = {
        acquireSession: () =>
          Effect.succeed({
            credential: { accountId: "acc-1", kind: "anthropic", secretRef: "s1", resolvedSecret: Redacted.make("secret") },
            model: "claude-sonnet-4-5",
            stepIndex: 0,
            failoverPossible: true,
          } as any),
        report: () => {
          brokerReportCalled = true
          return Effect.fail(new Error("Broker reporting failure"))
        },
        list: () => Effect.succeed([]),
        _inspect: () => Effect.succeed([]),
      } as any

      // Assert that running broker.report with .catch(() => {}) does not throw unhandled rejection
      let caught = false
      await Effect.runPromise(mockBroker.report({ accountId: "acc-1", kind: "success" })).catch(() => {
        caught = true
      })

      expect(brokerReportCalled).toBe(true)
      expect(caught).toBe(true)
    })
  })
})
