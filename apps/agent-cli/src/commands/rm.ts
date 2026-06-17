/**
 * `luna account rm --id <id>` — delete one row by id.
 */
import { openDb, defaultDbPath } from "../db.js"
import type { CmdResult } from "./add.js"

interface RmArgs {
  id?: string
  dbPath?: string
}

const runRm = (args: RmArgs): CmdResult => {
  if (args.id === undefined || args.id.length === 0) {
    return {
      exitCode: 1,
      stderr: "error: missing or empty required field(s): --id\n",
    }
  }
  const id = args.id
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
    const stmt = db.query("DELETE FROM accounts WHERE id = ?")
    const result = stmt.run(id)
    if (result.changes === 0) {
      return {
        exitCode: 1,
        stderr: `error: no such account: ${id}\n`,
      }
    }
    return { exitCode: 0, stdout: `removed account id=${id}\n` }
  } catch (e) {
    return {
      exitCode: 2,
      stderr: `error: delete failed: ${String(e)}\n`,
    }
  } finally {
    db.close()
  }
}

/** Citty-friendly alias for runRm — returns exit code directly. */
export const removeAccount = runRm
