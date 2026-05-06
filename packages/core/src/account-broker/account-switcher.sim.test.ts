/**
 * Account Switcher — Tier-2 Simulation Tests
 *
 * Drives `AccountBroker` through acquire→release→report cycles that
 * mirror real account-switcher scenarios. Uses a mutable mock clock
 * (same pattern as account-broker.sim.test.ts).
 *
 * BDD scenarios:
 *
 * S1 — list() returns public fields only (no secretRef in output).
 * S2 — list() kind filter: "anthropic" hides tool-* accounts.
 * S3 — list() with no filter returns all accounts.
 * S4 — boundAccountId pin: new thread with boundAccountId="a2" acquires a2.
 * S5 — boundAccountId pin ignored when account is rate-limited → exhausted.
 * S6 — switching from exhausted-a1 to healthy-a2 succeeds.
 * S7 — list() health field reflects cooldown state (informational).
 * S8 — no inFlight leak after a pinned acquire + release cycle.
 *
 * Note: S1–S3 (list()) test the NEW `list()` method that will be added to
 * `AccountBrokerApi` as part of the feature. These tests will fail RED until
 * the method is implemented — that is the intent of TDD.
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { Effect, Exit, Layer } from "effect"
import { Clock } from "../clock.js"
import { FileSecretProvider } from "../secret-provider/index.js"
import {
  AccountBroker,
  AccountBrokerLayer,
  type AccountSeed,
} from "./index.js"

// ─── Test infrastructure (mirrors account-broker.sim.test.ts) ────────────────

interface MockClock {
  readonly layer: Layer.Layer<Clock>
  readonly setNow: (ms: number) => void
}

const makeMockClock = (initialMs: number): MockClock => {
  const holder = { now: initialMs }
  const layer = Layer.succeed(
    Clock,
    Clock.of({
      _tag: "luna/Clock",
      nowMs: () => Effect.sync(() => holder.now),
      nowIso: () => Effect.sync(() => new Date(holder.now).toISOString()),
    }),
  )
  return { layer, setNow: (ms) => (holder.now = ms) }
}

const tmpFileSecrets = (entries: Record<string, string>) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "switcher-sim-"))
  const p = path.join(dir, "secrets.json")
  fs.writeFileSync(p, JSON.stringify(entries))
  return FileSecretProvider.make(p)
}

// Standard 3-account anthropic pool used across most tests.
const THREE_SEEDS: ReadonlyArray<AccountSeed> = [
  { id: "a1", kind: "anthropic", secretRef: "anth:a1" },
  { id: "a2", kind: "anthropic", secretRef: "anth:a2" },
  { id: "a3", kind: "anthropic", secretRef: "anth:a3" },
]

const THREE_SECRETS = {
  "anth:a1": "tok-a1",
  "anth:a2": "tok-a2",
  "anth:a3": "tok-a3",
}

const makeLayer = (
  seeds: ReadonlyArray<AccountSeed>,
  secrets: Record<string, string>,
  clock: MockClock,
) =>
  AccountBrokerLayer.fromAccounts(seeds).pipe(
    Layer.provide(Layer.mergeAll(tmpFileSecrets(secrets), clock.layer)),
  )

// ─── S1 — list() returns public fields only ───────────────────────────────────

describe("S1 — list() returns public-safe fields only", () => {
  /**
   * Given: a pool of 3 anthropic accounts with known secretRefs.
   * When:  broker.list() is called.
   * Then:  result contains {id, label, kind, health} for each account.
   *        No secretRef, no resolvedSecret in the output.
   *
   * RED until AccountBrokerApi.list() is implemented.
   */
  it("returns id/label/kind/health but never secretRef", async () => {
    const clock = makeMockClock(0)
    const layer = makeLayer(THREE_SEEDS, THREE_SECRETS, clock)

    const summaries = await Effect.runPromise(
      Effect.gen(function* () {
        const broker = yield* AccountBroker
        // @ts-expect-error — list() added in this feature; will compile once implemented
        return yield* broker.list()
      }).pipe(Effect.provide(layer)),
    )

    expect(summaries).toHaveLength(3)
    for (const s of summaries) {
      expect(s).toHaveProperty("id")
      expect(s).toHaveProperty("kind")
      expect(s).toHaveProperty("health")
      // secretRef must NOT be present in the public summary shape
      expect(s).not.toHaveProperty("secretRef")
      expect(s).not.toHaveProperty("resolvedSecret")
    }
  })

  /**
   * Given: a healthy account (no cooldown, inFlight=0).
   * When:  list() is called.
   * Then:  health is "healthy".
   */
  it("healthy account has health='healthy'", async () => {
    const clock = makeMockClock(0)
    const layer = makeLayer(
      [{ id: "a1", kind: "anthropic", secretRef: "anth:a1" }],
      { "anth:a1": "tok-a1" },
      clock,
    )

    const summaries = await Effect.runPromise(
      Effect.gen(function* () {
        const broker = yield* AccountBroker
        // @ts-expect-error — list() added in this feature
        return yield* broker.list()
      }).pipe(Effect.provide(layer)),
    )

    expect(summaries[0]?.health).toBe("healthy")
  })

  /**
   * Given: account a1 is rate-limited (in cooldown).
   * When:  list() is called before the cooldown expires.
   * Then:  health is "rate_limited" (not "healthy").
   */
  it("rate-limited account has health='rate_limited'", async () => {
    const clock = makeMockClock(0)
    const layer = makeLayer(THREE_SEEDS, THREE_SECRETS, clock)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const broker = yield* AccountBroker
        // Put a1 in cooldown.
        yield* broker.report({
          accountId: "a1",
          kind: "rate_limit",
          retryAfterMs: 60_000,
        })
        // @ts-expect-error — list() added in this feature
        return yield* broker.list()
      }).pipe(Effect.provide(layer)),
    )

    const a1 = result.find((s: { id: string }) => s.id === "a1")
    expect(a1?.health).toBe("rate_limited")
    // a2 and a3 still healthy
    const a2 = result.find((s: { id: string }) => s.id === "a2")
    expect(a2?.health).toBe("healthy")
  })
})

