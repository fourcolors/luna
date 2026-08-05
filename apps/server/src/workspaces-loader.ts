/**
 * Standalone workspaces loader — extracted so tests can import it without
 * pulling in the full chat-server.ts dependency tree.
 *
 * SYSTEM.md tells Luna *that* workspaces exist and *how* to think about
 * them. This loader makes the workspaces themselves structurally present
 * in every thread's system prompt: at boot, query `~/.luna/luna.db` for
 * every `active` workspace, read each one's `<path>/.workspace/workspace.md`,
 * and concatenate the contents into a single labeled section.
 *
 * Why a structural inject and not a "Luna should read it" instruction:
 * SYSTEM.md already says she should read `workspace.md` to learn a
 * workspace's vocabulary. Dev-Luna's Phase 2 smoke test surfaced that the
 * read step is unreliable — she answered a workspace-scoped question
 * from runtime investigation alone and recommended doc fixes that were
 * already shipped. Putting the content directly in her context window
 * removes the failure mode entirely: she can't fail to consult something
 * that's already in her system prompt.
 *
 * bun:sqlite indirection: this file uses the same `createRequire` pattern
 * as `setup-login.ts` so vitest (running under node) can swap in a fake
 * `openDb` seam. Production `loadWorkspaces(dbPath)` with no second arg
 * resolves to bun:sqlite via the require.
 *
 * Imported and re-exported by chat-server.ts.
 */
import { existsSync, readFileSync, statSync } from "node:fs"
import { createRequire } from "node:module"
import { resolve as resolvePath } from "node:path"

/** Per-workspace cap on injected workspace.md bytes. ~4 KB files today;
 * the cap leaves headroom while protecting the prompt budget. */
const MAX_WORKSPACE_MD_BYTES = 32 * 1024

/** Aggregate cap across all active workspaces. Excess workspaces fall
 * back to a compact slug+path reference. */
const MAX_AGGREGATE_BYTES = 96 * 1024

/** Minimal bun:sqlite shape — just the methods this loader needs. */
export interface MinimalReadOnlyDb {
  query: (sql: string) => {
    get: (...p: unknown[]) => unknown
    all: (...p: unknown[]) => unknown[]
  }
  close: () => void
}

/** Factory the loader calls to open luna.db. Injectable for tests. */
export type OpenDb = (dbPath: string) => MinimalReadOnlyDb

interface WorkspaceRow {
  readonly slug: string
  readonly path: string
  readonly summary: string | null
}

const defaultOpenDb: OpenDb = (dbPath: string): MinimalReadOnlyDb => {
  const req = createRequire(import.meta.url)
  const mod = req("bun:sqlite") as {
    Database: new (p: string, opts?: { readonly?: boolean }) => MinimalReadOnlyDb
  }
  return new mod.Database(dbPath, { readonly: true })
}

/**
 * Build the workspaces section for Luna's system prompt.
 *
 * Behavior:
 *   - Returns `null` when `lunaDbPath` does not exist, when the
 *     `workspaces` table is missing, or when no rows have
 *     `status = 'active'`. The chat-server treats `null` as "omit the
 *     section entirely" (same pattern as `loadSystem`).
 *   - For each active workspace, attempts to read
 *     `<path>/.workspace/workspace.md`. Missing files are surfaced as a
 *     registry-only stub so the operator can still see the workspace is
 *     registered.
 *   - Output is markdown: a top-level `# Workspaces` heading, then one
 *     subsection per workspace ordered by `updated_at DESC` with slug,
 *     path, registry summary, and the workspace.md body verbatim (or a
 *     truncated form when oversized).
 *
 * The DB is opened via the injectable `openDb` seam (defaults to the
 * bun:sqlite `Database` opened readonly) and closed before the function
 * returns, so it's safe to call at boot before the chat-server's own
 * WorkspaceRegistryService layer attaches to the same file.
 */
export function loadWorkspaces(
  lunaDbPath: string,
  openDb: OpenDb = defaultOpenDb,
): string | null {
  if (!existsSync(lunaDbPath)) return null

  let rows: ReadonlyArray<WorkspaceRow>
  const db = openDb(lunaDbPath)
  try {
    const hasTable = db
      .query(
        "SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='workspaces' LIMIT 1",
      )
      .get() as { x: number } | undefined | null
    if (hasTable == null) return null

    rows = db
      .query(
        `SELECT slug, path, summary
         FROM workspaces
         WHERE status = 'active'
         ORDER BY updated_at DESC`,
      )
      .all() as WorkspaceRow[]
  } finally {
    db.close()
  }

  if (rows.length === 0) return null

  const sections: string[] = []
  let aggregateBytes = 0

  for (const row of rows) {
    const header =
      `## ${row.slug}\n` +
      `\n` +
      `_Folder:_ \`${row.path}\`\n` +
      (row.summary != null && row.summary.length > 0
        ? `_Summary:_ ${row.summary}\n`
        : "")

    const mdPath = resolvePath(row.path, ".workspace", "workspace.md")
    let body: string
    if (existsSync(mdPath)) {
      const stats = statSync(mdPath)
      const raw = readFileSync(mdPath, "utf-8")
      if (stats.size > MAX_WORKSPACE_MD_BYTES) {
        body =
          `\n_(workspace.md is ${stats.size} bytes; showing first ${MAX_WORKSPACE_MD_BYTES}. ` +
          `Use \`cat ${mdPath}\` for the full file.)_\n\n` +
          raw.slice(0, MAX_WORKSPACE_MD_BYTES)
      } else {
        body = `\n${raw.trim()}\n`
      }
    } else {
      body = `\n_(No workspace.md at ${mdPath} — registry entry only.)_\n`
    }

    const section = header + body
    if (aggregateBytes + section.length > MAX_AGGREGATE_BYTES) {
      const compact =
        `## ${row.slug}\n\n_Folder:_ \`${row.path}\`\n` +
        `_(omitted from prompt — aggregate workspace.md budget exceeded.)_\n`
      sections.push(compact)
      aggregateBytes = MAX_AGGREGATE_BYTES + 1
      continue
    }
    sections.push(section)
    aggregateBytes += section.length
  }

  const preface =
    `# Workspaces\n` +
    `\n` +
    `The following workspaces are registered in \`luna.db\` (\`status='active'\`).\n` +
    `Each section below is the workspace's \`workspace.md\` loaded at boot —\n` +
    `the source of truth for that workspace's vocabulary, entities, and\n` +
    `processes. Trust this section over any conflicting memory.\n`

  return preface + "\n" + sections.join("\n\n---\n\n")
}
