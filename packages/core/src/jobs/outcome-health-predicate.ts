/**
 * Outcome-health predicates — ADR 0001 Phase 2.
 *
 * A job's `payload_json` may carry an optional top-level `health` object:
 *   { predicate: string, ...params }
 *
 * When present, the executor evaluates the named predicate AFTER a successful
 * dispatch (recordRunEnd already committed "success") and writes the result
 * into the SCHEMA_V5 columns:
 *   - last_outcome_success_at — epoch ms of the LAST fresh evaluation
 *   - outcome_state           — 'fresh' | 'stale' | 'unknown'
 *
 * Evaluation NEVER fails a successful run. Predicate errors yield
 * outcome_state = 'unknown', recorded in a notify-only agent_note.
 *
 * Three built-in predicates:
 *   sqlite_newest_row_age { db, table, column, maxAgeDays }
 *   file_mtime_age        { path, maxAgeDays }
 *   http_ok               { url, timeoutMs }
 *
 * Unknown predicate names produce a typed validation failure (kind =
 * "unknown_predicate"), which is loud (logged once as a note) but does not
 * fail the run.
 */
import * as fs from "node:fs"

// ── Types ────────────────────────────────────────────────────────────────────

export interface HealthPayload {
  readonly predicate: string
  readonly [key: string]: unknown
}

export interface PredicateResult {
  readonly state: "fresh" | "stale"
  readonly detail?: string
}

export interface PredicateError {
  readonly kind: "unknown_predicate" | "eval_error"
  readonly message: string
}

export type PredicateOutcome =
  | { readonly ok: true; readonly result: PredicateResult }
  | { readonly ok: false; readonly error: PredicateError }

/** A registered predicate — sync or async. */
export type PredicateFn = (
  params: Record<string, unknown>,
) => PredicateResult | Promise<PredicateResult>

// ── Predicate registry ────────────────────────────────────────────────────────

const REGISTRY = new Map<string, PredicateFn>()

export const registerPredicate = (name: string, fn: PredicateFn): void => {
  REGISTRY.set(name, fn)
}

// ── Predicate: sqlite_newest_row_age ─────────────────────────────────────────

const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * Passes if MAX(column) in (db, table) is younger than maxAgeDays.
 * Opens the target DB read-only with a short busy timeout; never writes.
 * Table/column names are validated against a safe-identifier pattern before
 * being interpolated into the SQL (no parameterized form exists for
 * identifiers in SQLite).
 */
const sqliteNewestRowAge: PredicateFn = async (params) => {
  const dbPath = String(params["db"] ?? "")
  const table = String(params["table"] ?? "")
  const column = String(params["column"] ?? "")
  const maxAgeDays = Number(params["maxAgeDays"] ?? 0)

  if (!dbPath || !table || !column || !(maxAgeDays > 0)) {
    throw new Error(
      "sqlite_newest_row_age: missing or invalid params " +
        "(required: db, table, column, maxAgeDays > 0)",
    )
  }

  const identRe = /^[A-Za-z_][A-Za-z0-9_]*$/
  if (!identRe.test(table)) {
    throw new Error(`sqlite_newest_row_age: invalid table name: "${table}"`)
  }
  if (!identRe.test(column)) {
    throw new Error(`sqlite_newest_row_age: invalid column name: "${column}"`)
  }

  // Dynamic import — same @vite-ignore pattern the production stores use.
  const bunSqliteSpec = "bun:sqlite"
  const mod = (await import(/* @vite-ignore */ bunSqliteSpec)) as {
    Database: new (
      path: string,
      opts?: { readonly: boolean; timeout?: number },
    ) => {
      query: (sql: string) => { get: () => unknown }
      close: () => void
    }
  }

  const db = new mod.Database(dbPath, { readonly: true, timeout: 3000 })
  try {
    const row = db
      .query(`SELECT MAX(${column}) AS max_ts FROM ${table}`)
      .get() as { max_ts: number | null } | undefined | null

    const maxTs = row?.max_ts ?? null
    if (maxTs === null) {
      return {
        state: "stale",
        detail: `table "${table}" has no rows`,
      }
    }

    const ageMs = Date.now() - maxTs
    const fresh = ageMs <= maxAgeDays * MS_PER_DAY
    return {
      state: fresh ? "fresh" : "stale",
      detail: `newest-row age ${Math.round(ageMs / 1000)}s, threshold ${maxAgeDays}d`,
    }
  } finally {
    try { db.close() } catch { /* best-effort */ }
  }
}

