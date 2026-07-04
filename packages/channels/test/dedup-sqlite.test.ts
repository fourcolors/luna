/**
 * InboundDedupStore — bun:sqlite regression coverage.
 *
 * The Memory variant (channels.test.ts) can't catch the class of bug this
 * guards: bun:sqlite's prepared-statement `.get()` returns `null` (not
 * `undefined`) when no row matches. An existence check written as
 * `!== undefined` is therefore true for EVERY lookup, so `seenBefore` reports
 * every inbound message as already-seen and the channel silently drops all
 * traffic. This suite exercises the real SQLite-backed layer to lock in the
 * `!= null` semantics.
 *
 * bun:sqlite is a Bun built-in vitest cannot load, so this runs under the Bun
 * test runner only (see vitest.config.ts BUN_RUNTIME_TESTS + `test:bun`).
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer, Scope } from "effect"
import { Clock, LunaSqliteBootstrap } from "@luna/core"
import { InboundDedupStore } from "../src/dedup.js"

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"
const d = isBun ? describe : describe.skip

const bootstrapStubL = Layer.succeed(LunaSqliteBootstrap, {
  ok: false,
  reason: "channels test — bootstrap stub",
} as const)

const makeFullLayer = (dbPath: string) => {
  const clockL = Clock.Default
  const storeL = InboundDedupStore.makeLayer(dbPath).pipe(
    Layer.provide(clockL),
    Layer.provide(bootstrapStubL),
  )
  return Layer.mergeAll(storeL, clockL)
}

const run = <A, E>(
  prog: Effect.Effect<A, E, InboundDedupStore | Clock | Scope.Scope>,
  dbPath = ":memory:",
) =>
  Effect.runPromise(
    Effect.scoped(prog).pipe(Effect.provide(makeFullLayer(dbPath))) as Effect.Effect<A, E, never>,
  )

d("InboundDedupStore (sqlite)", () => {
  it("reports an unseen message as NOT seen (the null-vs-undefined regression)", async () => {
    const seen = await run(
      Effect.gen(function* () {
        const store = yield* InboundDedupStore
        return yield* store.seenBefore("telegram", "42")
      }),
    )
    expect(seen).toBe(false)
  })

  it("markSeen makes a subsequent seenBefore true; other ids stay false", async () => {
    const out = await run(
      Effect.gen(function* () {
        const store = yield* InboundDedupStore
        const before = yield* store.seenBefore("telegram", "100")
        yield* store.markSeen("telegram", "100", 1000)
        const after = yield* store.seenBefore("telegram", "100")
        const other = yield* store.seenBefore("telegram", "101")
        const otherTransport = yield* store.seenBefore("discord", "100")
        return { before, after, other, otherTransport }
      }),
    )
    expect(out.before).toBe(false)
    expect(out.after).toBe(true)
    expect(out.other).toBe(false)
    expect(out.otherTransport).toBe(false)
  })

  it("markSeen is idempotent (INSERT OR IGNORE on the composite key)", async () => {
    const out = await run(
      Effect.gen(function* () {
        const store = yield* InboundDedupStore
        yield* store.markSeen("telegram", "7", 1)
        yield* store.markSeen("telegram", "7", 2)
        return yield* store.seenBefore("telegram", "7")
      }),
    )
    expect(out).toBe(true)
  })
})
