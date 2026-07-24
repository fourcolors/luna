/**
 * ui-feedback-status-store.ts — SQLite-backed triage status for
 * `ui_feedback` agent_notes (Moon feedback-screenshot + triage-queue,
 * Phase 1).
 *
 * Mirrors provider-settings/store.ts EXACTLY: "component on an existing
 * luna.db handle, caller owns the connection" — the established pattern in
 * this codebase for a table that lives alongside others already sharing
 * luna.db via independent bun:sqlite connections, each owning one
 * component's own schema/migration ladder (schema_versions keyed by
 * component name — see ../db/schema-versions.ts).
 *
 * `ui_feedback_status` is a companion table to `agent_notes`: every
 * `ui_feedback`-kind note gets AT MOST one status row, created lazily on the
 * first `setStatus` call. A note with no status row defaults to `'open'`
 * (see `list()`'s COALESCE). `id` REFERENCES agent_notes(id) ON DELETE
 * CASCADE so a deleted note can never leave an orphaned status row — see the
 * FK CASCADE test in ui-feedback-status-store.test.ts, which proves this
 * with a real on-disk sqlite file and PRAGMA foreign_keys=ON.
 *
 * Why co-located with agent-notes/ instead of its own top-level directory:
 * this table has no independent lifecycle — it only ever exists in relation
 * to a `ui_feedback` agent_notes row, exactly like a Rails-style companion/
 * "profile" table.
 */

import { applyMigration, ensureSchemaVersions, type BunDb } from "../db/schema-versions.js"
// Type-only import — erased at compile time, so this does not create a
// runtime require() cycle even though feedback-job-bridge.ts imports
// FeedbackListRow (below) from this same file. FeedbackJobLookupRow is
// exactly this store's own JoinedRow shape plus `kind`/`sessionId`; defining
// it once on the bridge side (which is the seam that actually needs it) and
// importing it back here for getRow's return type avoids a second,
// independently-drifting copy of the same shape.
import type { FeedbackJobLookupRow } from "./feedback-job-bridge.js"

// Named UI_FEEDBACK_STATUS_COMPONENT (not the bare `COMPONENT` other stores
// in this codebase use, e.g. provider-settings/store.ts) because @luna/core's
// top-level index.ts does `export *` from every component's index barrel —
// a second bare `COMPONENT` re-export would collide with provider-settings'
// and break the whole package's public surface (TS2308). Every other
// consumer of this file still imports the migration-ladder component name
// under this constant; only the export name differs from the store.ts
// template it otherwise mirrors exactly.
export const UI_FEEDBACK_STATUS_COMPONENT = "ui_feedback_status"

/** The synthetic session id feedback-sink stamps on notes with no real
 *  originating chat thread (chat-server.ts feedbackSink) when the WS frame
 *  carries no `threadId`. Single source of truth: feedback-job-bridge.ts (the
 *  deliver_to guard) and chat-server.ts's feedbackSink both import THIS
 *  constant rather than each hand-typing the literal, so the two can never
 *  skew out of sync. */
export const UI_FEEDBACK_SENTINEL_SESSION = "ui-feedback"

const SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS ui_feedback_status (
    id           TEXT PRIMARY KEY REFERENCES agent_notes(id) ON DELETE CASCADE,
    status       TEXT NOT NULL DEFAULT 'open',
    resolved_ref TEXT,
    notes        TEXT,
    updated_at   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ui_feedback_status_status ON ui_feedback_status(status);
`

/** Wire-safe projection of one `ui_feedback` note + its (optional) triage
 *  status — returned DIRECTLY by the `feedback-list` MCP tool, so this shape
 *  IS the wire contract. Every field is defensively derived (see
 *  `projectFeedbackRow` below) so a malformed/legacy `payload_json` can never
 *  throw — old `ui_feedback` notes recorded before this feature shipped have
 *  no `screenshot` key in their payload at all, and must project cleanly to
 *  nulls. */
export interface FeedbackListRow {
  readonly id: string
  readonly note: string
  readonly page: string | null
  readonly selector: string | null
  readonly screenshotPath: string | null
  readonly screenshotWidth: number | null
  readonly screenshotHeight: number | null
  readonly status: string
  readonly resolvedRef: string | null
  readonly statusNotes: string | null
  readonly createdAt: number
  readonly updatedAt: number
}

export interface UiFeedbackStatusStore {
  readonly list: (args: {
    readonly limit: number
    readonly offset: number
    readonly status?: string
  }) => { readonly rows: ReadonlyArray<FeedbackListRow>; readonly hasMore: boolean }

  readonly setStatus: (
    args: {
      readonly id: string
      readonly status: string
      readonly resolvedRef?: string | null
      readonly notes?: string | null
    },
    /** Optional (timestamp hardening) — defaults to Date.now() computed
     *  INSIDE setStatus at call time when omitted. Tests keep injecting an
     *  explicit value for determinism; production call sites no longer have
     *  to thread their own Date.now() through. */
    nowMs?: number,
  ) => { readonly ok: boolean; readonly message?: string }

  /** Single-row lookup keyed by id, joining agent_notes for `kind` +
   *  `session_id` on top of the same projection `list()` uses — the seam
   *  feedback-job-bridge.ts's FeedbackJobLookupStore needs (kind to fail
   *  closed on a non-ui_feedback note, sessionId for the deliver_to guard).
   *  Returns null for an unknown id rather than throwing. */
  readonly getRow: (id: string) => FeedbackJobLookupRow | null
}

type JoinedRow = {
  id: string
  summary: string
  payload_json: string | null
  ts: number
  status: string | null
  resolved_ref: string | null
  notes: string | null
  updated_at: number | null
}

/** JoinedRow plus the two agent_notes columns `list()`'s query never selects
 *  (kind, session_id) — only getRow's single-row query needs them. */
type JoinedRowWithNoteFields = JoinedRow & { kind: string; session_id: string }

const asOptionalString = (v: unknown): string | null =>
  typeof v === "string" ? v : null

const asOptionalNumber = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null

/**
 * Project one joined (agent_notes ⋈ ui_feedback_status) row to the wire-safe
 * FeedbackListRow. `payload_json` parsing is fully defensive — a malformed
 * or legacy (pre-screenshot-feature) payload must never throw, it just
 * projects to nulls for the fields it's missing.
 */
const projectFeedbackRow = (row: JoinedRow): FeedbackListRow => {
  let payload: Record<string, unknown> = {}
  try {
    const parsed = row.payload_json != null ? JSON.parse(row.payload_json) : {}
    if (parsed !== null && typeof parsed === "object") {
      payload = parsed as Record<string, unknown>
    }
  } catch {
    payload = {}
  }
  const note = asOptionalString(payload["note"]) ?? row.summary
  const page = asOptionalString(payload["page"])
  const target =
    payload["target"] !== null && typeof payload["target"] === "object"
      ? (payload["target"] as Record<string, unknown>)
      : {}
  const selector = asOptionalString(target["selector"])
  const screenshot =
    payload["screenshot"] !== null && typeof payload["screenshot"] === "object"
      ? (payload["screenshot"] as Record<string, unknown>)
      : null
  const screenshotPath = screenshot ? asOptionalString(screenshot["screenshotPath"]) : null
  const screenshotWidth = screenshot ? asOptionalNumber(screenshot["width"]) : null
  const screenshotHeight = screenshot ? asOptionalNumber(screenshot["height"]) : null

  return {
    id: row.id,
    note,
    page,
    selector,
    screenshotPath,
    screenshotWidth,
    screenshotHeight,
    status: row.status ?? "open",
    resolvedRef: row.resolved_ref ?? null,
    statusNotes: row.notes ?? null,
    createdAt: row.ts,
    updatedAt: row.updated_at ?? row.ts,
  }
}

/**
 * Open or create the ui_feedback_status component on an existing luna.db
 * handle. Runs the v1 migration idempotently and enables `PRAGMA
 * foreign_keys = ON` on ITS OWN connection (needed so `setStatus` INSERTs
 * reject an id that doesn't exist in `agent_notes` — defense against orphan
 * status rows; SQLite foreign_keys is a per-connection pragma, not a
 * database-wide setting, so every connection that writes this table must
 * set it independently). Does NOT open the DB itself (the caller owns the
 * connection lifetime) — mirrors openProviderSettingsStore.
 */
export const openUiFeedbackStatusStore = (
  db: BunDb,
  nowMs: number = Date.now(),
): UiFeedbackStatusStore => {
  ensureSchemaVersions(db)
  applyMigration(db, UI_FEEDBACK_STATUS_COMPONENT, 1, SCHEMA_V1, nowMs)
  db.run("PRAGMA foreign_keys = ON")

  const list: UiFeedbackStatusStore["list"] = (args) => {
    // Over-fetch by one page (limit+1) so hasMore is exact without a second
    // COUNT query — the same pattern memory-list uses elsewhere (chat-server
    // getMemoryListPage).
    const fetchLimit = args.limit + 1
    const rows =
      args.status !== undefined
        ? (db
            .query(
              `SELECT n.id AS id, n.summary AS summary, n.payload_json AS payload_json, n.ts AS ts,
                      s.status AS status, s.resolved_ref AS resolved_ref, s.notes AS notes, s.updated_at AS updated_at
               FROM agent_notes n
               LEFT JOIN ui_feedback_status s ON s.id = n.id
               WHERE n.kind = 'ui_feedback' AND COALESCE(s.status, 'open') = ?
               ORDER BY n.ts DESC
               LIMIT ? OFFSET ?`,
            )
            .all(args.status, fetchLimit, args.offset) as JoinedRow[])
        : (db
            .query(
              `SELECT n.id AS id, n.summary AS summary, n.payload_json AS payload_json, n.ts AS ts,
                      s.status AS status, s.resolved_ref AS resolved_ref, s.notes AS notes, s.updated_at AS updated_at
               FROM agent_notes n
               LEFT JOIN ui_feedback_status s ON s.id = n.id
               WHERE n.kind = 'ui_feedback'
               ORDER BY n.ts DESC
               LIMIT ? OFFSET ?`,
            )
            .all(fetchLimit, args.offset) as JoinedRow[])

    const hasMore = rows.length > args.limit
    const page = rows.slice(0, args.limit)
    return { rows: page.map(projectFeedbackRow), hasMore }
  }

  const setStatus: UiFeedbackStatusStore["setStatus"] = (args, nowMs = Date.now()) => {
    try {
      const exists = db
        .query(`SELECT 1 AS x FROM agent_notes WHERE id = ? AND kind = 'ui_feedback' LIMIT 1`)
        .get(args.id) as { x: number } | undefined | null
      if (exists == null) {
        return { ok: false, message: "unknown feedback id" }
      }
      db.query(
        `INSERT INTO ui_feedback_status (id, status, resolved_ref, notes, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           resolved_ref = excluded.resolved_ref,
           notes = excluded.notes,
           updated_at = excluded.updated_at`,
      ).run(args.id, args.status, args.resolvedRef ?? null, args.notes ?? null, nowMs)
      return { ok: true }
    } catch (e) {
      return { ok: false, message: String(e) }
    }
  }

  const getRow: UiFeedbackStatusStore["getRow"] = (id) => {
    const row = db
      .query(
        `SELECT n.id AS id, n.kind AS kind, n.session_id AS session_id, n.summary AS summary,
                n.payload_json AS payload_json, n.ts AS ts,
                s.status AS status, s.resolved_ref AS resolved_ref, s.notes AS notes, s.updated_at AS updated_at
         FROM agent_notes n
         LEFT JOIN ui_feedback_status s ON s.id = n.id
         WHERE n.id = ?
         LIMIT 1`,
      )
      .get(id) as JoinedRowWithNoteFields | undefined | null
    if (row == null) return null
    return {
      ...projectFeedbackRow(row),
      kind: row.kind,
      sessionId: row.session_id,
    }
  }

  return { list, setStatus, getRow }
}