registerPredicate("sqlite_newest_row_age", sqliteNewestRowAge)

// ── Predicate: file_mtime_age ─────────────────────────────────────────────────

/**
 * Passes if the file at `path` was modified within `maxAgeDays`.
 * Uses synchronous `fs.statSync` — predicate runs outside the producer tick
 * loop (executor fiber) so a brief sync stat is acceptable.
 */
const fileMtimeAge: PredicateFn = (params) => {
  const filePath = String(params["path"] ?? "")
  const maxAgeDays = Number(params["maxAgeDays"] ?? 0)

  if (!filePath || !(maxAgeDays > 0)) {
    throw new Error(
      "file_mtime_age: missing or invalid params (required: path, maxAgeDays > 0)",
    )
  }

  const stat = fs.statSync(filePath) // throws ENOENT if missing
  const ageMs = Date.now() - stat.mtimeMs
  const fresh = ageMs <= maxAgeDays * MS_PER_DAY
  return {
    state: fresh ? "fresh" : "stale",
    detail: `file mtime age ${Math.round(ageMs / 1000)}s, threshold ${maxAgeDays}d`,
  }
}

registerPredicate("file_mtime_age", fileMtimeAge)

// ── Predicate: http_ok ────────────────────────────────────────────────────────

/**
 * Passes if `url` responds with a 2xx status within `timeoutMs` (default
 * 5000ms). Uses a HEAD request to minimize payload transfer.
 */
const httpOk: PredicateFn = async (params) => {
  const url = String(params["url"] ?? "")
  const timeoutMs = Number(params["timeoutMs"] ?? 5000)

  if (!url) {
    throw new Error("http_ok: missing params (required: url)")
  }

  const controller = new AbortController()
  const tid = setTimeout(() => controller.abort(), Math.max(500, timeoutMs))
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      method: "HEAD",
    })
    const ok = res.status >= 200 && res.status < 300
    return {
      state: ok ? "fresh" : "stale",
      detail: `HTTP ${res.status}`,
    }
  } catch (err) {
    throw new Error(`http_ok: request failed: ${String(err)}`)
  } finally {
    clearTimeout(tid)
  }
}

registerPredicate("http_ok", httpOk)

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extract the `health` object from a job payload. Returns null when absent,
 * malformed (not an object), or missing a string `predicate` key.
 */
export const extractHealthPayload = (
  payload: unknown,
): HealthPayload | null => {
  if (payload === null || typeof payload !== "object") return null
  const h = (payload as Record<string, unknown>)["health"]
  if (h === null || typeof h !== "object") return null
  const predicate = (h as Record<string, unknown>)["predicate"]
  if (typeof predicate !== "string" || predicate.length === 0) return null
  return h as HealthPayload
}

/**
 * Evaluate a named predicate. Returns PredicateOutcome (never throws).
 * The evaluation is capped at 10 seconds — a hung DB open or HTTP call must
 * not block the executor fiber indefinitely.
 */
export const evalPredicate = async (
  health: HealthPayload,
): Promise<PredicateOutcome> => {
  const { predicate, ...params } = health
  const fn = REGISTRY.get(predicate)
  if (!fn) {
    return {
      ok: false,
      error: {
        kind: "unknown_predicate",
        message: `no predicate registered for name "${predicate}"`,
      },
    }
  }

  const EVAL_TIMEOUT_MS = 10_000

  const timeout = new Promise<PredicateOutcome>((resolve) => {
    const t = setTimeout(() => {
      resolve({
        ok: false,
        error: {
          kind: "eval_error",
          message: `predicate "${predicate}" timed out after ${EVAL_TIMEOUT_MS}ms`,
        },
      })
    }, EVAL_TIMEOUT_MS)
    // Detach the timer so it does not keep Bun/Node alive past test teardown.
    if (typeof (t as unknown as { unref?: () => void }).unref === "function") {
      ;(t as unknown as { unref: () => void }).unref()
    }
  })

  const work = (async (): Promise<PredicateOutcome> => {
    try {
      const result = await fn(params as Record<string, unknown>)
      return { ok: true, result }
    } catch (err) {
      return {
        ok: false,
        error: {
          kind: "eval_error",
          message: `predicate "${predicate}" threw: ${String(err)}`,
        },
      }
    }
  })()

  return Promise.race([work, timeout])
}