// ─── S2 — list() kind filter ─────────────────────────────────────────────────

describe("S2 — list(kindFilter) hides non-matching accounts", () => {
  /**
   * Given: pool has 2 anthropic + 1 tool-computer account.
   * When:  list("anthropic") is called.
   * Then:  only the 2 anthropic accounts appear.
   *
   * This is what the account-switcher dropdown will call — it must
   * never show tool accounts.
   */
  it("filters to anthropic only when kindFilter='anthropic'", async () => {
    const mixedSeeds: ReadonlyArray<AccountSeed> = [
      { id: "a1", kind: "anthropic", secretRef: "anth:a1" },
      { id: "a2", kind: "anthropic", secretRef: "anth:a2" },
      { id: "t1", kind: "tool-computer", secretRef: "tool:t1" },
    ]
    const clock = makeMockClock(0)
    const layer = makeLayer(
      mixedSeeds,
      { "anth:a1": "tok-a1", "anth:a2": "tok-a2", "tool:t1": "tok-t1" },
      clock,
    )

    const summaries = await Effect.runPromise(
      Effect.gen(function* () {
        const broker = yield* AccountBroker
        // @ts-expect-error — list() added in this feature
        return yield* broker.list("anthropic")
      }).pipe(Effect.provide(layer)),
    )

    expect(summaries).toHaveLength(2)
    const ids = summaries.map((s: { id: string }) => s.id)
    expect(ids).toContain("a1")
    expect(ids).toContain("a2")
    expect(ids).not.toContain("t1")
  })
})

// ─── S3 — list() with no filter ───────────────────────────────────────────────

describe("S3 — list() with no filter returns all accounts", () => {
  /**
   * Given: pool has 2 anthropic + 1 tool account.
   * When:  list() is called with no kind filter.
   * Then:  all 3 accounts appear.
   */
  it("returns all accounts when no kindFilter is supplied", async () => {
    const mixedSeeds: ReadonlyArray<AccountSeed> = [
      { id: "a1", kind: "anthropic", secretRef: "anth:a1" },
      { id: "a2", kind: "anthropic", secretRef: "anth:a2" },
      { id: "t1", kind: "tool-computer", secretRef: "tool:t1" },
    ]
    const clock = makeMockClock(0)
    const layer = makeLayer(
      mixedSeeds,
      { "anth:a1": "tok-a1", "anth:a2": "tok-a2", "tool:t1": "tok-t1" },
      clock,
    )

    const summaries = await Effect.runPromise(
      Effect.gen(function* () {
        const broker = yield* AccountBroker
        // @ts-expect-error — list() added in this feature
        return yield* broker.list()
      }).pipe(Effect.provide(layer)),
    )

    expect(summaries).toHaveLength(3)
  })
})

