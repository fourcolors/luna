/**
 * SkillPrefsStore — durable skill enable/disable state (PRD Part B, S2).
 *
 * One table in luna.db, per-component migration ledger (Phase 25e):
 *
 *   skill_preferences(skill_id PK, enabled, updated_at)
 *
 * Persistence is DELTA-ONLY by design: a skill with no row is enabled by
 * default; rows exist only for ids the operator has touched. Re-enabling
 * keeps the row (enabled=1) — harmless, and it preserves updated_at as an
 * audit trail of the last change.
 *
 * The store is deliberately decoupled from SkillRegistry: the registry
 * takes `initialDisabled` (hydration) + `onToggle` (write-through) options,
 * and the chat-server wires the two together. That keeps the registry
 * SQLite-free and both halves unit-testable in isolation.
 *
 * Mirrors agent-notes.ts SQLite idioms exactly: dynamic bun:sqlite import,
 * WAL pragmas, ensureSchemaVersions + applyMigration, close-on-scope.
 */
import { Effect, Layer, Ref } from "effect"
import { Clock } from "../clock.js"
import { applyMigration, ensureSchemaVersions } from "../db/schema-versions.js"
import { LunaSqliteBootstrap } from "../db/sqlite-bootstrap.js"
import { ConfigError } from "../errors.js"

const SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS skill_preferences (
    skill_id    TEXT NOT NULL PRIMARY KEY,
    enabled     INTEGER NOT NULL DEFAULT 1,
    updated_at  INTEGER NOT NULL
  );
`

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

export interface SkillPrefsApi {
  /** Ids currently persisted as disabled — the registry's `initialDisabled`. */
  readonly disabledIds: () => Effect.Effect<ReadonlyArray<string>>
  /** Upsert the toggle delta. Infallible by signature — a SQLite failure
   *  here is a defect (the registry's onToggle contract). */
  readonly setEnabled: (id: string, enabled: boolean) => Effect.Effect<void>
}

export class SkillPrefsStore extends Effect.Tag("luna/SkillPrefsStore")<
  SkillPrefsStore,
  SkillPrefsApi
>() {
  /** In-memory variant for tests — same semantics, no SQLite. */
  static readonly Memory: Layer.Layer<SkillPrefsStore> = Layer.effect(
    SkillPrefsStore,
    Effect.gen(function* () {
      const store = yield* Ref.make<Map<string, boolean>>(new Map())
      return {
        disabledIds: () =>
          Ref.get(store).pipe(
            Effect.map((m) =>
              Array.from(m.entries())
                .filter(([, enabled]) => !enabled)
                .map(([id]) => id),
            ),
          ),
        setEnabled: (id, enabled) =>
          Ref.update(store, (m) => new Map(m).set(id, enabled)),
      } satisfies SkillPrefsApi
    }),
  )

  /**
   * SQLite-backed layer over luna.db (or any path; ":memory:" works for
   * ephemeral tests). Mirrors agent-notes.makeLayer.
   */
  static makeLayer(
    dbPath: string,
  ): Layer.Layer<SkillPrefsStore, ConfigError, Clock | LunaSqliteBootstrap> {
    return Layer.scoped(
      SkillPrefsStore,
      Effect.gen(function* () {
        yield* LunaSqliteBootstrap
        const clock = yield* Clock

        const bunSqliteSpec = "bun:sqlite"
        const mod = yield* Effect.tryPromise({
          try: () =>
            import(/* @vite-ignore */ bunSqliteSpec) as Promise<unknown>,
          catch: (cause) =>
            new ConfigError({
              module: "skill-prefs",
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
              module: "skill-prefs",
              key: "bun:sqlite",
              message: "bun:sqlite module has no `Database` export",
            }),
          )
        }
        const db = new Database(dbPath)

        db.run("PRAGMA journal_mode = WAL")
        db.run("PRAGMA synchronous = NORMAL")

        const nowMs = yield* clock.nowMs()
        ensureSchemaVersions(db)
        applyMigration(db, "skill_preferences", 1, SCHEMA_V1, nowMs)

        yield* Effect.addFinalizer(() => Effect.sync(() => db.close()))

        const disabledStmt = db.query(
          "SELECT skill_id FROM skill_preferences WHERE enabled = 0",
        )
        const upsertStmt = db.query(
          `INSERT INTO skill_preferences (skill_id, enabled, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(skill_id) DO UPDATE SET
             enabled = excluded.enabled,
             updated_at = excluded.updated_at`,
        )

        return {
          disabledIds: () =>
            Effect.sync(() =>
              (disabledStmt.all() as Array<{ skill_id: string }>).map(
                (r) => r.skill_id,
              ),
            ),
          setEnabled: (id, enabled) =>
            clock.nowMs().pipe(
              Effect.map((now) => {
                upsertStmt.run(id, enabled ? 1 : 0, now)
              }),
            ),
        } satisfies SkillPrefsApi
      }),
    )
  }
}
