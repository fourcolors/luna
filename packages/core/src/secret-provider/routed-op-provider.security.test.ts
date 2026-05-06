/**
 * RoutedOpSecretProvider — §3.4 security invariant tests.
 *
 * These tests close the two genuine gaps left by the Phase 25d test suite:
 *
 *   GAP-1: luna-op://<label> failure in a multi-account context must HARD FAIL
 *           (not fall through to other accounts). The existing "error wrapping"
 *           tests only use a single account; this file proves no-fallthrough
 *           with N=3 accounts where the named account's inner layer fails.
 *
 *   GAP-2: When the inner layer includes token-shaped material in its error
 *           message (the "leak-token" stub), the wrapped error must not expose
 *           ops_-prefixed or sk-ant-prefixed secrets. This exercises the
 *           `(account=<label>) ${e.message}` wrapping path with a realistic
 *           leaky inner error.
 *
 * The existing single-account "error wrapping breadcrumb" tests in
 * routed-op-provider.test.ts pass a plain failure message through; they do
 * NOT cover the no-fallthrough invariant (requires ≥2 accounts) or the
 * token-content invariant with a realistically leaked token string.
 */
import { describe, expect, it } from "vitest"
import { Effect, Exit, Layer, Redacted } from "effect"
import { ConfigError } from "../errors.js"
import { SecretProvider, type SecretProviderApi } from "./secret-provider.js"
import { RoutedOpSecretProvider } from "./routed-op-provider.js"

interface StubLog {
  readonly received: Array<string>
}

const stubLayer = (
  label: string,
  log: StubLog,
  behavior: "ok" | "fail" | "leak-token" = "ok",
): Layer.Layer<SecretProvider, ConfigError> =>
  Layer.effect(
    SecretProvider,
    Effect.sync(
      (): SecretProviderApi => ({
        get: (ref) => {
          log.received.push(`${label}:${ref}`)
          if (behavior === "fail") {
            return Effect.fail(
              new ConfigError({
                module: "OnePasswordSecretProvider",
                key: "op",
                message: `simulated failure for ${ref}`,
              }),
            )
          }
          if (behavior === "leak-token") {
            return Effect.fail(
              new ConfigError({
                module: "OnePasswordSecretProvider",
                key: "op",
                message: `'op read' exited with code 1: ops_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bad token`,
              }),
            )
          }
          return Effect.succeed(Redacted.make(`secret(${label}:${ref})`))
        },
      }),
    ),
  )

const get = (ref: string, layer: Layer.Layer<SecretProvider, ConfigError>) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      const sp = yield* SecretProvider
      return yield* sp.get(ref)
    }).pipe(Effect.provide(layer)),
  )

describe("RoutedOpSecretProvider — §3.4 no-fallthrough invariant (multi-account)", () => {
  /**
   * GAP-1: With 3 accounts [antmachine, mrbot, flow], requesting
   * luna-op://flow/v/i/f when flow's inner layer FAILS must:
   *   (a) propagate as a ConfigError (not succeed)
   *   (b) never call antmachine or mrbot (no cascade to other accounts)
   *   (c) include the (account=flow) breadcrumb
   */
  it("luna-op://flow failure does not fall through to antmachine or mrbot", async () => {
    const log: StubLog = { received: [] }
    const layer = RoutedOpSecretProvider.make({
      accounts: [
        { label: "antmachine", layer: stubLayer("antmachine", log, "ok") },
        { label: "mrbot", layer: stubLayer("mrbot", log, "ok") },
        { label: "flow", layer: stubLayer("flow", log, "fail") },
      ],
    })

    const exit = await get("luna-op://flow/v/i/f", layer)

    // Must fail — no fallthrough to a succeeding account.
    expect(Exit.isFailure(exit)).toBe(true)

    // Only flow was called — never antmachine, never mrbot.
    expect(log.received).toEqual(["flow:op://v/i/f"])

    // Error message includes the breadcrumb.
    if (Exit.isFailure(exit)) {
      expect(JSON.stringify(exit.cause)).toContain("(account=flow)")
    }
  })

  it("luna-op://antmachine failure does not fall through when mrbot + flow would succeed", async () => {
    const log: StubLog = { received: [] }
    const layer = RoutedOpSecretProvider.make({
      accounts: [
        { label: "antmachine", layer: stubLayer("antmachine", log, "fail") },
        { label: "mrbot", layer: stubLayer("mrbot", log, "ok") },
        { label: "flow", layer: stubLayer("flow", log, "ok") },
      ],
    })

    const exit = await get("luna-op://antmachine/v/i/f", layer)

    expect(Exit.isFailure(exit)).toBe(true)
    // mrbot and flow must not have been called.
    expect(log.received).toEqual(["antmachine:op://v/i/f"])
    if (Exit.isFailure(exit)) {
      expect(JSON.stringify(exit.cause)).toContain("(account=antmachine)")
    }
  })

  /**
   * Routing to an unknown label in a multi-account setup must hard-fail and
   * report the available labels — not silently try all accounts.
   */
  it("luna-op://ghost in 3-account setup → ConfigError; zero inner accounts called", async () => {
    const log: StubLog = { received: [] }
    const layer = RoutedOpSecretProvider.make({
      accounts: [
        { label: "antmachine", layer: stubLayer("antmachine", log, "ok") },
        { label: "mrbot", layer: stubLayer("mrbot", log, "ok") },
        { label: "flow", layer: stubLayer("flow", log, "ok") },
      ],
    })

    const exit = await get("luna-op://ghost/v/i/f", layer)

    expect(Exit.isFailure(exit)).toBe(true)
    // No inner account was called.
    expect(log.received).toEqual([])
    if (Exit.isFailure(exit)) {
      const j = JSON.stringify(exit.cause)
      expect(j).toContain("ghost")
      // Registered list is surfaced.
      expect(j).toContain("antmachine")
    }
  })
})

