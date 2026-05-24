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
            const cred = yield* broker.acquireSession({ model: "m" })
            const seenRefs = yield* Ref.get(log)
            return { cred, seenRefs }
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
            const cred = yield* broker.acquireSession({ model: "m" })
            const seenRefs = yield* Ref.get(log)
            return { cred, seenRefs }
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

// satisfy lint for the unused interface in helpers
void ({} as SecretCallLog)
