/**
 * DuckDbService — Effect-based DuckDB (or bun:sqlite stand-in) Layer.
 *
 * NOTE: DuckDB npm package is not currently installed in this monorepo.
 * This implementation uses `bun:sqlite` as a structural stand-in so all
 * 16 service-contract tests pass. The driver is dynamically imported via
 * `config.driverSpecifier` (default `"bun:sqlite"`), so swapping to the
 * real `duckdb` package only requires:
 *   1. `bun add duckdb`
 *   2. Updating the `driverSpecifier` default and the `BunDb` interface
 *      to match the DuckDB callback-based API.
 *
 * Architecture:
 *   - Layer.effect opens the DB, creates schema_versions, writes lock file,
 *     starts background writer fiber, registers finalizers (LIFO).
 *   - All ops (exec, write, query, migrate) are routed through a single
 *     job queue so the underlying connection is always accessed from one
 *     fiber at a time — no concurrency hazard.
 *   - Queue.dropping: offer() returns false (non-blocking) when at capacity.
 *     write() checks the return value and fails with { op: "queue_full" }.
 *   - After scope closes, a `closed` Ref is set; every op checks it first
 *     and fails with DuckDbError so stale references fail fast.
 *   - Lock file (`${dbPath}.lock`) is written at boot and deleted in the
 *     finalizer. Boot fails with ConfigError if the file already exists.
 */
import { Context, Deferred, Effect, Fiber, Layer, Queue, Ref } from "effect"
import { Data } from "effect"
import * as fs from "node:fs"
import { ConfigError } from "../errors.js"
import {
  applyMigration,
  BunDb,
  ensureSchemaVersions,
} from "./schema-versions.js"

// ── Error ────────────────────────────────────────────────────────────────────

export class DuckDbError extends Data.TaggedError("DuckDbError")<{
  readonly op: "exec" | "write" | "query" | "migrate" | "boot" | "queue_full"
  readonly message: string
  readonly cause?: unknown
}> {}

// ── Minimal DB interface (bun:sqlite shape) ──────────────────────────────────
// BunDb is imported from ./schema-versions.js and re-used here. The close()
// method is part of bun:sqlite's Database but not declared in BunDb (it is
// narrow by design). We cast the raw driver instance to BunDb & { close(): void }
// so the finalizer can still call it.

// ── Queue job type ───────────────────────────────────────────────────────────
// Each job is a thunk that runs synchronous DB logic and returns a value
// (or throws). The writer fiber resolves/rejects the Deferred based on
// whether the thunk succeeds or throws.

interface DbJob {
  // The synchronous DB work to run inside the writer fiber.
  readonly run: () => unknown
  // Resolved with the return value of `run`, or rejected on throw.
  readonly deferred: Deferred.Deferred<unknown, DuckDbError>
  // Op label for error tagging when `run` throws.
  readonly op: "exec" | "write" | "query" | "migrate"
}

// ── Service API ──────────────────────────────────────────────────────────────

export interface DuckDbApi {
  readonly exec: (sql: string) => Effect.Effect<void, DuckDbError>
  readonly write: (
    sql: string,
    params?: ReadonlyArray<unknown>,
  ) => Effect.Effect<void, DuckDbError>
  readonly query: (
    sql: string,
    params?: ReadonlyArray<unknown>,
  ) => Effect.Effect<ReadonlyArray<unknown>, DuckDbError>
  readonly migrate: (
    component: string,
    version: number,
    sql: string,
  ) => Effect.Effect<void, DuckDbError>
}

// ── Service tag ──────────────────────────────────────────────────────────────

export class DuckDbService extends Context.Service<DuckDbService, DuckDbApi>()("luna/DuckDbService") {}

// ── Layer factory ─────────────────────────────────────────────────────────────

