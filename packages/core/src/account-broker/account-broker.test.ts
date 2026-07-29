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
        const acq = yield* broker
          .acquireSession({ model: "claude-sonnet-4-5" })
          .pipe(Scope.extend(outer))
        const during = yield* broker._inspect()
        yield* Scope.close(outer, Exit.void)
        const after = yield* broker._inspect()
        return { acq, during, after }
      }).pipe(Effect.provide(buildLayer())),
    )
    // B6 widened return: AcquiredSession { credential, model, stepIndex }.
    expect(out.acq.credential.kind).toBe("anthropic")
    expect(["a1", "a2", "a3"]).toContain(out.acq.credential.accountId)
    expect(Redacted.value(out.acq.credential.resolvedSecret)).toMatch(
      /^tok-a[1-3]$/,
    )
    // No chain configured → single-step fallback: model = caller's model,
    // stepIndex = 0, no advancedFrom. BYTE-IDENTICAL routing to pre-B6.
    expect(out.acq.model).toBe("claude-sonnet-4-5")
    expect(out.acq.stepIndex).toBe(0)
    expect(out.acq.advancedFrom).toBeUndefined()
    const acquired = out.during.find(
      (a) => a.id === out.acq.credential.accountId,
    )
    expect(acquired?.inFlight).toBe(1)
    expect(out.after.every((a) => a.inFlight === 0)).toBe(true)
  })

  it("boundAccountId pins to that account when healthy", async () => {
    const acq = await Effect.runPromise(
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
    expect(acq.credential.accountId).toBe("a2")
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
    expect(out.c1.credential.accountId).not.toBe(out.c2.credential.accountId)
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

describe("AccountBroker.peekFailoverPossible", () => {
  it("no chain: false when pinned to a cooled account (nowhere for the pin to route), true for an unbound acquire with uncooled siblings", async () => {
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const broker = yield* AccountBroker
        yield* broker.report({ accountId: "a1", kind: "session_limit" })
        // Pinned to the now-cooled a1 - the pin allows only that account,
        // and it is unavailable, so no acquire could succeed right now.
        const pinnedToCooled = yield* broker.peekFailoverPossible({
          model: "claude-sonnet-4-5",
          boundAccountId: "a1",
        })
        // Unbound: a2/a3 are still uncooled, so a real acquire would land.
        const unbound = yield* broker.peekFailoverPossible({
          model: "claude-sonnet-4-5",
        })
        return { pinnedToCooled, unbound }
      }).pipe(Effect.provide(buildLayer())),
    )
    expect(out.pinnedToCooled).toBe(false)
    expect(out.unbound).toBe(true)
  })

  it("read-only: never mutates inFlight or lastUsedMs, never perturbs a subsequent real acquire", async () => {
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const broker = yield* AccountBroker
        const before = yield* broker._inspect()
        yield* broker.peekFailoverPossible({ model: "claude-sonnet-4-5" })
        yield* broker.peekFailoverPossible({ model: "claude-sonnet-4-5" })
        const after = yield* broker._inspect()
        return { before, after }
      }).pipe(Effect.provide(buildLayer())),
    )
    expect(out.after).toEqual(out.before)
  })
})

/**
 * BLOCKER #3 regression: `peekFailoverPossible` must reuse the CANONICAL
 * `pickLaneTarget`/`pickChainTarget` selection (overflow-chain.ts) - the
 * same one `acquireSession` runs - never a private re-derivation off
 * `list(kindFilter).some(...)`. A prior private re-derivation drifted from
 * the canonical predicate in BOTH directions:
 *   - cross-kind chain: kind-filtered `list` is blind to a chain step on a
 *     DIFFERENT provider, so it under-reports (false when canonical is
 *     true) - the user's turn would be silently dropped instead of rotated.
 *   - pinned single-step chain + an off-chain same-kind sibling:
 *     kind-filtered `list` sees the sibling as "another healthy account" of
 *     the same kind and over-reports (true when canonical is false) - chat-
 *     service would rotate toward a target the chain would never actually
 *     route to (reintroducing Defect #2).
 * Both tests below reproduce the exact divergence by computing the OLD
 * formula inline (`list(kind).some(...)`) alongside the fixed method, on
 * the SAME broker state, and asserting they disagree exactly as described.
 */
