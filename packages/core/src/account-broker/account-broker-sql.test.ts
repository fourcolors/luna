/**
 * AccountBrokerLayer.fromSql() — Tier-1 SQLite hydration tests (Phase 25a).
 *
 * Mirrors `cost-accounting/sqlite.test.ts` shape: bun-only (`bun:sqlite`
 * import dies under stock vitest/node), gated via `describe.skipIf`.
 */
import { describe, expect, it } from "vitest"
import { Effect, Exit, Layer, Redacted, Ref } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Clock } from "../clock.js"
import { LunaSqliteBootstrap } from "../db/sqlite-bootstrap.js"
import { ConfigError } from "../errors.js"
import {
  CLAUDE_CODE_LOGIN_SECRET_REF,
  SecretProvider,
  type SecretProviderApi,
} from "../secret-provider/index.js"
import { AccountBroker, AccountBrokerLayer } from "./index.js"

// Phase 27a: AccountBrokerLayer.fromSql now declares `LunaSqliteBootstrap`
// in its `R`. The real Live Layer lives in @luna/memory; @luna/core tests
// satisfy the Tag with a no-op success value.
const bootstrapStubL = Layer.succeed(LunaSqliteBootstrap, {
  ok: false,
  reason: "core test — bootstrap stub",
} as const)

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"
const d = isBun ? describe : describe.skip

// ── Test helpers ──────────────────────────────────────────────────────────
const tmpDb = () =>
  path.join(
    os.tmpdir(),
    `luna-accounts-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  )

const cleanupTmp = (p: string) => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(p + suffix)
    } catch {
      /* ignore */
    }
  }
}

/**
 * Open a fresh DB via `bun:sqlite`, run the §5.1 migration ladder logic
 * by spinning up the Layer once, then reuse the file. For tests that need
 * to seed rows BEFORE the broker hydrates, we open a raw `bun:sqlite`
 * handle, ensure the schema exists, INSERT, close, then build the Layer.
 */
const seedAccountsTable = async (
  dbPath: string,
  rows: ReadonlyArray<{
    id: string
    label?: string
    kind: string
    secret_ref: string
    health?: string
    cooldown_ms?: number | null
    usage_json?: string
  }>,
) => {
  const bunSqliteSpec = "bun:sqlite"
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import(/* @vite-ignore */ bunSqliteSpec)
  const db = new mod.Database(dbPath) as {
    run: (sql: string) => void
    query: (sql: string) => {
      get: () => unknown
      all: () => unknown[]
      run: (...p: unknown[]) => { changes: number }
    }
    close: () => void
  }
  db.run(`CREATE TABLE IF NOT EXISTS accounts (
    id            TEXT PRIMARY KEY,
    label         TEXT NOT NULL,
    kind          TEXT NOT NULL,
    secret_ref    TEXT NOT NULL,
    health        TEXT NOT NULL,
    cooldown_ms   INTEGER,
    usage_json    TEXT NOT NULL
  )`)
  db.run("PRAGMA user_version = 1")
  const ins = db.query(
    `INSERT INTO accounts (id, label, kind, secret_ref, health, cooldown_ms, usage_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const r of rows) {
    ins.run(
      r.id,
      r.label ?? r.id,
      r.kind,
      r.secret_ref,
      r.health ?? "healthy",
      r.cooldown_ms ?? null,
      r.usage_json ?? "{}",
    )
  }
  db.close()
}

interface SecretCallLog {
  readonly refs: ReadonlyArray<string>
}

/** Stub SecretProvider that records the refs it was asked to resolve. */
const stubSecretsLayer = (
  entries: Record<string, string>,
  log: Ref.Ref<ReadonlyArray<string>>,
): Layer.Layer<SecretProvider> =>
  Layer.effect(
    SecretProvider,
    Effect.sync(
      (): SecretProviderApi => ({
        get: (ref) =>
          Effect.gen(function* () {
            yield* Ref.update(log, (xs) => [...xs, ref])
            const v = entries[ref]
            if (v === undefined) {
              return yield* Effect.fail(
                new ConfigError({
                  module: "stub-secrets",
                  key: ref,
                  message: "no entry",
                }),
              )
            }
            return Redacted.make(v)
          }),
      }),
    ),
  )

