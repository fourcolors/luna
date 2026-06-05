#!/usr/bin/env bun
/**
 * bootstrap-workspace.ts — register a workspace row in ~/.luna/luna.db.
 *
 * One-shot. Idempotent. Run after a deploy to make a workspace
 * discoverable to Luna without spinning up the chat-server.
 *
 * Usage:
 *   bun run scripts/bootstrap-workspace.ts \
 *     --slug luna \
 *     --path /root/luna/dev/repo \
 *     [--db /root/.luna/luna.db]
 *     [--summary "free text"]
 *     [--status active]
 *
 * Defaults:
 *   --db        ~/.luna/luna.db (resolved from $HOME)
 *   --summary   first paragraph of <path>/.workspace/workspace.md if present
 *   --status    active
 *
 * Schema parity: this script uses the exact same CREATE TABLE +
 * schema_versions ledger as @luna/core's WorkspaceRegistryService.makeLayer
 * so it's safe to run before the chat-server has booted, or against a
 * fresh ~/.luna/. The chat-server's Layer will detect the version-1 row
 * in schema_versions and skip its own migration.
 */
import { Database } from "bun:sqlite"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { resolve as resolvePath } from "node:path"

interface BootstrapArgs {
  readonly slug: string
  readonly path: string
  readonly db: string
  readonly summary: string | null
  readonly status: string
}

const SCHEMA_VERSIONS_DDL = `
  CREATE TABLE IF NOT EXISTS schema_versions (
    component   TEXT NOT NULL,
    version     INTEGER NOT NULL,
    applied_at  INTEGER NOT NULL,
    PRIMARY KEY (component, version)
  );
`

const WORKSPACES_DDL = `
  CREATE TABLE IF NOT EXISTS workspaces (
    slug        TEXT PRIMARY KEY,
    path        TEXT NOT NULL,
    summary     TEXT,
    status      TEXT NOT NULL DEFAULT 'active',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_workspaces_status_updated
    ON workspaces(status, updated_at);
`

function parseArgs(argv: ReadonlyArray<string>): BootstrapArgs {
  const get = (k: string): string | undefined => {
    const idx = argv.indexOf(`--${k}`)
    return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : undefined
  }
  const slug = get("slug")
  const path = get("path")
  if (!slug || !path) {
    console.error(
      "usage: bootstrap-workspace.ts --slug <slug> --path <abs-path> " +
        "[--db <luna.db>] [--summary <text>] [--status <status>]",
    )
    process.exit(2)
  }
  const db = get("db") ?? resolvePath(homedir(), ".luna", "luna.db")
  const status = get("status") ?? "active"
  const explicitSummary = get("summary") ?? null
  const summary = explicitSummary ?? readSummaryFromWorkspaceMd(path)
  return { slug, path, db, summary, status }
}

function readSummaryFromWorkspaceMd(workspacePath: string): string | null {
  const md = resolvePath(workspacePath, ".workspace", "workspace.md")
  if (!existsSync(md)) return null
  const text = readFileSync(md, "utf-8").trim()
  // Skip the first H1 line if present, then take the first non-empty
  // paragraph (lines until the first blank line after content starts).
  const lines = text.split("\n")
  let i = 0
  if (i < lines.length && lines[i]!.startsWith("# ")) i++
  while (i < lines.length && lines[i]!.trim() === "") i++
  const buf: string[] = []
  for (; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() === "") break
    buf.push(line.trim())
  }
  const summary = buf.join(" ").trim()
  return summary.length > 0 ? summary : null
}

function applyMigration(
  db: Database,
  component: string,
  version: number,
  sql: string,
  nowMs: number,
): void {
  const has = db
    .query(
      "SELECT 1 AS x FROM schema_versions WHERE component = ? AND version = ? LIMIT 1",
    )
    .get(component, version) as { x: number } | undefined | null
  if (has != null) return
  db.run("BEGIN IMMEDIATE")
  try {
    db.run(sql)
    db.query(
      "INSERT INTO schema_versions (component, version, applied_at) VALUES (?, ?, ?)",
    ).run(component, version, nowMs)
    db.run("COMMIT")
  } catch (e) {
    try {
      db.run("ROLLBACK")
    } catch {
      /* best-effort */
    }
    throw e
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  console.log("[bootstrap-workspace] target db:", args.db)
  console.log("[bootstrap-workspace] slug    :", args.slug)
  console.log("[bootstrap-workspace] path    :", args.path)
  console.log("[bootstrap-workspace] status  :", args.status)
  console.log(
    "[bootstrap-workspace] summary :",
    args.summary != null
      ? `${args.summary.slice(0, 80)}${args.summary.length > 80 ? "…" : ""}`
      : "(none)",
  )

  const db = new Database(args.db)
  try {
    db.run("PRAGMA journal_mode = WAL")
    db.run("PRAGMA synchronous = NORMAL")
    db.run("PRAGMA foreign_keys = ON")
    const now = Date.now()
    db.run(SCHEMA_VERSIONS_DDL)
    applyMigration(db, "workspaces", 1, WORKSPACES_DDL, now)

    const existing = db
      .query(
        "SELECT slug, path, summary, status, created_at, updated_at FROM workspaces WHERE slug = ?",
      )
      .get(args.slug) as
      | {
          slug: string
          path: string
          summary: string | null
          status: string
          created_at: number
          updated_at: number
        }
      | undefined
      | null

    const createdAt = existing?.created_at ?? now
    const status = args.status

    db.run("BEGIN IMMEDIATE")
    try {
      db.query(
        `INSERT INTO workspaces (slug, path, summary, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(slug) DO UPDATE SET
           path = excluded.path,
           summary = excluded.summary,
           status = excluded.status,
           updated_at = excluded.updated_at`,
      ).run(args.slug, args.path, args.summary, status, createdAt, now)
      db.run("COMMIT")
    } catch (e) {
      try {
        db.run("ROLLBACK")
      } catch {
        /* best-effort */
      }
      throw e
    }

    const after = db
      .query(
        "SELECT slug, path, summary, status, created_at, updated_at FROM workspaces WHERE slug = ?",
      )
      .get(args.slug) as {
      slug: string
      path: string
      summary: string | null
      status: string
      created_at: number
      updated_at: number
    }
    console.log(
      existing != null
        ? "[bootstrap-workspace] updated:"
        : "[bootstrap-workspace] inserted:",
      after,
    )
  } finally {
    db.close()
  }
}

main()
