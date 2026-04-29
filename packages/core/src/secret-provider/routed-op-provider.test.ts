/**
 * RoutedOpSecretProvider tests — Phase 25d.
 *
 * Inner OP backends are replaced by stub layers so we exercise routing
 * semantics without shelling out to `op`.
 */
import { describe, expect, it } from "vitest"
import { Context, Effect, Exit, Layer, Redacted } from "effect"
import { ConfigError } from "../errors.js"
import { SecretProvider, type SecretProviderApi } from "./secret-provider.js"
import {
  RoutedOpSecretProvider,
  validateAccountsTableLabels,
} from "./routed-op-provider.js"

interface StubLog {
  readonly received: Array<string>
}

/**
 * Build a stub SecretProvider layer that returns a tagged success
 * (so we can assert which inner layer was hit) or a failure.
 */
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
                message: `'op read' exited with code 1: ***REDACTED-OP-TOKEN*** bad`,
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

describe("RoutedOpSecretProvider — construction-time invariants", () => {
  it("rejects label that fails regex (uppercase)", async () => {
    const log: StubLog = { received: [] }
    const layer = RoutedOpSecretProvider.make({
      accounts: [{ label: "Bad", layer: stubLayer("Bad", log) }],
    })
    const exit = await get("op://VAULT/ITEM/FIELD", layer)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const j = JSON.stringify(exit.cause)
      expect(j).toContain("ConfigError")
      expect(j).toContain("Bad")
    }
  })

  it("rejects reserved label (env)", async () => {
    const log: StubLog = { received: [] }
    const layer = RoutedOpSecretProvider.make({
      accounts: [{ label: "env", layer: stubLayer("env", log) }],
    })
    const exit = await get("op://VAULT/ITEM/FIELD", layer)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(JSON.stringify(exit.cause)).toContain("reserved")
    }
  })

  it("rejects duplicate labels", async () => {
    const log: StubLog = { received: [] }
    const layer = RoutedOpSecretProvider.make({
      accounts: [
        { label: "flow", layer: stubLayer("flow", log) },
        { label: "flow", layer: stubLayer("flow", log) },
      ],
    })
    const exit = await get("op://VAULT/ITEM/FIELD", layer)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(JSON.stringify(exit.cause)).toContain("duplicate")
    }
  })

  it("empty accounts array — op:// rejected with N=0 guidance", async () => {
    const layer = RoutedOpSecretProvider.make({ accounts: [] })
    const exit = await get("op://VAULT/ITEM/FIELD", layer)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const j = JSON.stringify(exit.cause)
      expect(j).toContain("(have 0)")
    }
  })
})

describe("RoutedOpSecretProvider — single-account routing", () => {
  it("op://VAULT/ITEM/FIELD resolves via the only registered account", async () => {
    const log: StubLog = { received: [] }
    const layer = RoutedOpSecretProvider.make({
      accounts: [{ label: "antmachine", layer: stubLayer("antmachine", log) }],
    })
    const exit = await get("op://VAULT/ITEM/FIELD", layer)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(Redacted.value(exit.value)).toBe("secret(antmachine:op://VAULT/ITEM/FIELD)")
    }
    expect(log.received).toEqual(["antmachine:op://VAULT/ITEM/FIELD"])
  })

  it("luna-op://VAULT/ITEM/FIELD rewrites to op://VAULT/ITEM/FIELD and routes correctly", async () => {
    const log: StubLog = { received: [] }
    const layer = RoutedOpSecretProvider.make({
      accounts: [{ label: "antmachine", layer: stubLayer("antmachine", log) }],
    })
    const exit = await get("luna-op://VAULT/ITEM/FIELD", layer)
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(log.received).toEqual(["antmachine:op://VAULT/ITEM/FIELD"])
  })

  it("luna-op://VAULT/ITEM/FIELD → ConfigError naming the unknown label and listing registered set", async () => {
    const log: StubLog = { received: [] }
    const layer = RoutedOpSecretProvider.make({
      accounts: [{ label: "antmachine", layer: stubLayer("antmachine", log) }],
    })
    const exit = await get("luna-op://VAULT/ITEM/FIELD", layer)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const j = JSON.stringify(exit.cause)
      expect(j).toContain("wrong")
      expect(j).toContain("[antmachine]")
    }
    expect(log.received).toEqual([])
  })
})

describe("RoutedOpSecretProvider — multi-account routing", () => {
  const buildMulti = (log: StubLog) =>
    RoutedOpSecretProvider.make({
      accounts: [
        { label: "antmachine", layer: stubLayer("antmachine", log) },
        { label: "mrbot", layer: stubLayer("mrbot", log) },
        { label: "flow", layer: stubLayer("flow", log) },
      ],
    })

  it("bare op:// → ConfigError with N≥2 guidance + registered list", async () => {
    const log: StubLog = { received: [] }
    const exit = await get("op://VAULT/ITEM/FIELD", buildMulti(log))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const j = JSON.stringify(exit.cause)
      expect(j).toContain("(have 3)")
      expect(j).toContain("luna-op://<label>")
      expect(j).toContain("[antmachine, mrbot, flow]")
    }
    expect(log.received).toEqual([])
  })

  it("luna-op://VAULT/ITEM/FIELD routes only to flow", async () => {
    const log: StubLog = { received: [] }
    const exit = await get("luna-op://VAULT/ITEM/FIELD", buildMulti(log))
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(log.received).toEqual(["flow:op://VAULT/ITEM/FIELD"])
  })

  it("luna-op://VAULT/ITEM/FIELD preserves the section path segment", async () => {
    const log: StubLog = { received: [] }
    const exit = await get("luna-op://VAULT/ITEM/FIELD", buildMulti(log))
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(log.received).toEqual(["mrbot:op://VAULT/ITEM/FIELD"])
  })
})

