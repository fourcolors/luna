/**
 * Spend-meter (B2) + overflow-chain fold (B6) — Tier-1/Tier-2 tests for the
 * IN-MEMORY broker (account-broker.ts). Node-clean (NO bun:sqlite).
 *
 * Covers:
 *   - usage report accumulates spend (no budget = telemetry only, never cools).
 *   - budget → cooldown at the cycle boundary (nextCycleBoundary).
 *   - cycle roll under a controllable mock clock.
 *   - B6 no-chain → single-account, model = caller, stepIndex 0, no advancedFrom
 *     (BYTE-IDENTICAL to pre-B6).
 *   - B6 chain advances when the preferred step's account cools down.
 *   - B6 advancedFrom tracked across two acquires on the same lane.
 *   - applyUsage pure unit (boundary + roll arithmetic).
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { Clock } from "../clock.js"
import { FileSecretProvider } from "../secret-provider/index.js"
import {
  AccountBroker,
  AccountBrokerLayer,
  applyUsage,
  type AccountSeed,
} from "./index.js"

// ── Mutable mock clock (mirrors account-broker.sim.test.ts) ─────────────────
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spend-meter-"))
  const p = path.join(dir, "secrets.json")
  fs.writeFileSync(p, JSON.stringify(entries))
  return FileSecretProvider.make(p)
}

const makeLayer = (seeds: ReadonlyArray<AccountSeed>, clock: MockClock) =>
  AccountBrokerLayer.fromAccounts(seeds).pipe(
    Layer.provide(
      Layer.mergeAll(
        tmpFileSecrets(Object.fromEntries(seeds.map((s) => [s.secretRef, "tok"]))),
        clock.layer,
      ),
    ),
  )

/** Save/restore a global env var around a body (chains/cycle are process-wide). */
const withEnv = async (
  vars: Record<string, string | undefined>,
  body: () => Promise<void>,
) => {
  const prev: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    await body()
  } finally {
    for (const [k] of Object.entries(vars)) {
      if (prev[k] === undefined) delete process.env[k]
      else process.env[k] = prev[k]
    }
  }
}

// USD a sonnet turn costs: claude-sonnet rate is 3/M in, 15/M out.
//   1_000_000 in + 0 out = $3.00. Handy round number for budget tests.

