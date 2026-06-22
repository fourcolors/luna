// packages/core/src/wake/wake-log-store.ts
//
// WakeLogStore — append-only ledger of wake cycles, persisted into the
// workspace-scoped `workspace.db` (NOT luna.db) because wake_log is a
// workspace artifact, not a Luna-runtime artifact.
//
// Schema (created by scripts/bootstrap-workspace.ts):
//   CREATE TABLE wake_log (
//     id        INTEGER PRIMARY KEY AUTOINCREMENT,
//     woke_at   INTEGER NOT NULL,
//     goal_slug TEXT,
//     summary   TEXT NOT NULL,
//     outcome   TEXT NOT NULL,
//     artifacts TEXT,
//     FOREIGN KEY (goal_slug) REFERENCES goals(slug)
//   )
//
// bun:sqlite is loaded via dynamic-import-string indirection, mirroring the
// pattern in jobs-store.ts and agent-notes.ts (the project deliberately
// avoids @types/bun — see DESIGN.md §6.2).
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { Effect, Layer, Ref } from "effect"
import { ConfigError } from "../errors.js"
import type { WakeLogRow, WakeLogRowInput, WakeOutcome } from "./types.js"
import { WakeError } from "./types.js"

// ── bun:sqlite minimal shape ────────────────────────────────────────────────
interface BunDb {
  run: (sql: string) => void
  query: (sql: string) => BunStmt
  close: () => void
}
interface BunStmt {
  get: (...p: unknown[]) => unknown
  all: (...p: unknown[]) => unknown[]
  run: (...p: unknown[]) => { changes: number }
}

export interface WakeLogStoreApi {
  /** Insert a wake_log row. Returns the new row id. */
  readonly append: (
    row: WakeLogRowInput,
  ) => Effect.Effect<number, WakeError>
  /** Read the N most recent wake rows, newest first. */
  readonly recent: (
    limit: number,
  ) => Effect.Effect<ReadonlyArray<WakeLogRow>, WakeError>
  /**
   * File planned actions into the workspace.db `next_actions` table (status
   * 'todo'). Path-B step 1: this is how a wake reasoner's proposals become
   * actionable instead of evaporating into wake_log. Caller pre-validates rows
   * (dedup, FK-safe goalSlug, clamped priority) via `planNextActions`. Returns
   * the number of rows inserted. The `next_actions` table is created by
   * scripts/bootstrap-workspace.ts; a missing table surfaces as a WakeError.
   */
  readonly appendNextActions: (
    actions: ReadonlyArray<{
      readonly goalSlug: string | null
      readonly action: string
      readonly priority: number
    }>,
    now: number,
  ) => Effect.Effect<number, WakeError>
}

export class WakeLogStore extends Effect.Tag("luna/WakeLogStore")<
  WakeLogStore,
  WakeLogStoreApi
