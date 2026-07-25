/**
 * Unit tests for the ui_feedback_status SQLite store (Moon feedback-
 * screenshot + triage-queue, Phase 1). Mirrors provider-settings/
 * store.test.ts's bun:sqlite dynamic-import + skip-if-not-bun pattern.
 *
 * Coverage:
 *   1. migration is idempotent (open twice, no error)
 *   2. list() LEFT JOIN default: no status row -> status:'open'
 *   3. list() respects an explicit status filter + pagination (limit/offset/hasMore)
 *   4. setStatus() upserts on first call, updates on a second call
 *   5. setStatus() on an unknown id returns {ok:false} and inserts nothing
 *   6. row projection on an OLD-SHAPE payload (no `screenshot` key at all)
 *      projects screenshotPath/Width/Height: null without throwing
 *   7. FK CASCADE: deleting the parent agent_notes row (with
 *      PRAGMA foreign_keys=ON on a REAL on-disk db) removes the status row
 */

import { describe, it, expect } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { openUiFeedbackStatusStore, UI_FEEDBACK_STATUS_COMPONENT } from "./ui-feedback-status-store.js"
import type { BunDb } from "../db/schema-versions.js"

// ── bun:sqlite dynamic import helper (mirrors provider-settings/store.test.ts) ──

// Minimal mirror of agent-notes.ts's SCHEMA_V1 — the parent table our FK
// references. Not exported from agent-notes.ts today, so this is a
// deliberate, commented copy (kept in sync manually; drift here would only
// ever make these tests too strict/loose, never silently wrong at runtime,
// since production always goes through the real agent-notes.ts migration).
const AGENT_NOTES_SCHEMA = `
  CREATE TABLE IF NOT EXISTS agent_notes (
    id           TEXT NOT NULL PRIMARY KEY,
    session_id   TEXT NOT NULL,
    parent_id    TEXT,
    kind         TEXT NOT NULL,
    summary      TEXT NOT NULL,
    payload_json TEXT,
    ts           INTEGER NOT NULL
  );
`

async function openMemoryDbWithAgentNotes(): Promise<BunDb> {
  try {
    const mod = await import("bun:sqlite" as string)
    const Database = (mod as { Database?: new (p: string) => BunDb }).Database
    if (!Database) throw new Error("no Database export")
    const db = new Database(":memory:")
    db.run("PRAGMA journal_mode = WAL")
    db.run(AGENT_NOTES_SCHEMA)
    return db
  } catch {
    // In environments without bun:sqlite (vitest via node) — skip DB tests.
    return null as unknown as BunDb
  }
}

