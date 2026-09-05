/**
 * luna.db schema-continuity contract - CI assertion.
 *
 * Companion to `docs/next/luna-db-contract.md`. That document enumerates the
 * tables/columns/indexes a Luna daemon depends on across three physical
 * SQLite files (`luna.db`, `memory.db`, and per-workspace `workspace.db`).
 * This test boots the REAL migration chain / bootstrap functions for every
 * component named there against fresh databases, then asserts the resulting
 * schema still matches the contract. A future migration that drops or
 * renames a table/column the contract names fails HERE, with a pointer back
 * to the doc, instead of surfacing later as a silent daemon-cutover bug.
 *
 * Bun-only: every component below opens a real `bun:sqlite` database via a
 * dynamic `import("bun:sqlite")` (same indirection-plus-`@vite-ignore`
 * pattern the production stores use - see e.g. `thread-registry.ts`), gated
 * behind an `isBun` check so a non-bun runner (vitest under Node) skips the
 * whole suite cleanly instead of failing to resolve the module. Run via
 * `bun run test:bun` (see TESTING.md). Mirrors the existing convention in
 * `packages/core/test/session-store-sqlite.test.ts` and
 * `packages/core/src/db/migration-collision.test.ts`.
 *
 * Scope note - `memory_vectors_hnsw` (Part B of the contract doc) is
 * deliberately NOT asserted here. It is created only when the optional
 * Vectorlite native extension loads (see `sqlite-vector.ts`), which requires
 * a platform-specific prebuilt + Homebrew libsqlite3 on macOS and is not
 * guaranteed present in every hermetic CI/dev environment - the production
 * code already treats its absence as a graceful degradation, never an error.
 * Asserting a table whose creation is itself best-effort would make this
 * suite flaky by design, which defeats the point of a CI gate. The base
 * `memory_vectors` table (which the HNSW v-table mirrors via triggers) IS
 * asserted below, so a rename/drop of the columns HNSW depends on
 * (`embedding`, `dimension`) still fails this test.
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import * as os from "node:os"
import * as path from "node:path"
import * as fs from "node:fs"
import {
  AgentNotesService,
  AlignmentStore,
  Clock,
  CostAccountingService,
  DreamStore,
  JobsStoreService,
  LunaSqliteBootstrap,
  ObservabilityService,
  SessionStore,
  ThreadRegistryService,
  hasWakeSchema,
  installWakeSchema,
  makeCostAccountingSqlite,
  makeSessionStoreSqlite,
} from "../src/index.js"
import { ensureMemoryVectorSchema } from "@luna/memory"

// ── Runtime guard ─────────────────────────────────────────────────────────
const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"
const d = isBun ? describe : describe.skip

// ── bun:sqlite (dynamic, `@vite-ignore`d so vitest never statically
//    resolves it - matches thread-registry.ts / migration-collision.test.ts) ──
interface RawBunDb {
  readonly run: (sql: string) => void
  readonly query: (sql: string) => {
    readonly get: (...p: unknown[]) => unknown
    readonly all: (...p: unknown[]) => unknown[]
    readonly run: (...p: unknown[]) => { changes: number }
  }
  readonly close: () => void
}
const bunSqliteSpec = "bun:sqlite"
const openRawDb = async (dbPath: string): Promise<RawBunDb> => {
  const mod = (await import(/* @vite-ignore */ bunSqliteSpec)) as {
    Database: new (p: string) => RawBunDb
  }
  return new mod.Database(dbPath)
}