// ─── S4 — boundAccountId pin: new-thread routes to the selected account ───────

describe("S4 — boundAccountId pin routes acquireSession to selected account", () => {
  /**
   * Given: 3 healthy anthropic accounts; a2 is NOT next in round-robin.
   * When:  acquireSession is called with boundAccountId="a2".
   * Then:  a2's credential is returned, NOT a1 or a3.
   *
   * This simulates what happens when the user picks "a2" in the dropdown
   * and the frontend sends new-thread with accountId="a2".
   */
  it("acquireSession with boundAccountId='a2' returns a2's credential", async () => {
    const clock = makeMockClock(0)
    const layer = makeLayer(THREE_SEEDS, THREE_SECRETS, clock)

    const accountId = await Effect.runPromise(
      Effect.gen(function* () {
        const broker = yield* AccountBroker
        // First call: a1 gets selected by LRU (all lastUsedMs=0, a1 is head).
        // Advance clock so a2 is NOT naturally next.
        yield* Effect.sync(() => clock.setNow(1))
        yield* Effect.scoped(broker.acquireSession({ model: "m" }))
        yield* Effect.sync(() => clock.setNow(2))

        // Now pin to a2 explicitly — simulates dropdown selection.
        const cred = yield* Effect.scoped(
          broker.acquireSession({ model: "m", boundAccountId: "a2" }),
        )
        return cred.accountId
      }).pipe(Effect.provide(layer)),
    )

    expect(accountId).toBe("a2")
  })

  /**
   * Given: 10 sequential acquires pinned to a2.
   * When:  each runs to completion.
   * Then:  all 10 return a2 — pin is stable across iterations.
   */
  it("pin to a2 is stable across 10 sequential acquires", async () => {
    const clock = makeMockClock(0)
    const layer = makeLayer(THREE_SEEDS, THREE_SECRETS, clock)

    const ids = await Effect.runPromise(
      Effect.gen(function* () {
        const broker = yield* AccountBroker
        const results: string[] = []
        for (let i = 0; i < 10; i++) {
          yield* Effect.sync(() => clock.setNow(i))
          const cred = yield* Effect.scoped(
            broker.acquireSession({ model: "m", boundAccountId: "a2" }),
          )
          results.push(cred.accountId)
        }
        return results
      }).pipe(Effect.provide(layer)),
    )

    expect(ids.every((id) => id === "a2")).toBe(true)
  })
})

// ─── S5 — boundAccountId + rate-limited → AllAccountsExhaustedError ──────────

describe("S5 — pinned account rate-limited → exhausted error", () => {
  /**
   * Given: user has selected a2 in the dropdown; a2 gets rate-limited.
   * When:  new thread is opened with boundAccountId="a2" after the rate-limit.
   * Then:  AllAccountsExhaustedError — NOT silently routed to a1 or a3.
   *
   * Correct UX: show an error in the UI, not create a thread on the wrong
   * account. The dropdown should update health to "rate_limited" and let
   * the user pick another account.
   */
  it("returns AllAccountsExhaustedError when pinned account is rate-limited", async () => {
    const clock = makeMockClock(0)
    const layer = makeLayer(THREE_SEEDS, THREE_SECRETS, clock)

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const broker = yield* AccountBroker
        // Rate-limit a2.
        yield* broker.report({
          accountId: "a2",
          kind: "rate_limit",
          retryAfterMs: 60_000,
        })
        // Pin to a2 — should fail, NOT fall back to a1.
        return yield* Effect.scoped(
          broker.acquireSession({ model: "m", boundAccountId: "a2" }),
        )
      }).pipe(Effect.provide(layer)),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify(exit)).toContain("AllAccountsExhausted")
  })
})

// ─── S6 — Switch from exhausted to healthy account ────────────────────────────

