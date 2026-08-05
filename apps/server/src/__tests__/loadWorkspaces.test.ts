/**
 * loadWorkspaces helper unit tests.
 *
 * The loader queries luna.db for active workspaces and injects each
 * workspace's workspace.md content into a single labeled string for
 * Luna's system prompt.
 *
 * bun:sqlite is not available under vitest/node, so we use the
 * `openDb` injectable seam (mirrors the pattern in setup-login.test.ts)
 * with a pure-JS fake DB. The fake interprets only the two queries the
 * loader actually runs:
 *
 *   1. has-table probe (`SELECT 1 ... sqlite_master ...`)
 *   2. active-workspaces fetch (`SELECT ... WHERE status='active' ORDER BY updated_at DESC`)
 *
 * Coverage:
 *   1. Returns null when luna.db file is missing.
 *   2. Returns null when workspaces table is missing.
 *   3. Returns null when no rows are active.
 *   4. Embeds workspace.md content for each active workspace.
 *   5. Archived/paused rows are excluded by the fake's query parser.
 *   6. Missing workspace.md surfaces a registry-only stub.
 *   7. Oversized workspace.md is truncated with a clear marker.
 *   8. Output is ordered most-recently-updated first.
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  loadWorkspaces,
  type MinimalReadOnlyDb,
  type OpenDb,
} from "../workspaces-loader.js"

interface SeedRow {
  readonly slug: string
  readonly path: string
  readonly summary: string | null
  readonly status: string
  readonly updated_at: number
}

/**
 * Build an injectable `openDb` that pretends to be a luna.db with the
 * given seeded rows and the `workspaces` table present.
 *
 * `hasTable=false` simulates a brand-new luna.db with no workspaces table.
 */
function makeFakeOpenDb(
  rows: ReadonlyArray<SeedRow>,
  hasTable = true,
): OpenDb {
  return (_dbPath: string): MinimalReadOnlyDb => ({
    query: (sql: string) => {
      const trimmed = sql.replace(/\s+/g, " ").trim().toLowerCase()
      if (trimmed.startsWith("select 1 as x from sqlite_master")) {
        return {
          get: () => (hasTable ? { x: 1 } : null),
          all: () => (hasTable ? [{ x: 1 }] : []),
        }
      }
      if (trimmed.startsWith("select slug, path, summary")) {
        const active = rows
          .filter((r) => r.status === "active")
          .slice()
          .sort((a, b) => b.updated_at - a.updated_at)
          .map((r) => ({ slug: r.slug, path: r.path, summary: r.summary }))
        return {
          get: () => active[0] ?? null,
          all: () => active,
        }
      }
      throw new Error(`Fake DB: unexpected SQL: ${sql}`)
    },
    close: () => {},
  })
}

function writeWorkspaceMd(workspacePath: string, body: string): void {
  const wsDir = path.join(workspacePath, ".workspace")
  fs.mkdirSync(wsDir, { recursive: true })
  fs.writeFileSync(path.join(wsDir, "workspace.md"), body)
}

