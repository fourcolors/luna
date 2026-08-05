#!/usr/bin/env bun
/**
 * enable-wake.ts — turn the per-workspace wake cycle ON for a workspace by
 * installing the canonical wake schema (goals, next_actions, wake_log) into its
 * workspace.db. Idempotent and safe to re-run.
 *
 * Background: the wake cycle reads `goals`/`next_actions` from a workspace.db,
 * but nothing in production ever created that schema — so wake errored on every
 * real workspace. This installer is the explicit, auditable "enable wake here"
 * action. Without it a workspace simply reads as a skip (no error).
 *
 * Usage:
 *   bun run apps/server/scripts/enable-wake.ts --path /root/.luna/workspace/<slug>
 *   bun run apps/server/scripts/enable-wake.ts --db /abs/path/to/workspace.db
 *
 * After running:
 *   1. Seed at least one row in `goals` (the reasoner needs something to orient
 *      around) — otherwise wake just records `no-op`.
 *   2. Ensure the workspace's `kind:'wake'` job row in luna.db is enabled.
 */
// TODO(#444): `import ... from "bun:sqlite"` has no type declarations under
// the root tsconfig; this file is outside apps/*/src/** on purpose so it
// doesn't regress the tsc gate. Fix by switching to the require("bun:sqlite")
// pattern used elsewhere in apps/server/src; remove this marker only with
// that fix.
import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import { resolve as resolvePath } from "node:path"
import { hasWakeSchema, installWakeSchema } from "@luna/core"

interface Args {
  readonly dbPath: string
}

function parseArgs(argv: ReadonlyArray<string>): Args {
  const get = (k: string): string | undefined => {
    const i = argv.indexOf(`--${k}`)
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined
  }
  const explicitDb = get("db")
  const path = get("path")
  if (explicitDb === undefined && path === undefined) {
    console.error(
      "usage: enable-wake.ts (--path <workspace-dir> | --db <workspace.db>)",
    )
    process.exit(2)
  }
  const dbPath =
    explicitDb ?? resolvePath(path!, ".workspace", "workspace.db")
  return { dbPath }
}

/** Report next_actions.goal_slug nullability — the old test-only schema had it
 *  NOT NULL, which silently drops unattached proposals. We can't safely ALTER an
 *  existing table here, so detect-and-warn instead of pretending it's fine. */
function goalSlugIsNotNull(db: Database): boolean {
  const cols = db.query("PRAGMA table_info(next_actions)").all() as Array<{
    name: string
    notnull: number
  }>
  const col = cols.find((c) => c.name === "goal_slug")
  return col !== undefined && col.notnull === 1
}

function main(): void {
  const { dbPath } = parseArgs(process.argv.slice(2))
  if (dbPath !== ":memory:" && !existsSync(dbPath)) {
    console.error(`[enable-wake] workspace.db not found: ${dbPath}`)
    process.exit(1)
  }
  console.log("[enable-wake] target db:", dbPath)

  const db = new Database(dbPath)
  try {
    db.run("PRAGMA journal_mode = WAL")
    db.run("PRAGMA foreign_keys = ON")

    const before = hasWakeSchema(db)
    const preexistingBadShape =
      db
        .query(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='next_actions'",
        )
        .get() !== null && goalSlugIsNotNull(db)

    if (preexistingBadShape) {
      console.warn(
        "[enable-wake] WARNING: existing next_actions.goal_slug is NOT NULL — " +
          "unattached wake proposals will be dropped. installWakeSchema uses " +
          "CREATE TABLE IF NOT EXISTS and will NOT fix this. Migrate the column " +
          "to nullable (recreate next_actions) before relying on Path-B filing.",
      )
    }

    installWakeSchema(db)

    const after = hasWakeSchema(db)
    console.log(
      `[enable-wake] wake schema ${before ? "already present" : "installed"}; ` +
        `goals/next_actions present: ${after}`,
    )
    const goals = db.query("SELECT COUNT(*) AS n FROM goals").get() as {
      n: number
    }
    if (goals.n === 0) {
      console.log(
        "[enable-wake] note: `goals` is empty — wake will record `no-op` until " +
          "you seed at least one active goal.",
      )
    }
  } finally {
    db.close()
  }
}

main()
