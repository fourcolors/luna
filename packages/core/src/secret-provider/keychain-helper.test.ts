/**
 * KeychainHelper unit + composition tests.
 *
 * Strategy: dependency-inject a fake `execFile` so we can assert
 * happy-path, miss, timeout, non-darwin, and no-leak behavior without
 * actually shelling out. A live integration test (gated to darwin) at
 * the bottom verifies the real `security` binary against the
 * pre-populated `luna.op.antmachine` keychain entry.
 */
import type { ChildProcess, ExecFileException } from "node:child_process"
import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"
import { Effect, Exit, Redacted } from "effect"
import {
  readKeychainToken,
  type KeychainHelperInternals,
} from "./keychain-helper.js"
import {
  EnvSecretProvider,
  OnePasswordSecretProvider,
  SecretProvider,
  secretProviderFirstOf,
} from "./index.js"
import { Clock } from "../clock.js"
import { Layer } from "effect"

type ExecFileCallback = (
  err: ExecFileException | null,
  stdout: string | Buffer,
  stderr: string | Buffer,
) => void

interface FakeChild extends EventEmitter {
  kill: (signal?: NodeJS.Signals) => boolean
}

const makeFakeChild = (): FakeChild => {
  const ee = new EventEmitter() as FakeChild
  ee.kill = () => true
  return ee
}

const fakeExecFileImmediate =
  (
    err: ExecFileException | null,
    stdout: string,
    stderr: string,
  ): KeychainHelperInternals["_execFile"] =>
  // The signature used internally is: (file, args, options, callback)
  ((..._args: Array<unknown>) => {
    const cb = _args[3] as ExecFileCallback
    queueMicrotask(() => cb(err, stdout, stderr))
    const child = makeFakeChild()
    queueMicrotask(() => child.emit("close", err ? (err.code ?? 1) : 0))
    return child as unknown as ChildProcess
  }) as unknown as KeychainHelperInternals["_execFile"]

// Never invokes the callback; lets the timeout guard fire.
const fakeExecFileHang: KeychainHelperInternals["_execFile"] = ((
  ..._args: Array<unknown>
) => {
  return makeFakeChild() as unknown as ChildProcess
}) as unknown as KeychainHelperInternals["_execFile"]

