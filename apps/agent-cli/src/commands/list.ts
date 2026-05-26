/**
 * `luna account list` — print all accounts (id, label, kind, secret_ref).
 *
 * §0.2 hard rule: NEVER resolve or print the actual secret. We print the
 * pointer string from the row. The pointer is not a secret — it's the
 * `op://vault/item/field` (or env: / file: / claude-code:login) reference itself.
 */
import { openDb, defaultDbPath, type AccountRow } from "../db.js"
import type { CmdResult } from "./add.js"

export interface ListArgs {
  dbPath?: string
}

export const runList = (args: ListArgs): CmdResult => {
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
    const rows = db.query("SELECT * FROM accounts").all() as AccountRow[]
    if (rows.length === 0) {
      return { exitCode: 0, stdout: "no accounts\n" }
    }
    // Tabular plain-text output. Columns are intentionally limited to
    // (id, label, kind, secret_ref). Health/usage are omitted from the
    // default view to keep the output skim-friendly; the pointer is
    // printed verbatim because it is NOT a secret (DESIGN.md §0.2).
    const lines: string[] = []
    lines.push("id\tlabel\tkind\tsecret_ref")
    for (const r of rows) {
      lines.push(`${r.id}\t${r.label}\t${r.kind}\t${r.secret_ref}`)
    }
    return { exitCode: 0, stdout: lines.join("\n") + "\n" }
  } catch (e) {
    return {
      exitCode: 2,
      stderr: `error: list failed: ${String(e)}\n`,
    }
  } finally {
    db.close()
  }
}

/** Citty-friendly alias for runList — returns exit code directly. */
export const listAccounts = runList
