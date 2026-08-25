/**
 * Account-manage mutations — CLI-equivalent validation + SQLite writes.
 *
 * AccountBroker is load-once-at-boot: these helpers write `accounts` rows
 * only. Callers MUST schedule a server restart after a successful mutation
 * so `AccountBrokerLayer.fromSql` rehydrates (same pattern as
 * model-routing-save). Never touches acquire/report/rotation/cooling.
 */
import {
  accountSecretRefError,
  validateAccountKind,
} from "./account-refs.js"

export interface AccountManageRow {
  readonly id: string
  readonly label: string
  readonly kind: string
  readonly health: string
}

export interface AccountManageResult {
  readonly ok: boolean
  readonly message: string
}

/** Minimal bun:sqlite surface used by account-manage writers. */
export interface AccountManageDb {
  query: (sql: string) => {
    all: (...p: unknown[]) => unknown[]
    get: (...p: unknown[]) => unknown
    run: (...p: unknown[]) => { changes: number }
  }
}

export interface AccountAddInput {
  readonly id: string
  readonly label: string
  readonly kind: string
  readonly secretRef: string
}

/** Pure validation shared with tests — no DB I/O. */
export function validateAccountAddInput(
  input: AccountAddInput,
): AccountManageResult {
  const id = input.id.trim()
  const label = input.label.trim()
  const kind = input.kind.trim()
  const secretRef = input.secretRef.trim()
  if (!id || !label || !kind || !secretRef) {
    return { ok: false, message: "id, label, kind, and secretRef are required" }
  }
  if (!validateAccountKind(kind)) {
    return { ok: false, message: `invalid kind "${kind}"` }
  }
  const refErr = accountSecretRefError(secretRef)
  if (refErr) {
    return { ok: false, message: refErr }
  }
  return { ok: true, message: "ok" }
}

export function listAccountsFromDb(db: AccountManageDb): ReadonlyArray<AccountManageRow> {
  const rows = db
    .query(
      "SELECT id, label, kind, health FROM accounts ORDER BY id ASC",
    )
    .all() as Array<{
    id: string
    label: string
    kind: string
    health: string
  }>
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    kind: r.kind,
    // DB health column is not live; post-mutation list is membership-accurate.
    // After restart, hello uses AccountBroker.list() for live cooldown health.
    health: typeof r.health === "string" && r.health.length > 0 ? r.health : "healthy",
  }))
}

export function addAccountToDb(
  db: AccountManageDb,
  input: AccountAddInput,
): AccountManageResult {
  const validated = validateAccountAddInput(input)
  if (!validated.ok) return validated
  const id = input.id.trim()
  const label = input.label.trim()
  const kind = input.kind.trim()
  const secretRef = input.secretRef.trim()
  try {
    db.query(
      `INSERT INTO accounts (id, label, kind, secret_ref, health, cooldown_ms, usage_json)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    ).run(id, label, kind, secretRef, "healthy", "{}")
    return {
      ok: true,
      message: "Account added. Restarting to apply.",
    }
  } catch (e) {
    const msg = String(e)
    if (msg.includes("UNIQUE") || msg.includes("PRIMARY KEY")) {
      return { ok: false, message: `account id="${id}" already exists` }
    }
    return { ok: false, message: `insert failed: ${msg}` }
  }
}

export function removeAccountFromDb(
  db: AccountManageDb,
  idRaw: string,
): AccountManageResult {
  const id = idRaw.trim()
  if (!id) {
    return { ok: false, message: "id is required" }
  }
  const row = db
    .query("SELECT id, kind FROM accounts WHERE id = ? LIMIT 1")
    .get(id) as { id: string; kind: string } | null | undefined
  if (row == null) {
    return { ok: false, message: `no such account: ${id}` }
  }
  if (row.kind === "anthropic") {
    const countRow = db
      .query(
        "SELECT COUNT(*) AS n FROM accounts WHERE kind = 'anthropic'",
      )
      .get() as { n: number } | null | undefined
    const n = typeof countRow?.n === "number" ? countRow.n : 0
    if (n <= 1) {
      return {
        ok: false,
        message: "refusing to delete the last Anthropic account",
      }
    }
  }
  try {
    const result = db.query("DELETE FROM accounts WHERE id = ?").run(id)
    if (result.changes === 0) {
      return { ok: false, message: `no such account: ${id}` }
    }
    return {
      ok: true,
      message: "Account removed. Restarting to apply.",
    }
  } catch (e) {
    return { ok: false, message: `delete failed: ${String(e)}` }
  }
}
