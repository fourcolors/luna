/**
 * AccountBroker — SQLite-backed Layer factory (Phase 25a).
 *
 * Persistence-backed sibling of `AccountBrokerLayer.fromAccounts`. Closes the
 * §0.2/§5.1 deferral noted in `account-broker.ts` lines 18–20.
 *
 * Contract:
 *   - §7.5 — public surface unchanged. Returns the SAME `AccountBrokerApi`
 *     `fromAccounts` returns; callers cannot tell which factory was used.
 *   - §0.2 — OAuth subscription tokens NEVER hit disk in plaintext. The
 *     `accounts.secret_ref` column is a pointer string; resolution flows
 *     through `SecretProvider`, returning `Redacted<string>` only at acquire
 *     time — same shape as Phase 9.
 *   - §5.1 — `accounts(id, label, kind, secret_ref, health, cooldown_ms,
 *     usage_json)` columns byte-exact per DESIGN.md. No additive columns.
 *   - §5.2 — Migration ladder uses the per-component `schema_versions`
 *     ledger (Phase 25e) via `applyMigration("accounts", 1, ...)`. The
 *     pre-25e drift to `PRAGMA user_version` collided across components
 *     sharing `~/.luna/luna.db`; the new ledger keys per (component, version)
 *     so each store migrates independently.
 *   - §6 — Errors only via existing `ConfigError`. Missing `bun:sqlite` →
 *     ConfigError. Malformed row at hydrate (empty `kind` or empty
 *     `secret_ref`) → ConfigError with offending `id` in the message.
 *
 * Hydrate rule for §5.1 columns the in-memory `AccountRecord` doesn't model:
 *   - `label`        — carried into AccountRecord (displayed in UI/AccountSwitcher)
 *   - `health`       — ignored at hydrate (semantically default "healthy");
 *                      runtime cooldowns live on `cooldownUntilMs`
 *   - `cooldown_ms`  — if non-zero, sets `cooldownUntilMs = now + cooldown_ms`
 *                      so a row that was rate-limited shortly before reboot
 *                      keeps its remaining cooldown
 *   - `usage_json`   — ignored for now; write-back is Phase 25b+
 *
 * Out of scope this phase:
 *   - `report()` SQL write-back (in-memory cooldown only, exactly as Phase 9)
 *   - Hot-reload of new accounts post-boot (load-once-at-boot)
 *   - Seed CLI / chat-server wiring (Phase 25b)
 */
import { Effect, Layer, Redacted, Ref } from "effect"
import type * as Scope from "effect/Scope"
import * as os from "node:os"
import * as path from "node:path"
import { Clock } from "../clock.js"
import { applyMigration, ensureSchemaVersions } from "../db/schema-versions.js"
import { LunaSqliteBootstrap } from "../db/sqlite-bootstrap.js"
import {
  AllAccountsExhaustedError,
  ConfigError,
} from "../errors.js"
import {
  SecretProvider,
  isClaudeCodeLoginSecretRef,
  type SecretRef,
} from "../secret-provider/index.js"
import {
  AccountBroker,
  type AccountBrokerApi,
  type AccountError,
  type Credential,
  type AccountSummary,
} from "./account-broker.js"
import { pickAccount, type AccountRecord } from "./rotation-policy.js"

// ── Schema (§5.1, byte-exact columns) ──────────────────────────────────────
const SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS accounts (
    id            TEXT PRIMARY KEY,
    label         TEXT NOT NULL,
    kind          TEXT NOT NULL,
    secret_ref    TEXT NOT NULL,
    health        TEXT NOT NULL,
    cooldown_ms   INTEGER,
    usage_json    TEXT NOT NULL
  );
