/**
 * McpServerStore — durable registry of operator-registered external MCP servers.
 *
 * This is the DURABLE operator registry (luna.db); core's MCPRegistry is the
 * in-memory runtime projection it will feed.
 *
 * One table in luna.db (or any dbPath) via the per-component migration ledger.
 * Headers are stored as JSON; they hold secret-REFS, never raw values.
 *
 * Security defaults: freshly inserted rows have enabled=true, trustAcceptedAt
 * null, allowedTools [], allowAll false — fail-closed until the operator
 * explicitly trusts and allows tools.
 *
 * Memory variant for unit tests; SQLite for production — same idioms as
 * ConnectorInstanceStore / VaultStore.
 */
import { Effect, Layer, Ref } from "effect"
import {
  Clock,
  ConfigError,
  LunaSqliteBootstrap,
  applyMigration,
  ensureSchemaVersions,
} from "@luna/core"
import type { McpServerInput, McpServerRow } from "./types.js"
import {
  McpRegistryError,
  McpSlugExists,
  McpSlugInvalid,
  McpSlugReserved,
  McpUrlInvalid,
  validateSlug,
  validateUrl,
} from "./types.js"

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS mcp_servers (
    slug                TEXT NOT NULL PRIMARY KEY,
    url                 TEXT NOT NULL,
    headers_json        TEXT NOT NULL DEFAULT '{}',
    enabled             INTEGER NOT NULL DEFAULT 1,
    trust_accepted_at   INTEGER,
    allowed_tools_json  TEXT NOT NULL DEFAULT '[]',
    allow_all           INTEGER NOT NULL DEFAULT 0,
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL
  );