describe("RoutedOpSecretProvider — malformed / edge cases", () => {
  const log: StubLog = { received: [] }
  const layer = RoutedOpSecretProvider.make({
    accounts: [{ label: "flow", layer: stubLayer("flow", log) }],
  })

  it("luna-op://flow/ (empty rest) → ConfigError", async () => {
    const exit = await get("luna-op://flow/", layer)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(JSON.stringify(exit.cause)).toContain("malformed")
    }
  })

  it("luna-op://flow (no slash, no rest) → ConfigError", async () => {
    const exit = await get("luna-op://flow", layer)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(JSON.stringify(exit.cause)).toContain("malformed")
    }
  })

  it("luna-op:///v/i/f (empty label) → ConfigError", async () => {
    const exit = await get("luna-op:///v/i/f", layer)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(JSON.stringify(exit.cause)).toContain("malformed")
    }
  })

  it("luna-op://VAULT/ITEM/FIELD (reserved) → ConfigError", async () => {
    const exit = await get("luna-op://VAULT/ITEM/FIELD", layer)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(JSON.stringify(exit.cause)).toContain("reserved")
    }
  })

  it("luna-op://Mr Bot/v/i/f (space) → ConfigError, no path leak", async () => {
    const exit = await get("luna-op://Mr Bot/v/i/f", layer)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const j = JSON.stringify(exit.cause)
      // Privacy: error names label, not the full ref path
      expect(j).not.toContain("/v/i/f")
    }
  })

  it("luna-op://VAULT/ITEM/FIELD (no URL decoding)", async () => {
    // The whole "flow%2Fother" is the label — fails regex (% not allowed)
    const exit = await get("luna-op://VAULT/ITEM/FIELD", layer)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const j = JSON.stringify(exit.cause)
      expect(j).toContain("ConfigError")
    }
  })

  it("non-op://, non-luna-op:// ref → ConfigError (firstOf-falls-through)", async () => {
    const exit = await get("env:FOO", layer)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const j = JSON.stringify(exit.cause)
      expect(j).toContain("ConfigError")
      expect(j).toContain("not an op://")
    }
  })
})

describe("RoutedOpSecretProvider — error wrapping breadcrumb", () => {
  it("wraps inner failure with (account=<label>) and the wrapper itself never introduces a token", async () => {
    const log: StubLog = { received: [] }
    const layer = RoutedOpSecretProvider.make({
      accounts: [{ label: "flow", layer: stubLayer("flow", log, "fail") }],
    })
    const exit = await get("luna-op://VAULT/ITEM/FIELD", layer)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const j = JSON.stringify(exit.cause)
      expect(j).toContain("(account=flow)")
      // Token-shape assertions on the wrapper's contribution: no
      // ops_-prefixed blob, no sk-ant prefix.
      expect(j).not.toMatch(/ops_[A-Za-z0-9_-]{20,}/)
      expect(j).not.toContain("sk-ant")
    }
  })

  it("wraps simulated-failure with (account=<label>) prefix", async () => {
    const log: StubLog = { received: [] }
    const layer = RoutedOpSecretProvider.make({
      accounts: [{ label: "flow", layer: stubLayer("flow", log, "fail") }],
    })
    const exit = await get("luna-op://VAULT/ITEM/FIELD", layer)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(JSON.stringify(exit.cause)).toContain("(account=flow)")
    }
  })
})

describe("validateAccountsTableLabels", () => {
  it("flags luna-op:// refs pointing at unknown labels", () => {
    const refs = [
      "luna-op://VAULT/ITEM/FIELD",
      "luna-op://VAULT/ITEM/FIELD",
      "op://VAULT/ITEM/FIELD",
      "env:FOO",
    ]
    const dangling = validateAccountsTableLabels(refs, ["flow", "antmachine"])
    expect(dangling).toEqual([{ ref: "luna-op://VAULT/ITEM/FIELD", label: "ghost" }])
  })

  it("ignores non-luna-op:// refs entirely", () => {
    const refs = ["op://VAULT/ITEM/FIELD", "env:FOO", "file:/tmp/x"]
    const dangling = validateAccountsTableLabels(refs, [])
    expect(dangling).toEqual([])
  })

  it("ignores malformed luna-op:// refs (no slash) — wrapper reports those at resolve time", () => {
    const refs = ["luna-op://flow", "luna-op:///v/i/f"]
    const dangling = validateAccountsTableLabels(refs, [])
    expect(dangling).toEqual([])
  })
})

// Demonstrate that Layer.build errors propagate cleanly when an
// accountLabel is invalid — not strictly required, but documents the
// integration shape with secretProviderFirstOf.
describe("RoutedOpSecretProvider — Layer surface", () => {
  it("Layer carries SecretProvider in the `out` channel and ConfigError in the `error` channel", () => {
    const log: StubLog = { received: [] }
    const layer: Layer.Layer<SecretProvider, ConfigError> =
      RoutedOpSecretProvider.make({
        accounts: [{ label: "ok", layer: stubLayer("ok", log) }],
      })
    // Type assertion only — the value of this test is at the type level.
    expect(typeof layer).toBe("object")
    // Touch Context to keep `import` unflagged.
    expect(typeof Context.empty).toBe("function")
  })
})
