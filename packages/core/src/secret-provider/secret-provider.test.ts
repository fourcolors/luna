/**
 * SecretProvider Tier-1 tests — backends + composer + Redacted leakage.
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import * as util from "node:util"
import { describe, expect, it } from "vitest"
import { Effect, Exit, Layer, Redacted } from "effect"
import { ConfigError } from "../errors.js"
import {
  EnvSecretProvider,
  FileSecretProvider,
  KeychainEnvSecretProvider,
  type SecretProviderApi,
  SecretProvider,
  secretProviderFirstOf,
} from "./index.js"

const tmpJson = (obj: unknown): string => {
  const p = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "secret-provider-")),
    "secrets.json",
  )
  fs.writeFileSync(p, JSON.stringify(obj))
  return p
}

describe("EnvSecretProvider", () => {
  it("resolves env: refs", async () => {
    process.env.TEST_VAR_OK = "shh-its-a-secret"
    const got = await Effect.runPromise(
      Effect.gen(function* () {
        const sp = yield* SecretProvider
        return yield* sp.get("env:TEST_VAR_OK")
      }).pipe(Effect.provide(EnvSecretProvider.Default)),
    )
    expect(Redacted.value(got)).toBe("shh-its-a-secret")
    delete process.env.TEST_VAR_OK
  })

  it("ConfigError when env var unset", async () => {
    delete process.env.TEST_VAR_MISSING
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const sp = yield* SecretProvider
        return yield* sp.get("env:TEST_VAR_MISSING")
      }).pipe(Effect.provide(EnvSecretProvider.Default)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(JSON.stringify(exit.cause)).toContain("ConfigError")
    }
  })

  it("ConfigError when ref is not env:", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const sp = yield* SecretProvider
        return yield* sp.get("file:foo")
      }).pipe(Effect.provide(EnvSecretProvider.Default)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

describe("FileSecretProvider", () => {
  it("happy path", async () => {
    const p = tmpJson({ "anth:a1": "tok-a1" })
    const got = await Effect.runPromise(
      Effect.gen(function* () {
        const sp = yield* SecretProvider
        return yield* sp.get("anth:a1")
      }).pipe(Effect.provide(FileSecretProvider.make(p))),
    )
    expect(Redacted.value(got)).toBe("tok-a1")
  })

  it("missing file → ConfigError", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const sp = yield* SecretProvider
        return yield* sp.get("anth:a1")
      }).pipe(
        Effect.provide(
          FileSecretProvider.make("/tmp/__definitely_not_here__.json"),
        ),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify((exit as Exit.Failure<never, unknown>).cause)).toContain(
      "ConfigError",
    )
  })

  it("malformed JSON → ConfigError", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "secret-provider-"))
    const p = path.join(dir, "bad.json")
    fs.writeFileSync(p, "{not valid json")
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const sp = yield* SecretProvider
        return yield* sp.get("anth:a1")
      }).pipe(Effect.provide(FileSecretProvider.make(p))),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify((exit as Exit.Failure<never, unknown>).cause)).toContain(
      "malformed JSON",
    )
  })

  it("missing ref → ConfigError", async () => {
    const p = tmpJson({ "anth:a1": "tok-a1" })
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const sp = yield* SecretProvider
        return yield* sp.get("anth:nope")
      }).pipe(Effect.provide(FileSecretProvider.make(p))),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify((exit as Exit.Failure<never, unknown>).cause)).toContain(
      "not found",
    )
  })
})

describe("firstOf composer", () => {
  it("env miss falls through to file", async () => {
    delete process.env.NO_SUCH_VAR
    const p = tmpJson({ "anth:a1": "from-file" })
    const got = await Effect.runPromise(
      Effect.gen(function* () {
        const sp = yield* SecretProvider
        return yield* sp.get("anth:a1")
      }).pipe(
        Effect.provide(
          secretProviderFirstOf([
            EnvSecretProvider.Default,
            FileSecretProvider.make(p),
          ]),
        ),
      ),
    )
    expect(Redacted.value(got)).toBe("from-file")
  })

  it("env hit short-circuits", async () => {
    process.env.MY_SECRET = "from-env"
    const p = tmpJson({ "env:MY_SECRET": "from-file" })
    const got = await Effect.runPromise(
      Effect.gen(function* () {
        const sp = yield* SecretProvider
        return yield* sp.get("env:MY_SECRET")
      }).pipe(
        Effect.provide(
          secretProviderFirstOf([
            EnvSecretProvider.Default,
            FileSecretProvider.make(p),
          ]),
        ),
      ),
    )
    expect(Redacted.value(got)).toBe("from-env")
    delete process.env.MY_SECRET
  })

  it("both miss → ConfigError", async () => {
    const p = tmpJson({})
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const sp = yield* SecretProvider
        return yield* sp.get("anth:nowhere")
      }).pipe(
        Effect.provide(
          secretProviderFirstOf([
            EnvSecretProvider.Default,
            FileSecretProvider.make(p),
          ]),
        ),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

describe("firstOf stopOn (integrity must not fall through)", () => {
  /** A provider that always fails with a given message. */
  const failing = (
    module: string,
    message: string,
  ): Layer.Layer<SecretProvider, ConfigError> =>
    Layer.succeed(SecretProvider, {
      get: (ref) =>
        Effect.fail(new ConfigError({ module, key: ref, message })),
    } satisfies SecretProviderApi)

  /** A provider that always succeeds with a fixed value. */
  const succeeding = (
    value: string,
  ): Layer.Layer<SecretProvider, ConfigError> =>
    Layer.succeed(SecretProvider, {
      get: () => Effect.succeed(Redacted.make(value)),
    } satisfies SecretProviderApi)

  const INTEGRITY = "luna vault integrity: key-missing (locked out)"

  it("stops immediately with the matched error, never consulting later providers", async () => {
    const later = succeeding("stale-from-env-tail")
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const sp = yield* SecretProvider
        return yield* sp.get("env:X")
      }).pipe(
        Effect.provide(
          secretProviderFirstOf(
            [failing("Vault", INTEGRITY), later],
            { stopOn: (e) => e.message.startsWith("luna vault integrity:") },
          ),
        ),
      ),
    )
    // The later (succeeding) provider must NOT have been consulted: the chain
    // fails loudly with the integrity error rather than resolving stale plaintext.
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(JSON.stringify(exit.cause)).toContain("luna vault integrity:")
    }
  })

  it("without the option, an integrity-shaped miss still falls through", async () => {
    const value = await Effect.runPromise(
      Effect.gen(function* () {
        const sp = yield* SecretProvider
        return yield* sp.get("env:X")
      }).pipe(
        Effect.provide(
          secretProviderFirstOf([
            failing("Vault", INTEGRITY),
            succeeding("from-env-tail"),
          ]),
        ),
      ),
    )
    // Default behavior unchanged: no stopOn means the loop keeps trying tiers.
    expect(Redacted.value(value)).toBe("from-env-tail")
  })

  it("continues on a NON-matching error (a clean miss still falls through)", async () => {
    const value = await Effect.runPromise(
      Effect.gen(function* () {
        const sp = yield* SecretProvider
        return yield* sp.get("env:X")
      }).pipe(
        Effect.provide(
          secretProviderFirstOf(
            [failing("Vault", "secret X is not set"), succeeding("from-next")],
            { stopOn: (e) => e.message.startsWith("luna vault integrity:") },
          ),
        ),
      ),
    )
    // The first provider's error does not match stopOn, so the chain proceeds.
    expect(Redacted.value(value)).toBe("from-next")
  })
})