`

// ---------------------------------------------------------------------------
// Low-level bun:sqlite shims (narrowly typed — matches connectors / vault)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Service API
// ---------------------------------------------------------------------------

export interface McpServerStoreApi {
  /**
   * Register a new external MCP server.  Validates slug format and reserved
   * names, rejects duplicates, enforces HTTPS url.  Defaults: enabled=true,
   * trustAcceptedAt null, allowedTools [], allowAll false.
   */
  readonly add: (
    input: McpServerInput,
  ) => Effect.Effect<
    McpServerRow,
    McpRegistryError | McpSlugReserved | McpSlugExists | McpSlugInvalid | McpUrlInvalid
  >

  /** All registered servers, ordered by createdAt ascending. */
  readonly list: () => Effect.Effect<McpServerRow[], McpRegistryError>

  /** Single server by slug, or null when not found. */
  readonly get: (slug: string) => Effect.Effect<McpServerRow | null, McpRegistryError>

  /**
   * Servers where enabled=true AND trustAcceptedAt IS NOT NULL.
   * Called by the Slice B loader to build the active mcpServers map.
   */
  readonly listEnabledTrusted: () => Effect.Effect<McpServerRow[], McpRegistryError>

  /** Delete a server entry.  Silent no-op when slug is absent. */
  readonly remove: (slug: string) => Effect.Effect<void, McpRegistryError>

  /** Toggle the enabled flag. */
  readonly setEnabled: (slug: string, enabled: boolean) => Effect.Effect<void, McpRegistryError>

  /**
   * Record when the operator accepted the trust prompt.
   * Sets trustAcceptedAt to nowMs for the given slug.
   */
  readonly acceptTrust: (slug: string, nowMs: number) => Effect.Effect<void, McpRegistryError>

  /**
   * Append a tool name to allowedTools (deduplicates).  Operates independently
   * of the allowAll flag — both flags are checked separately by the mount gate
   * (allowAll OR tool-in-allowedTools grants access).  Calling this when
   * allowAll is already true is valid and still records the tool name.
   */
  readonly allowTool: (slug: string, tool: string) => Effect.Effect<void, McpRegistryError>

  /**
   * Set or clear the allowAll flag — when true, all tools advertised by the
   * server are exposed without per-tool vetting.  Requires explicit operator
   * action.
   */
  readonly allowAllTools: (slug: string, allowAll: boolean) => Effect.Effect<void, McpRegistryError>
}

// ---------------------------------------------------------------------------
// DB row → domain type
// ---------------------------------------------------------------------------

type DbRow = {
  slug: string
  url: string
  headers_json: string
  enabled: number
  trust_accepted_at: number | null
  allowed_tools_json: string
  allow_all: number
  created_at: number
  updated_at: number
}

const toRow = (r: DbRow): McpServerRow => ({
  slug: r.slug,
  url: r.url,
  headers: JSON.parse(r.headers_json) as Record<string, string>,
  enabled: r.enabled !== 0,
  trustAcceptedAt: r.trust_accepted_at,
  allowedTools: JSON.parse(r.allowed_tools_json) as string[],
  allowAll: r.allow_all !== 0,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

// ---------------------------------------------------------------------------
// Effect service
// ---------------------------------------------------------------------------

export class McpServerStore extends Effect.Tag("luna/McpServerStore")<
  McpServerStore,
  McpServerStoreApi
>() {
  // -------------------------------------------------------------------------
  // In-memory variant — unit tests
  // -------------------------------------------------------------------------
  static readonly Memory: Layer.Layer<McpServerStore, never, Clock> = Layer.effect(
    McpServerStore,
    Effect.gen(function* () {
      const store = yield* Ref.make<Map<string, McpServerRow>>(new Map())
      const clock = yield* Clock

      return {
        add: (input) =>
          Effect.gen(function* () {
            // Validate slug — throws typed errors on failure.
            yield* Effect.try({
              try: () => validateSlug(input.slug),
              catch: (e) => e as McpSlugInvalid | McpSlugReserved,
            })

            // Enforce HTTPS — prevents credential leakage over plaintext.
            yield* Effect.try({
              try: () => validateUrl(input.url),
              catch: (e) => e as McpUrlInvalid,
            })

            const m = yield* Ref.get(store)
            if (m.has(input.slug)) {
              return yield* Effect.fail(new McpSlugExists({ slug: input.slug }))
            }

            const ts = yield* clock.nowMs()
            const row: McpServerRow = {
              slug: input.slug,
              url: input.url,
              headers: input.headers ?? {},
              enabled: input.enabled ?? true,
              trustAcceptedAt: null,
              allowedTools: [],
              allowAll: false,
              createdAt: ts,
              updatedAt: ts,
            }
            yield* Ref.update(store, (m2) => new Map(m2).set(row.slug, row))
            return row
          }),

        list: () =>
          Ref.get(store).pipe(
            Effect.map((m) =>
              Array.from(m.values()).sort((a, b) => a.createdAt - b.createdAt),
            ),
          ),

        get: (slug) =>
          Ref.get(store).pipe(Effect.map((m) => m.get(slug) ?? null)),

        listEnabledTrusted: () =>
          Ref.get(store).pipe(
            Effect.map((m) =>
              Array.from(m.values())
                .filter((r) => r.enabled && r.trustAcceptedAt !== null)
                .sort((a, b) => a.createdAt - b.createdAt),
            ),
          ),

        remove: (slug) => Ref.update(store, (m) => {
          const next = new Map(m)
          next.delete(slug)
          return next
        }),

        setEnabled: (slug, enabled) =>
          Effect.gen(function* () {
            const ts = yield* clock.nowMs()
            yield* Ref.update(store, (m) => {
              const cur = m.get(slug)
              if (cur === undefined) return m
              return new Map(m).set(slug, { ...cur, enabled, updatedAt: ts })
            })
          }),

        acceptTrust: (slug, ts) =>
          Effect.gen(function* () {
            const now = yield* clock.nowMs()
            yield* Ref.update(store, (m) => {
              const cur = m.get(slug)
              if (cur === undefined) return m
              return new Map(m).set(slug, {
                ...cur,
                trustAcceptedAt: ts,
                updatedAt: now,
              })
            })
          }),

        allowTool: (slug, tool) =>
          Effect.gen(function* () {
            const ts = yield* clock.nowMs()
            yield* Ref.update(store, (m) => {
              const cur = m.get(slug)
              if (cur === undefined) return m
              const tools = cur.allowedTools.includes(tool)
                ? cur.allowedTools
                : [...cur.allowedTools, tool]
              return new Map(m).set(slug, {
                ...cur,
                allowedTools: tools,
                updatedAt: ts,
              })
            })
          }),

        allowAllTools: (slug, allowAll) =>
          Effect.gen(function* () {
            const ts = yield* clock.nowMs()
            yield* Ref.update(store, (m) => {
              const cur = m.get(slug)
              if (cur === undefined) return m
              return new Map(m).set(slug, {
                ...cur,
                allowAll,
                updatedAt: ts,
              })
            })
          }),
      } satisfies McpServerStoreApi
    }),
  )

  // -------------------------------------------------------------------------
  // SQLite-backed layer (bun:sqlite, WAL + synchronous NORMAL)
  // -------------------------------------------------------------------------
  static makeLayer(
    dbPath: string,
  ): Layer.Layer<McpServerStore, ConfigError, Clock | LunaSqliteBootstrap> {
    return Layer.scoped(
      McpServerStore,
      Effect.gen(function* () {
        yield* LunaSqliteBootstrap
        const clock = yield* Clock

        const bunSqliteSpec = "bun:sqlite"
        const mod = yield* Effect.tryPromise({
          try: () => import(/* @vite-ignore */ bunSqliteSpec) as Promise<unknown>,
          catch: (cause) =>
            new ConfigError({
              module: "mcp-registry",
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
              module: "mcp-registry",
              key: "bun:sqlite",
              message: "bun:sqlite module has no `Database` export",
            }),
          )
        }

        const db = new Database(dbPath)
        db.run("PRAGMA journal_mode = WAL")
        db.run("PRAGMA synchronous = NORMAL")

        const initNowMs = yield* clock.nowMs()
        ensureSchemaVersions(db as never)
        applyMigration(db as never, "mcp_registry", 1, SCHEMA_V1, initNowMs)

        yield* Effect.addFinalizer(() => Effect.sync(() => db.close()))

        // Prepared statements.
        const listStmt = db.query(
          `SELECT slug, url, headers_json, enabled, trust_accepted_at,
                  allowed_tools_json, allow_all, created_at, updated_at
           FROM mcp_servers ORDER BY created_at ASC`,
        )
        const getStmt = db.query(
          `SELECT slug, url, headers_json, enabled, trust_accepted_at,
                  allowed_tools_json, allow_all, created_at, updated_at
           FROM mcp_servers WHERE slug = ?`,
        )
        const listEnabledTrustedStmt = db.query(
          `SELECT slug, url, headers_json, enabled, trust_accepted_at,
                  allowed_tools_json, allow_all, created_at, updated_at
           FROM mcp_servers
           WHERE enabled = 1 AND trust_accepted_at IS NOT NULL
           ORDER BY created_at ASC`,
        )
        const insertStmt = db.query(
          `INSERT INTO mcp_servers
             (slug, url, headers_json, enabled, trust_accepted_at,
              allowed_tools_json, allow_all, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        const removeStmt = db.query(`DELETE FROM mcp_servers WHERE slug = ?`)
        const setEnabledStmt = db.query(
          `UPDATE mcp_servers SET enabled = ?, updated_at = ? WHERE slug = ?`,
        )
        const acceptTrustStmt = db.query(
          `UPDATE mcp_servers SET trust_accepted_at = ?, updated_at = ? WHERE slug = ?`,
        )
        const getAllowedToolsStmt = db.query(
          `SELECT allowed_tools_json FROM mcp_servers WHERE slug = ?`,
        )
        const setAllowedToolsStmt = db.query(
          `UPDATE mcp_servers SET allowed_tools_json = ?, updated_at = ? WHERE slug = ?`,
        )
        const setAllowAllStmt = db.query(
          `UPDATE mcp_servers SET allow_all = ?, updated_at = ? WHERE slug = ?`,
        )

        return {
          add: (input) =>
            Effect.gen(function* () {
              yield* Effect.try({
                try: () => validateSlug(input.slug),
                catch: (e) => e as McpSlugInvalid | McpSlugReserved,
              })

              // Enforce HTTPS — prevents credential leakage over plaintext.
              yield* Effect.try({
                try: () => validateUrl(input.url),
                catch: (e) => e as McpUrlInvalid,
              })

              const existing = yield* Effect.try({
                try: () => getStmt.get(input.slug) as DbRow | null,
                catch: (cause) =>
                  new McpRegistryError({ op: "add", message: String(cause) }),
              })
              if (existing != null) {
                return yield* Effect.fail(new McpSlugExists({ slug: input.slug }))
              }

              const ts = yield* clock.nowMs()
              const row: McpServerRow = {
                slug: input.slug,
                url: input.url,
                headers: input.headers ?? {},
                enabled: input.enabled ?? true,
                trustAcceptedAt: null,
                allowedTools: [],
                allowAll: false,
                createdAt: ts,
                updatedAt: ts,
              }

              yield* Effect.try({
                try: () =>
                  insertStmt.run(
                    row.slug,
                    row.url,
                    JSON.stringify(row.headers),
                    row.enabled ? 1 : 0,
                    null,
                    JSON.stringify(row.allowedTools),
                    0,
                    row.createdAt,
                    row.updatedAt,
                  ),
                catch: (cause) =>
                  new McpRegistryError({
                    op: "add",
                    message: String(cause),
                  }),
              })

              return row
            }),

          list: () =>
            Effect.try({
              try: () => (listStmt.all() as DbRow[]).map(toRow),
              catch: (cause) =>
                new McpRegistryError({ op: "list", message: String(cause) }),
            }),

          get: (slug) =>
            Effect.try({
              try: () => {
                const r = getStmt.get(slug) as DbRow | null
                return r != null ? toRow(r) : null
              },
              catch: (cause) =>
                new McpRegistryError({ op: "get", message: String(cause) }),
            }),

          listEnabledTrusted: () =>
            Effect.try({
              try: () => (listEnabledTrustedStmt.all() as DbRow[]).map(toRow),
              catch: (cause) =>
                new McpRegistryError({ op: "listEnabledTrusted", message: String(cause) }),
            }),

          remove: (slug) =>
            Effect.try({
              try: () => { removeStmt.run(slug) },
              catch: (cause) =>
                new McpRegistryError({ op: "remove", message: String(cause) }),
            }),

          setEnabled: (slug, enabled) =>
            Effect.gen(function* () {
              const ts = yield* clock.nowMs()
              yield* Effect.try({
                try: () => { setEnabledStmt.run(enabled ? 1 : 0, ts, slug) },
                catch: (cause) =>
                  new McpRegistryError({ op: "setEnabled", message: String(cause) }),
              })
            }),

          acceptTrust: (slug, ts) =>
            Effect.gen(function* () {
              const now = yield* clock.nowMs()
              yield* Effect.try({
                try: () => { acceptTrustStmt.run(ts, now, slug) },
                catch: (cause) =>
                  new McpRegistryError({ op: "acceptTrust", message: String(cause) }),
              })
            }),

          allowTool: (slug, tool) =>
            Effect.gen(function* () {
              const toolRow = yield* Effect.try({
                try: () =>
                  getAllowedToolsStmt.get(slug) as
                    | { allowed_tools_json: string }
                    | null,
                catch: (cause) =>
                  new McpRegistryError({ op: "allowTool", message: String(cause) }),
              })
              if (toolRow == null) return
              const current = yield* Effect.try({
                try: () => JSON.parse(toolRow.allowed_tools_json) as string[],
                catch: (cause) =>
                  new McpRegistryError({ op: "allowTool", message: `corrupt allowed_tools_json: ${String(cause)}` }),
              })
              if (current.includes(tool)) return
              const next = [...current, tool]
              const ts = yield* clock.nowMs()
              yield* Effect.try({
                try: () => { setAllowedToolsStmt.run(JSON.stringify(next), ts, slug) },
                catch: (cause) =>
                  new McpRegistryError({ op: "allowTool", message: String(cause) }),
              })
            }),

          allowAllTools: (slug, allowAll) =>
            Effect.gen(function* () {
              const ts = yield* clock.nowMs()
              yield* Effect.try({
                try: () => { setAllowAllStmt.run(allowAll ? 1 : 0, ts, slug) },
                catch: (cause) =>
                  new McpRegistryError({ op: "allowAllTools", message: String(cause) }),
              })
            }),
        } satisfies McpServerStoreApi
      }),
    )
  }
}