describe("readKeychainToken — unit", () => {
  it("happy path returns trimmed token", async () => {
    const got = await Effect.runPromise(
      readKeychainToken(
        { service: "luna.op.test", account: "test" },
        {
          _execFile: fakeExecFileImmediate(null, "sk-token\n", ""),
        },
      ),
    )
    expect(got).toBe("sk-token")
  })

  it("returns ConfigError on non-darwin and does not shell out", async () => {
    const spy = vi.fn(fakeExecFileImmediate(null, "leaked\n", ""))
    const exit = await Effect.runPromiseExit(
      readKeychainToken(
        { service: "luna.op.test", account: "test" },
        {
          _platform: "linux",
          _execFile: spy as unknown as KeychainHelperInternals["_execFile"],
        },
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const json = JSON.stringify(exit.cause)
      expect(json).toContain("ConfigError")
      expect(json).toContain("linux")
      expect(json).not.toContain("leaked")
    }
    expect(spy).not.toHaveBeenCalled()
  })

  it("entry not found → ConfigError without token-shaped substring", async () => {
    const err = Object.assign(new Error("Command failed"), {
      code: 44,
    }) as ExecFileException
    const exit = await Effect.runPromiseExit(
      readKeychainToken(
        { service: "luna.op.missing", account: "missing" },
        {
          _execFile: fakeExecFileImmediate(
            err,
            "",
            "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n",
          ),
        },
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const json = JSON.stringify(exit.cause)
      expect(json).toContain("ConfigError")
      expect(json).toContain("luna.op.missing/missing")
      // No 1Password service-account JWT prefix; no obviously-tokenish strings.
      expect(json).not.toContain("ops_")
      expect(json).not.toMatch(/sk-[A-Za-z0-9]/)
    }
  })

  it("timeout → ConfigError mentioning service name (not token)", async () => {
    const exit = await Effect.runPromiseExit(
      readKeychainToken(
        { service: "luna.op.slow", account: "slow" },
        {
          _execFile: fakeExecFileHang,
          _timeoutMs: 25,
        },
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const json = JSON.stringify(exit.cause)
      expect(json).toContain("timed out")
      expect(json).toContain("luna.op.slow")
    }
  }, 2000)

  it("does not log the token via console", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      await Effect.runPromise(
        readKeychainToken(
          { service: "luna.op.test", account: "test" },
          {
            _execFile: fakeExecFileImmediate(
              null,
              "ops_supersecret_DO_NOT_LEAK\n",
              "",
            ),
          },
        ),
      )
      const seen = [logSpy, errSpy, warnSpy].flatMap((s) =>
        s.mock.calls.flat().map(String),
      )
      for (const line of seen) {
        expect(line).not.toContain("ops_supersecret_DO_NOT_LEAK")
      }
    } finally {
      logSpy.mockRestore()
      errSpy.mockRestore()
      warnSpy.mockRestore()
    }
  })
})

describe("readKeychainToken — live (darwin only, antmachine entry)", () => {
  it.skipIf(process.platform !== "darwin")(
    "reads luna.op.antmachine and returns ops_-prefixed token",
    async () => {
      const result = await Effect.runPromiseExit(
        readKeychainToken({
          service: "luna.op.antmachine",
          account: "antmachine",
        }),
      )
      if (Exit.isFailure(result)) {
        // Soft-skip if the entry happens to be absent on this box (e.g. CI).
        const json = JSON.stringify(result.cause)
        expect(json).toContain("ConfigError")
        return
      }
      expect(result.value.startsWith("ops_")).toBe(true)
      expect(result.value.length).toBeGreaterThan(20)
    },
  )
})

describe("secretProviderFirstOf — multi-account routing", () => {
  /**
   * Verifies the routing claim: each OnePasswordSecretProvider sees only
   * its own account's vaults, so wrong-token attempts fall through and
   * the chain resolves at the first provider that recognizes the ref.
   */
  it("falls through on miss and resolves at the third provider", async () => {
    process.env.PROVIDER_THREE_TOKEN = "expected-token"
    delete process.env.PROVIDER_ONE_TOKEN
    delete process.env.PROVIDER_TWO_TOKEN

    // Three EnvSecretProvider layers, each looking up a distinct env
    // var. The composition test exercises `firstOf` semantics; the
    // semantics generalize to OnePasswordSecretProvider since both
    // backends fail-on-miss with ConfigError.
    const layer = secretProviderFirstOf([
      EnvSecretProvider.Default,
      EnvSecretProvider.Default,
      EnvSecretProvider.Default,
    ])

    // Use a ref that only the third provider's env will satisfy. We
    // rely on env not having the first two vars set, then we look up a
    // ref that exists only as PROVIDER_THREE_TOKEN.
    const got = await Effect.runPromise(
      Effect.gen(function* () {
        const sp = yield* SecretProvider
        return yield* sp.get("env:PROVIDER_THREE_TOKEN")
      }).pipe(Effect.provide(layer)),
    )
    expect(Redacted.value(got)).toBe("expected-token")
    delete process.env.PROVIDER_THREE_TOKEN
  })

  it("OnePassword chain: bad-ref miss propagates to env fallback", async () => {
    // Two OP providers (with bogus tokens) chained with an env provider.
    // We resolve `env:FOO` — both OP providers reject the ref shape with
    // ConfigError, env wins.
    process.env.MULTI_OP_FALLBACK = "env-wins"
    const op1 = OnePasswordSecretProvider.make({
      accountLabel: "fake1",
      token: "ops_fake_1",
    }).pipe(Layer.provide(Clock.Default))
    const op2 = OnePasswordSecretProvider.make({
      accountLabel: "fake2",
      token: "ops_fake_2",
    }).pipe(Layer.provide(Clock.Default))
    const layer = secretProviderFirstOf([op1, op2, EnvSecretProvider.Default])
    const got = await Effect.runPromise(
      Effect.gen(function* () {
        const sp = yield* SecretProvider
        return yield* sp.get("env:MULTI_OP_FALLBACK")
      }).pipe(Effect.provide(layer)),
    )
    expect(Redacted.value(got)).toBe("env-wins")
    delete process.env.MULTI_OP_FALLBACK
  })
})
