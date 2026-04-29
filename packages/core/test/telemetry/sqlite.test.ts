/**
 * TelemetryService.fromPath() — SQLite-backed Layer tests (Phase 24b).
 *
 * Mirrors `cost-accounting/sqlite.test.ts` shape. Bun-only: `bun:sqlite`
 * import dies under stock vitest/node — gated via `describe.skipIf`.
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer, Scope } from "effect"
import * as os from "node:os"
import * as path from "node:path"
import * as fs from "node:fs"
import { Clock } from "../../src/clock.js"
// Importing the SQLite module installs `TelemetryService.fromPath`.
import "../../src/telemetry/telemetry-store-sqlite.js"
import {
  TelemetryService,
  type TelemetrySqliteOptions,
} from "../../src/telemetry/index.js"

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"
const d = isBun ? describe : describe.skip

const makeFullLayer = (
  dbPath: string,
  options?: TelemetrySqliteOptions,
) => {
  const clockL = Clock.Default
  const telL = TelemetryService.fromPath(dbPath, options).pipe(
    Layer.provide(clockL),
  )
  return Layer.mergeAll(telL, clockL)
}

const run = <A, E>(
  prog: Effect.Effect<A, E, TelemetryService | Clock | Scope.Scope>,
  dbPath = ":memory:",
  options?: TelemetrySqliteOptions,
) =>
  Effect.runPromise(
    Effect.scoped(prog).pipe(
      Effect.provide(makeFullLayer(dbPath, options)),
    ) as Effect.Effect<A, E, never>,
  )

const tmpDb = () =>
  path.join(
    os.tmpdir(),
    `luna-telemetry-sqlite-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}.db`,
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

// Helper: open a raw bun:sqlite handle for low-level assertions on the
// underlying tables. Runtime-only; never imported by source.
const openRaw = async (dbPath: string) => {
  const bunSqliteSpec = "bun:sqlite"
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import(/* @vite-ignore */ bunSqliteSpec)
  return new mod.Database(dbPath) as {
    query: (sql: string) => {
      get: (...p: unknown[]) => unknown
      all: (...p: unknown[]) => unknown[]
    }
    close: () => void
  }
}