`

const DEFAULT_COOLDOWN_MS = 60_000

// ── bun:sqlite minimal shape (mirrors cost-store-sqlite.ts) ────────────────
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

interface AccountsRow {
  id: string
  label: string
  kind: string
  secret_ref: string
  health: string
  cooldown_ms: number | null
  usage_json: string
}

const cfgErr = (key: string, message: string) =>
  new ConfigError({ module: "account-broker", key, message })

const defaultDbPath = (): string => path.join(os.homedir(), ".luna", "luna.db")

export interface FromSqlOptions {
  /** Defaults to `~/.luna/luna.db`. Pass `":memory:"` for ephemeral tests. */
  readonly dbPath?: string
}

/**
 * Build an AccountBroker layer hydrated from the §5.1 `accounts` table.
 * Load-once-at-boot: the table is read at Layer construction; subsequent
 * INSERTs to the table do not appear in the broker's pool until the
 * surrounding Layer scope is rebuilt.
 *
 * Depends on `SecretProvider` and `Clock`. Layer error channel is
 * `ConfigError` (boot-time `bun:sqlite` import or malformed-row).
 */
const fromSql = (
  opts: FromSqlOptions = {},
): Layer.Layer<
  AccountBroker,
  ConfigError,
  SecretProvider | Clock | LunaSqliteBootstrap
> =>
  Layer.scoped(
    AccountBroker,
    Effect.gen(function* () {
      // Phase 27a: pull the bootstrap Tag BEFORE the dynamic
      // `import("bun:sqlite")`. Forcing the dependency this way means the
      // process-wide `Database.setCustomSQLite()` swap (provided by
      // `LunaSqliteBootstrapLive` from @luna/memory) has run before the
      // very first `new Database()` in the process — so Vectorlite's HNSW
      // path is available downstream. We don't branch on the result; the
      // side effect is what matters.
      yield* LunaSqliteBootstrap

      const secrets = yield* SecretProvider
      const clock = yield* Clock
      const dbPath = opts.dbPath ?? defaultDbPath()

      // Dynamic import so stock node+vitest doesn't hard-fail at import time;
      // bun resolves `bun:sqlite` natively. (Mirrors cost-store-sqlite.ts.)
      const bunSqliteSpec = "bun:sqlite"
      const mod = yield* Effect.tryPromise({
        try: () => import(/* @vite-ignore */ bunSqliteSpec) as Promise<unknown>,
        catch: (cause) =>
          cfgErr(
            "bun:sqlite",
            `failed to import bun:sqlite: ${String(cause)}`,
          ),
      })
      const Database = (mod as { Database?: unknown }).Database as
        | (new (p: string) => BunDb)
        | undefined
      if (!Database) {
        return yield* Effect.fail(
          cfgErr("bun:sqlite", "bun:sqlite module has no `Database` export"),
        )
      }
      const db = new Database(dbPath)

      // Pragmas BEFORE any user data writes.
      db.run("PRAGMA journal_mode = WAL")
      db.run("PRAGMA synchronous = NORMAL")
      db.run("PRAGMA foreign_keys = ON")

      // §5.2 migration ladder: per-component `schema_versions` ledger.
      // Component name "accounts" is shared with apps/agent-cli/src/db.ts —
      // the CLI writes the same table on the same DB and must agree on
      // version keying.
      const now = yield* clock.nowMs()
      ensureSchemaVersions(db)
      applyMigration(db, "accounts", 1, SCHEMA_V1, now)

      // §3.4 #4 LIFO: register `db.close` finalizer so the DB closes
      // when the surrounding scope finalizes.
      yield* Effect.addFinalizer(() => Effect.sync(() => db.close()))

      // Hydrate rows → AccountRecord[].
      const rows = db.query("SELECT * FROM accounts").all() as AccountsRow[]

      const initial: AccountRecord[] = []
      for (const r of rows) {
        if (typeof r.kind !== "string" || r.kind.length === 0) {
          // We don't need to reach directly into the DB to close it —
          // the `addFinalizer` above will run on Layer error.
          return yield* Effect.fail(
            cfgErr(
              `accounts.${r.id}.kind`,
              `account row id="${r.id}" has empty kind`,
            ),
          )
        }
        if (typeof r.secret_ref !== "string" || r.secret_ref.length === 0) {
          return yield* Effect.fail(
            cfgErr(
              `accounts.${r.id}.secret_ref`,
              `account row id="${r.id}" has empty secret_ref`,
            ),
          )
        }
        const cooldownMs =
          typeof r.cooldown_ms === "number" && r.cooldown_ms > 0
            ? r.cooldown_ms
            : 0
        const record: AccountRecord = {
          id: r.id,
          label: r.label || r.id,
          kind: r.kind,
          secretRef: r.secret_ref as SecretRef,
          inFlight: 0,
          lastUsedMs: 0,
          ...(cooldownMs > 0 ? { cooldownUntilMs: now + cooldownMs } : {}),
        }
        initial.push(record)
      }

      const ref = yield* Ref.make<ReadonlyArray<AccountRecord>>(initial)

      // ── Public API (mirrors fromAccounts) ───────────────────────────────
      const acquireWithKind = (
        kind: string,
        boundId: string | undefined,
      ): Effect.Effect<Credential, AccountError, Scope.Scope> =>
        Effect.gen(function* () {
          const t = yield* clock.nowMs()
          const picked = yield* Ref.modify(ref, (accounts) => {
            const chosen = pickAccount(accounts, kind, t, boundId)
            if (chosen === null) return [null, accounts] as const
            const next = accounts.map((a) =>
              a.id === chosen.id
                ? { ...a, inFlight: a.inFlight + 1, lastUsedMs: t }
                : a,
            )
            return [chosen, next] as const
          })
          if (picked === null) {
            return yield* Effect.fail(
              new AllAccountsExhaustedError({ kind }),
            )
          }
          yield* Effect.addFinalizer(() =>
            Ref.update(ref, (accounts) =>
              accounts.map((a) =>
                a.id === picked.id
                  ? { ...a, inFlight: Math.max(0, a.inFlight - 1) }
                  : a,
              ),
            ),
          )
          const resolved = isClaudeCodeLoginSecretRef(picked.secretRef)
            ? Redacted.make("")
            : yield* secrets.get(picked.secretRef)
          return {
            kind: picked.kind,
            accountId: picked.id,
            secretRef: picked.secretRef,
            resolvedSecret: resolved,
          } satisfies Credential
        })

      const acquireSession: AccountBrokerApi["acquireSession"] = (o) =>
        acquireWithKind("anthropic", o.boundAccountId)

      const acquireTool: AccountBrokerApi["acquireTool"] = (toolName) =>
        acquireWithKind(`tool-${toolName}`, undefined)

      const report: AccountBrokerApi["report"] = (usage) =>
        Effect.gen(function* () {
          if (usage.kind !== "rate_limit") return
          const t = yield* clock.nowMs()
          const cooldownUntil =
            t + (usage.retryAfterMs ?? DEFAULT_COOLDOWN_MS)
          yield* Ref.update(ref, (accounts) =>
            accounts.map((a) =>
              a.id === usage.accountId
                ? { ...a, cooldownUntilMs: cooldownUntil }
                : a,
            ),
          )
        })

      const _inspect: AccountBrokerApi["_inspect"] = () => Ref.get(ref)

      const list: AccountBrokerApi["list"] = (kindFilter) =>
        Effect.gen(function* () {
          const t = yield* clock.nowMs()
          const accounts = yield* Ref.get(ref)
          const filtered = kindFilter
            ? accounts.filter((a) => a.kind === kindFilter)
            : accounts
          return filtered.map((a): AccountSummary => ({
            id: a.id,
            label: a.label ?? a.id,
            kind: a.kind,
            health:
              a.cooldownUntilMs !== undefined && a.cooldownUntilMs > t
                ? "rate_limited"
                : "healthy",
          }))
        })

      // Suppress "unused" lint without changing surface — Redacted is
      // imported for the JSDoc reference to redacted secrets.
      void Redacted

      return {
        acquireSession,
        acquireTool,
        report,
        _inspect,
        list,
      } satisfies AccountBrokerApi
    }),
  )

export const AccountBrokerSqlLayer = { fromSql } as const

// Re-export under the canonical AccountBrokerLayer barrel via index.ts.
export { fromSql }
