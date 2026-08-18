/**
 * Sync Settings → Models provider enablement + credentialRef into the
 * connected server's `accounts` table.
 *
 * Without this, enabling a provider in the UI only wrote `provider_settings`
 * and left AccountBroker empty until someone ran `luna account add` on the
 * *server* host (easy to mis-run on the Mac while Moon is paired to jax-box).
 *
 * Contract:
 * - Only manages rows with id `settings-<kind>` — never touches CLI-seeded
 *   accounts with other ids.
 * - enabled + non-empty credentialRef → upsert (pointer only; never a raw key).
 * - disabled / missing credentialRef → delete the settings-<kind> row if present.
 * - credentialRef must be an opaque pointer (env: / op:// / luna-op:// /
 *   claude-code:login). Raw API keys are rejected.
 */

import type { ProviderConfig, ProviderKind } from "./types.js"

/** Stable id prefix so Settings-managed rows are distinguishable from CLI seeds. */
export const SETTINGS_ACCOUNT_ID_PREFIX = "settings-" as const

export const settingsAccountId = (kind: ProviderKind): string =>
  `${SETTINGS_ACCOUNT_ID_PREFIX}${kind}`

const ACCOUNT_LABEL_RE = /^[a-z][a-z0-9-]{0,30}$/
const RESERVED_LABELS = new Set(["env", "file", "op"])

/** Same allowlist as `luna account add` — pointer forms only. */
export const isValidCredentialRef = (ref: string): boolean => {
  if (ref === "claude-code:login") return true
  if (ref.startsWith("luna-op://")) {
    const rest = ref.slice("luna-op://".length)
    const slash = rest.indexOf("/")
    if (slash <= 0) return false
    const label = rest.slice(0, slash)
    const remainder = rest.slice(slash + 1)
    if (remainder.length === 0) return false
    if (RESERVED_LABELS.has(label)) return false
    return ACCOUNT_LABEL_RE.test(label)
  }
  if (ref.startsWith("op://")) return ref.length > "op://".length
  if (ref.startsWith("env:")) {
    if (ref.startsWith("env://")) return false
    const name = ref.slice("env:".length)
    return name.length > 0 && !name.includes("/")
  }
  return false
}

const ACCOUNTS_SCHEMA = `
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

/** Minimal bun:sqlite / better-sqlite3 shape used by the sync helper. */
export interface AccountsDb {
  run(sql: string): void
  query(sql: string): {
    run(...args: unknown[]): unknown
  }
}

export class ProviderAccountSyncError extends Error {
  readonly _tag = "ProviderAccountSyncError"
  constructor(message: string) {
    super(message)
    this.name = "ProviderAccountSyncError"
  }
}

/**
 * Apply provider enablement to the accounts table on the CONNECTED server's DB.
 * Throws ProviderAccountSyncError on an invalid credentialRef (caller should
 * surface it on model-routing-status and skip restart).
 */
export const syncProviderAccountsToDb = (
  db: AccountsDb,
  providers: ReadonlyArray<ProviderConfig>,
): void => {
  db.run(ACCOUNTS_SCHEMA)

  const upsert = db.query(
    `INSERT INTO accounts (id, label, kind, secret_ref, health, cooldown_ms, usage_json)
     VALUES (?, ?, ?, ?, 'healthy', NULL, '{}')
     ON CONFLICT(id) DO UPDATE SET
       label = excluded.label,
       kind = excluded.kind,
       secret_ref = excluded.secret_ref,
       health = 'healthy'`,
  )
  const del = db.query(`DELETE FROM accounts WHERE id = ?`)

  for (const p of providers) {
    const id = settingsAccountId(p.kind)
    const ref = p.credentialRef?.trim() ?? ""
    if (p.enabled && ref.length > 0) {
      if (!isValidCredentialRef(ref)) {
        throw new ProviderAccountSyncError(
          `Invalid credentialRef for ${p.kind}: must be env:NAME, op://…, luna-op://label/…, or claude-code:login (never a raw API key)`,
        )
      }
      upsert.run(id, `settings-${p.kind}`, p.kind, ref)
    } else {
      del.run(id)
    }
  }
}
