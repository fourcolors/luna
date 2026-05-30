/**
 * setup-login.ts — decision logic for what happens after `claude setup-token`
 * exits in setup-mode.
 *
 * Separated from chat-server.ts so it can be unit-tested without triggering
 * chat-server.ts's module-level `resolveUiWsToken()` call (which throws when
 * LUNA_UI_WS_TOKEN is not set).
 *
 * All side-effecting operations are injectable so tests never spawn real
 * processes or call real process.exit.
 */
import { createRequire } from "node:module"
import * as fs from "node:fs"
import * as path from "node:path"
import type { PtyOutputFrame } from "@luna/ui-ws"
import { applyMigration, ensureSchemaVersions } from "@luna/core"

// ── minimal sqlite shape (matches credential-readiness.ts / agent-cli/db.ts) ──
interface MinimalDb {
  run: (sql: string) => void
  query: (sql: string) => {
    get: (...p: unknown[]) => unknown
    all: (...p: unknown[]) => unknown[]
    run: (...p: unknown[]) => { changes: number }
  }
  close: () => void
}

// §5.1 accounts schema — byte-exact 7 columns. Kept identical to
// apps/agent-cli/src/db.ts SCHEMA_V1 and account-broker-sql.ts's ACCOUNTS_DDL.
// Applied through the canonical `schema_versions` ledger (NOT hand-rolled) so
// setup-mode produces a db that normal boot's migration ladder treats as
// already-migrated — the ('accounts', 1) ledger row is recorded atomically by
// applyMigration. Without this, the table would exist but the ledger would say
// "migration never ran", and normal boot would re-run it (idempotent today,
// but a contract violation: migration N must run against ledger-state N-1).
const ACCOUNTS_DDL = `
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

/**
 * Open (or create) the luna.db at `dbPath` in read-write mode, fully migrated
 * via the canonical `schema_versions` ledger (the same path agent-cli's openDb
 * uses). Returns the open db handle; caller must call close().
 *
 * Migration contract: this records the ('accounts', 1) ledger row so a
 * subsequent normal boot sees the component as already-migrated. We reuse
 * @luna/core's `ensureSchemaVersions` + `applyMigration` (the single source of
 * truth that agent-cli/db.ts mirrors) — NO hand-rolled DDL/ledger logic.
 *
 * Exposed as a named export so tests can stub it.
 */
export const openSetupDb = (dbPath: string): MinimalDb => {
  // Ensure parent directory exists (same pattern as agent-cli/db.ts).
  if (dbPath !== ":memory:") {
    const dir = path.dirname(dbPath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  }
  const req = createRequire(import.meta.url)
  const { Database } = req("bun:sqlite") as {
    Database: new (p: string) => MinimalDb
  }
  const db = new Database(dbPath)
  // Pragmas matching agent-cli/db.ts so setup-mode produces an identical db.
  db.run("PRAGMA journal_mode = WAL")
  db.run("PRAGMA synchronous = NORMAL")
  db.run("PRAGMA foreign_keys = ON")
  // §5.2 migration ladder: per-component `schema_versions` ledger (Phase 25e).
  // applyMigration runs the DDL AND records the ledger row atomically, and is a
  // no-op if ('accounts', 1) is already present — so this is idempotent.
  ensureSchemaVersions(db)
  applyMigration(db, "accounts", 1, ACCOUNTS_DDL, Date.now())
  return db
}

/**
 * Idempotently seed one `anthropic / claude-code:login` row.
 *
 * If a row with `secret_ref = 'claude-code:login'` already exists (the common
 * "lapsed-login re-login" flow), this is a no-op. Otherwise inserts a new row
 * with a fixed id/label so the gate's `SELECT kind, secret_ref FROM accounts`
 * query finds it on the next boot.
 *
 * @param dbPath - path to luna.db
 * @param _openDb - test seam for openSetupDb
 */
export const seedLoginAccount = (
  dbPath: string,
  _openDb: (p: string) => MinimalDb = openSetupDb,
): void => {
  const db = _openDb(dbPath)
  try {
    const existing = db
      .query("SELECT 1 AS x FROM accounts WHERE secret_ref = ? LIMIT 1")
      .get("claude-code:login")
    if (existing != null) return // already seeded — idempotent no-op
    db.query(
      `INSERT INTO accounts (id, label, kind, secret_ref, health, cooldown_ms, usage_json)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    ).run("default", "Default", "anthropic", "claude-code:login", "healthy", "{}")
  } finally {
    db.close()
  }
}

export interface OnLoginCompleteOpts {
  /** Sends a pty-output frame to the connected client. */
  readonly send: (frame: PtyOutputFrame) => void
  /** Returns true when the claude CLI reports loggedIn === true. */
  readonly checkLoggedIn: () => boolean
  /** Path to luna.db; used by seedLoginAccount. */
  readonly dbPath: string
  /** Called with 0 on successful login to restart into normal mode. Defaults to process.exit. */
  readonly exit?: (code: number) => void
  /** Test seam for openSetupDb — forwarded to seedLoginAccount. */
  readonly _openDb?: (p: string) => MinimalDb
}

const ptyNote = (msg: string): PtyOutputFrame => ({
  type: "pty-output",
  data: Buffer.from(msg).toString("base64"),
})

/**
 * Called when the `claude setup-token` pty exits. Checks login status;
 * if logged in: seeds the account row and restarts; if not: notifies the
 * client to reconnect and try again.
 */
export const onLoginAttemptComplete = (opts: OnLoginCompleteOpts): void => {
  const exit = opts.exit ?? ((code: number) => process.exit(code))
  const { send, checkLoggedIn, dbPath } = opts

  if (!checkLoggedIn()) {
    send(ptyNote("\r\n[setup] login not detected — reconnect to try again.\r\n"))
    return
  }

  // Logged in — seed the account row (idempotent) then restart.
  try {
    seedLoginAccount(dbPath, opts._openDb)
  } catch (e) {
    console.error("[setup] account seed failed:", e)
    send(ptyNote("\r\n[setup] login detected but account seed failed — see server logs.\r\n"))
    return
  }

  fs.writeSync(1, "[setup] login detected — credential seeded; restarting into normal mode\n")
  // Tell the client before exiting so the browser terminal doesn't just go
  // dead — the server will respawn and the next connection enters normal mode.
  send(ptyNote("\r\n[setup] Login successful — restarting into normal mode…\r\n"))
  // Schedule the exit one tick later so the synchronous ws.send above flushes
  // the frame to the socket before the process terminates.
  setImmediate(() => exit(0))
}