describe("AccountBroker.peekFailoverPossible - canonical selection (BLOCKER #3)", () => {
  it("cross-kind overflow chain: canonical is true; the old kind-filtered list() formula would have said false", async () => {
    const chainSeeds: ReadonlyArray<AccountSeed> = [
      { id: "cross-a", kind: "anthropic", secretRef: "anth:cross-a" },
      { id: "cross-o", kind: "openai", secretRef: "anth:cross-o" },
    ]
    const prevChains = process.env["LUNA_OVERFLOW_CHAINS"]
    process.env["LUNA_OVERFLOW_CHAINS"] = JSON.stringify({
      chains: {
        "cross-lane": [
          { kind: "anthropic", accountId: "cross-a", model: "claude-sonnet-4-5" },
          { kind: "openai", accountId: "cross-o", model: "gpt-5" },
        ],
      },
    })
    try {
      const layer = AccountBrokerLayer.fromAccounts(chainSeeds).pipe(
        Layer.provide(
          Layer.mergeAll(
            fileSecrets({ "anth:cross-a": "tok-a", "anth:cross-o": "tok-o" }),
            Clock.Test(1000),
          ),
        ),
      )
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const broker = yield* AccountBroker
          // Cool the winning (anthropic) step, as a throttle report would.
          yield* broker.report({ accountId: "cross-a", kind: "session_limit" })
          const canonical = yield* broker.peekFailoverPossible({
            model: "cross-lane",
          })
          // Reproduce the OLD, now-deleted formula for direct comparison:
          // kind-filtered `list(acquiredAccountKind).some(...)`.
          const summaries = yield* broker.list("anthropic")
          const naiveOldFormula = summaries.some(
            (s) => s.id !== "cross-a" && s.health === "healthy",
          )
          return { canonical, naiveOldFormula }
        }).pipe(Effect.provide(layer)),
      )
      expect(result.canonical).toBe(true)
      expect(result.naiveOldFormula).toBe(false)
    } finally {
      if (prevChains === undefined) delete process.env["LUNA_OVERFLOW_CHAINS"]
      else process.env["LUNA_OVERFLOW_CHAINS"] = prevChains
    }
  })

  it("pinned single-step chain + off-chain same-kind sibling: canonical is false; the old kind-filtered list() formula would have said true", async () => {
    const pinnedSeeds: ReadonlyArray<AccountSeed> = [
      { id: "pin-a", kind: "anthropic", secretRef: "anth:pin-a" },
      { id: "pin-sib", kind: "anthropic", secretRef: "anth:pin-sib" },
    ]
    const prevChains = process.env["LUNA_OVERFLOW_CHAINS"]
    process.env["LUNA_OVERFLOW_CHAINS"] = JSON.stringify({
      chains: {
        "pinned-lane": [{ accountId: "pin-a", model: "claude-sonnet-4-5" }],
      },
    })
    try {
      const layer = AccountBrokerLayer.fromAccounts(pinnedSeeds).pipe(
        Layer.provide(
          Layer.mergeAll(
            fileSecrets({ "anth:pin-a": "tok-a", "anth:pin-sib": "tok-sib" }),
            Clock.Test(1000),
          ),
        ),
      )
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const broker = yield* AccountBroker
          yield* broker.report({ accountId: "pin-a", kind: "session_limit" })
          const canonical = yield* broker.peekFailoverPossible({
            model: "pinned-lane",
          })
          const summaries = yield* broker.list("anthropic")
          const naiveOldFormula = summaries.some(
            (s) => s.id !== "pin-a" && s.health === "healthy",
          )
          return { canonical, naiveOldFormula }
        }).pipe(Effect.provide(layer)),
      )
      // The chain's ONLY step is pinned to pin-a; excluding it leaves the
      // chain with nowhere to route - canonically false.
      expect(result.canonical).toBe(false)
      // The old formula sees pin-sib as a healthy same-kind account and
      // wrongly says true - exactly the divergence that reintroduced
      // Defect #2 (rotating toward a target the chain would never route to).
      expect(result.naiveOldFormula).toBe(true)
    } finally {
      if (prevChains === undefined) delete process.env["LUNA_OVERFLOW_CHAINS"]
      else process.env["LUNA_OVERFLOW_CHAINS"] = prevChains
    }
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
    const acq = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const broker = yield* AccountBroker
          return yield* broker.acquireSession({ model: "m" })
        }),
      ).pipe(Effect.provide(layer)),
    )
    expect(Redacted.value(acq.credential.resolvedSecret)).toBe("from-env")
    delete process.env.ENV_TOK
  })
})