describe("B2 spend-meter (in-memory)", () => {
  it("usage accumulates spend; no-budget account = telemetry, never cools", async () => {
    const clock = makeMockClock(1000)
    const seeds: ReadonlyArray<AccountSeed> = [
      { id: "a1", kind: "anthropic", secretRef: "anth:a1" }, // no budgetUsd
    ]
    const after = await Effect.runPromise(
      Effect.gen(function* () {
        const broker = yield* AccountBroker
        yield* broker.report({
          accountId: "a1",
          kind: "usage",
          model: "claude-sonnet-4-5",
          tokensIn: 1_000_000,
          tokensOut: 0,
        })
        return yield* broker._inspect()
      }).pipe(Effect.provide(makeLayer(seeds, clock))),
    )
    const a1 = after.find((a) => a.id === "a1")
    expect(a1?.usage?.spentUsd).toBeCloseTo(3.0, 5)
    expect(a1?.usage?.cycleStartMs).toBe(1000)
    // No budget → NEVER cooled down by spend.
    expect(a1?.cooldownUntilMs).toBeUndefined()
  })

  it("budget exhausted → cooldown set to the next cycle boundary", async () => {
    const CYCLE = 100_000
    await withEnv({ LUNA_SPEND_CYCLE_MS: String(CYCLE) }, async () => {
      const clock = makeMockClock(5000)
      const seeds: ReadonlyArray<AccountSeed> = [
        { id: "a1", kind: "anthropic", secretRef: "anth:a1", budgetUsd: 2.0 },
      ]
      const out = await Effect.runPromise(
        Effect.gen(function* () {
          const broker = yield* AccountBroker
          // $3.00 turn > $2.00 budget → exhausted.
          yield* broker.report({
            accountId: "a1",
            kind: "usage",
            model: "claude-sonnet-4-5",
            tokensIn: 1_000_000,
            tokensOut: 0,
          })
          const inspected = yield* broker._inspect()
          // The exhausted account must now be unavailable (cooled down).
          const exit = yield* Effect.exit(
            Effect.scoped(
              broker.acquireSession({ model: "claude-sonnet-4-5" }),
            ),
          )
          return { inspected, exit }
        }).pipe(Effect.provide(makeLayer(seeds, clock))),
      )
      const a1 = out.inspected.find((a) => a.id === "a1")
      // cycleStart=5000, cycleMs=100000 → boundary 105000.
      expect(a1?.cooldownUntilMs).toBe(5000 + CYCLE)
      expect(a1?.usage?.spentUsd).toBeCloseTo(3.0, 5)
      // No other account → acquire fails (exhausted).
      expect(out.exit._tag).toBe("Failure")
    })
  })

  it("under-budget usage does NOT cool the account", async () => {
    const clock = makeMockClock(0)
    const seeds: ReadonlyArray<AccountSeed> = [
      { id: "a1", kind: "anthropic", secretRef: "anth:a1", budgetUsd: 100.0 },
    ]
    const a1 = await Effect.runPromise(
      Effect.gen(function* () {
        const broker = yield* AccountBroker
        yield* broker.report({
          accountId: "a1",
          kind: "usage",
          model: "claude-sonnet-4-5",
          tokensIn: 1_000_000,
          tokensOut: 0,
        })
        const all = yield* broker._inspect()
        return all.find((a) => a.id === "a1")
      }).pipe(Effect.provide(makeLayer(seeds, clock))),
    )
    expect(a1?.usage?.spentUsd).toBeCloseTo(3.0, 5)
    expect(a1?.cooldownUntilMs).toBeUndefined()
  })

  it("cycle rolls under the test clock: spend resets when now passes the boundary", async () => {
    const CYCLE = 100_000
    await withEnv({ LUNA_SPEND_CYCLE_MS: String(CYCLE) }, async () => {
      const clock = makeMockClock(0)
      const seeds: ReadonlyArray<AccountSeed> = [
        { id: "a1", kind: "anthropic", secretRef: "anth:a1" },
      ]
      const out = await Effect.runPromise(
        Effect.gen(function* () {
          const broker = yield* AccountBroker
          // First report at t=0 → cycleStart=0, spend=$3.
          yield* broker.report({
            accountId: "a1",
            kind: "usage",
            model: "claude-sonnet-4-5",
            tokensIn: 1_000_000,
            tokensOut: 0,
          })
          const first = (yield* broker._inspect()).find((a) => a.id === "a1")
          // Advance PAST the boundary (0 + 100000) → next report rolls.
          yield* Effect.sync(() => clock.setNow(150_000))
          yield* broker.report({
            accountId: "a1",
            kind: "usage",
            model: "claude-sonnet-4-5",
            tokensIn: 1_000_000,
            tokensOut: 0,
          })
          const second = (yield* broker._inspect()).find((a) => a.id === "a1")
          return { first, second }
        }).pipe(Effect.provide(makeLayer(seeds, clock))),
      )
      expect(out.first?.usage?.cycleStartMs).toBe(0)
      expect(out.first?.usage?.spentUsd).toBeCloseTo(3.0, 5)
      // Rolled: new window starts at 150000, spend is just this turn's $3.
      expect(out.second?.usage?.cycleStartMs).toBe(150_000)
      expect(out.second?.usage?.spentUsd).toBeCloseTo(3.0, 5)
    })
  })

  it("usage accumulates WITHIN a cycle (two turns sum before the boundary)", async () => {
    const CYCLE = 100_000
    await withEnv({ LUNA_SPEND_CYCLE_MS: String(CYCLE) }, async () => {
      const clock = makeMockClock(0)
      const seeds: ReadonlyArray<AccountSeed> = [
        { id: "a1", kind: "anthropic", secretRef: "anth:a1" },
      ]
      const a1 = await Effect.runPromise(
        Effect.gen(function* () {
          const broker = yield* AccountBroker
          for (let i = 0; i < 2; i++) {
            yield* broker.report({
              accountId: "a1",
              kind: "usage",
              model: "claude-sonnet-4-5",
              tokensIn: 1_000_000,
              tokensOut: 0,
            })
            yield* Effect.sync(() => clock.setNow(10_000 * (i + 1)))
          }
          return (yield* broker._inspect()).find((a) => a.id === "a1")
        }).pipe(Effect.provide(makeLayer(seeds, clock))),
      )
      // Two $3 turns, both within the window → $6, cycle unchanged.
      expect(a1?.usage?.cycleStartMs).toBe(0)
      expect(a1?.usage?.spentUsd).toBeCloseTo(6.0, 5)
    })
  })
})