const tmpDbPath = (label: string): string =>
  path.join(
    os.tmpdir(),
    `luna-db-contract-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  )

const cleanupDbFile = (p: string): void => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(p + suffix)
    } catch {
      /* ignore - may never have been created */
    }
  }
}

const columnSet = (db: RawBunDb, table: string): Set<string> =>
  new Set(
    (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
      (r) => r.name,
    ),
  )

const tableExists = (db: RawBunDb, table: string): boolean =>
  db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(table) != null

const indexExists = (db: RawBunDb, index: string): boolean =>
  db
    .query("SELECT name FROM sqlite_master WHERE type='index' AND name=?")
    .get(index) != null

interface TableSpec {
  readonly table: string
  readonly columns: readonly string[]
}

/** Diffs `manifest` against `db`, collecting `table.column` / `index:name`
 * failures into one array so a single `expect(...).toEqual([])` names every
 * gap at once instead of stopping at the first one. */
const diffManifest = (
  db: RawBunDb,
  tables: readonly TableSpec[],
  indexes: readonly string[],
): string[] => {
  const failures: string[] = []
  for (const spec of tables) {
    if (!tableExists(db, spec.table)) {
      failures.push(`MISSING TABLE:${spec.table}`)
      continue
    }
    const cols = columnSet(db, spec.table)
    for (const col of spec.columns) {
      if (!cols.has(col)) failures.push(`${spec.table}.${col}`)
    }
  }
  for (const idx of indexes) {
    if (!indexExists(db, idx)) failures.push(`index:${idx}`)
  }
  return failures
}

// ── Part A manifest - tables inside a shared `luna.db` file ────────────────
// Column lists are transcribed from the migration DDL cited in
// docs/next/luna-db-contract.md Part A. Keep the two in sync.
const LUNA_DB_TABLES: readonly TableSpec[] = [
  { table: "schema_versions", columns: ["component", "version", "applied_at"] },
  {
    table: "sessions",
    columns: [
      "id", "parent_id", "title", "tags", "created_at", "ended_at",
      "model", "options_json", "status", "meta_json",
    ],
  },
  {
    table: "messages",
    columns: [
      "id", "session_id", "parent_id", "kind", "role", "content_json",
      "schema_version", "ts", "seq",
    ],
  },
  {
    table: "threads",
    columns: [
      "id", "sdk_session_id", "cwd", "title", "model", "effort",
      "created_at", "last_active_at", "status", "archived_at",
    ],
  },
  {
    table: "jobs",
    columns: [
      "id", "kind", "spec", "next_run", "last_run", "last_status",
      "payload_json", "created_at", "updated_at", "schedule", "enabled",
      "next_run_at", "retry_attempt", "fail_streak", "orphan_streak",
      "heal_attempts", "heal_state",
      "last_outcome_success_at", "outcome_state",
    ],
  },
  {
    table: "job_runs",
    columns: [
      "id", "job_id", "started_at", "finished_at", "status", "attempt",
      "output_text", "error", "steps_json",
    ],
  },
  {
    table: "agent_notes",
    columns: ["id", "session_id", "parent_id", "kind", "summary", "payload_json", "ts"],
  },
  {
    table: "alignment_log",
    columns: ["id", "at", "signal_kind", "score_delta", "ewma_after", "ref"],
  },
  { table: "alignment_state", columns: ["id", "ewma", "updated_at"] },
  {
    table: "cost_events",
    columns: [
      "id", "session_id", "team_name", "workflow_id", "account_id",
      "tokens_in", "tokens_out", "cache_read", "cache_write", "usd", "ts",
    ],
  },
  {
    table: "cost_event_experiments",
    columns: ["cost_event_id", "experiment_id"],
  },
  { table: "cost_budgets", columns: ["dim", "key", "budget_usd"] },
  {
    table: "dream_audit",
    columns: [
      "id", "dream_id", "at", "op", "target_id", "before_json", "after_json",
      "rationale", "status", "applied_at", "reverted_at",
    ],
  },
  { table: "dream_state", columns: ["k", "v"] },
]

const LUNA_DB_INDEXES: readonly string[] = [
  "idx_sessions_created", "idx_sessions_status", "idx_sessions_status_created",
  "idx_sessions_lastmsgat", "idx_messages_session_seq", "idx_messages_toplevel_user",
  "idx_threads_last_active", "idx_threads_status",
  "idx_jobs_kind_created", "idx_jobs_due", "idx_job_runs_job", "idx_job_runs_status",
  "idx_agent_notes_session_ts", "idx_agent_notes_kind_ts",
  "idx_alignment_log_kind_at",
  "idx_cost_session", "idx_cost_team", "idx_cost_workflow", "idx_cost_exp",
  "idx_dream_audit_dream", "idx_dream_audit_target", "idx_dream_audit_status",
]

// ── Part B manifest - tables inside `memory.db` (a SEPARATE file) ──────────
const MEMORY_DB_TABLES: readonly TableSpec[] = [
  {
    table: "memory_keyed",
    columns: [
      "id", "namespace", "kind", "content_json", "schema_version",
      "created_at", "updated_at", "tags_json", "scope_json", "provenance_json",
    ],
  },
  {
    table: "memory_vectors",
    columns: [
      "id", "namespace", "embedding", "dimension", "text", "ts",
      "embedding_provider", "embedding_model", "embedding_format",
      "embedding_input_hash", "embedded_at", "enrichment",
    ],
  },
]
const MEMORY_DB_INDEXES: readonly string[] = [
  "idx_memory_ns", "idx_memory_kind", "idx_memory_updated", "idx_vectors_ns",
]

// ── Part C manifest - tables inside a PER-WORKSPACE `workspace.db` ─────────
const WORKSPACE_DB_TABLES: readonly TableSpec[] = [
  {
    table: "goals",
    columns: ["slug", "title", "description", "status", "priority", "created_at", "updated_at"],
  },
  {
    table: "next_actions",
    columns: [
      "id", "goal_slug", "action", "status", "priority",
      "created_at", "updated_at", "completed_at", "notes",
    ],
  },
  {
    table: "wake_log",
    columns: ["id", "woke_at", "goal_slug", "summary", "outcome", "artifacts"],
  },
]

d("luna.db schema-continuity contract (docs/next/luna-db-contract.md)", () => {
  // The bootstrap Tag just marks "a Vectorlite swap was attempted" - no real
  // Vectorlite load happens against these throwaway files, same stub used by
  // thread-registry.sqlite.test.ts and migration-collision.test.ts.
  const BootstrapStub = Layer.succeed(LunaSqliteBootstrap, {
    ok: false,
    reason: "luna-db-contract test stub - no Vectorlite",
  } as const)
  const CommonDeps = Layer.mergeAll(Clock.Default, BootstrapStub)

  it("Part A: every luna.db table/column/index the contract names exists after the real migration chain runs", async () => {
    const dbPath = tmpDbPath("luna")
    try {
      // Boot every component's REAL makeLayer() against the SAME physical
      // file, one at a time (each Layer.effect closes its connection when
      // its own scope ends, so there is no cross-component lock contention).
      // This exercises the exact per-component `schema_versions` ledger that
      // fixed the Phase 25e migration-collision bug - if a future change
      // reintroduces a shared `PRAGMA user_version` gate, one of these
      // components silently loses its tables and this test fails.
      await Effect.runPromise(
        Effect.scoped(Effect.gen(function* () {
          yield* ThreadRegistryService
        })).pipe(Effect.provide(ThreadRegistryService.makeLayer(dbPath).pipe(Layer.provide(CommonDeps)))),
      )
      await Effect.runPromise(
        Effect.scoped(Effect.gen(function* () {
          yield* JobsStoreService
        })).pipe(Effect.provide(JobsStoreService.makeLayer(dbPath).pipe(Layer.provide(CommonDeps)))),
      )
      await Effect.runPromise(
        Effect.scoped(Effect.gen(function* () {
          yield* AgentNotesService
        })).pipe(Effect.provide(AgentNotesService.makeLayer(dbPath).pipe(Layer.provide(CommonDeps)))),
      )
      await Effect.runPromise(
        Effect.scoped(Effect.gen(function* () {
          yield* AlignmentStore
        })).pipe(Effect.provide(AlignmentStore.makeLayer(dbPath).pipe(Layer.provide(CommonDeps)))),
      )
      await Effect.runPromise(
        Effect.scoped(Effect.gen(function* () {
          yield* DreamStore
        })).pipe(Effect.provide(DreamStore.makeLayer(dbPath).pipe(Layer.provide(CommonDeps)))),
      )
      // CostAccountingService's SQLite Layer additionally needs
      // ObservabilityService (it subscribes to CostAccrued events).
      const obsL = ObservabilityService.Default.pipe(Layer.provide(Clock.Default))
      await Effect.runPromise(
        Effect.scoped(Effect.gen(function* () {
          yield* CostAccountingService
        })).pipe(
          Effect.provide(
            makeCostAccountingSqlite(dbPath).pipe(
              Layer.provide(Layer.mergeAll(CommonDeps, obsL)),
            ),
          ),
        ),
      )
      // SessionStore's SQLite Layer only needs LunaSqliteBootstrap.
      await Effect.runPromise(
        Effect.scoped(Effect.gen(function* () {
          yield* SessionStore
        })).pipe(Effect.provide(makeSessionStoreSqlite(dbPath).pipe(Layer.provide(BootstrapStub)))),
      )

      const db = await openRawDb(dbPath)
      try {
        const failures = diffManifest(db, LUNA_DB_TABLES, LUNA_DB_INDEXES)
        expect(failures).toEqual([])

        // Faithfulness checks called out explicitly by the contract doc:
        // dream persists to dream_audit/dream_state, never a `dream_log`
        // table; beliefs are memory rows, never a `beliefs` table in luna.db.
        expect(tableExists(db, "dream_log")).toBe(false)
        expect(tableExists(db, "beliefs")).toBe(false)
      } finally {
        db.close()
      }
    } finally {
      cleanupDbFile(dbPath)
    }
  })

  it("Part B: memory.db tables (memory_keyed, memory_vectors) match the contract via the real ensureMemoryVectorSchema()", async () => {
    const dbPath = tmpDbPath("memory")
    try {
      const db = await openRawDb(dbPath)
      try {
        ensureMemoryVectorSchema(db)
        const failures = diffManifest(db, MEMORY_DB_TABLES, MEMORY_DB_INDEXES)
        expect(failures).toEqual([])
      } finally {
        db.close()
      }
    } finally {
      cleanupDbFile(dbPath)
    }
  })

  it("Part C: workspace.db bootstrap (goals, next_actions, wake_log) matches the contract via the real installWakeSchema()", async () => {
    const dbPath = tmpDbPath("workspace")
    try {
      const db = await openRawDb(dbPath)
      try {
        installWakeSchema(db)
        expect(hasWakeSchema(db)).toBe(true)
        const failures = diffManifest(db, WORKSPACE_DB_TABLES, [])
        expect(failures).toEqual([])
      } finally {
        db.close()
      }
    } finally {
      cleanupDbFile(dbPath)
    }
  })
})
