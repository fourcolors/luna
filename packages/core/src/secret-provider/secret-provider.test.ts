/**
 * SecretProvider Tier-1 tests — backends + composer + Redacted leakage.
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import * as util from "node:util"
import { describe, expect, it } from "vitest"
import { Effect, Exit, Redacted } from "effect"
import {
  EnvSecretProvider,
  FileSecretProvider,
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
