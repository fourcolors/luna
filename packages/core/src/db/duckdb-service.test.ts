/**
 * DuckDbService tests — red phase (TDD).
 *
 * These tests define the full behavioral contract for DuckDbService before
 * the implementation exists. They WILL FAIL until duckdb-service.ts is written.
 *
 * Coverage:
 *   1. migrate() is idempotent — calling twice does not error or double-apply
 *   2. migrate() records the component+version row in schema_versions
 *   3. exec() runs DDL — create table, insert, query back
 *   4. write() serializes concurrent calls — all writes land
 *   5. write() fails with DuckDbError{ op: "queue_full" } when queue is full
 *   6. query() returns typed rows — insert then query, verify shape
 *   7. Layer closes connection on scope finalize — lock file released
 *   8. Boot fails with ConfigError when DuckDB driver is unavailable
 *
 * Test DB strategy: temp file per test (`/tmp/luna-test-duckdb-<ts>.duckdb`)
 * with cleanup in finally blocks. DuckDB does not support `:memory:` in the
 * same way as SQLite — each test gets its own file to avoid cross-test state.
 */
import { describe, expect, it } from "vitest"
import { Data, Effect, Exit, Layer, Queue, Scope } from "effect"
import * as os from "node:os"
import * as path from "node:path"
import * as fs from "node:fs"
import { spawn } from "node:child_process"

// ── Imports under test (will not exist until implementation) ─────────────────
// These are the contracts the test holds the implementation to.
import {
  DuckDbService,
  DuckDbError,
  makeDuckDbLayer,
} from "./duckdb-service.js"

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Generate a unique temp DB path and clean it up (+ WAL files) after use. */
const withTempDb = <A>(
  fn: (dbPath: string) => Promise<A>,
): Promise<A> => {
  const dbPath = path.join(
    os.tmpdir(),
    `luna-test-duckdb-${Date.now()}-${Math.random().toString(36).slice(2)}.duckdb`,
  )
  return fn(dbPath).finally(() => {
    for (const suffix of ["", ".wal", ".lock"]) {
      try {
        fs.unlinkSync(dbPath + suffix)
      } catch {
        /* ignore — file may not exist */
      }
    }
  })
}

/**
 * Build a run helper for a given Layer, following the exact pattern used in
 * hook-registry.test.ts. Runs the effect inside a managed scope so Layer
 * finalizers fire at the end of runPromise.
 */
const makeRun = <E, R>(
  layer: Layer.Layer<DuckDbService, E, R>,
) => <A>(eff: Effect.Effect<A, DuckDbError | E, DuckDbService>) =>
  Effect.runPromise(
    Effect.scoped(eff.pipe(Effect.provide(layer as Layer.Layer<DuckDbService, E, never>))),
  )

