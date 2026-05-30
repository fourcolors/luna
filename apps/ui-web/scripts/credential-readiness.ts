import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"

export type Mode = "setup" | "normal"
export type ReadinessReason =
  | "accounts-read-failed"
  | "no-accounts"
  | "claude-login-ok"
  | "claude-login-lapsed"
  | "non-login-account-present"
export interface Readiness {
  readonly ready: boolean
  readonly reason: ReadinessReason
}
interface AccountRow {
  readonly kind: string
  readonly secret_ref: string
}
export interface ProbeDeps {
  readonly dbPath: string
  readonly claudeExe: string
  readonly _readAccounts?: (dbPath: string) => ReadonlyArray<AccountRow>
  readonly _authStatus?: (claudeExe: string) => { ok: boolean }
}

const CLAUDE_CODE_LOGIN = "claude-code:login"
const AUTH_PROBE_TIMEOUT_MS = 8_000

const defaultReadAccounts = (dbPath: string): ReadonlyArray<AccountRow> => {
  const require = createRequire(import.meta.url)
  const { Database } = require("bun:sqlite") as {
    Database: new (p: string, opts?: { readonly?: boolean }) => {
      query: (sql: string) => { all: () => unknown[] }
      close: () => void
    }
  }
  const db = new Database(dbPath, { readonly: true })
  try {
    return db.query("SELECT kind, secret_ref FROM accounts").all() as ReadonlyArray<AccountRow>
  } finally {
    db.close()
  }
}

const defaultAuthStatus = (claudeExe: string): { ok: boolean } => {
  const r = spawnSync(claudeExe, ["auth", "status", "--json"], {
    encoding: "utf8",
    timeout: AUTH_PROBE_TIMEOUT_MS,
    env: process.env,
  })
  if (r.status !== 0 || typeof r.stdout !== "string") return { ok: false }
  try {
    return { ok: (JSON.parse(r.stdout) as { loggedIn?: boolean }).loggedIn === true }
  } catch {
    return { ok: false }
  }
}

export const decideMode = (r: Readiness): Mode => (r.ready ? "normal" : "setup")

export const probeCredentialReadiness = (deps: ProbeDeps): Readiness => {
  const readAccounts = deps._readAccounts ?? defaultReadAccounts
  const authStatus = deps._authStatus ?? defaultAuthStatus
  let accounts: ReadonlyArray<AccountRow>
  try {
    accounts = readAccounts(deps.dbPath)
  } catch (e) {
    console.error("[credential-readiness] accounts read failed:", e)
    return { ready: false, reason: "accounts-read-failed" }
  }
  if (accounts.length === 0) return { ready: false, reason: "no-accounts" }
  const hasLogin = accounts.some((a) => a.secret_ref === CLAUDE_CODE_LOGIN)
  if (hasLogin) {
    return authStatus(deps.claudeExe).ok
      ? { ready: true, reason: "claude-login-ok" }
      : { ready: false, reason: "claude-login-lapsed" }
  }
  return { ready: true, reason: "non-login-account-present" }
}