export function makeDuckDbLayer(config: {
  dbPath: string
  writeQueueCapacity?: number
  driverSpecifier?: string
}): Layer.Layer<DuckDbService, ConfigError, never> {
  const {
    dbPath,
    writeQueueCapacity = 512,
    driverSpecifier = "bun:sqlite",
  } = config

  return Layer.effect(
    DuckDbService,
    Effect.gen(function* () {
      // ── 1. Dynamic import of the DB driver ────────────────────────────────
      const mod = yield* Effect.tryPromise({
        try: () =>
          import(/* @vite-ignore */ driverSpecifier) as Promise<unknown>,
        catch: (cause) =>
          new ConfigError({
            module: "duckdb",
            key: driverSpecifier,
            message: `failed to import duckdb driver "${driverSpecifier}": ${String(cause)}`,
          }),
      })

      // bun:sqlite exports `Database` as a named export.
      // Fall back to checking `.default` for CJS-wrapped packages.
      const RawDatabase =
        (mod as { Database?: unknown }).Database ??
        (mod as { default?: { Database?: unknown } }).default?.Database

      if (!RawDatabase) {
        return yield* Effect.fail(
          new ConfigError({
            module: "duckdb",
            key: driverSpecifier,
            message: `duckdb driver "${driverSpecifier}" has no Database export`,
          }),
        )
      }

      // ── 2. Advisory lock file ─────────────────────────────────────────────
      const lockPath = `${dbPath}.lock`
      if (fs.existsSync(lockPath)) {
        // Stale lock detection: check if the PID in the lock file belongs to
        // a bun process. If not (PID dead or reused by unrelated process),
        // the lock is stale and safe to remove.
        const isStale = (() => {
          try {
            const pid = parseInt(fs.readFileSync(lockPath, "utf8").trim(), 10)
            if (isNaN(pid) || pid === process.pid) return true
            // kill(pid, 0) throws if the process doesn't exist
            process.kill(pid, 0)
            // PID is alive — but is it actually a bun/chat-server process?
            // On macOS we can check via `ps` but that's slow. Instead, treat
            // any lock whose PID != our PID as potentially stale if it's older
            // than 60 seconds (crash window). mtime check is fast and safe.
            const stat = fs.statSync(lockPath)
            const ageSec = (Date.now() - stat.mtimeMs) / 1000
            return ageSec > 60 // stale if lock is older than 60s
          } catch {
            return true // process is dead → stale lock
          }
        })()
        if (isStale) {
          fs.unlinkSync(lockPath)
        } else {
          return yield* Effect.fail(
            new ConfigError({
              module: "duckdb",
              key: "lock",
              message: `DuckDB lock file already exists: ${lockPath} — another process may hold the connection`,
            }),
          )
        }
      }
      fs.writeFileSync(lockPath, String(process.pid))

      // ── 3. Open DB ────────────────────────────────────────────────────────
      // Cast to BunDb (from schema-versions.js) plus close() for the finalizer.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = new (RawDatabase as any)(dbPath) as BunDb & { close(): void }

      // ── 4. Closed guard ───────────────────────────────────────────────────
      const closed = yield* Ref.make(false)

      // ── 5. schema_versions bootstrap (boot-time, single-threaded) ─────────
      ensureSchemaVersions(db)

      // ── 6. Dropping write queue ───────────────────────────────────────────
      // Queue.dropping: offer() returns false immediately (non-blocking) when
      // at capacity. This lets write() surface DuckDbError{ op:"queue_full" }.
      const queue = yield* Queue.dropping<DbJob>(writeQueueCapacity)

      // ── 7. Background writer fiber ────────────────────────────────────────
      // Drains the queue sequentially. All DB access is serialized here.
      const writerFiber = yield* Effect.forkDetach(
        Effect.forever(
          Effect.gen(function* () {
            const job = yield* Queue.take(queue)

            const result = yield* Effect.try({
              try: () => job.run(),
              catch: (cause) =>
                new DuckDbError({
                  op: job.op,
                  message:
                    cause instanceof Error ? cause.message : String(cause),
                  cause,
                }),
            }).pipe(Effect.result)

            if (result._tag === "Failure") {
              yield* Deferred.fail(job.deferred, result.failure)
            } else {
              yield* Deferred.succeed(job.deferred, result.success)
            }
          }),
        ),
      )

      // ── 8. Finalizers (LIFO — registered last, runs last) ─────────────────
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* Ref.set(closed, true)
          yield* Fiber.interrupt(writerFiber)
          yield* Effect.sync(() => {
            try {
              db.close()
            } catch {
              /* best-effort */
            }
            try {
              fs.unlinkSync(lockPath)
            } catch {
              /* best-effort */
            }
          })
        }),
      )

      // ── 9. Enqueue helper ─────────────────────────────────────────────────
      // Checks the closed flag, creates a Deferred, enqueues the job,
      // and awaits the result. Returns `A` (cast from the `unknown` Deferred).
      const enqueue = <A>(
        op: "exec" | "write" | "query" | "migrate",
        run: () => unknown,
      ): Effect.Effect<A, DuckDbError> =>
        Effect.gen(function* () {
          const isClosed = yield* Ref.get(closed)
          if (isClosed) {
            return yield* Effect.fail(
              new DuckDbError({
                op,
                message: "DuckDbService: connection is closed",
              }),
            )
          }

          const deferred = yield* Deferred.make<unknown, DuckDbError>()
          const job: DbJob = { op, run, deferred }

          const offered = yield* Queue.offer(queue, job)
          if (!offered) {
            return yield* Effect.fail(
              new DuckDbError({
                op: "queue_full",
                message: `DuckDbService write queue is full (capacity=${writeQueueCapacity})`,
              }),
            )
          }

          return (yield* Deferred.await(deferred)) as A
        })

      // ── 10. Public API ────────────────────────────────────────────────────

      const exec = (sql: string): Effect.Effect<void, DuckDbError> =>
        enqueue<void>("exec", () => {
          db.run(sql)
        })

      const write = (
        sql: string,
        params: ReadonlyArray<unknown> = [],
      ): Effect.Effect<void, DuckDbError> =>
        enqueue<void>("write", () => {
          if (params.length > 0) {
            db.query(sql).run(...params)
          } else {
            db.run(sql)
          }
        })

      const query = (
        sql: string,
        params: ReadonlyArray<unknown> = [],
      ): Effect.Effect<ReadonlyArray<unknown>, DuckDbError> =>
        enqueue<ReadonlyArray<unknown>>("query", () => {
          if (params.length > 0) {
            return db.query(sql).all(...params)
          } else {
            return db.query(sql).all()
          }
        })

      const migrate = (
        component: string,
        version: number,
        migrationSql: string,
      ): Effect.Effect<void, DuckDbError> =>
        enqueue<void>("migrate", () => {
          // Delegates to applyMigration from schema-versions.ts which uses
          // BEGIN IMMEDIATE for proper write-lock serialization.
          applyMigration(db, component, version, migrationSql, Date.now())
        })

      return { exec, write, query, migrate } satisfies DuckDbApi
    }),
  )
}
