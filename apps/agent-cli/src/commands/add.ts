/**
 * `luna-account add` — insert one row into the §5.1 `accounts` table.
 *
 * Validation:
 *   - all four required fields non-empty
 *   - kind ∈ allowlist (`anthropic`, `tool-<name>`, `mcp-<name>`)
 *   - secret-ref starts with `op://`, `env://`, or `file://`
 *
 * NEVER resolves the secret. The CLI is a pointer-mover only.
 */
import { openDb, defaultDbPath } from "../db.js"

const KIND_ALLOWLIST_EXACT = new Set(["anthropic"])
const KIND_PREFIX_ALLOW = ["tool-", "mcp-"]
const SECRET_REF_PREFIXES = ["op://", "env://", "file://"]

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

const validateSecretRef = (ref: string): boolean =>
  SECRET_REF_PREFIXES.some((p) => ref.startsWith(p))

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
        `Must start with op://, env://, or file://.\n`,
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