>() {
  /**
   * Live layer opening the given workspace.db. The table must exist (created
   * by scripts/bootstrap-workspace.ts at workspace creation time). Opening a
   * workspace.db that doesn't have wake_log will surface as a WakeError on
   * the first append() call — keeping boot fast and non-blocking when a
   * workspace isn't yet bootstrapped.
   */
  static readonly makeLayer = (
    dbPath: string,
  ): Layer.Layer<WakeLogStore, ConfigError> =>
    Layer.scoped(
      WakeLogStore,
      Effect.gen(function* () {
        const bunSqliteSpec = "bun:sqlite"
        const mod = yield* Effect.tryPromise({
          try: () =>
            import(/* @vite-ignore */ bunSqliteSpec) as Promise<unknown>,
          catch: (cause) =>
            new ConfigError({
              module: "wake-log-store",
              key: "bun:sqlite",
              message: `failed to import bun:sqlite: ${String(cause)}`,
            }),
        })
        const Database = (mod as { Database?: unknown }).Database as
          | (new (p: string) => BunDb)
          | undefined
        if (!Database) {
          return yield* Effect.fail(
            new ConfigError({
              module: "wake-log-store",
              key: "bun:sqlite",
              message: "bun:sqlite module has no `Database` export",
            }),
          )
        }
        // Ensure the workspace dir exists before opening — the workspace.db is
        // workspace-scoped (not under ~/.luna), so on a fresh local/dev boot the
        // `.workspace/` parent may not exist yet and bun:sqlite would otherwise
        // fail with SQLITE_CANTOPEN. mkdir is idempotent; skip the in-memory case.
        if (dbPath !== ":memory:") {
          try {
            mkdirSync(dirname(dbPath), { recursive: true })
          } catch (cause) {
            return yield* Effect.fail(
              new ConfigError({
                module: "wake-log-store",
                key: "workspace-dir",
                message: `failed to create workspace dir for ${dbPath}: ${String(cause)}`,
              }),
            )
          }
        }
        const db = new Database(dbPath)
        // Conservative pragmas — match what bootstrap-workspace.ts uses so
        // we don't fight over journal mode.
        db.run("PRAGMA journal_mode = WAL")
        db.run("PRAGMA synchronous = NORMAL")
        db.run("PRAGMA foreign_keys = ON")
        // Ensure wake_log exists. The workspace bootstrap script
        // (scripts/bootstrap-workspace.ts) also creates this table; using
        // `IF NOT EXISTS` here means either creation order works and an
        // un-bootstrapped workspace still accepts writes after a wake fires.
        // Schema must stay in sync with the bootstrap definition.
        db.run(
          "CREATE TABLE IF NOT EXISTS wake_log (\n" +
            "  id        INTEGER PRIMARY KEY AUTOINCREMENT,\n" +
            "  woke_at   INTEGER NOT NULL,\n" +
            "  goal_slug TEXT,\n" +
            "  summary   TEXT NOT NULL,\n" +
            "  outcome   TEXT NOT NULL,\n" +
            "  artifacts TEXT\n" +
            ")",
        )
        yield* Effect.addFinalizer(() => Effect.sync(() => db.close()))

        const insertStmt = db.query(
          "INSERT INTO wake_log (woke_at, goal_slug, summary, outcome, artifacts) " +
            "VALUES (?, ?, ?, ?, ?) RETURNING id",
        )
        const recentStmt = db.query(
          "SELECT id, woke_at, goal_slug, summary, outcome, artifacts " +
            "FROM wake_log ORDER BY woke_at DESC LIMIT ?",
        )
        // next_actions is owned by scripts/bootstrap-workspace.ts (full schema
        // incl. the goals FK). We do NOT create it here — that would risk schema
        // drift — so an un-bootstrapped workspace surfaces a WakeError on first
        // file (caught by runWake; non-poisoning).
        //
        // PREPARED LAZILY (on first appendNextActions), NOT here: `db.query()`
        // compiles the SQL immediately, and against a workspace.db whose
        // next_actions table doesn't exist yet that throws `no such table` at
        // LAYER-CONSTRUCTION time — i.e. it crashes BOOT, breaking the very
        // promise the paragraph above makes ("surfaces a WakeError on first
        // file"). Deferring restores that contract (and unblocks a fresh local
        // boot / an un-bootstrapped workspace).
        let insertActionStmt: BunStmt | null = null
        return {
          append: (row) =>
            Effect.try({
              try: () => {
                const result = insertStmt.get(
                  row.wokeAt,
                  row.goalSlug,
                  row.summary,
                  row.outcome,
                  row.artifacts,
                ) as { id: number } | null
                if (result === null) {
                  throw new Error("wake_log insert returned no id row")
                }
                return result.id
              },
              catch: (cause) =>
                new WakeError({
                  op: "wake-log/append",
                  message: `failed to append wake_log row: ${String(cause)}`,
                  cause,
                }),
            }),
          recent: (limit) =>
            Effect.try({
              try: () => {
                const rows = recentStmt.all(limit) as ReadonlyArray<{
                  id: number
                  woke_at: number
                  goal_slug: string | null
                  summary: string
                  outcome: string
                  artifacts: string | null
                }>
                return rows.map((r) => ({
                  id: r.id,
                  wokeAt: r.woke_at,
                  goalSlug: r.goal_slug,
                  summary: r.summary,
                  outcome: r.outcome as WakeOutcome,
                  artifacts: r.artifacts ?? "{}",
                } satisfies WakeLogRow))
              },
              catch: (cause) =>
                new WakeError({
                  op: "wake-log/recent",
                  message: `failed to query wake_log: ${String(cause)}`,
                  cause,
                }),
            }),
          appendNextActions: (actions, now) =>
            Effect.try({
              try: () => {
                // Lazy prepare — see the note at the declaration. A missing
                // next_actions table throws HERE (inside the Effect.try), so it
                // becomes a caught WakeError, not a boot crash.
                if (insertActionStmt === null) {
                  insertActionStmt = db.query(
                    "INSERT INTO next_actions (goal_slug, action, status, priority, created_at, updated_at) " +
                      "VALUES (?, ?, 'todo', ?, ?, ?)",
                  )
                }
                let inserted = 0
                for (const a of actions) {
                  insertActionStmt.run(a.goalSlug, a.action, a.priority, now, now)
                  inserted++
                }
                return inserted
              },
              catch: (cause) =>
                new WakeError({
                  op: "wake-log/append-next-actions",
                  message: `failed to file next_actions: ${String(cause)}`,
                  cause,
                }),
            }),
        }
      }),
    )

  /**
   * In-memory layer for tests — does not touch disk. Rows live in a Ref so
   * tests can both write and read back.
   */
  static readonly Memory: Layer.Layer<WakeLogStore> = Layer.effect(
    WakeLogStore,
    Effect.gen(function* () {
      const rowsRef = yield* Ref.make<ReadonlyArray<WakeLogRow>>([])
      const nextIdRef = yield* Ref.make(1)
      const filedActionsRef = yield* Ref.make<
        ReadonlyArray<{ goalSlug: string | null; action: string; priority: number; now: number }>
      >([])
      return {
        append: (row) =>
          Effect.gen(function* () {
            const id = yield* Ref.getAndUpdate(nextIdRef, (n) => n + 1)
            yield* Ref.update(rowsRef, (rs) => [...rs, { id, ...row }])
            return id
          }),
        recent: (limit) =>
          Ref.get(rowsRef).pipe(
            Effect.map((rs) =>
              [...rs].sort((a, b) => b.wokeAt - a.wokeAt).slice(0, limit),
            ),
          ),
        appendNextActions: (actions, now) =>
          Ref.update(filedActionsRef, (fs) => [
            ...fs,
            ...actions.map((a) => ({ ...a, now })),
          ]).pipe(Effect.as(actions.length)),
      }
    }),
  )
}