describe("Redacted leakage", () => {
  it("never reveals secret in JSON.stringify / String / inspect", async () => {
    const SECRET = "PLEASE_DO_NOT_LEAK_ME_b9f7c3"
    process.env.LEAK_VAR = SECRET
    const value = await Effect.runPromise(
      Effect.gen(function* () {
        const sp = yield* SecretProvider
        return yield* sp.get("env:LEAK_VAR")
      }).pipe(Effect.provide(EnvSecretProvider.Default)),
    )
    delete process.env.LEAK_VAR

    // Simulate a "credential" envelope similar to what AccountBroker builds.
    const credential = {
      kind: "anthropic",
      accountId: "a1",
      secretRef: "env:LEAK_VAR",
      resolvedSecret: value,
    }

    expect(JSON.stringify(credential)).not.toContain(SECRET)
    expect(JSON.stringify(value)).not.toContain(SECRET)
    expect(String(value)).not.toContain(SECRET)
    expect(util.inspect(value)).not.toContain(SECRET)
    expect(util.inspect(credential)).not.toContain(SECRET)

    // Sanity: extracting the value explicitly DOES yield the secret —
    // this is the only allowed escape hatch.
    expect(Redacted.value(value)).toBe(SECRET)
  })
})

describe("KeychainEnvSecretProvider", () => {
  it("resolves env: refs from luna.vault.<name> keychain entries", async () => {
    const got = await Effect.runPromise(
      Effect.gen(function* () {
        const sp = yield* SecretProvider
        return yield* sp.get("env:OPENAI_API_KEY")
      }).pipe(
        Effect.provide(
          KeychainEnvSecretProvider.make({
            _platform: "darwin",
            _read: (q) =>
              q.service === "luna.vault.OPENAI_API_KEY" &&
              q.account === "OPENAI_API_KEY"
                ? Effect.succeed("from-keychain")
                : Effect.fail(new Error("wrong key") as never),
          }),
        ),
      ),
    )

    expect(Redacted.value(got)).toBe("from-keychain")
  })

  it("misses non-env refs so firstOf can fall through", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const sp = yield* SecretProvider
        return yield* sp.get("file:thing")
      }).pipe(
        Effect.provide(
          KeychainEnvSecretProvider.make({
            _platform: "darwin",
            _read: () => Effect.succeed("should-not-run"),
          }),
        ),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("falls through to EnvSecretProvider when keychain misses", async () => {
    process.env.OPENAI_API_KEY = "from-env"
    const got = await Effect.runPromise(
      Effect.gen(function* () {
        const sp = yield* SecretProvider
        return yield* sp.get("env:OPENAI_API_KEY")
      }).pipe(
        Effect.provide(
          secretProviderFirstOf([
            KeychainEnvSecretProvider.make({
              _platform: "darwin",
              _read: () => Effect.fail(new Error("not found") as never),
            }),
            EnvSecretProvider.Default,
          ]),
        ),
      ),
    )
    delete process.env.OPENAI_API_KEY

    expect(Redacted.value(got)).toBe("from-env")
  })
})
