/**
 * One-shot boot migration: import rows from the legacy
 * thread-session-map.json into the ThreadRegistry (luna.db).
 *
 * Filter rules (from advisor spec):
 *   1. Rows that have no `sid` (sdk_session_id) are SKIPPED — nothing to resume.
 *   2. Rows whose Luna thread id contains "claude-test" are DROPPED — those are
 *      simulator rows, not real sessions.
 *   3. `cwd` is unknown from the JSON; it is backfilled with `defaultCwd` (the
 *      boot default) and a warning is logged for every guessed row.
 *   4. The import is IDEMPOTENT — existing rows (by id) are left untouched.
 *
 * Real path: the server writes to `$LUNA_HOME/.luna/thread-session-map.json`
 * (doubled `.luna/.luna/` because `threadSessionMapPath` joins `.luna` onto
 * LUNA_HOME=/root/.luna). This module reads that same path and also accepts
 * an explicit override for tests.
 *
 * After import, the caller should STOP writing the JSON file (single-writer
 * cutover). The JSON is read-only from this point forward (and only once, at
 * boot).
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import type { ThreadRegistryApi, ThreadRow } from "./thread-registry.js"

// ── JSON map shapes ──────────────────────────────────────────────────────────

interface LegacyEntry {
  sid?: string
  model?: string
  effort?: string
}

type LegacyMap = Record<string, string | LegacyEntry>

const LUNA_THREAD_ID = /^thr_[A-Za-z0-9_]{1,64}$/
const SDK_SESSION_ID = /^[A-Za-z0-9_-]{4,128}$/
const CLAUDE_TEST_PAT = /claude[-_]?test/i

/**
 * Compute the actual on-disk path the server uses.
 * threadSessionMapPath(lunaHome) = join(lunaHome, ".luna", "thread-session-map.json")
 * which for LUNA_HOME=/root/.luna yields /root/.luna/.luna/thread-session-map.json
 * (the "doubled" path the advisor identified).
 */
export const resolveJsonMapPath = (lunaHome: string): string =>
  join(lunaHome, ".luna", "thread-session-map.json")

export interface ImportResult {
  /** Total entries parsed from the JSON. */
  readonly total: number
  /** Entries skipped because they lacked a valid sdk_session_id. */
  readonly skippedNoSid: number
  /** Entries skipped because they matched the claude-test pattern. */
  readonly skippedClaudeTest: number
  /** Entries skipped because the id was already present (idempotent). */
  readonly skippedAlreadyPresent: number
  /** Entries that were actually inserted. */
  readonly inserted: number
  /** Of `inserted`, how many had their cwd guessed (always all of them — JSON has no cwd). */
  readonly cwdGuessed: number
}

/**
 * Parse the JSON map from `jsonPath`. Returns an empty record on any error.
 */
export const parseJsonMap = (jsonPath: string): LegacyMap => {
  if (!existsSync(jsonPath)) return {}
  try {
    const raw = readFileSync(jsonPath, "utf8")
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      return {}
    return parsed as LegacyMap
  } catch {
    return {}
  }
}

/**
 * Run the one-shot import.
 *
 * @param registry   The live ThreadRegistry API (already open against luna.db).
 * @param lunaHome   LUNA_HOME path — used to derive the json map path.
 * @param defaultCwd Fallback cwd for every imported row (set to the server's cwd at boot).
 * @param nowMs      Current Unix ms timestamp (for created_at / last_active_at).
 * @param jsonPathOverride  Override the computed json path (for tests).
 * @param log        Optional logger; receives info/warning strings.
 */
export const importJsonMap = async (
  registry: ThreadRegistryApi,
  lunaHome: string,
  defaultCwd: string,
  nowMs: number,
  opts: {
    jsonPathOverride?: string
    log?: (level: "info" | "warn", msg: string) => void
  } = {},
): Promise<ImportResult> => {
  const { log } = opts
  const jsonPath = opts.jsonPathOverride ?? resolveJsonMapPath(lunaHome)
  const raw = parseJsonMap(jsonPath)

  const result: {
    total: number
    skippedNoSid: number
    skippedClaudeTest: number
    skippedAlreadyPresent: number
    inserted: number
    cwdGuessed: number
  } = {
    total: 0,
    skippedNoSid: 0,
    skippedClaudeTest: 0,
    skippedAlreadyPresent: 0,
    inserted: 0,
    cwdGuessed: 0,
  }

  const entries = Object.entries(raw)
  result.total = entries.length

  log?.("info", `[thread-registry] boot import: ${entries.length} entries in ${jsonPath}`)

  for (const [lunaId, value] of entries) {
    // Validate Luna thread id
    if (!LUNA_THREAD_ID.test(lunaId)) {
      result.skippedNoSid++
      continue
    }

    // Drop claude-test simulator rows
    if (CLAUDE_TEST_PAT.test(lunaId)) {
      result.skippedClaudeTest++
      continue
    }

    // Extract sid
    let sid: string | undefined
    let model: string | undefined
    let effort: string | undefined

    if (typeof value === "string") {
      sid = SDK_SESSION_ID.test(value) ? value : undefined
    } else if (value !== null && typeof value === "object") {
      const obj = value as LegacyEntry
      sid =
        typeof obj.sid === "string" && SDK_SESSION_ID.test(obj.sid)
          ? obj.sid
          : undefined
      model = typeof obj.model === "string" ? obj.model : undefined
      effort = typeof obj.effort === "string" ? obj.effort : undefined
    }

    if (sid === undefined) {
      result.skippedNoSid++
      continue
    }

    // Check idempotency: if row already exists, skip.
    // We use a direct call; errors from the Effect are swallowed (best-effort).
    let existing: ThreadRow | null = null
    try {
      existing = await Effect.runPromise(registry.get(lunaId))
    } catch {
      existing = null
    }

    if (existing !== null) {
      result.skippedAlreadyPresent++
      continue
    }

    // Backfill cwd with the boot default (warn — JSON has no cwd).
    log?.("warn", `[thread-registry] boot import: backfilling cwd='${defaultCwd}' for thread ${lunaId} (JSON has no cwd)`)

    try {
      await Effect.runPromise(
        registry.upsert({
          id: lunaId,
          sdkSessionId: sid,
          cwd: defaultCwd,
          model: model ?? null,
          effort: effort ?? null,
        }),
      )
      result.inserted++
      result.cwdGuessed++
    } catch (e) {
      log?.("warn", `[thread-registry] boot import: failed to insert ${lunaId}: ${String(e)}`)
    }
  }

  log?.(
    "info",
    `[thread-registry] boot import done: inserted=${result.inserted} skippedNoSid=${result.skippedNoSid} skippedClaudeTest=${result.skippedClaudeTest} skippedAlreadyPresent=${result.skippedAlreadyPresent} cwdGuessed=${result.cwdGuessed}`,
  )

  return result
}
