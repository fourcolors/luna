/**
 * `luna-account add` — insert one row into the §5.1 `accounts` table.
 *
 * Validation (DESIGN.md §2.2.11):
 *   - all four required fields non-empty
 *   - kind ∈ allowlist (`anthropic`, `tool-<name>`, `mcp-<name>`)
 *   - secret-ref matches one of:
 *       op://<rest>                                — bare 1Password
 *       luna-op://<label>/<rest>                   — explicit-account 1Password
 *       env:<VAR>                                  — process env (one colon)
 *       file:<path>  |  file://<host>/<path>       — local file
 *       claude-code:login                          — CLAUDE_CONFIG_DIR login
 *     where <label> matches ^[a-z][a-z0-9-]{0,30}$ and is not in
 *     {env, file, op}.
 *
 * NEVER resolves the secret. The CLI is a pointer-mover only.
 */
import { openDb, defaultDbPath } from "../db.js"

const KIND_ALLOWLIST_EXACT = new Set(["anthropic"])
const KIND_PREFIX_ALLOW = ["tool-", "mcp-"]

const ACCOUNT_LABEL_RE = /^[a-z][a-z0-9-]{0,30}$/
const RESERVED_LABELS = new Set(["env", "file", "op"])

export interface AddArgs {
  id?: string
  label?: string
  kind?: string
  secretRef?: string
  dbPath?: string
}

export interface CmdResult {
  exitCode: 0 | 1 | 2
  stderr?: string
  stdout?: string
}

const validateKind = (kind: string): boolean => {
  if (KIND_ALLOWLIST_EXACT.has(kind)) return true
  return KIND_PREFIX_ALLOW.some(
    (p) => kind.startsWith(p) && kind.length > p.length,
  )
}

const validateSecretRef = (ref: string): boolean => {
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
  if (ref.startsWith("op://")) {
    return ref.length > "op://".length
  }
  if (ref.startsWith("env:")) {
    // env:VAR — one colon, no slashes immediately after.
    // Reject env:// (would never resolve at runtime).
    if (ref.startsWith("env://")) return false
    const name = ref.slice("env:".length)
    return name.length > 0 && !name.includes("/")
  }
  if (ref.startsWith("file:")) {
    // file:<path> or file:///<path> — both supported by FileSecretProvider.
    return ref.length > "file:".length
  }
  return false
}

export const runAdd = (args: AddArgs): CmdResult => {
  const missing: string[] = []
  if (args.id === undefined || args.id.length === 0) missing.push("--id")
  if (args.label === undefined || args.label.length === 0)
    missing.push("--label")
  if (args.kind === undefined || args.kind.length === 0) missing.push("--kind")
  if (args.secretRef === undefined || args.secretRef.length === 0)
    missing.push("--secret-ref")
  if (missing.length > 0) {
    return {
      exitCode: 1,
      stderr: `error: missing or empty required field(s): ${missing.join(", ")}\n`,
    }
  }

  const id = args.id as string
  const label = args.label as string
  const kind = args.kind as string
  const secretRef = args.secretRef as string

  if (!validateKind(kind)) {
    return {
      exitCode: 1,
      stderr:
        `error: invalid --kind "${kind}". ` +
        `Must be "anthropic" or start with "tool-" or "mcp-".\n`,
    }
  }
  if (!validateSecretRef(secretRef)) {
    return {
      exitCode: 1,
      stderr:
        `error: invalid --secret-ref "${secretRef}". ` +
        `Must be one of: op://<rest>, luna-op://<label>/<rest> ` +
        `(label matches ^[a-z][a-z0-9-]{0,30}$, not in {env, file, op}), ` +
        `env:<VAR> (one colon, no slashes), file:<path>, file:///<path>, ` +
        `or claude-code:login.\n`,
    }
  }

  const dbPath = args.dbPath ?? defaultDbPath()
  let db
  try {
    db = openDb(dbPath)
  } catch (e) {
    return {
      exitCode: 2,
      stderr: `error: failed to open db at ${dbPath}: ${String(e)}\n`,
    }
  }
  try {
    const stmt = db.query(
      `INSERT INTO accounts (id, label, kind, secret_ref, health, cooldown_ms, usage_json)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    )
    stmt.run(id, label, kind, secretRef, "healthy", "{}")
    return {
      exitCode: 0,
      stdout: `added account id=${id} kind=${kind}\n`,
    }
  } catch (e) {
    const msg = String(e)
    if (msg.includes("UNIQUE") || msg.includes("PRIMARY KEY")) {
      return {
        exitCode: 1,
        stderr: `error: account id="${id}" already exists. Use rm first or pick a new id.\n`,
      }
    }
    return {
      exitCode: 2,
      stderr: `error: insert failed: ${msg}\n`,
    }
  } finally {
    db.close()
  }
}

/** Citty-friendly alias for runAdd — returns exit code directly. */
export const addAccount = runAdd
