/**
 * ArtifactStore — durable pinned artifacts (PRD Part C, W1 — §19).
 *
 * Two tables in luna.db via the per-component migration ledger:
 *
 *   artifacts(id PK, kind, title, lang, content, origin, bridge_caps,
 *             pinned_at, updated_at)
 *   artifact_versions(artifact_id, version, content, edited_by, created_at,
 *             PK(artifact_id, version))
 *
 * `artifacts.content` is the denormalized *head* — a copy of the latest
 * `artifact_versions` row, so the common read (list/get) needs no join. The
 * version ledger is append-only: an agent edit inserts a new version and
 * bumps the head; a revert copies an older version's content *forward* as a
 * new head version, so history is never rewritten (you can revert a revert).
 *
 * Mirrors skill-prefs-store / connectors store idioms exactly: a Ref-backed
 * Memory layer for unit tests, a dynamic-`bun:sqlite` makeLayer for prod,
 * both satisfying the same Effect.Tag service.
 */
import { Effect, Layer, Ref } from "effect"
import { Clock } from "../clock.js"
import { applyMigration, ensureSchemaVersions } from "../db/schema-versions.js"
import { LunaSqliteBootstrap } from "../db/sqlite-bootstrap.js"
import { ConfigError } from "../errors.js"
import type {
  ArtifactEditor,
  ArtifactVersion,
  PinInput,
  PinnedArtifact,
} from "./types.js"
import { deriveArtifactKind } from "./types.js"

const SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS artifacts (
    id           TEXT NOT NULL PRIMARY KEY,
    kind         TEXT NOT NULL,
    title        TEXT NOT NULL,
    lang         TEXT,
    content      TEXT NOT NULL,
    origin       TEXT,
    bridge_caps  TEXT,
    pinned_at    INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS artifact_versions (
    artifact_id  TEXT NOT NULL,
    version      INTEGER NOT NULL,
    content      TEXT NOT NULL,
    edited_by    TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    PRIMARY KEY (artifact_id, version)
  );
  CREATE INDEX IF NOT EXISTS idx_artifacts_updated
    ON artifacts(updated_at DESC);
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

export interface ArtifactStoreApi {
  /** Persist an artifact (idempotent on `id` — re-pinning returns the
   *  existing row unchanged, so a double-click can't fork history). */
  readonly pin: (input: PinInput) => Effect.Effect<PinnedArtifact>
  /** Drop a pinned artifact and its entire version ledger. Returns false
   *  when the id was not pinned. */
  readonly unpin: (id: string) => Effect.Effect<boolean>
  /** All pinned artifacts, most-recently-updated first. */
  readonly list: () => Effect.Effect<ReadonlyArray<PinnedArtifact>>
  readonly get: (id: string) => Effect.Effect<PinnedArtifact | null>
  /** Append a new version and advance the head. Returns null when the id is
   *  not pinned. `bridgeCaps`, when given, also re-sets the widget's bridge
   *  allowlist on the head (so iterating a widget can widen/narrow/revoke its
   *  caps — review G3); omit it to leave the existing caps untouched. */
  readonly update: (
    id: string,
    content: string,
    editedBy: ArtifactEditor,
    bridgeCaps?: ReadonlyArray<string> | null,
  ) => Effect.Effect<PinnedArtifact | null>
  /** The append-only version ledger for an artifact, oldest first. */
  readonly versions: (
    id: string,
  ) => Effect.Effect<ReadonlyArray<ArtifactVersion>>
  /** Copy an older version's content forward as a new head version (the
   *  one-click time-travel revert). Returns null when the id/version pair is
   *  unknown. */
  readonly revert: (
    id: string,
    version: number,
  ) => Effect.Effect<PinnedArtifact | null>
}

const resolveKind = (input: PinInput) =>
  input.kind ?? deriveArtifactKind(input.lang, null)

export class ArtifactStore extends Effect.Tag("luna/ArtifactStore")<
  ArtifactStore,
  ArtifactStoreApi
>() {
  /** In-memory variant for tests — same semantics, no SQLite. */
  static readonly Memory: Layer.Layer<ArtifactStore, never, Clock> =
    Layer.effect(
      ArtifactStore,
      Effect.gen(function* () {
        const clock = yield* Clock
        // head rows keyed by id; ledger keyed by id → versions (ascending)
        const heads = yield* Ref.make<Map<string, PinnedArtifact>>(new Map())
        const ledger = yield* Ref.make<
          Map<string, ReadonlyArray<ArtifactVersion>>
        >(new Map())

        const headList = () =>
          Ref.get(heads).pipe(
            Effect.map((m) =>
              Array.from(m.values()).sort((a, b) => b.updatedAt - a.updatedAt),
            ),
          )

        const doUpdate = (
          id: string,
          content: string,
          editedBy: ArtifactEditor,
          bridgeCaps?: ReadonlyArray<string> | null,
        ): Effect.Effect<PinnedArtifact | null> =>
          Effect.gen(function* () {
            const head = (yield* Ref.get(heads)).get(id)
            if (!head) return null
            const now = yield* clock.nowMs()
            const nextVersion = head.version + 1
            const next: PinnedArtifact = {
              ...head,
              content,
              version: nextVersion,
              updatedAt: now,
              ...(bridgeCaps !== undefined ? { bridgeCaps } : {}),
            }
            const row: ArtifactVersion = {
              artifactId: id,
              version: nextVersion,
              content,
              editedBy,
              createdAt: now,
            }
            yield* Ref.update(heads, (m) => new Map(m).set(id, next))
            yield* Ref.update(ledger, (m) => {
              const n = new Map(m)
              n.set(id, [...(n.get(id) ?? []), row])
              return n
            })
            return next
          })

        return {
          pin: (input) =>
            Effect.gen(function* () {
              const existing = (yield* Ref.get(heads)).get(input.id)
              if (existing) return existing
              const now = yield* clock.nowMs()
              const head: PinnedArtifact = {
                id: input.id,
                kind: resolveKind(input),
                title: input.title,
                lang: input.lang ?? null,
                content: input.content,
                origin: input.origin ?? null,
                bridgeCaps: input.bridgeCaps ?? null,
                version: 1,
                pinnedAt: now,
                updatedAt: now,
              }
              const v1: ArtifactVersion = {
                artifactId: input.id,
                version: 1,
                content: input.content,
                editedBy: input.editedBy ?? "user",
                createdAt: now,
              }
              yield* Ref.update(heads, (m) => new Map(m).set(input.id, head))
              yield* Ref.update(ledger, (m) =>
                new Map(m).set(input.id, [v1]),
              )
              return head
            }),
          unpin: (id) =>
            Effect.gen(function* () {
              const had = (yield* Ref.get(heads)).has(id)
              yield* Ref.update(heads, (m) => {
                const n = new Map(m)
                n.delete(id)
                return n
              })
              yield* Ref.update(ledger, (m) => {
                const n = new Map(m)
                n.delete(id)
                return n
              })
              return had
            }),
          list: () => headList(),
          get: (id) =>
            Ref.get(heads).pipe(Effect.map((m) => m.get(id) ?? null)),
          update: (id, content, editedBy, bridgeCaps) =>
            doUpdate(id, content, editedBy, bridgeCaps),
          versions: (id) =>
            Ref.get(ledger).pipe(Effect.map((m) => m.get(id) ?? [])),
          revert: (id, version) =>
            Effect.gen(function* () {
              const rows = (yield* Ref.get(ledger)).get(id)
              const target = rows?.find((r) => r.version === version)
              if (!target) return null
              // Revert is an edit: copy the old content forward as a new
              // user-authored head version.
              return yield* doUpdate(id, target.content, "user")
            }),
        } satisfies ArtifactStoreApi
      }),
    )

  /** SQLite-backed layer over luna.db (":memory:" works for ephemeral tests). */
  static makeLayer(
    dbPath: string,
  ): Layer.Layer<ArtifactStore, ConfigError, Clock | LunaSqliteBootstrap> {
    return Layer.scoped(
      ArtifactStore,
      Effect.gen(function* () {
        yield* LunaSqliteBootstrap
        const clock = yield* Clock

        const bunSqliteSpec = "bun:sqlite"
        const mod = yield* Effect.tryPromise({
          try: () =>
            import(/* @vite-ignore */ bunSqliteSpec) as Promise<unknown>,
          catch: (cause) =>
            new ConfigError({
              module: "artifacts",
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
              module: "artifacts",
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
        applyMigration(db, "artifacts", 1, SCHEMA_V1, nowMs)

        yield* Effect.addFinalizer(() => Effect.sync(() => db.close()))

        const insertArtifact = db.query(
          `INSERT INTO artifacts
             (id, kind, title, lang, content, origin, bridge_caps, pinned_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        const insertVersion = db.query(
          `INSERT INTO artifact_versions
             (artifact_id, version, content, edited_by, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        const updateHead = db.query(
          "UPDATE artifacts SET content = ?, updated_at = ? WHERE id = ?",
        )
        const updateBridgeCaps = db.query(
          "UPDATE artifacts SET bridge_caps = ? WHERE id = ?",
        )
        const selectHead = db.query(
          `SELECT a.*,
             (SELECT MAX(version) FROM artifact_versions WHERE artifact_id = a.id) AS version
           FROM artifacts a WHERE a.id = ?`,
        )
        const selectAll = db.query(
          `SELECT a.*,
             (SELECT MAX(version) FROM artifact_versions WHERE artifact_id = a.id) AS version
           FROM artifacts a ORDER BY a.updated_at DESC`,
        )
        const selectVersions = db.query(
          `SELECT artifact_id, version, content, edited_by, created_at
           FROM artifact_versions WHERE artifact_id = ? ORDER BY version ASC`,
        )
        const selectVersion = db.query(
          `SELECT content FROM artifact_versions
           WHERE artifact_id = ? AND version = ? LIMIT 1`,
        )
        const maxVersion = db.query(
          "SELECT MAX(version) AS v FROM artifact_versions WHERE artifact_id = ?",
        )
        const deleteArtifact = db.query("DELETE FROM artifacts WHERE id = ?")
        const deleteVersions = db.query(
          "DELETE FROM artifact_versions WHERE artifact_id = ?",
        )

        interface ArtifactRow {
          id: string
          kind: string
          title: string
          lang: string | null
          content: string
          origin: string | null
          bridge_caps: string | null
          pinned_at: number
          updated_at: number
          version: number | null
        }

        const rowToArtifact = (r: ArtifactRow): PinnedArtifact => ({
          id: r.id,
          kind: r.kind as PinnedArtifact["kind"],
          title: r.title,
          lang: r.lang,
          content: r.content,
          origin: r.origin,
          bridgeCaps:
            r.bridge_caps == null
              ? null
              : (JSON.parse(r.bridge_caps) as ReadonlyArray<string>),
          version: r.version ?? 1,
          pinnedAt: r.pinned_at,
          updatedAt: r.updated_at,
        })

        const readHead = (id: string): PinnedArtifact | null => {
          const r = selectHead.get(id) as ArtifactRow | undefined | null
          return r ? rowToArtifact(r) : null
        }

        const nextVersionFor = (id: string): number => {
          const r = maxVersion.get(id) as { v: number | null } | undefined
          return (r?.v ?? 0) + 1
        }

        // Multi-statement writes must be atomic: a crash between an
        // `artifacts` insert and its `artifact_versions` insert would leave an
        // orphan head (empty ledger) that permanently poisons the id (review
        // W1/store). BEGIN IMMEDIATE acquires the write lock up front, matching
        // jobs-store.ts.
        const tx = (fn: () => void): void => {
          db.run("BEGIN IMMEDIATE")
          try {
            fn()
            db.run("COMMIT")
          } catch (e) {
            try {
              db.run("ROLLBACK")
            } catch {
              /* best-effort */
            }
            throw e
          }
        }

        const appendVersion = (
          id: string,
          content: string,
          editedBy: ArtifactEditor,
          now: number,
        ): void => {
          tx(() => {
            const version = nextVersionFor(id)
            insertVersion.run(id, version, content, editedBy, now)
            updateHead.run(content, now, id)
          })
        }

        return {
          pin: (input) =>
            clock.nowMs().pipe(
              Effect.map((now) => {
                const existing = readHead(input.id)
                if (existing) return existing
                const kind = resolveKind(input)
                const bridge =
                  input.bridgeCaps == null
                    ? null
                    : JSON.stringify(input.bridgeCaps)
                // Atomic: the artifacts head + its v1 ledger row commit together
                // or not at all (review W1/store — no orphan heads).
                tx(() => {
                  insertArtifact.run(
                    input.id,
                    kind,
                    input.title,
                    input.lang ?? null,
                    input.content,
                    input.origin ?? null,
                    bridge,
                    now,
                    now,
                  )
                  insertVersion.run(
                    input.id,
                    1,
                    input.content,
                    input.editedBy ?? "user",
                    now,
                  )
                })
                return readHead(input.id) as PinnedArtifact
              }),
            ),
          unpin: (id) =>
            Effect.sync(() => {
              const res = deleteArtifact.run(id)
              deleteVersions.run(id)
              return res.changes > 0
            }),
          list: () =>
            Effect.sync(() =>
              (selectAll.all() as ArtifactRow[]).map(rowToArtifact),
            ),
          get: (id) => Effect.sync(() => readHead(id)),
          update: (id, content, editedBy, bridgeCaps) =>
            clock.nowMs().pipe(
              Effect.map((now) => {
                if (!readHead(id)) return null
                appendVersion(id, content, editedBy, now)
                // Re-set the widget's caps when the caller supplied them
                // (review G3: iterating a widget can widen/narrow/revoke caps).
                if (bridgeCaps !== undefined) {
                  updateBridgeCaps.run(
                    bridgeCaps == null ? null : JSON.stringify(bridgeCaps),
                    id,
                  )
                }
                return readHead(id)
              }),
            ),
          versions: (id) =>
            Effect.sync(() =>
              (
                selectVersions.all(id) as Array<{
                  artifact_id: string
                  version: number
                  content: string
                  edited_by: string
                  created_at: number
                }>
              ).map((r) => ({
                artifactId: r.artifact_id,
                version: r.version,
                content: r.content,
                editedBy: r.edited_by as ArtifactEditor,
                createdAt: r.created_at,
              })),
            ),
          revert: (id, version) =>
            clock.nowMs().pipe(
              Effect.map((now) => {
                if (!readHead(id)) return null
                const target = selectVersion.get(id, version) as
                  | { content: string }
                  | undefined
                  | null
                if (target == null) return null
                appendVersion(id, target.content, "user", now)
                return readHead(id)
              }),
            ),
        } satisfies ArtifactStoreApi
      }),
    )
  }
}