const buildLayer = (
  dbPath: string,
  secretsLayer: Layer.Layer<SecretProvider>,
  fixedMs = 1000,
) =>
  AccountBrokerLayer.fromSql({ dbPath }).pipe(
    Layer.provide(
      Layer.mergeAll(secretsLayer, Clock.Test(fixedMs), bootstrapStubL),
    ),
  )

// ── Mutable mock clock (for cycle-roll under a controllable clock) ──────────
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

const buildLayerWithClock = (
  dbPath: string,
  secretsLayer: Layer.Layer<SecretProvider>,
  clockLayer: Layer.Layer<Clock>,
) =>
  AccountBrokerLayer.fromSql({ dbPath }).pipe(
    Layer.provide(Layer.mergeAll(secretsLayer, clockLayer, bootstrapStubL)),
  )

/** Save/restore a global env var around an async body. */
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

/** Read the raw usage_json blob for one account id, via a fresh bun:sqlite handle. */
const readUsageJson = async (
  dbPath: string,
  id: string,
): Promise<{ cycleStartMs?: number; spentUsd?: number; budgetUsd?: number }> => {
  const bunSqliteSpec = "bun:sqlite"
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import(/* @vite-ignore */ bunSqliteSpec)
  const raw = new mod.Database(dbPath) as {
    query: (sql: string) => { get: (...p: unknown[]) => unknown }
    close: () => void
  }
  const row = raw
    .query("SELECT usage_json FROM accounts WHERE id = ?")
    .get(id) as { usage_json?: string } | undefined
  raw.close()
  if (!row?.usage_json) return {}
  try {
    return JSON.parse(row.usage_json)
  } catch {
    return {}
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────

d("AccountBrokerLayer.fromSql — schema migration", () => {
  it("(1) fresh DB → accounts table exists with all §5.1 columns", async () => {
    const dbPath = tmpDb()
    try {
      const log = await Effect.runPromise(Ref.make<ReadonlyArray<string>>([]))
      const layer = buildLayer(dbPath, stubSecretsLayer({}, log))
      // Build the layer to execute migration; nothing else needed.
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const broker = yield* AccountBroker
            return yield* broker._inspect()
          }),
        ).pipe(Effect.provide(layer)),
      )
      // Inspect schema directly via raw bun:sqlite.
      const bunSqliteSpec = "bun:sqlite"
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod: any = await import(/* @vite-ignore */ bunSqliteSpec)
      const raw = new mod.Database(dbPath) as {
        query: (sql: string) => { all: () => unknown[]; get: () => unknown }
        close: () => void
      }
      const cols = raw
        .query("PRAGMA table_info(accounts)")
        .all() as Array<{ name: string; type: string; notnull: number }>
      raw.close()
      const byName = new Map(cols.map((c) => [c.name, c]))
      for (const expected of [
        "id",
        "label",
        "kind",
        "secret_ref",
        "health",
        "cooldown_ms",
        "usage_json",
      ]) {
        expect(byName.has(expected), `missing column ${expected}`).toBe(true)
      }
    } finally {
      cleanupTmp(dbPath)
    }
  })

  it("(2) re-run migration on existing DB is idempotent; schema_versions row stays single", async () => {
    const dbPath = tmpDb()
    try {
      const log = await Effect.runPromise(Ref.make<ReadonlyArray<string>>([]))
      const layer = buildLayer(dbPath, stubSecretsLayer({}, log))
      // First build → applyMigration("accounts", 1, ...) inserts a single row.
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const broker = yield* AccountBroker
            return yield* broker._inspect()
          }),
        ).pipe(Effect.provide(layer)),
      )
      const bunSqliteSpec = "bun:sqlite"
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod: any = await import(/* @vite-ignore */ bunSqliteSpec)
      const raw1 = new mod.Database(dbPath) as {
        query: (sql: string) => {
          get: (...p: unknown[]) => unknown
          all: (...p: unknown[]) => unknown[]
        }
        close: () => void
      }
      const rows1 = raw1
        .query(
          "SELECT component, version FROM schema_versions WHERE component = ?",
        )
        .all("accounts") as ReadonlyArray<{
        component: string
        version: number
      }>
      raw1.close()
      expect(rows1).toHaveLength(1)
      expect(rows1[0]).toEqual({ component: "accounts", version: 1 })

      // Second build → no-op, must not throw, ledger row count unchanged.
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const broker = yield* AccountBroker
            return yield* broker._inspect()
          }),
        ).pipe(Effect.provide(layer)),
      )
      const raw2 = new mod.Database(dbPath) as {
        query: (sql: string) => {
          get: (...p: unknown[]) => unknown
          all: (...p: unknown[]) => unknown[]
        }
        close: () => void
      }
      const rows2 = raw2
        .query(
          "SELECT component, version FROM schema_versions WHERE component = ?",
        )
        .all("accounts") as ReadonlyArray<unknown>
      raw2.close()
      expect(rows2).toHaveLength(1)
    } finally {
      cleanupTmp(dbPath)
    }
  })
})