describe("S6 — Switch from exhausted account to healthy account", () => {
  /**
   * Given: a1 is rate-limited; user opens dropdown, sees a2 as healthy,
   *        switches to a2 in the UI.
   * When:  new thread is opened with boundAccountId="a2".
   * Then:  succeeds with a2's credential.
   *
   * This is the primary "recovery via the switcher" scenario.
   */
  it("switching to a healthy account after rate-limit succeeds", async () => {
    const clock = makeMockClock(0)
    const layer = makeLayer(THREE_SEEDS, THREE_SECRETS, clock)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const broker = yield* AccountBroker

        // a1 gets rate-limited (e.g. hit quota).
        yield* broker.report({
          accountId: "a1",
          kind: "rate_limit",
          retryAfterMs: 60_000,
        })

        // Without pin: a1 is excluded, so a2 or a3 are used.
        const freeRide = yield* Effect.scoped(
          broker.acquireSession({ model: "m" }),
        )

        // User explicitly switches to a2 via the dropdown.
        const pinned = yield* Effect.scoped(
          broker.acquireSession({ model: "m", boundAccountId: "a2" }),
        )

        return { freeRide: freeRide.accountId, pinned: pinned.accountId }
      }).pipe(Effect.provide(layer)),
    )

    // Without pin: a1 excluded, so we get a2 or a3.
    expect(result.freeRide).not.toBe("a1")
    // With pin to a2: exactly a2.
    expect(result.pinned).toBe("a2")
  })
})

// ─── S7 — list() health reflects cooldown state ───────────────────────────────

describe("S7 — list() health field reflects live cooldown state", () => {
  /**
   * Given: a1 is rate-limited with retryAfter=100ms.
   * When:  list() is called at nowMs=50 (before expiry) and at nowMs=200 (after).
   * Then:  at 50ms → a1 is "rate_limited"; at 200ms → a1 is "healthy".
   *
   * The dropdown uses this to grey-out unavailable accounts in real time.
   */
  it("health transitions from rate_limited to healthy after cooldown expires", async () => {
    const clock = makeMockClock(0)
    const layer = makeLayer(THREE_SEEDS, THREE_SECRETS, clock)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const broker = yield* AccountBroker

        yield* broker.report({
          accountId: "a1",
          kind: "rate_limit",
          retryAfterMs: 100,
        })

        // Query at t=50: a1 in cooldown.
        yield* Effect.sync(() => clock.setNow(50))
        // @ts-expect-error — list() added in this feature
        const before = yield* broker.list("anthropic")

        // Advance clock past cooldown.
        yield* Effect.sync(() => clock.setNow(200))
        // @ts-expect-error — list() added in this feature
        const after = yield* broker.list("anthropic")

        return { before, after }
      }).pipe(Effect.provide(layer)),
    )

    const a1Before = result.before.find((s: { id: string }) => s.id === "a1")
    const a1After = result.after.find((s: { id: string }) => s.id === "a1")
    expect(a1Before?.health).toBe("rate_limited")
    expect(a1After?.health).toBe("healthy")
  })
})

// ─── S8 — No inFlight leak after pinned acquire + release ─────────────────────

describe("S8 — No inFlight leak after pinned acquire + release", () => {
  /**
   * Given: boundAccountId="a2" is used for a session.
   * When:  the session Scope closes (simulates thread end).
   * Then:  a2's inFlight returns to 0; no leak.
   *
   * This mirrors the invariant in account-broker.sim.test.ts
   * ("30 ticks: no inFlight leak") but scoped to the pinned account.
   */
  it("inFlight on pinned account is 0 after session Scope closes", async () => {
    const clock = makeMockClock(0)
    const layer = makeLayer(THREE_SEEDS, THREE_SECRETS, clock)

    const final = await Effect.runPromise(
      Effect.gen(function* () {
        const broker = yield* AccountBroker

        // Run 5 pinned sessions in series.
        for (let i = 0; i < 5; i++) {
          yield* Effect.scoped(
            broker.acquireSession({ model: "m", boundAccountId: "a2" }),
          )
        }

        return yield* broker._inspect()
      }).pipe(Effect.provide(layer)),
    )

    const a2 = final.find((a) => a.id === "a2")
    expect(a2?.inFlight).toBe(0)
    // Other accounts also clean.
    expect(final.every((a) => a.inFlight === 0)).toBe(true)
  })
})