describe("B6 overflow-chain fold (in-memory)", () => {
  it("PER-STEP budgetUsd cools the step's account (account has no seed budget) → chain advances (Copilot #2)", async () => {
    // Step 0 carries its OWN $1 budget; account a1 has NO seed budget. Spending
    // > $1 on step 0 must cool a1 via the STEP budget, advancing to step 1 —
    // this is the `[opus($200) → codex($50)]` headline that the account-only
    // budget could never deliver.
    const chains = {
      chains: {
        "chat-lane": [
          {
            kind: "anthropic",
            accountId: "a1",
            model: "claude-sonnet-4-5",
            budgetUsd: 1.0,
          },
          { kind: "google", accountId: "g1", model: "gemini-2.5-flash" },
        ],
      },
    }
    await withEnv(
      { LUNA_OVERFLOW_CHAINS: JSON.stringify(chains) },
      async () => {
        const clock = makeMockClock(0)
        const seeds: ReadonlyArray<AccountSeed> = [
          { id: "a1", kind: "anthropic", secretRef: "anth:a1" }, // NO seed budget
          { id: "g1", kind: "google", secretRef: "anth:g1" },
        ]
        const out = await Effect.runPromise(
          Effect.gen(function* () {
            const broker = yield* AccountBroker
            // (1) Acquire → step 0 (a1); the broker surfaces the step's $1 budget.
            const first = yield* Effect.scoped(
              broker.acquireSession({ model: "chat-lane" }),
            )
            // (2) A $3 turn (1M Sonnet input tokens) WITH the surfaced step
            //     budget → exceeds $1 → a1 cools (despite no account budget).
            yield* broker.report({
              accountId: "a1",
              kind: "usage",
              model: "claude-sonnet-4-5",
              tokensIn: 1_000_000,
              tokensOut: 0,
              budgetUsd: first.budgetUsd,
            })
            // (3) Next acquire → a1 is budget-cooled → advance to step 1 (g1).
            const second = yield* Effect.scoped(
              broker.acquireSession({ model: "chat-lane" }),
            )
            return { first, second }
          }).pipe(Effect.provide(makeLayer(seeds, clock))),
        )
        expect(out.first.credential.accountId).toBe("a1")
        expect(out.first.budgetUsd).toBe(1.0) // step budget, NOT the account's
        expect(out.second.credential.accountId).toBe("g1")
        expect(out.second.stepIndex).toBe(1)
        expect(out.second.advancedFrom).toBe(0)
      },
    )
  })

  it("no chain → single account, model=caller, stepIndex 0, no advancedFrom (byte-identical)", async () => {
    await withEnv({ LUNA_OVERFLOW_CHAINS: undefined }, async () => {
      const clock = makeMockClock(0)
      const seeds: ReadonlyArray<AccountSeed> = [
        { id: "a1", kind: "anthropic", secretRef: "anth:a1" },
      ]
      const acq = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const broker = yield* AccountBroker
            return yield* broker.acquireSession({ model: "claude-sonnet-4-5" })
          }),
        ).pipe(Effect.provide(makeLayer(seeds, clock))),
      )
      expect(acq.credential.accountId).toBe("a1")
      expect(acq.model).toBe("claude-sonnet-4-5")
      expect(acq.stepIndex).toBe(0)
      expect(acq.advancedFrom).toBeUndefined()
    })
  })

  it("chain advances to the next step when the preferred step's account is cooled down", async () => {
    // Lane key = the model string passed to acquireSession (here "chat-lane").
    const chains = {
      chains: {
        "chat-lane": [
          { kind: "anthropic", accountId: "a1", model: "claude-sonnet-4-5" },
          { kind: "google", accountId: "g1", model: "gemini-2.5-flash" },
        ],
      },
    }
    await withEnv(
      { LUNA_OVERFLOW_CHAINS: JSON.stringify(chains) },
      async () => {
        const clock = makeMockClock(0)
        const seeds: ReadonlyArray<AccountSeed> = [
          { id: "a1", kind: "anthropic", secretRef: "anth:a1" },
          { id: "g1", kind: "google", secretRef: "anth:g1" },
        ]
        const out = await Effect.runPromise(
          Effect.gen(function* () {
            const broker = yield* AccountBroker
            // Cool down a1 (step 0's account) so the chain must advance.
            yield* broker.report({
              accountId: "a1",
              kind: "rate_limit",
              retryAfterMs: 60_000,
            })
            const acq = yield* Effect.scoped(
              broker.acquireSession({ model: "chat-lane" }),
            )
            return acq
          }).pipe(Effect.provide(makeLayer(seeds, clock))),
        )
        // Step 0 (a1) is cooled → step 1 (g1/gemini) wins.
        expect(out.credential.accountId).toBe("g1")
        expect(out.credential.kind).toBe("google")
        expect(out.model).toBe("gemini-2.5-flash")
        expect(out.stepIndex).toBe(1)
      },
    )
  })

  it("advancedFrom tracked: two acquires on the same lane → the second reports advancedFrom", async () => {
    const chains = {
      chains: {
        "chat-lane": [
          { kind: "anthropic", accountId: "a1", model: "claude-sonnet-4-5" },
          { kind: "google", accountId: "g1", model: "gemini-2.5-flash" },
        ],
      },
    }
    await withEnv(
      { LUNA_OVERFLOW_CHAINS: JSON.stringify(chains) },
      async () => {
        const clock = makeMockClock(0)
        const seeds: ReadonlyArray<AccountSeed> = [
          { id: "a1", kind: "anthropic", secretRef: "anth:a1" },
          { id: "g1", kind: "google", secretRef: "anth:g1" },
        ]
        const out = await Effect.runPromise(
          Effect.gen(function* () {
            const broker = yield* AccountBroker
            // (1) First acquire → lands step 0 (a1), sets lastStep=0,
            //     advancedFrom undefined (no prior step recorded).
            const first = yield* Effect.scoped(
              broker.acquireSession({ model: "chat-lane" }),
            )
            // Cool a1 so the chain must advance on the next acquire.
            yield* broker.report({
              accountId: "a1",
              kind: "rate_limit",
              retryAfterMs: 60_000,
            })
            // (2) Second acquire → advances to step 1, advancedFrom = 0.
            const second = yield* Effect.scoped(
              broker.acquireSession({ model: "chat-lane" }),
            )
            return { first, second }
          }).pipe(Effect.provide(makeLayer(seeds, clock))),
        )
        expect(out.first.stepIndex).toBe(0)
        expect(out.first.advancedFrom).toBeUndefined()
        expect(out.second.stepIndex).toBe(1)
        expect(out.second.advancedFrom).toBe(0)
      },
    )
  })
})