d("AccountBrokerLayer.fromSql — hydration", () => {
  it("(3) empty table → broker has zero accounts; acquireSession → AllAccountsExhaustedError", async () => {
    const dbPath = tmpDb()
    try {
      const log = await Effect.runPromise(Ref.make<ReadonlyArray<string>>([]))
      const layer = buildLayer(dbPath, stubSecretsLayer({}, log))
      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          Effect.gen(function* () {
            const broker = yield* AccountBroker
            const accounts = yield* broker._inspect()
            expect(accounts).toHaveLength(0)
            return yield* broker.acquireSession({ model: "m" })
          }),
        ).pipe(Effect.provide(layer)),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("AllAccountsExhaustedError")
      }
    } finally {
      cleanupTmp(dbPath)
    }
  })

  it("(4) 3 valid rows → pool has exactly 3 records with id/kind/secretRef mapped", async () => {
    const dbPath = tmpDb()
    try {
      await seedAccountsTable(dbPath, [
        { id: "a1", kind: "anthropic", secret_ref: "anth:a1" },
        { id: "a2", kind: "anthropic", secret_ref: "anth:a2" },
        { id: "a3", kind: "anthropic", secret_ref: "anth:a3" },
      ])
      const log = await Effect.runPromise(Ref.make<ReadonlyArray<string>>([]))
      const layer = buildLayer(
        dbPath,
        stubSecretsLayer(
          { "anth:a1": "tok-1", "anth:a2": "tok-2", "anth:a3": "tok-3" },
          log,
        ),
      )
      const accounts = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const broker = yield* AccountBroker
            return yield* broker._inspect()
          }),
        ).pipe(Effect.provide(layer)),
      )
      expect(accounts).toHaveLength(3)
      const byId = Object.fromEntries(accounts.map((a) => [a.id, a]))
      expect(byId.a1?.kind).toBe("anthropic")
      expect(byId.a1?.secretRef).toBe("anth:a1")
      expect(byId.a2?.secretRef).toBe("anth:a2")
      expect(byId.a3?.secretRef).toBe("anth:a3")
      // Cooldown defaults to undefined when cooldown_ms IS NULL.
      expect(byId.a1?.cooldownUntilMs).toBeUndefined()
    } finally {
      cleanupTmp(dbPath)
    }
  })

  it("(5) row with non-zero cooldown_ms → cooldownUntilMs = now + cooldown_ms (Test Clock)", async () => {
    const dbPath = tmpDb()
    try {
      const FIXED = 1_000_000
      await seedAccountsTable(dbPath, [
        {
          id: "a1",
          kind: "anthropic",
          secret_ref: "anth:a1",
          cooldown_ms: 5_000,
        },
        {
          id: "a2",
          kind: "anthropic",
          secret_ref: "anth:a2",
          cooldown_ms: 0,
        },
      ])
      const log = await Effect.runPromise(Ref.make<ReadonlyArray<string>>([]))
      const layer = buildLayer(
        dbPath,
        stubSecretsLayer({ "anth:a1": "x", "anth:a2": "y" }, log),
        FIXED,
      )
      const accounts = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const broker = yield* AccountBroker
            return yield* broker._inspect()
          }),
        ).pipe(Effect.provide(layer)),
      )
      const byId = Object.fromEntries(accounts.map((a) => [a.id, a]))
      expect(byId.a1?.cooldownUntilMs).toBe(FIXED + 5_000)
      // cooldown_ms = 0 → no cooldown set.
      expect(byId.a2?.cooldownUntilMs).toBeUndefined()
    } finally {
      cleanupTmp(dbPath)
    }
  })

  it("(6) malformed row (empty kind) → ConfigError with offending id; Layer fails", async () => {
    const dbPath = tmpDb()
    try {
      await seedAccountsTable(dbPath, [
        { id: "good", kind: "anthropic", secret_ref: "anth:good" },
        { id: "bad-kind", kind: "", secret_ref: "anth:bad" },
      ])
      const log = await Effect.runPromise(Ref.make<ReadonlyArray<string>>([]))
      const layer = buildLayer(dbPath, stubSecretsLayer({}, log))
      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          Effect.gen(function* () {
            const broker = yield* AccountBroker
            return yield* broker._inspect()
          }),
        ).pipe(Effect.provide(layer)),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const flat = JSON.stringify(exit.cause)
        expect(flat).toContain("ConfigError")
        expect(flat).toContain("bad-kind")
      }
    } finally {
      cleanupTmp(dbPath)
    }
  })

  it("(6b) malformed row (empty secret_ref) → ConfigError with offending id", async () => {
    const dbPath = tmpDb()
    try {
      await seedAccountsTable(dbPath, [
        { id: "ghost", kind: "anthropic", secret_ref: "" },
      ])
      const log = await Effect.runPromise(Ref.make<ReadonlyArray<string>>([]))
      const layer = buildLayer(dbPath, stubSecretsLayer({}, log))
      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          Effect.gen(function* () {
            const broker = yield* AccountBroker
            return yield* broker._inspect()
          }),
        ).pipe(Effect.provide(layer)),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const flat = JSON.stringify(exit.cause)
        expect(flat).toContain("ConfigError")
        expect(flat).toContain("ghost")
      }
    } finally {
      cleanupTmp(dbPath)
    }
  })
})