// Simple DDL used across tests.
const CREATE_WIDGETS = `
  CREATE TABLE IF NOT EXISTS widgets (
    id    INTEGER PRIMARY KEY,
    label VARCHAR NOT NULL
  )
`

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("DuckDbService", () => {
  // ── 1. migrate() idempotency ─────────────────────────────────────────────

  it("migrate is idempotent — calling twice does not error", async () => {
    await withTempDb(async (dbPath) => {
      const layer = makeDuckDbLayer({ dbPath })
      const run = makeRun(layer)

      await run(
        Effect.gen(function* () {
          const db = yield* DuckDbService
          // First call — applies the migration
          yield* db.migrate("test-idem", 1, CREATE_WIDGETS)
          // Second call — must be a no-op, not an error
          yield* db.migrate("test-idem", 1, CREATE_WIDGETS)
        }),
      )
    })
  })

  it("migrate is idempotent — second call with invalid SQL is still a no-op", async () => {
    await withTempDb(async (dbPath) => {
      const layer = makeDuckDbLayer({ dbPath })
      const run = makeRun(layer)

      await run(
        Effect.gen(function* () {
          const db = yield* DuckDbService
          yield* db.migrate("test-idem-invalid", 1, CREATE_WIDGETS)
          // If the second call actually ran this SQL it would fail — proving
          // idempotency: it must skip because (component, version) is already applied.
          yield* db.migrate(
            "test-idem-invalid",
            1,
            "THIS IS NOT VALID SQL AT ALL",
          )
        }),
      )
    })
  })

  // ── 2. migrate() tracks applied versions ────────────────────────────────

  it("migrate records the component+version row in schema_versions", async () => {
    await withTempDb(async (dbPath) => {
      const layer = makeDuckDbLayer({ dbPath })
      const run = makeRun(layer)

      const rows = await run(
        Effect.gen(function* () {
          const db = yield* DuckDbService
          yield* db.migrate("tracker", 1, CREATE_WIDGETS)
          return yield* db.query(
            "SELECT component, version FROM schema_versions WHERE component = ?",
            ["tracker"],
          )
        }),
      )

      expect(rows).toHaveLength(1)
      const row = rows[0] as { component: string; version: number }
      expect(row.component).toBe("tracker")
      expect(row.version).toBe(1)
    })
  })

  it("migrate records each distinct version separately", async () => {
    await withTempDb(async (dbPath) => {
      const layer = makeDuckDbLayer({ dbPath })
      const run = makeRun(layer)

      const rows = await run(
        Effect.gen(function* () {
          const db = yield* DuckDbService
          yield* db.migrate("multi", 1, CREATE_WIDGETS)
          yield* db.migrate(
            "multi",
            2,
            "ALTER TABLE widgets ADD COLUMN color VARCHAR",
          )
          return yield* db.query(
            "SELECT version FROM schema_versions WHERE component = ? ORDER BY version",
            ["multi"],
          )
        }),
      )

      expect(rows).toHaveLength(2)
      expect((rows[0] as { version: number }).version).toBe(1)
      expect((rows[1] as { version: number }).version).toBe(2)
    })
  })

  // ── 3. exec() runs DDL ───────────────────────────────────────────────────

  it("exec creates a table and rows are subsequently queryable", async () => {
    await withTempDb(async (dbPath) => {
      const layer = makeDuckDbLayer({ dbPath })
      const run = makeRun(layer)

      const rows = await run(
        Effect.gen(function* () {
          const db = yield* DuckDbService
          yield* db.exec(CREATE_WIDGETS)
          yield* db.exec("INSERT INTO widgets (id, label) VALUES (1, 'foo')")
          return yield* db.query("SELECT id, label FROM widgets")
        }),
      )

      expect(rows).toHaveLength(1)
      const row = rows[0] as { id: number; label: string }
      expect(row.id).toBe(1)
      expect(row.label).toBe("foo")
    })
  })

  it("exec propagates a DuckDbError on invalid SQL", async () => {
    await withTempDb(async (dbPath) => {
      const layer = makeDuckDbLayer({ dbPath })
      const run = makeRun(layer)

      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          Effect.gen(function* () {
            const db = yield* DuckDbService
            yield* db.exec("NOT VALID SQL AT ALL")
          }).pipe(
            Effect.provide(layer as Layer.Layer<DuckDbService, never, never>),
          ),
        ),
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const flat = JSON.stringify(exit.cause)
        expect(flat).toContain("DuckDbError")
        expect(flat).toContain("exec")
      }
    })
  })

  // ── 4. write() serializes concurrent calls ───────────────────────────────

  it("write serializes concurrent calls — all writes land", async () => {
    await withTempDb(async (dbPath) => {
      const layer = makeDuckDbLayer({ dbPath })
      const run = makeRun(layer)

      const count = await run(
        Effect.gen(function* () {
          const db = yield* DuckDbService
          yield* db.exec(CREATE_WIDGETS)

          // Fire 20 concurrent writes — all must land.
          const writes = Array.from({ length: 20 }, (_, i) =>
            db.write(
              `INSERT INTO widgets (id, label) VALUES (${i + 1}, 'item-${i + 1}')`,
            ),
          )
          yield* Effect.all(writes, { concurrency: "unbounded" })

          // Drain the queue: query is synchronous relative to the fiber.
          const rows = yield* db.query("SELECT COUNT(*) AS n FROM widgets")
          return (rows[0] as { n: number }).n
        }),
      )

      expect(count).toBe(20)
    })
  })

  it("write with params serializes through the queue", async () => {
    await withTempDb(async (dbPath) => {
      const layer = makeDuckDbLayer({ dbPath })
      const run = makeRun(layer)

      const rows = await run(
        Effect.gen(function* () {
          const db = yield* DuckDbService
          yield* db.exec(CREATE_WIDGETS)
          yield* db.write(
            "INSERT INTO widgets (id, label) VALUES (?, ?)",
            [42, "parameterized"],
          )
          return yield* db.query(
            "SELECT label FROM widgets WHERE id = ?",
            [42],
          )
        }),
      )

      expect(rows).toHaveLength(1)
      expect((rows[0] as { label: string }).label).toBe("parameterized")
    })
  })

  // ── 5. write() fails with queue_full when queue is saturated ────────────

  it("write returns DuckDbError { op: 'queue_full' } when queue capacity is exhausted", async () => {
    await withTempDb(async (dbPath) => {
      // Use capacity=1 so it saturates immediately.
      const layer = makeDuckDbLayer({ dbPath, writeQueueCapacity: 1 })
      const run = makeRun(layer)

      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          Effect.gen(function* () {
            const db = yield* DuckDbService
            yield* db.exec(CREATE_WIDGETS)

            // Flood the queue beyond its capacity without draining.
            // We fire many concurrent writes; at least one must fail with queue_full.
            const writes = Array.from({ length: 100 }, (_, i) =>
              db.write(
                `INSERT OR IGNORE INTO widgets (id, label) VALUES (${i + 1}, 'x')`,
              ),
            )
            yield* Effect.all(writes, { concurrency: "unbounded" })
          }).pipe(
            Effect.provide(layer as Layer.Layer<DuckDbService, never, never>),
          ),
        ),
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const flat = JSON.stringify(exit.cause)
        expect(flat).toContain("DuckDbError")
        expect(flat).toContain("queue_full")
      }
    })
  })

  // ── 6. query() returns typed rows ───────────────────────────────────────

  it("query returns rows with correct field types", async () => {
    await withTempDb(async (dbPath) => {
      const layer = makeDuckDbLayer({ dbPath })
      const run = makeRun(layer)

      const rows = await run(
        Effect.gen(function* () {
          const db = yield* DuckDbService
          yield* db.exec(`
            CREATE TABLE IF NOT EXISTS typed_test (
              num     INTEGER NOT NULL,
              txt     VARCHAR NOT NULL,
              flt     DOUBLE  NOT NULL
            )
          `)
          yield* db.exec(
            "INSERT INTO typed_test (num, txt, flt) VALUES (7, 'hello', 3.14)",
          )
          return yield* db.query(
            "SELECT num, txt, flt FROM typed_test WHERE num = ?",
            [7],
          )
        }),
      )

      expect(rows).toHaveLength(1)
      const row = rows[0] as { num: number; txt: string; flt: number }
      expect(row.num).toBe(7)
      expect(row.txt).toBe("hello")
      expect(row.flt).toBeCloseTo(3.14)
    })
  })

  it("query returns an empty array when no rows match", async () => {
    await withTempDb(async (dbPath) => {
      const layer = makeDuckDbLayer({ dbPath })
      const run = makeRun(layer)

      const rows = await run(
        Effect.gen(function* () {
          const db = yield* DuckDbService
          yield* db.exec(CREATE_WIDGETS)
          return yield* db.query(
            "SELECT * FROM widgets WHERE id = ?",
            [9999],
          )
        }),
      )

      expect(rows).toHaveLength(0)
      expect(Array.isArray(rows)).toBe(true)
    })
  })

  it("query propagates DuckDbError on invalid SQL", async () => {
    await withTempDb(async (dbPath) => {
      const layer = makeDuckDbLayer({ dbPath })
      const run = makeRun(layer)

      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          Effect.gen(function* () {
            const db = yield* DuckDbService
            yield* db.query("SELECT * FROM nonexistent_table_xyz")
          }).pipe(
            Effect.provide(layer as Layer.Layer<DuckDbService, never, never>),
          ),
        ),
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const flat = JSON.stringify(exit.cause)
        expect(flat).toContain("DuckDbError")
        expect(flat).toContain("query")
      }
    })
  })

  // ── 7. Layer closes connection on scope finalize ─────────────────────────

  it("lock file is released after the Layer scope exits", async () => {
    await withTempDb(async (dbPath) => {
      const lockPath = dbPath + ".lock"

      // Build and finalize the layer inside a managed scope.
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const db = yield* DuckDbService
            // Touch the service to confirm the layer built successfully.
            yield* db.exec(CREATE_WIDGETS)
            // Lock file must exist while scope is open.
            expect(fs.existsSync(lockPath)).toBe(true)
          }).pipe(
            Effect.provide(
              makeDuckDbLayer({ dbPath }) as Layer.Layer<
                DuckDbService,
                never,
                never
              >,
            ),
          ),
        ),
      )

      // After scope closes, lock file must be gone.
      expect(fs.existsSync(lockPath)).toBe(false)
    })
  })

  it("using the service after scope close produces an error", async () => {
    await withTempDb(async (dbPath) => {
      const layer = makeDuckDbLayer({ dbPath })

      // Grab a reference to the service during the scope, close the scope,
      // then try to use the stale reference.
      let staleRef: { exec: (sql: string) => Effect.Effect<void, DuckDbError> } | null = null

      const scope = await Effect.runPromise(Scope.make())

      await Effect.runPromise(
        Effect.gen(function* () {
          const db = yield* DuckDbService
          staleRef = db
        }).pipe(
          Effect.provide(
            layer as Layer.Layer<DuckDbService, never, never>,
          ),
          Scope.provide(scope),
        ),
      )

      // Close the scope — this fires the db.close() finalizer.
      await Effect.runPromise(Scope.close(scope, Exit.void))

      // Attempting to use the stale service reference must fail.
      expect(staleRef).not.toBeNull()
      const exit = await Effect.runPromiseExit(staleRef!.exec(CREATE_WIDGETS))
      expect(Exit.isFailure(exit)).toBe(true)
    })
  })

  // ── 8. Boot fails with ConfigError when driver is unavailable ────────────

  it("Layer build fails with ConfigError when DuckDB driver import fails", async () => {
    await withTempDb(async (dbPath) => {
      // Pass a driver specifier that cannot be resolved so the dynamic import
      // inside the Layer fails. The Layer must surface ConfigError.
      const badLayer = makeDuckDbLayer({
        dbPath,
        driverSpecifier: "this-package-does-not-exist-at-all",
      })

      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          Effect.gen(function* () {
            // Merely constructing the scope forces the Layer to build.
            yield* DuckDbService
          }).pipe(
            Effect.provide(badLayer as Layer.Layer<DuckDbService, never, never>),
          ),
        ),
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const flat = JSON.stringify(exit.cause)
        expect(flat).toContain("ConfigError")
        expect(flat).toContain("duckdb")
      }
    })
  })

  it("Layer build fails with ConfigError when lock file is already held", async () => {
    await withTempDb(async (dbPath) => {
      const lockPath = dbPath + ".lock"
      const holder = spawn("sleep", ["10"], { stdio: "ignore" })
      holder.unref()
      await new Promise<void>((resolve, reject) => {
        holder.once("spawn", resolve)
        holder.once("error", reject)
      })
      expect(holder.pid).toBeDefined()

      // Simulate another live process holding the lock by writing its PID.
      fs.writeFileSync(lockPath, String(holder.pid))

      try {
        const layer = makeDuckDbLayer({ dbPath })
        const exit = await Effect.runPromiseExit(
          Effect.scoped(
            Effect.gen(function* () {
              yield* DuckDbService
            }).pipe(
              Effect.provide(layer as Layer.Layer<DuckDbService, never, never>),
            ),
          ),
        )

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const flat = JSON.stringify(exit.cause)
          expect(flat).toContain("ConfigError")
          expect(flat).toContain("lock")
        }
      } finally {
        holder.kill("SIGTERM")
      }

      // Clean up the lock we wrote so withTempDb cleanup doesn't trip.
      try {
        fs.unlinkSync(lockPath)
      } catch {
        /* ignore */
      }
    })
  })
})