describe("applyUsage (pure)", () => {
  it("rolls a stale cycle and prices fresh", () => {
    const u = applyUsage(
      { kind: "anthropic", usage: { cycleStartMs: 0, spentUsd: 9.0 } },
      { model: "claude-sonnet-4-5", tokensIn: 1_000_000, tokensOut: 0 },
      undefined,
      200_000, // now is past 0 + 100000
      100_000,
    )
    expect(u.usage.cycleStartMs).toBe(200_000) // rolled
    expect(u.usage.spentUsd).toBeCloseTo(3.0, 5) // fresh, not 9+3
    expect(u.cooldownUntilMs).toBeUndefined()
  })

  it("accumulates within the cycle and sets cooldown at budget boundary", () => {
    const u = applyUsage(
      { kind: "anthropic", usage: { cycleStartMs: 0, spentUsd: 1.0 } },
      { model: "claude-sonnet-4-5", tokensIn: 1_000_000, tokensOut: 0 },
      2.0, // budget — 1.0 + 3.0 = 4.0 >= 2.0 → exhausted
      50_000,
      100_000,
    )
    expect(u.usage.cycleStartMs).toBe(0) // same window
    expect(u.usage.spentUsd).toBeCloseTo(4.0, 5)
    expect(u.cooldownUntilMs).toBe(100_000) // 0 + cycleMs
  })
})