d("AccountBrokerLayer.fromSql — invariant enforcement", () => {
  it("(7) acquireSession resolves SecretProvider with the row's secret_ref", async () => {
    const dbPath = tmpDb()
    try {
      await seedAccountsTable(dbPath, [
        { id: "only", kind: "anthropic", secret_ref: "anth:only" },
      ])
      const log = await Effect.runPromise(Ref.make<ReadonlyArray<string>>([]))
      const layer = buildLayer(
        dbPath,
        stubSecretsLayer({ "anth:only": "the-token" }, log),
      )
      const out = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const broker = yield* AccountBroker
            const acq = yield* broker.acquireSession({ model: "m" })
            const seenRefs = yield* Ref.get(log)
            return { cred: acq.credential, seenRefs }
          }),
        ).pipe(Effect.provide(layer)),
      )
      expect(out.cred.accountId).toBe("only")
      expect(out.cred.secretRef).toBe("anth:only")
      expect(Redacted.value(out.cred.resolvedSecret)).toBe("the-token")
      expect(out.seenRefs).toContain("anth:only")
    } finally {
      cleanupTmp(dbPath)
    }
  })

  it("claude-code:login rows do not resolve through SecretProvider", async () => {
    const dbPath = tmpDb()
    try {
      await seedAccountsTable(dbPath, [
        {
          id: "claude-login",
          kind: "anthropic",
          secret_ref: CLAUDE_CODE_LOGIN_SECRET_REF,
        },
      ])
      const log = await Effect.runPromise(Ref.make<ReadonlyArray<string>>([]))
      const layer = buildLayer(dbPath, stubSecretsLayer({}, log))
      const out = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const broker = yield* AccountBroker
            const acq = yield* broker.acquireSession({ model: "m" })
            const seenRefs = yield* Ref.get(log)
            return { cred: acq.credential, seenRefs }
          }),
        ).pipe(Effect.provide(layer)),
      )
      expect(out.cred.accountId).toBe("claude-login")
      expect(out.cred.secretRef).toBe(CLAUDE_CODE_LOGIN_SECRET_REF)
      expect(Redacted.value(out.cred.resolvedSecret)).toBe("")
      expect(out.seenRefs).toEqual([])
    } finally {
      cleanupTmp(dbPath)
    }
  })
})

