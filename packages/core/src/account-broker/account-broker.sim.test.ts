/**
 * AccountBroker Tier-2 simulation per §8.2.
 *
 * Drives a mutable mock clock through N ticks of acquire→release→report
 * to assert: load spread, no inFlight leak, cooldown excludes accounts
 * until the clock advances past `cooldownUntilMs`, all-cooldown →
 * AllAccountsExhaustedError, recovery once cooldowns expire.
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

// Mock clock backed by a mutable holder; tests advance it explicitly.
// Holder is set up before the layer is built so the test scope can
// flip the value mid-run.
interface MockClock {
  readonly layer: Layer.Layer<Clock>
  readonly setNow: (ms: number) => void
}
const makeMockClock = (initialMs: number): MockClock => {
  const holder = { now: initialMs }
  const layer = Layer.succeed(
    Clock,
    Clock.of({
      nowMs: () => Effect.sync(() => holder.now),
      nowIso: () =>
        Effect.sync(() => new Date(holder.now).toISOString()),
    }),
  )
  return { layer, setNow: (ms) => (holder.now = ms) }
}

const tmpFileSecrets = (entries: Record<string, string>) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "broker-sim-"))
  const p = path.join(dir, "secrets.json")
  fs.writeFileSync(p, JSON.stringify(entries))
  return FileSecretProvider.make(p)
}

describe("AccountBroker simulation", () => {
  it("30 ticks: load spreads across 3 accounts; no inFlight leak", async () => {
    const seeds: ReadonlyArray<AccountSeed> = [
      { id: "a1", kind: "anthropic", secretRef: "anth:a1" },
      { id: "a2", kind: "anthropic", secretRef: "anth:a2" },
      { id: "a3", kind: "anthropic", secretRef: "anth:a3" },
    ]
    const clock = makeMockClock(0)
    const layer = AccountBrokerLayer.fromAccounts(seeds).pipe(
      Layer.provide(
        Layer.mergeAll(
          tmpFileSecrets({
            "anth:a1": "t1",
            "anth:a2": "t2",
            "anth:a3": "t3",
          }),
          clock.layer,
        ),
      ),
    )

    const counts = await Effect.runPromise(
      Effect.gen(function* () {
        const broker = yield* AccountBroker
        const counts: Record<string, number> = { a1: 0, a2: 0, a3: 0 }
        for (let tick = 0; tick < 30; tick++) {
          // Advance clock each tick so LRU tie-break can rotate.
          yield* Effect.sync(() => clock.setNow(tick + 1))
          yield* Effect.scoped(
            Effect.gen(function* () {
              const acq = yield* broker.acquireSession({ model: "m" })
              const id = acq.credential.accountId
              counts[id] = (counts[id] ?? 0) + 1
              yield* broker.report({
                accountId: id,
                kind: "success",
              })
            }),
          )
        }
        const final = yield* broker._inspect()
        return { counts, final }
      }).pipe(Effect.provide(layer)),
    )

    // Each account used at least 8 times (round-robin should give ~10 each).
    expect(counts.counts.a1).toBeGreaterThanOrEqual(8)
    expect(counts.counts.a2).toBeGreaterThanOrEqual(8)
    expect(counts.counts.a3).toBeGreaterThanOrEqual(8)
    // No inFlight leak.
    expect(counts.final.every((a) => a.inFlight === 0)).toBe(true)
  })

  it("rate_limit excludes account until clock advances past cooldown", async () => {
    const seeds: ReadonlyArray<AccountSeed> = [
      { id: "a1", kind: "anthropic", secretRef: "anth:a1" },
      { id: "a2", kind: "anthropic", secretRef: "anth:a2" },
      { id: "a3", kind: "anthropic", secretRef: "anth:a3" },
    ]
    const clock = makeMockClock(0)
    const layer = AccountBrokerLayer.fromAccounts(seeds).pipe(
      Layer.provide(
        Layer.mergeAll(
          tmpFileSecrets({
            "anth:a1": "t1",
            "anth:a2": "t2",
            "anth:a3": "t3",
          }),
          clock.layer,
        ),
      ),
    )

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const broker = yield* AccountBroker
        // Tick 0: rate-limit a1 with retryAfter=100ms.
        yield* broker.report({
          accountId: "a1",
          kind: "rate_limit",
          retryAfterMs: 100,
        })
        // For 10 acquires while clock is still at 0, a1 must never appear.
        const seen: string[] = []
        for (let i = 0; i < 10; i++) {
          const id = yield* Effect.scoped(
            broker
              .acquireSession({ model: "m" })
              .pipe(Effect.map((c) => c.credential.accountId)),
          )
          seen.push(id)
        }
        // Now advance past cooldown.
        yield* Effect.sync(() => clock.setNow(1000))
        // a1 should be reachable again — pin to it.
        const pinned = yield* Effect.scoped(
          broker.acquireSession({ model: "m", boundAccountId: "a1" }),
        )
        return { seen, pinned: pinned.credential.accountId }
      }).pipe(Effect.provide(layer)),
    )
    expect(result.seen).not.toContain("a1")
    expect(result.pinned).toBe("a1")
  })

  it("all in cooldown → AllAccountsExhaustedError; recovers when clock advances", async () => {
    const seeds: ReadonlyArray<AccountSeed> = [
      { id: "a1", kind: "anthropic", secretRef: "anth:a1" },
      { id: "a2", kind: "anthropic", secretRef: "anth:a2" },
      { id: "a3", kind: "anthropic", secretRef: "anth:a3" },
    ]
    const clock = makeMockClock(0)
    const layer = AccountBrokerLayer.fromAccounts(seeds).pipe(
      Layer.provide(
        Layer.mergeAll(
          tmpFileSecrets({
            "anth:a1": "t1",
            "anth:a2": "t2",
            "anth:a3": "t3",
          }),
          clock.layer,
        ),
      ),
    )

    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const broker = yield* AccountBroker
        for (const id of ["a1", "a2", "a3"]) {
          yield* broker.report({
            accountId: id,
            kind: "rate_limit",
            retryAfterMs: 50,
          })
        }
        const exhausted = yield* Effect.exit(
          Effect.scoped(broker.acquireSession({ model: "m" })),
        )
        // Advance past 50ms cooldown.
        yield* Effect.sync(() => clock.setNow(100))
        const recovered = yield* Effect.exit(
          Effect.scoped(broker.acquireSession({ model: "m" })),
        )
        return { exhausted, recovered }
      }).pipe(Effect.provide(layer)),
    )
    expect(Exit.isFailure(out.exhausted)).toBe(true)
    expect(Exit.isSuccess(out.recovered)).toBe(true)
  })
})
