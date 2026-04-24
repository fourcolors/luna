/**
 * AccountBroker Tier-1 tests.
 *
 * These tests exercise the broker's behavior with a fixed (Test) Clock.
 * For multi-tick / cooldown-with-time-advance scenarios see the .sim
 * test file.
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { Effect, Exit, Layer, Redacted, Scope } from "effect"
import { Clock } from "../clock.js"
import {
  EnvSecretProvider,
  FileSecretProvider,
  secretProviderFirstOf,
} from "../secret-provider/index.js"
import {
  AccountBroker,
  AccountBrokerLayer,
  type AccountSeed,
} from "./index.js"

// Use a file-backed SecretProvider with inline JSON written to env-style
// refs so we don't have to mutate process.env across tests.
const fileSecrets = (entries: Record<string, string>) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "broker-"))
  const p = path.join(dir, "secrets.json")
  fs.writeFileSync(p, JSON.stringify(entries))
  return FileSecretProvider.make(p)
}

const seeds: ReadonlyArray<AccountSeed> = [
  { id: "a1", kind: "anthropic", secretRef: "anth:a1" },
  { id: "a2", kind: "anthropic", secretRef: "anth:a2" },
  { id: "a3", kind: "anthropic", secretRef: "anth:a3" },
]

const stockEntries = {
  "anth:a1": "tok-a1",
  "anth:a2": "tok-a2",
  "anth:a3": "tok-a3",
  "tool-foo:t1": "tok-t1",
}

const buildLayer = (
  fixedMs = 1000,
  customSeeds: ReadonlyArray<AccountSeed> = seeds,
) =>
  AccountBrokerLayer.fromAccounts(customSeeds).pipe(
    Layer.provide(
      Layer.mergeAll(fileSecrets(stockEntries), Clock.Test(fixedMs)),
    ),
  )

describe("AccountBroker.acquireSession", () => {
  it("inside Effect.scoped: returns Credential with resolved secret; inFlight=1 during, 0 after", async () => {
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const broker = yield* AccountBroker
        // Open an outer scope to keep the broker alive across two
        // observation points.
        const outer = yield* Scope.make()
        const cred = yield* broker
          .acquireSession({ model: "claude-sonnet-4-5" })
          .pipe(Scope.extend(outer))
        const during = yield* broker._inspect()
        yield* Scope.close(outer, Exit.void)
        const after = yield* broker._inspect()
        return { cred, during, after }
      }).pipe(Effect.provide(buildLayer())),
    )
    expect(out.cred.kind).toBe("anthropic")
    expect(["a1", "a2", "a3"]).toContain(out.cred.accountId)
    expect(Redacted.value(out.cred.resolvedSecret)).toMatch(/^tok-a[1-3]$/)
    const acquired = out.during.find((a) => a.id === out.cred.accountId)
    expect(acquired?.inFlight).toBe(1)
    expect(out.after.every((a) => a.inFlight === 0)).toBe(true)
  })

  it("boundAccountId pins to that account when healthy", async () => {
    const cred = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const broker = yield* AccountBroker
          return yield* broker.acquireSession({
            model: "claude-sonnet-4-5",
            boundAccountId: "a2",
          })
        }),
      ).pipe(Effect.provide(buildLayer())),
    )
    expect(cred.accountId).toBe("a2")
  })

  it("boundAccountId unknown → AllAccountsExhaustedError", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const broker = yield* AccountBroker
          return yield* broker.acquireSession({
            model: "claude-sonnet-4-5",
            boundAccountId: "ghost",
          })
        }),
      ).pipe(Effect.provide(buildLayer())),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify((exit as Exit.Failure<never, unknown>).cause)).toContain(
      "AllAccountsExhaustedError",
    )
  })

  it("two parallel scopes hit two distinct accounts (round-robin advances under load)", async () => {
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const broker = yield* AccountBroker
        const outer = yield* Scope.make()
        const c1 = yield* broker
          .acquireSession({ model: "m" })
          .pipe(Scope.extend(outer))
        const c2 = yield* broker
          .acquireSession({ model: "m" })
          .pipe(Scope.extend(outer))
        yield* Scope.close(outer, Exit.void)
        return { c1, c2 }
      }).pipe(Effect.provide(buildLayer())),
    )
    expect(out.c1.accountId).not.toBe(out.c2.accountId)
  })
})

describe("AccountBroker.acquireTool", () => {
  it("matches kind: tool-<toolName>", async () => {
    const toolSeeds: ReadonlyArray<AccountSeed> = [
      { id: "t1", kind: "tool-foo", secretRef: "tool-foo:t1" },
      { id: "a1", kind: "anthropic", secretRef: "anth:a1" },
    ]
    const cred = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const broker = yield* AccountBroker
          return yield* broker.acquireTool("foo")
        }),
      ).pipe(Effect.provide(buildLayer(1000, toolSeeds))),
    )
    expect(cred.kind).toBe("tool-foo")
    expect(cred.accountId).toBe("t1")
  })
})

describe("AccountBroker.report", () => {
  it("rate_limit puts account in cooldown; subsequent acquire skips it", async () => {
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const broker = yield* AccountBroker
        // Pin a1, report rate-limit on it.
        yield* Effect.scoped(
          broker.acquireSession({ model: "m", boundAccountId: "a1" }),
        )
        yield* broker.report({
          accountId: "a1",
          kind: "rate_limit",
          retryAfterMs: 5000,
        })
        // Now request a1 specifically — should fail (in cooldown).
        const exit = yield* Effect.exit(
          Effect.scoped(
            broker.acquireSession({ model: "m", boundAccountId: "a1" }),
          ),
        )
        // And generic acquire should hit a2 or a3.
        const generic = yield* Effect.scoped(
          broker.acquireSession({ model: "m" }),
        )
        return { exit, generic }
      }).pipe(Effect.provide(buildLayer(1000))),
    )
    expect(Exit.isFailure(out.exit)).toBe(true)
    expect(out.generic.accountId).not.toBe("a1")
  })

  it("all exhausted → AllAccountsExhaustedError with kind populated", async () => {
    const out = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const broker = yield* AccountBroker
        for (const id of ["a1", "a2", "a3"]) {
          yield* broker.report({
            accountId: id,
            kind: "rate_limit",
            retryAfterMs: 5000,
          })
        }
        return yield* Effect.scoped(broker.acquireSession({ model: "m" }))
      }).pipe(Effect.provide(buildLayer(1000))),
    )
    expect(Exit.isFailure(out)).toBe(true)
    if (Exit.isFailure(out)) {
      const flat = JSON.stringify(out.cause)
      expect(flat).toContain("AllAccountsExhaustedError")
      expect(flat).toContain("anthropic")
    }
  })

  it("success report does not change cooldown", async () => {
    const after = await Effect.runPromise(
      Effect.gen(function* () {
        const broker = yield* AccountBroker
        yield* broker.report({ accountId: "a1", kind: "success" })
        yield* broker.report({ accountId: "a1", kind: "error" })
        return yield* broker._inspect()
      }).pipe(Effect.provide(buildLayer(1000))),
    )
    expect(after.find((a) => a.id === "a1")?.cooldownUntilMs).toBeUndefined()
  })
})

// Ensure the secretProviderFirstOf composer also wires through the broker.
describe("composition smoke", () => {
  it("broker resolves via firstOf([env, file])", async () => {
    process.env.ENV_TOK = "from-env"
    const composed = secretProviderFirstOf([
      EnvSecretProvider.Default,
      fileSecrets({ "anth:a1": "from-file" }),
    ])
    const layer = AccountBrokerLayer.fromAccounts([
      { id: "a1", kind: "anthropic", secretRef: "env:ENV_TOK" },
    ]).pipe(Layer.provide(Layer.mergeAll(composed, Clock.Test(1000))))
    const cred = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const broker = yield* AccountBroker
          return yield* broker.acquireSession({ model: "m" })
        }),
      ).pipe(Effect.provide(layer)),
    )
    expect(Redacted.value(cred.resolvedSecret)).toBe("from-env")
    delete process.env.ENV_TOK
  })
})