// ── B3 spend-meter: usage accumulation, budget→cooldown, survives-restart ──
d("AccountBrokerLayer.fromSql — spend-meter (B3)", () => {
  it("(B3.1) usage report accumulates spend and writes it back to usage_json", async () => {
    const dbPath = tmpDb()
    try {
      await seedAccountsTable(dbPath, [
        { id: "a1", kind: "anthropic", secret_ref: "anth:a1" },
      ])
      const log = await Effect.runPromise(Ref.make<ReadonlyArray<string>>([]))
      const layer = buildLayer(
        dbPath,
        stubSecretsLayer({ "anth:a1": "tok" }, log),
        1000,
      )
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const broker = yield* AccountBroker
            // $3.00 sonnet turn (1M input @ $3/M).
            yield* broker.report({
              accountId: "a1",
              kind: "usage",
              model: "claude-sonnet-4-5",
              tokensIn: 1_000_000,
              tokensOut: 0,
            })
            const inspected = yield* broker._inspect()
            const a1 = inspected.find((a) => a.id === "a1")
            expect(a1?.usage?.spentUsd).toBeCloseTo(3.0, 5)
          }),
        ).pipe(Effect.provide(layer)),
      )
      // The write-back persisted the accumulator to disk.
      const persisted = await readUsageJson(dbPath, "a1")
      expect(persisted.spentUsd).toBeCloseTo(3.0, 5)
      expect(persisted.cycleStartMs).toBe(1000)
    } finally {
      cleanupTmp(dbPath)
    }
  })

  it("(B3.2) budget exhausted → cooldown at the cycle boundary (rolling cycle via env)", async () => {
    const CYCLE = 100_000
    await withEnv({ LUNA_SPEND_CYCLE_MS: String(CYCLE) }, async () => {
      const dbPath = tmpDb()
      try {
        // Budget packed INTO usage_json (§5.1 — no new column).
        await seedAccountsTable(dbPath, [
          {
            id: "a1",
            kind: "anthropic",
            secret_ref: "anth:a1",
            usage_json: JSON.stringify({ budgetUsd: 2.0 }),
          },
        ])
        const log = await Effect.runPromise(Ref.make<ReadonlyArray<string>>([]))
        const FIXED = 5000
        const layer = buildLayer(
          dbPath,
          stubSecretsLayer({ "anth:a1": "tok" }, log),
          FIXED,
        )
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const broker = yield* AccountBroker
              // $3.00 > $2.00 budget → exhausted.
              yield* broker.report({
                accountId: "a1",
                kind: "usage",
                model: "claude-sonnet-4-5",
                tokensIn: 1_000_000,
                tokensOut: 0,
              })
              const inspected = yield* broker._inspect()
              const a1 = inspected.find((a) => a.id === "a1")
              // cooldown = cycleStart(5000) + CYCLE(100000).
              expect(a1?.cooldownUntilMs).toBe(FIXED + CYCLE)
              // Account is now unavailable (no others) → acquire fails.
              const exit = yield* Effect.exit(
                Effect.scoped(
                  broker.acquireSession({ model: "claude-sonnet-4-5" }),
                ),
              )
              expect(exit._tag).toBe("Failure")
            }),
          ).pipe(Effect.provide(layer)),
        )
        // The budget round-trips in usage_json after write-back.
        const persisted = await readUsageJson(dbPath, "a1")
        expect(persisted.budgetUsd).toBe(2.0)
        expect(persisted.spentUsd).toBeCloseTo(3.0, 5)
      } finally {
        cleanupTmp(dbPath)
      }
    })
  })

  it("(B3.3) cycle rolls under a controllable clock: spend resets after the boundary", async () => {
    const CYCLE = 100_000
    await withEnv({ LUNA_SPEND_CYCLE_MS: String(CYCLE) }, async () => {
      const dbPath = tmpDb()
      try {
        await seedAccountsTable(dbPath, [
          { id: "a1", kind: "anthropic", secret_ref: "anth:a1" },
        ])
        const log = await Effect.runPromise(Ref.make<ReadonlyArray<string>>([]))
        const clock = makeMockClock(0)
        const layer = buildLayerWithClock(
          dbPath,
          stubSecretsLayer({ "anth:a1": "tok" }, log),
          clock.layer,
        )
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const broker = yield* AccountBroker
              yield* broker.report({
                accountId: "a1",
                kind: "usage",
                model: "claude-sonnet-4-5",
                tokensIn: 1_000_000,
                tokensOut: 0,
              })
              const first = (yield* broker._inspect()).find((a) => a.id === "a1")
              expect(first?.usage?.cycleStartMs).toBe(0)
              expect(first?.usage?.spentUsd).toBeCloseTo(3.0, 5)
              // Advance past the boundary → next report rolls the window.
              yield* Effect.sync(() => clock.setNow(150_000))
              yield* broker.report({
                accountId: "a1",
                kind: "usage",
                model: "claude-sonnet-4-5",
                tokensIn: 1_000_000,
                tokensOut: 0,
              })
              const second = (yield* broker._inspect()).find((a) => a.id === "a1")
              expect(second?.usage?.cycleStartMs).toBe(150_000)
              expect(second?.usage?.spentUsd).toBeCloseTo(3.0, 5)
            }),
          ).pipe(Effect.provide(layer)),
        )
      } finally {
        cleanupTmp(dbPath)
      }
    })
  })

  it("(B3.4) SURVIVES RESTART: a budget-exhausted account is still cooled down after rehydrate", async () => {
    const CYCLE = 100_000
    await withEnv({ LUNA_SPEND_CYCLE_MS: String(CYCLE) }, async () => {
      const dbPath = tmpDb()
      try {
        await seedAccountsTable(dbPath, [
          {
            id: "a1",
            kind: "anthropic",
            secret_ref: "anth:a1",
            usage_json: JSON.stringify({ budgetUsd: 2.0 }),
          },
        ])
        const log = await Effect.runPromise(Ref.make<ReadonlyArray<string>>([]))
        // SAME fixed clock for BOTH builds so cooldown (persisted as remaining
        // ms) does not extend across the "restart" — see hydrate contract.
        const FIXED = 5000
        const secrets = stubSecretsLayer({ "anth:a1": "tok" }, log)

        // ── Run 1: exhaust the budget → cooldown persisted. ──
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const broker = yield* AccountBroker
              yield* broker.report({
                accountId: "a1",
                kind: "usage",
                model: "claude-sonnet-4-5",
                tokensIn: 1_000_000,
                tokensOut: 0,
              })
            }),
          ).pipe(Effect.provide(buildLayer(dbPath, secrets, FIXED))),
        )

        // ── Run 2: reopen the SAME db → the account must hydrate STILL cooled
        // down (cooldown_ms round-tripped) and STILL carry its spend/budget. ──
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const broker = yield* AccountBroker
              const a1 = (yield* broker._inspect()).find((a) => a.id === "a1")
              // Re-hydrated cooled down: cooldownUntilMs in the future.
              expect(a1?.cooldownUntilMs).toBeGreaterThan(FIXED)
              // Spend + budget survived.
              expect(a1?.usage?.spentUsd).toBeCloseTo(3.0, 5)
              expect(a1?.budgetUsd).toBe(2.0)
              // Acquire fails — account is locked out post-restart.
              const exit = yield* Effect.exit(
                Effect.scoped(
                  broker.acquireSession({ model: "claude-sonnet-4-5" }),
                ),
              )
              expect(exit._tag).toBe("Failure")
            }),
          ).pipe(Effect.provide(buildLayer(dbPath, secrets, FIXED))),
        )
      } finally {
        cleanupTmp(dbPath)
      }
    })
  })

  it("(B3.6) RESTART re-anchoring: budget cooldown stays on the ABSOLUTE cycle boundary + releases at it (review BLOCKER #2)", async () => {
    const CYCLE = 100_000
    await withEnv({ LUNA_SPEND_CYCLE_MS: String(CYCLE) }, async () => {
      const dbPath = tmpDb()
      try {
        await seedAccountsTable(dbPath, [
          {
            id: "a1",
            kind: "anthropic",
            secret_ref: "anth:a1",
            usage_json: JSON.stringify({ budgetUsd: 2.0 }),
          },
        ])
        const log = await Effect.runPromise(Ref.make<ReadonlyArray<string>>([]))
        const secrets = stubSecretsLayer({ "anth:a1": "tok" }, log)
        const EXHAUST_AT = 5000
        const BOUNDARY = EXHAUST_AT + CYCLE // 105000

        // ── Run 1: exhaust the budget at t=5000 → cooldown boundary = 105000. ──
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const broker = yield* AccountBroker
              yield* broker.report({
                accountId: "a1",
                kind: "usage",
                model: "claude-sonnet-4-5",
                tokensIn: 1_000_000,
                tokensOut: 0,
              })
            }),
          ).pipe(Effect.provide(buildLayer(dbPath, secrets, EXHAUST_AT))),
        )

        // ── Run 2: restart WITHIN the cycle (t=50000). The budget cooldown must
        // re-anchor to the ABSOLUTE boundary (105000), NOT now+remaining
        // (150000). The old flatten/re-anchor shoved it forward each restart. ──
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const broker = yield* AccountBroker
              const a1 = (yield* broker._inspect()).find((a) => a.id === "a1")
              expect(a1?.cooldownUntilMs).toBe(BOUNDARY) // absolute, not 150000
              const exit = yield* Effect.exit(
                Effect.scoped(
                  broker.acquireSession({ model: "claude-sonnet-4-5" }),
                ),
              )
              expect(exit._tag).toBe("Failure") // still cooled mid-cycle
            }),
          ).pipe(Effect.provide(buildLayer(dbPath, secrets, 50_000))),
        )

        // ── Run 3: restart PAST the boundary (t=110000). The cycle is stale →
        // spend resets → the account is FRESH and acquire SUCCEEDS. The old code
        // computed cooldownUntilMs = 110000 + remaining and wrongly stayed
        // locked (potentially forever under frequent restarts). ──
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const broker = yield* AccountBroker
              const a1 = (yield* broker._inspect()).find((a) => a.id === "a1")
              expect(a1?.cooldownUntilMs).toBeUndefined() // released
              const acq = yield* broker.acquireSession({
                model: "claude-sonnet-4-5",
              })
              expect(acq.credential.accountId).toBe("a1") // usable again
            }),
          ).pipe(Effect.provide(buildLayer(dbPath, secrets, 110_000))),
        )
      } finally {
        cleanupTmp(dbPath)
      }
    })
  })

  it("(B3.5) §7.5 cross-broker identity: in-memory and SQL price one report identically", async () => {
    const dbPath = tmpDb()
    try {
      await seedAccountsTable(dbPath, [
        { id: "a1", kind: "anthropic", secret_ref: "anth:a1" },
      ])
      const log = await Effect.runPromise(Ref.make<ReadonlyArray<string>>([]))
      const FIXED = 1000
      // SQL broker spend.
      const sqlSpent = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const broker = yield* AccountBroker
            yield* broker.report({
              accountId: "a1",
              kind: "usage",
              model: "claude-opus-4-5",
              tokensIn: 500_000,
              tokensOut: 100_000,
              cacheRead: 10_000,
              cacheWrite: 2_000,
            })
            const a1 = (yield* broker._inspect()).find((a) => a.id === "a1")
            return a1?.usage?.spentUsd ?? -1
          }),
        ).pipe(
          Effect.provide(
            buildLayer(dbPath, stubSecretsLayer({ "anth:a1": "tok" }, log), FIXED),
          ),
        ),
      )
      // In-memory broker spend with the IDENTICAL report.
      const memSpent = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const broker = yield* AccountBroker
            yield* broker.report({
              accountId: "a1",
              kind: "usage",
              model: "claude-opus-4-5",
              tokensIn: 500_000,
              tokensOut: 100_000,
              cacheRead: 10_000,
              cacheWrite: 2_000,
            })
            const a1 = (yield* broker._inspect()).find((a) => a.id === "a1")
            return a1?.usage?.spentUsd ?? -1
          }),
        ).pipe(
          Effect.provide(
            AccountBrokerLayer.fromAccounts([
              { id: "a1", kind: "anthropic", secretRef: "anth:a1" },
            ]).pipe(
              Layer.provide(
                Layer.mergeAll(
                  stubSecretsLayer({ "anth:a1": "tok" }, log),
                  Clock.Test(FIXED),
                ),
              ),
            ),
          ),
        ),
      )
      expect(sqlSpent).toBeGreaterThan(0)
      expect(sqlSpent).toBeCloseTo(memSpent, 9)
    } finally {
      cleanupTmp(dbPath)
    }
  })
})

// satisfy lint for the unused interface in helpers
void ({} as SecretCallLog)