const insertNote = (
  db: BunDb,
  args: { id: string; kind?: string; summary?: string; payload?: unknown; ts?: number },
): void => {
  db.query(
    `INSERT INTO agent_notes (id, session_id, parent_id, kind, summary, payload_json, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    args.id,
    "sess-test",
    null,
    args.kind ?? "ui_feedback",
    args.summary ?? "a feedback note",
    args.payload !== undefined ? JSON.stringify(args.payload) : null,
    args.ts ?? Date.now(),
  )
}

const samplePayload = (over: Record<string, unknown> = {}) => ({
  note: "the send button is too small",
  page: "chat.html",
  target: { selector: "#send-btn" },
  ...over,
})

describe("openUiFeedbackStatusStore", () => {
  it("migration is idempotent — opening twice on the same db does not error", async (ctx) => {
    const db = await openMemoryDbWithAgentNotes()
    if (db === null) {
      ctx.skip() // visibly skipped (not silently green) in non-bun environments
      return
    }
    const store1 = openUiFeedbackStatusStore(db, Date.now())
    const store2 = openUiFeedbackStatusStore(db, Date.now())
    expect(store1).toBeTruthy()
    expect(store2).toBeTruthy()
    const row = db
      .query("SELECT version FROM schema_versions WHERE component = ? LIMIT 1")
      .get(UI_FEEDBACK_STATUS_COMPONENT) as { version: number } | undefined
    expect(row?.version).toBe(1)
  })

  it("list() defaults to status:'open' when a note has no status row", async (ctx) => {
    const db = await openMemoryDbWithAgentNotes()
    if (db === null) {
      ctx.skip()
      return
    }
    insertNote(db, { id: "fb-1", payload: samplePayload() })
    const store = openUiFeedbackStatusStore(db, Date.now())
    const { rows, hasMore } = store.list({ limit: 25, offset: 0 })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe("fb-1")
    expect(rows[0]!.status).toBe("open")
    expect(hasMore).toBe(false)
  })

  it("list() respects an explicit status filter and pagination (limit/offset/hasMore)", async (ctx) => {
    const db = await openMemoryDbWithAgentNotes()
    if (db === null) {
      ctx.skip()
      return
    }
    const store = openUiFeedbackStatusStore(db, Date.now())
    for (let i = 0; i < 5; i++) {
      insertNote(db, { id: `fb-p-${i}`, payload: samplePayload(), ts: 1000 + i })
    }
    // Mark two as resolved.
    store.setStatus({ id: "fb-p-0", status: "resolved" }, Date.now())
    store.setStatus({ id: "fb-p-1", status: "resolved" }, Date.now())

    const openPage1 = store.list({ limit: 2, offset: 0, status: "open" })
    expect(openPage1.rows).toHaveLength(2)
    expect(openPage1.hasMore).toBe(true)
    expect(openPage1.rows.every((r) => r.status === "open")).toBe(true)

    const openPage2 = store.list({ limit: 2, offset: 2, status: "open" })
    expect(openPage2.rows).toHaveLength(1)
    expect(openPage2.hasMore).toBe(false)

    const resolved = store.list({ limit: 25, offset: 0, status: "resolved" })
    expect(resolved.rows).toHaveLength(2)
    expect(resolved.rows.every((r) => r.status === "resolved")).toBe(true)
  })

  it("setStatus() upserts on first call and updates on a second call with different values", async (ctx) => {
    const db = await openMemoryDbWithAgentNotes()
    if (db === null) {
      ctx.skip()
      return
    }
    insertNote(db, { id: "fb-up", payload: samplePayload() })
    const store = openUiFeedbackStatusStore(db, Date.now())

    const r1 = store.setStatus({ id: "fb-up", status: "triaged", notes: "looking into it" }, 1000)
    expect(r1.ok).toBe(true)
    const after1 = store.list({ limit: 25, offset: 0 }).rows[0]!
    expect(after1.status).toBe("triaged")
    expect(after1.statusNotes).toBe("looking into it")
    expect(after1.updatedAt).toBe(1000)

    const r2 = store.setStatus(
      { id: "fb-up", status: "resolved", resolvedRef: "pr-123", notes: "fixed" },
      2000,
    )
    expect(r2.ok).toBe(true)
    const after2 = store.list({ limit: 25, offset: 0 }).rows[0]!
    expect(after2.status).toBe("resolved")
    expect(after2.resolvedRef).toBe("pr-123")
    expect(after2.statusNotes).toBe("fixed")
    expect(after2.updatedAt).toBe(2000)
  })

  it("setStatus() on an unknown id returns {ok:false} and does not insert a row", async (ctx) => {
    const db = await openMemoryDbWithAgentNotes()
    if (db === null) {
      ctx.skip()
      return
    }
    const store = openUiFeedbackStatusStore(db, Date.now())
    const result = store.setStatus({ id: "does-not-exist", status: "resolved" }, Date.now())
    expect(result.ok).toBe(false)
    expect(result.message).toBe("unknown feedback id")
    const row = db
      .query("SELECT 1 AS x FROM ui_feedback_status WHERE id = ?")
      .get("does-not-exist")
    expect(row).toBeNull()
  })

  it("projects an OLD-SHAPE payload (no `screenshot` key at all) to null screenshot fields without throwing", async (ctx) => {
    const db = await openMemoryDbWithAgentNotes()
    if (db === null) {
      ctx.skip()
      return
    }
    // Exact pre-this-PR payload shape: note/target/page/appVersion/appearance/
    // clientTs — NO `screenshot` key.
    insertNote(db, {
      id: "fb-old",
      summary: "the icon looks wrong",
      payload: {
        note: "the icon looks wrong",
        target: { selector: "#icon", tag: "svg" },
        page: "chat.html",
        appVersion: "0.0.50",
        clientTs: 1700000000000,
      },
    })
    const store = openUiFeedbackStatusStore(db, Date.now())
    const { rows } = store.list({ limit: 25, offset: 0 })
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.note).toBe("the icon looks wrong")
    expect(row.selector).toBe("#icon")
    expect(row.screenshotPath).toBeNull()
    expect(row.screenshotWidth).toBeNull()
    expect(row.screenshotHeight).toBeNull()
  })

  it("projects cleanly even when payload_json is malformed (defensive parse, never throws)", async (ctx) => {
    const db = await openMemoryDbWithAgentNotes()
    if (db === null) {
      ctx.skip()
      return
    }
    db.query(
      `INSERT INTO agent_notes (id, session_id, parent_id, kind, summary, payload_json, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("fb-malformed", "sess-test", null, "ui_feedback", "fallback summary", "{not-json", Date.now())
    const store = openUiFeedbackStatusStore(db, Date.now())
    expect(() => store.list({ limit: 25, offset: 0 })).not.toThrow()
    const row = store.list({ limit: 25, offset: 0 }).rows[0]!
    expect(row.note).toBe("fallback summary") // falls back to the note's summary column
    expect(row.screenshotPath).toBeNull()
  })

  it("setStatus with expectedStatus updates only when the current status matches", async (ctx) => {
    const db = await openMemoryDbWithAgentNotes()
    if (db === null) {
      ctx.skip()
      return
    }
    insertNote(db, { id: "fb-guard-ok" })
    const store = openUiFeedbackStatusStore(db, Date.now())
    store.setStatus({ id: "fb-guard-ok", status: "queued", notes: "first" }, 1000)

    const result = store.setStatus(
      {
        id: "fb-guard-ok",
        status: "resolved",
        resolvedRef: "done",
        notes: "auto",
        expectedStatus: "queued",
      },
      2000,
    )

    expect(result.ok).toBe(true)
    const row = store.getRow("fb-guard-ok")
    expect(row?.status).toBe("resolved")
    expect(row?.resolvedRef).toBe("done")
  })

  it("setStatus with expectedStatus returns ok:false and does not overwrite a status set after the snapshot", async (ctx) => {
    const db = await openMemoryDbWithAgentNotes()
    if (db === null) {
      ctx.skip()
      return
    }
    insertNote(db, { id: "fb-guard-race" })
    const store = openUiFeedbackStatusStore(db, Date.now())
    store.setStatus({ id: "fb-guard-race", status: "queued", notes: "human" }, 1000)
    store.setStatus({ id: "fb-guard-race", status: "triaged", notes: "human already looked" }, 1500)

    const result = store.setStatus(
      {
        id: "fb-guard-race",
        status: "resolved",
        resolvedRef: "done",
        notes: "auto",
        expectedStatus: "queued",
      },
      2000,
    )

    expect(result.ok).toBe(false)
    const row = store.getRow("fb-guard-race")
    expect(row?.status).toBe("triaged")
    expect(row?.statusNotes).toBe("human already looked")
  })

  it("setStatus with appendNotes appends to an existing note without wiping it", async (ctx) => {
    const db = await openMemoryDbWithAgentNotes()
    if (db === null) {
      ctx.skip()
      return
    }
    insertNote(db, { id: "fb-append" })
    const store = openUiFeedbackStatusStore(db, Date.now())
    store.setStatus({ id: "fb-append", status: "queued", notes: "human note" }, 1000)
    store.setStatus(
      { id: "fb-append", status: "resolved", notes: "auto: done", appendNotes: true },
      2000,
    )

    expect(store.getRow("fb-append")?.statusNotes).toBe("human note\nauto: done")
  })

  it("setStatus with expectedStatus and appendNotes preserves an existing note through the fold-back", async (ctx) => {
    const db = await openMemoryDbWithAgentNotes()
    if (db === null) {
      ctx.skip()
      return
    }
    insertNote(db, { id: "fb-guard-append" })
    const store = openUiFeedbackStatusStore(db, Date.now())
    store.setStatus({ id: "fb-guard-append", status: "queued", notes: "human" }, 1000)
    const result = store.setStatus(
      {
        id: "fb-guard-append",
        status: "resolved",
        notes: "auto: completed",
        expectedStatus: "queued",
        appendNotes: true,
      },
      2000,
    )

    expect(result.ok).toBe(true)
    expect(store.getRow("fb-guard-append")?.statusNotes).toBe("human\nauto: completed")
  })

  it("setStatus with expectedStatus and appendNotes leaves notes untouched when the guard fails", async (ctx) => {
    const db = await openMemoryDbWithAgentNotes()
    if (db === null) {
      ctx.skip()
      return
    }
    insertNote(db, { id: "fb-guard-fail" })
    const store = openUiFeedbackStatusStore(db, Date.now())
    store.setStatus({ id: "fb-guard-fail", status: "queued", notes: "human" }, 1000)
    store.setStatus({ id: "fb-guard-fail", status: "triaged", notes: "human moved" }, 1500)
    const result = store.setStatus(
      {
        id: "fb-guard-fail",
        status: "resolved",
        notes: "auto",
        expectedStatus: "queued",
        appendNotes: true,
      },
      2000,
    )

    expect(result.ok).toBe(false)
    expect(store.getRow("fb-guard-fail")?.statusNotes).toBe("human moved")
  })

  it("setStatus with appendNotes and an explicit null clears the note (null outranks append)", async (ctx) => {
    const db = await openMemoryDbWithAgentNotes()
    if (db === null) {
      ctx.skip()
      return
    }
    insertNote(db, { id: "fb-append-null" })
    const store = openUiFeedbackStatusStore(db, Date.now())
    store.setStatus({ id: "fb-append-null", status: "queued", notes: "human note" }, 1000)
    // Exercises the INSERT..ON CONFLICT path. `null` means clear; there is no
    // meaningful way to append nothing, so appendNotes must not resurrect the
    // old note via its CASE ELSE branch.
    store.setStatus(
      { id: "fb-append-null", status: "resolved", notes: null, appendNotes: true },
      2000,
    )

    expect(store.getRow("fb-append-null")?.statusNotes).toBeNull()
  })

  it("setStatus with expectedStatus, appendNotes and an explicit null clears the note", async (ctx) => {
    const db = await openMemoryDbWithAgentNotes()
    if (db === null) {
      ctx.skip()
      return
    }
    insertNote(db, { id: "fb-guard-append-null" })
    const store = openUiFeedbackStatusStore(db, Date.now())
    store.setStatus({ id: "fb-guard-append-null", status: "queued", notes: "human" }, 1000)
    // Same contract on the guarded UPDATE path.
    const result = store.setStatus(
      {
        id: "fb-guard-append-null",
        status: "resolved",
        notes: null,
        expectedStatus: "queued",
        appendNotes: true,
      },
      2000,
    )

    expect(result.ok).toBe(true)
    expect(store.getRow("fb-guard-append-null")?.statusNotes).toBeNull()
  })

  it("setStatus with appendNotes still appends when notes is a real string (null fix is scoped)", async (ctx) => {
    const db = await openMemoryDbWithAgentNotes()
    if (db === null) {
      ctx.skip()
      return
    }
    insertNote(db, { id: "fb-append-still" })
    const store = openUiFeedbackStatusStore(db, Date.now())
    store.setStatus({ id: "fb-append-still", status: "queued", notes: "human" }, 1000)
    store.setStatus(
      { id: "fb-append-still", status: "resolved", notes: "auto: done", appendNotes: true },
      2000,
    )
    // Guards against the null normalization accidentally disabling append mode
    // for the production observer call sites, which always pass a string.
    expect(store.getRow("fb-append-still")?.statusNotes).toBe("human\nauto: done")
  })

  it("setStatus preserves existing resolvedRef and notes when they are omitted, and clears notes when explicitly null", async (ctx) => {
    const db = await openMemoryDbWithAgentNotes()
    if (db === null) {
      ctx.skip()
      return
    }
    insertNote(db, { id: "fb-preserve" })
    const store = openUiFeedbackStatusStore(db, Date.now())
    store.setStatus(
      { id: "fb-preserve", status: "queued", resolvedRef: "job-1", notes: "human note" },
      1000,
    )

    const r1 = store.setStatus({ id: "fb-preserve", status: "triaged" }, 2000)
    expect(r1.ok).toBe(true)
    const row1 = store.getRow("fb-preserve")
    expect(row1?.status).toBe("triaged")
    expect(row1?.resolvedRef).toBe("job-1")
    expect(row1?.statusNotes).toBe("human note")
    expect(row1?.updatedAt).toBe(2000)

    const r2 = store.setStatus({ id: "fb-preserve", status: "resolved", notes: null }, 3000)
    expect(r2.ok).toBe(true)
    const row2 = store.getRow("fb-preserve")
    expect(row2?.status).toBe("resolved")
    expect(row2?.resolvedRef).toBe("job-1")
    expect(row2?.statusNotes).toBeNull()
    expect(row2?.updatedAt).toBe(3000)
  })

  it("setStatus with expectedStatus preserves existing resolvedRef and notes when they are omitted, and clears notes when explicitly null", async (ctx) => {
    const db = await openMemoryDbWithAgentNotes()
    if (db === null) {
      ctx.skip()
      return
    }
    insertNote(db, { id: "fb-guard-preserve" })
    const store = openUiFeedbackStatusStore(db, Date.now())
    store.setStatus(
      { id: "fb-guard-preserve", status: "queued", resolvedRef: "job-2", notes: "human note" },
      1000,
    )

    const r1 = store.setStatus(
      { id: "fb-guard-preserve", status: "resolved", expectedStatus: "queued" },
      2000,
    )
    expect(r1.ok).toBe(true)
    const row1 = store.getRow("fb-guard-preserve")
    expect(row1?.status).toBe("resolved")
    expect(row1?.resolvedRef).toBe("job-2")
    expect(row1?.statusNotes).toBe("human note")
    expect(row1?.updatedAt).toBe(2000)

    const r2 = store.setStatus(
      { id: "fb-guard-preserve", status: "triaged", notes: null, expectedStatus: "resolved" },
      3000,
    )
    expect(r2.ok).toBe(true)
    const row2 = store.getRow("fb-guard-preserve")
    expect(row2?.status).toBe("triaged")
    expect(row2?.resolvedRef).toBe("job-2")
    expect(row2?.statusNotes).toBeNull()
    expect(row2?.updatedAt).toBe(3000)
  })

  it("FK CASCADE: deleting the parent agent_notes row removes the ui_feedback_status row", async (ctx) => {
    // A real on-disk sqlite file (not :memory:) with PRAGMA foreign_keys=ON,
    // exercised on ONE connection shared by both the parent table and the
    // store — proves the CASCADE actually fires, not just that the schema
    // declares it.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "luna-fb-cascade-"))
    const dbPath = path.join(dir, "test.db")
    try {
      let Database: (new (p: string) => BunDb) | undefined
      try {
        const mod = await import("bun:sqlite" as string)
        Database = (mod as { Database?: new (p: string) => BunDb }).Database
      } catch {
        // In environments without bun:sqlite (vitest via node) — skip DB tests.
      }
      if (!Database) {
        ctx.skip() // visibly skipped (not silently green) in non-bun environments
        return
      }
      const db = new Database(dbPath)
      db.run(AGENT_NOTES_SCHEMA)
      insertNote(db, { id: "fb-cascade", payload: samplePayload() })

      const store = openUiFeedbackStatusStore(db, Date.now())
      const setResult = store.setStatus({ id: "fb-cascade", status: "triaged" }, Date.now())
      expect(setResult.ok).toBe(true)

      const before = db
        .query("SELECT 1 AS x FROM ui_feedback_status WHERE id = ?")
        .get("fb-cascade")
      expect(before).not.toBeNull()

      db.run("PRAGMA foreign_keys = ON")
      db.query("DELETE FROM agent_notes WHERE id = ?").run("fb-cascade")

      const after = db
        .query("SELECT 1 AS x FROM ui_feedback_status WHERE id = ?")
        .get("fb-cascade")
      expect(after).toBeNull()
      db.close()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