describe("rate_limit vs budget cooldown (never-shorten guard)", () => {
  it("a transient rate_limit report never SHORTENS an existing budget cooldown", async () => {
    const CYCLE = 100_000
    await withEnv({ LUNA_SPEND_CYCLE_MS: String(CYCLE) }, async () => {
      const clock = makeMockClock(5_000)
      const seeds: ReadonlyArray<AccountSeed> = [
        { id: "a1", kind: "anthropic", secretRef: "anth:a1", budgetUsd: 2.0 },
      ]
      const out = await Effect.runPromise(
        Effect.gen(function* () {
          const broker = yield* AccountBroker
          // Cross the budget → cooled until the cycle boundary (5000 + CYCLE).
          yield* broker.report({
            accountId: "a1",
            kind: "usage",
            model: "claude-sonnet-4-5",
            tokensIn: 1_000_000,
            tokensOut: 0,
          })
          const afterBudget = (yield* broker._inspect()).find(
            (a) => a.id === "a1",
          )
          // A still-in-flight turn 429s → rate_limit with a SHORT retry-after.
          // Pre-fix this OVERWROTE the budget cooldown (now+30s), re-opening
          // the over-budget account 30s later.
          yield* broker.report({
            accountId: "a1",
            kind: "rate_limit",
            retryAfterMs: 30_000,
          })
          const afterThrottle = (yield* broker._inspect()).find(
            (a) => a.id === "a1",
          )
          return { afterBudget, afterThrottle }
        }).pipe(Effect.provide(makeLayer(seeds, clock))),
      )
      expect(out.afterBudget?.cooldownUntilMs).toBe(5_000 + CYCLE)
      expect(out.afterThrottle?.cooldownUntilMs).toBe(5_000 + CYCLE)
    })
  })

  it("a rate_limit report still EXTENDS a shorter existing cooldown", async () => {
    const clock = makeMockClock(0)
    const seeds: ReadonlyArray<AccountSeed> = [
      { id: "a1", kind: "anthropic", secretRef: "anth:a1" },
    ]
    const a1 = await Effect.runPromise(
      Effect.gen(function* () {
        const broker = yield* AccountBroker
        yield* broker.report({
          accountId: "a1",
          kind: "rate_limit",
          retryAfterMs: 10_000,
        })
        yield* broker.report({
          accountId: "a1",
          kind: "rate_limit",
          retryAfterMs: 60_000,
        })
        return (yield* broker._inspect()).find((a) => a.id === "a1")
      }).pipe(Effect.provide(makeLayer(seeds, clock))),
    )
    expect(a1?.cooldownUntilMs).toBe(60_000)
  })
})

describe("acquireSession failoverPossible (throttle-gate viability)", () => {
  it("no chain → false; chain with another viable target → true; pinned sole-account chain → false", async () => {
    const chains = {
      chains: {
        "two-step": [
          { kind: "anthropic", accountId: "a1", model: "m1" },
          { kind: "anthropic", accountId: "a2", model: "m2" },
        ],
        "sole-step": [{ kind: "anthropic", accountId: "a1", model: "m1" }],
      },
    }
    await withEnv(
      { LUNA_OVERFLOW_CHAINS: JSON.stringify(chains) },
      async () => {
        const clock = makeMockClock(0)
        const seeds: ReadonlyArray<AccountSeed> = [
          { id: "a1", kind: "anthropic", secretRef: "anth:a1" },
          { id: "a2", kind: "anthropic", secretRef: "anth:a2" },
        ]
        const out = await Effect.runPromise(
          Effect.gen(function* () {
            const broker = yield* AccountBroker
            const noChain = yield* Effect.scoped(
              broker.acquireSession({ model: "default" }),
            )
            const twoStep = yield* Effect.scoped(
              broker.acquireSession({ model: "two-step" }),
            )
            const soleStep = yield* Effect.scoped(
              broker.acquireSession({ model: "sole-step" }),
            )
            return { noChain, twoStep, soleStep }
          }).pipe(Effect.provide(makeLayer(seeds, clock))),
        )
        // No chain ⇒ nothing to fail over to (the no-chain path never cools).
        expect(out.noChain.failoverPossible).toBe(false)
        // Two-step chain, second step viable ⇒ cooling a1 has somewhere to go.
        expect(out.twoStep.failoverPossible).toBe(true)
        // One pinned step ⇒ cooling its sole account would self-inflict an
        // outage (the empty-/sole-chain case BLOCKER #1 guards against).
        expect(out.soleStep.failoverPossible).toBe(false)
      },
    )
  })
})