d("TelemetryService.fromPath (sqlite)", () => {
  it("(1) round-trip: counter survives close + reopen", async () => {
    const dbPath = tmpDb()
    try {
      await run(
        Effect.gen(function* () {
          const tel = yield* TelemetryService
          yield* tel.inc("foo", {}, 5)
        }),
        dbPath,
      )
      const snap = await run(
        Effect.gen(function* () {
          const tel = yield* TelemetryService
          return yield* tel.snapshot
        }),
        dbPath,
      )
      expect(snap).toHaveLength(1)
      expect(snap[0]?.name).toBe("foo")
      expect(snap[0]?.value).toBe(5)
    } finally {
      cleanupTmp(dbPath)
    }
  })

  it("(2) UPSERT idempotence: 4× inc(x, {a:1}, 3) → get returns 12", async () => {
    const value = await run(
      Effect.gen(function* () {
        const tel = yield* TelemetryService
        for (let i = 0; i < 4; i++) {
          yield* tel.inc("x", { a: "1" }, 3)
        }
        return yield* tel.get("x", { a: "1" })
      }),
    )
    expect(value).toBe(12)
  })

  it("(3) tag-order independence: {a,b} and {b,a} hit same row", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tel = yield* TelemetryService
        yield* tel.inc("y", { a: "1", b: "2" }, 1)
        yield* tel.inc("y", { b: "2", a: "1" }, 1)
        const v1 = yield* tel.get("y", { a: "1", b: "2" })
        const v2 = yield* tel.get("y", { b: "2", a: "1" })
        const snap = yield* tel.snapshot
        return { v1, v2, snap }
      }),
    )
    expect(result.v1).toBe(2)
    expect(result.v2).toBe(2)
    // Single canonical row — UPSERT collapsed both calls.
    expect(result.snap).toHaveLength(1)
    expect(result.snap[0]?.value).toBe(2)
  })

  it("(4) history opt-in DISABLED by default: 5× inc → 0 history rows", async () => {
    const dbPath = tmpDb()
    try {
      await run(
        Effect.gen(function* () {
          const tel = yield* TelemetryService
          for (let i = 0; i < 5; i++) {
            yield* tel.inc("untracked", {}, 1)
          }
        }),
        dbPath,
      )
      const db = await openRaw(dbPath)
      const row = db
        .query("SELECT COUNT(*) AS c FROM telemetry_history")
        .get() as { c: number }
      db.close()
      expect(row.c).toBe(0)
    } finally {
      cleanupTmp(dbPath)
    }
  })

  it("(5) history opt-in with allowlist: only allowlisted names logged", async () => {
    const dbPath = tmpDb()
    try {
      await run(
        Effect.gen(function* () {
          const tel = yield* TelemetryService
          yield* tel.inc("watched", {}, 2)
          yield* tel.inc("ignored", {}, 7)
          yield* tel.inc("watched", { tag: "x" }, 1)
        }),
        dbPath,
        { history: { enabled: true, nameAllowlist: ["watched"] } },
      )
      const db = await openRaw(dbPath)
      const rows = db
        .query("SELECT name, delta FROM telemetry_history ORDER BY id")
        .all() as ReadonlyArray<{ name: string; delta: number }>
      db.close()
      expect(rows).toHaveLength(2)
      expect(rows.every((r) => r.name === "watched")).toBe(true)
      expect(rows[0]?.delta).toBe(2)
      expect(rows[1]?.delta).toBe(1)
    } finally {
      cleanupTmp(dbPath)
    }
  })

  it("(6) reset() clears both counters and history tables", async () => {
    const dbPath = tmpDb()
    try {
      await run(
        Effect.gen(function* () {
          const tel = yield* TelemetryService
          yield* tel.inc("a", {}, 1)
          yield* tel.inc("b", { k: "v" }, 2)
          yield* tel.inc("a", {}, 3)
          yield* tel.reset
          const snap = yield* tel.snapshot
          expect(snap).toHaveLength(0)
        }),
        dbPath,
        { history: { enabled: true } },
      )
      const db = await openRaw(dbPath)
      const cnt = db
        .query("SELECT COUNT(*) AS c FROM telemetry_counters")
        .get() as { c: number }
      const hist = db
        .query("SELECT COUNT(*) AS c FROM telemetry_history")
        .get() as { c: number }
      db.close()
      expect(cnt.c).toBe(0)
      expect(hist.c).toBe(0)
    } finally {
      cleanupTmp(dbPath)
    }
  })

  it("(7) migration ladder idempotent: reopen leaves single schema_versions row", async () => {
    const dbPath = tmpDb()
    try {
      // First open — runs telemetry v1 migration via applyMigration.
      await run(
        Effect.gen(function* () {
          const tel = yield* TelemetryService
          yield* tel.inc("seed", {}, 1)
        }),
        dbPath,
      )
      const db1 = await openRaw(dbPath)
      const rows1 = db1
        .query("SELECT version FROM schema_versions WHERE component = ?")
        .all("telemetry") as ReadonlyArray<{ version: number }>
      db1.close()
      expect(rows1).toHaveLength(1)
      expect(rows1[0]?.version).toBe(1)

      // Second open — must be a no-op (applyMigration early-returns).
      await run(
        Effect.gen(function* () {
          const tel = yield* TelemetryService
          return yield* tel.snapshot
        }),
        dbPath,
      )
      const db2 = await openRaw(dbPath)
      const rows2 = db2
        .query("SELECT version FROM schema_versions WHERE component = ?")
        .all("telemetry") as ReadonlyArray<unknown>
      db2.close()
      expect(rows2).toHaveLength(1)
    } finally {
      cleanupTmp(dbPath)
    }
  })
})