describe("loadWorkspaces", () => {
  let tmpDir: string
  let dbPath: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "luna-loadWorkspaces-"))
    dbPath = path.join(tmpDir, "luna.db")
    // Create the file so existsSync() passes; the fake openDb supplies
    // the query semantics, not the file contents.
    fs.writeFileSync(dbPath, "")
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("returns null when luna.db file is missing", () => {
    const result = loadWorkspaces(
      path.join(tmpDir, "missing.db"),
      makeFakeOpenDb([]),
    )
    expect(result).toBeNull()
  })

  it("returns null when workspaces table is missing", () => {
    const result = loadWorkspaces(dbPath, makeFakeOpenDb([], false))
    expect(result).toBeNull()
  })

  it("returns null when no workspaces have status=active", () => {
    const result = loadWorkspaces(
      dbPath,
      makeFakeOpenDb([
        {
          slug: "old",
          path: tmpDir,
          summary: null,
          status: "archived",
          updated_at: 1,
        },
      ]),
    )
    expect(result).toBeNull()
  })

  it("embeds workspace.md body for each active workspace", () => {
    const wsA = path.join(tmpDir, "ws-a")
    const wsB = path.join(tmpDir, "ws-b")
    fs.mkdirSync(wsA)
    fs.mkdirSync(wsB)
    writeWorkspaceMd(wsA, "# WS A\n\nA-body.\n")
    writeWorkspaceMd(wsB, "# WS B\n\nB-body.\n")
    const result = loadWorkspaces(
      dbPath,
      makeFakeOpenDb([
        {
          slug: "a",
          path: wsA,
          summary: "alpha workspace",
          status: "active",
          updated_at: 1,
        },
        {
          slug: "b",
          path: wsB,
          summary: null,
          status: "active",
          updated_at: 2,
        },
      ]),
    )
    expect(result).not.toBeNull()
    const out = result!
    expect(out).toContain("# Workspaces")
    expect(out).toContain("## a")
    expect(out).toContain("## b")
    expect(out).toContain(`_Folder:_ \`${wsA}\``)
    expect(out).toContain(`_Folder:_ \`${wsB}\``)
    expect(out).toContain("alpha workspace")
    expect(out).toContain("A-body.")
    expect(out).toContain("B-body.")
  })

  it("excludes archived and paused rows", () => {
    const wsOn = path.join(tmpDir, "ws-on")
    const wsOff = path.join(tmpDir, "ws-off")
    fs.mkdirSync(wsOn)
    fs.mkdirSync(wsOff)
    writeWorkspaceMd(wsOn, "ACTIVE-MARKER")
    writeWorkspaceMd(wsOff, "ARCHIVED-MARKER")
    const result = loadWorkspaces(
      dbPath,
      makeFakeOpenDb([
        {
          slug: "on",
          path: wsOn,
          summary: null,
          status: "active",
          updated_at: 1,
        },
        {
          slug: "off",
          path: wsOff,
          summary: null,
          status: "archived",
          updated_at: 1,
        },
        {
          slug: "paused-one",
          path: wsOff,
          summary: null,
          status: "paused",
          updated_at: 1,
        },
      ]),
    )!
    expect(result).toContain("ACTIVE-MARKER")
    expect(result).not.toContain("ARCHIVED-MARKER")
    expect(result).not.toContain("paused-one")
  })

  it("surfaces a registry-only stub when workspace.md is missing", () => {
    const wsPath = path.join(tmpDir, "ws-no-md")
    fs.mkdirSync(wsPath)
    const result = loadWorkspaces(
      dbPath,
      makeFakeOpenDb([
        {
          slug: "bare",
          path: wsPath,
          summary: "no md yet",
          status: "active",
          updated_at: 1,
        },
      ]),
    )!
    expect(result).toContain("## bare")
    expect(result).toContain("No workspace.md")
    expect(result).toContain("no md yet")
  })

  it("truncates an oversized workspace.md with a clear marker", () => {
    const wsPath = path.join(tmpDir, "ws-big")
    fs.mkdirSync(wsPath)
    const huge = "x".repeat(64 * 1024) // 64 KB > 32 KB per-file cap
    writeWorkspaceMd(wsPath, huge)
    const result = loadWorkspaces(
      dbPath,
      makeFakeOpenDb([
        {
          slug: "big",
          path: wsPath,
          summary: null,
          status: "active",
          updated_at: 1,
        },
      ]),
    )!
    expect(result).toContain("## big")
    expect(result).toMatch(/showing first \d+/i)
    expect(result.length).toBeLessThan(48 * 1024)
  })

  it("orders sections by updated_at DESC", () => {
    const wsOld = path.join(tmpDir, "old")
    const wsNew = path.join(tmpDir, "new")
    fs.mkdirSync(wsOld)
    fs.mkdirSync(wsNew)
    writeWorkspaceMd(wsOld, "OLD-MARKER")
    writeWorkspaceMd(wsNew, "NEW-MARKER")
    const result = loadWorkspaces(
      dbPath,
      makeFakeOpenDb([
        {
          slug: "old",
          path: wsOld,
          summary: null,
          status: "active",
          updated_at: 1,
        },
        {
          slug: "new",
          path: wsNew,
          summary: null,
          status: "active",
          updated_at: 100,
        },
      ]),
    )!
    const newIdx = result.indexOf("NEW-MARKER")
    const oldIdx = result.indexOf("OLD-MARKER")
    expect(newIdx).toBeGreaterThan(-1)
    expect(oldIdx).toBeGreaterThan(-1)
    expect(newIdx).toBeLessThan(oldIdx)
  })
})
