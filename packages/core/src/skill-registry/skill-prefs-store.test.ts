/**
 * SkillPrefsStore tests — the delta-only persistence behind skill toggles.
 *
 * The load-bearing property: a toggle SURVIVES a store reopen (two layer
 * builds over the same SQLite file), because that is exactly what a
 * chat-server restart does at hydration time.
 */
import { afterEach, describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Clock } from "../clock.js"
import { LunaSqliteBootstrap } from "../db/sqlite-bootstrap.js"
import { SkillPrefsStore } from "./skill-prefs-store.js"
import { SkillRegistry, type SkillManifest } from "./skill-registry.js"

// Phase 27a: makeLayer declares LunaSqliteBootstrap in R. Tests stub it —
// the Vectorlite swap is irrelevant to a plain key/value table.
const bootstrapStubL = Layer.succeed(LunaSqliteBootstrap, {
  ok: false,
  reason: "test-stub",
})

// bun-only (`bun:sqlite` import dies under stock vitest/node) — same gate
// as account-broker-sql.test.ts / cost-accounting/sqlite.test.ts.
const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"
const d = isBun ? describe : describe.skip

const dbPath = join(
  tmpdir(),
  `luna-skill-prefs-test-${process.pid}-${Date.now()}.db`,
)

afterEach(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(dbPath + suffix, { force: true })
    } catch {
      /* best-effort */
    }
  }
})

const storeLayer = () =>
  SkillPrefsStore.makeLayer(dbPath).pipe(
    Layer.provide(Clock.Default),
    Layer.provide(bootstrapStubL),
  )

const runStore = <A, E>(eff: Effect.Effect<A, E, SkillPrefsStore>) =>
  Effect.runPromise(eff.pipe(Effect.provide(storeLayer())) as Effect.Effect<A, E>)

d("SkillPrefsStore (sqlite)", () => {
  it("starts empty — absent rows mean enabled-by-default", async () => {
    const disabled = await runStore(
      Effect.gen(function* () {
        const prefs = yield* SkillPrefsStore
        return yield* prefs.disabledIds()
      }),
    )
    expect(disabled).toEqual([])
  })

  it("toggle persists ACROSS REOPEN; re-enable clears; upsert is idempotent", async () => {
    // First open: disable two, re-enable one, double-write one.
    await runStore(
      Effect.gen(function* () {
        const prefs = yield* SkillPrefsStore
        yield* prefs.setEnabled("alpha", false)
        yield* prefs.setEnabled("beta", false)
        yield* prefs.setEnabled("beta", false) // idempotent upsert
        yield* prefs.setEnabled("gamma", false)
        yield* prefs.setEnabled("gamma", true) // re-enabled → not disabled
        const disabled = yield* prefs.disabledIds()
        expect([...disabled].sort()).toEqual(["alpha", "beta"])
      }),
    )
    // Second open over the SAME file — the restart-hydration path.
    const afterReopen = await runStore(
      Effect.gen(function* () {
        const prefs = yield* SkillPrefsStore
        return yield* prefs.disabledIds()
      }),
    )
    expect([...afterReopen].sort()).toEqual(["alpha", "beta"])
  })

  it("hydrates the registry end-to-end: disabled rows -> initialDisabled -> snapshot excludes", async () => {
    const m = (id: string): SkillManifest => ({
      id,
      name: `Skill ${id}`,
      description: `Does ${id}.`,
      whenToUse: `When ${id}.`,
      category: "other",
      tags: [],
      source: "builtin",
      body: `BODY-${id}`,
    })
    // Persist a disable, then build the registry the way chat-server does:
    // hydrate initialDisabled from the store + write-through onToggle.
    await runStore(
      Effect.gen(function* () {
        const prefs = yield* SkillPrefsStore
        yield* prefs.setEnabled("muted", false)

        const disabled = yield* prefs.disabledIds()
        const registryL = SkillRegistry.layer({
          seeds: [m("loud"), m("muted")],
          initialDisabled: disabled,
          onToggle: (id, enabled) => prefs.setEnabled(id, enabled),
        })
        yield* Effect.gen(function* () {
          const reg = yield* SkillRegistry
          const snap = reg.promptSnapshotSync()
          expect(snap).toContain("BODY-loud")
          expect(snap).not.toContain("BODY-muted")
          // toggle through the registry → write-through lands in sqlite
          yield* reg.setEnabled("loud", false)
        }).pipe(Effect.provide(registryL))

        const after = yield* prefs.disabledIds()
        expect([...after].sort()).toEqual(["loud", "muted"])
      }),
    )
  })
})

describe("SkillPrefsStore.Memory", () => {
  it("mirrors the sqlite semantics for unit tests", async () => {
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const prefs = yield* SkillPrefsStore
        yield* prefs.setEnabled("a", false)
        yield* prefs.setEnabled("b", false)
        yield* prefs.setEnabled("b", true)
        return yield* prefs.disabledIds()
      }).pipe(Effect.provide(SkillPrefsStore.Memory)),
    )
    expect(out).toEqual(["a"])
  })
})