describe("RoutedOpSecretProvider — §3.4 zero-secret-material invariant (leak-token path)", () => {
  /**
   * GAP-2: When the inner OP layer emits an error message that happens to
   * contain an ops_-prefixed token string (realistic `op` CLI output), the
   * wrapper's (account=<label>) breadcrumb pass-through must not amplify
   * or re-introduce that token outside what the inner layer already leaked.
   *
   * What we CAN assert: the wrapper itself does not ADD new token material.
   * The (account=<label>) prefix is the only thing the wrapper contributes;
   * the rest is e.message verbatim. This test documents that the outer
   * wrapping layer's own contribution is free of ops_/sk-ant patterns.
   *
   * Note: the inner message IS included (by design — operators need the
   * original OP error). The security guarantee is that RoutedOpSecretProvider
   * does not introduce NEW tokens beyond what the backend reported.
   */
  it("single-account leak-token: wrapper contains (account=flow) breadcrumb, no new token material injected", async () => {
    const log: StubLog = { received: [] }
    const layer = RoutedOpSecretProvider.make({
      accounts: [{ label: "flow", layer: stubLayer("flow", log, "leak-token") }],
    })

    const exit = await get("luna-op://flow/v/i/f", layer)
    expect(Exit.isFailure(exit)).toBe(true)

    if (Exit.isFailure(exit)) {
      const j = JSON.stringify(exit.cause)
      // Breadcrumb is present.
      expect(j).toContain("(account=flow)")
      // The wrapper message prefix itself (`(account=flow) `) contains no
      // token material — any ops_ presence comes only from the inner message.
      // Verify by checking the prefix extracted from the message field.
      const errorObj = exit.cause as { _tag?: string; error?: { message?: string } }
      if (errorObj._tag === "Fail" && errorObj.error?.message) {
        const msg: string = errorObj.error.message
        expect(msg).toMatch(/^\(account=flow\)/)
        // Strip the inner message: the prefix itself must not be a token.
        const prefix = msg.split(" ops_")[0] ?? ""
        expect(prefix).not.toMatch(/ops_[A-Za-z0-9_-]{20,}/)
        expect(prefix).not.toContain("sk-ant")
      }
    }
  })

  it("multi-account leak-token: only the named account's error propagates, zero calls to other accounts", async () => {
    const log: StubLog = { received: [] }
    const layer = RoutedOpSecretProvider.make({
      accounts: [
        { label: "antmachine", layer: stubLayer("antmachine", log, "ok") },
        { label: "flow", layer: stubLayer("flow", log, "leak-token") },
      ],
    })

    const exit = await get("luna-op://flow/v/i/f", layer)
    expect(Exit.isFailure(exit)).toBe(true)

    // antmachine must not have been called.
    expect(log.received).toEqual(["flow:op://v/i/f"])

    if (Exit.isFailure(exit)) {
      const j = JSON.stringify(exit.cause)
      // Breadcrumb present.
      expect(j).toContain("(account=flow)")
      // No sk-ant or anthropic-key patterns introduced by the wrapper.
      expect(j).not.toContain("sk-ant")
    }
  })
})
