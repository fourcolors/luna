/**
 * thread-session-map — LEGACY fallback for the thread→SDK-session mapping.
 *
 * STATUS: RETIRED as the primary durable mechanism. The ThreadRegistry
 * (luna.db `threads` table, @luna/core) is now the source of truth. This
 * module is kept ONLY as a headless/no-registry fallback for environments
 * that do not wire the ThreadRegistry at boot (e.g. older tests, non-server
 * usage). It is NO LONGER WRITTEN when the ThreadRegistry is present at
 * chat-server boot (see chat-service.ts: dual-write is gated on
 * `Option.isNone(threadRegistry)`).
 *
 * Migration: on first boot with the ThreadRegistry wired, json-map-importer.ts
 * performs a one-shot import of any existing entries from this file into
 * luna.db. After that import the JSON file is treated as read-only; the
 * registry is the only writer.
 *
 * Historical role: a single JSON file `~/.luna/thread-session-map.json`
 * (doubled path: `$LUNA_HOME/.luna/thread-session-map.json`) whose top-level
 * keys are Luna thread ids (`thr_<base36>_<rand>`) and values are EITHER:
 *   - A bare string (legacy format) — the SDK session UUID.
 *   - An object `{sid?: string, model?: string, effort?: string}` — the SDK
 *     session UUID plus the thread's last-known model and effort selections.
 *
 * Best-effort by design — disk failures must not break a live chat session.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { isEffortOption } from "./effort.js"

const LUNA_THREAD_ID = /^thr_[A-Za-z0-9_]{1,64}$/
const SDK_SESSION_ID = /^[A-Za-z0-9_-]{4,128}$/
/** Loose model id pattern — must be a non-empty string with no path traversal. */
const MODEL_ID = /^[A-Za-z0-9][\w\-./]{0,127}$/

/** Per-thread config persisted alongside the SDK session id. */
export interface ThreadConfig {
  /** The Claude SDK session UUID. Absent until onSdkSessionId fires (a
   *  config selection made before the first turn creates a sid-less entry). */
  readonly sid?: string
  /** Last-known model id for this thread (used to rebuild createThread on recovery). */
  readonly model?: string
  /** Last-known effort level for this thread (used to rebuild createThread on recovery). */
  readonly effort?: string
}

/** The full map type. Legacy entries are bare strings (sid only). */
export type ThreadSessionMap = Readonly<Record<string, string | ThreadConfig>>

export const threadSessionMapPath = (homeDir: string): string =>
  join(homeDir, ".luna", "thread-session-map.json")

/** Validate and normalize one raw map value to a `ThreadConfig`. */
const normalizeEntry = (v: unknown): ThreadConfig | undefined => {
  // Legacy: bare string → sid only
  if (typeof v === "string" && SDK_SESSION_ID.test(v)) {
    return { sid: v }
  }
  // New: object shape. `sid` may be ABSENT (config-only entry written before
  // the SDK session id arrived) — but a PRESENT-yet-invalid sid means the
  // entry is corrupt and is dropped entirely.
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    const obj = v as Record<string, unknown>
    const entry: ThreadConfig = {}
    if (typeof obj["sid"] === "string" && SDK_SESSION_ID.test(obj["sid"])) {
      Object.assign(entry, { sid: obj["sid"] })
    } else if (obj["sid"] !== undefined) {
      return undefined
    }
    if (typeof obj["model"] === "string" && MODEL_ID.test(obj["model"])) {
      Object.assign(entry, { model: obj["model"] })
    }
    // isEffortOption (not isEffort): also admits the "ultracode" token so the
    // mode survives a chat-server restart instead of being dropped on load.
    if (isEffortOption(obj["effort"])) {
      Object.assign(entry, { effort: obj["effort"] })
    }
    // An object carrying neither a sid nor any config is meaningless.
    if (
      entry.sid === undefined &&
      entry.model === undefined &&
      entry.effort === undefined
    ) {
      return undefined
    }
    return entry
  }
  return undefined
}

const readRawMap = (homeDir: string): Record<string, ThreadConfig> => {
  const path = threadSessionMapPath(homeDir)
  if (!existsSync(path)) return {}
  try {
    const raw = readFileSync(path, "utf8")
    const parsed = JSON.parse(raw) as unknown
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return {}
    }
    const out: Record<string, ThreadConfig> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!LUNA_THREAD_ID.test(k)) continue
      const entry = normalizeEntry(v)
      if (entry !== undefined) out[k] = entry
    }
    return out
  } catch {
    return {}
  }
}

const writeRawMap = (homeDir: string, map: Record<string, ThreadConfig>): void => {
  const path = threadSessionMapPath(homeDir)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, JSON.stringify(map, null, 2) + "\n", { mode: 0o600 })
}

/** Load the thread→config map from disk. Legacy bare-string entries are
 *  normalized to `{sid}` objects. Returns an empty object on any error. */
export const loadThreadSessionMap = (homeDir: string): ThreadSessionMap =>
  readRawMap(homeDir)

/**
 * Append or update the SDK session id entry for a thread.
 * Preserves any existing model/effort if not replaced; merges additively.
 */
export const appendThreadSessionEntry = (
  homeDir: string,
  lunaThreadId: string,
  sdkSessionId: string,
): void => {
  if (!LUNA_THREAD_ID.test(lunaThreadId)) return
  if (!SDK_SESSION_ID.test(sdkSessionId)) return
  const current = readRawMap(homeDir)
  const prev = current[lunaThreadId]
  current[lunaThreadId] = {
    ...(prev !== undefined ? prev : {}),
    sid: sdkSessionId,
  }
  try {
    writeRawMap(homeDir, current)
  } catch {
    // Best-effort: if disk write fails, the live session continues. Resume
    // across restart won't work for THIS thread but won't poison others.
  }
}

/**
 * Persist model and/or effort for a thread (merged with the existing entry).
 * When the thread has NO entry yet — the SDK session id arrives only
 * asynchronously around the first turn — a config-only (sid-less) entry is
 * CREATED so a selection made before any turn survives a restart; the later
 * appendThreadSessionEntry merges the sid in without disturbing it.
 * No-ops when neither field validates (never writes an empty entry).
 */
export const appendThreadConfigEntry = (
  homeDir: string,
  lunaThreadId: string,
  config: { model?: string; effort?: string },
): void => {
  if (!LUNA_THREAD_ID.test(lunaThreadId)) return
  const validFields: Partial<ThreadConfig> = {
    ...(config.model !== undefined && MODEL_ID.test(config.model)
      ? { model: config.model }
      : {}),
    ...(config.effort !== undefined && isEffortOption(config.effort)
      ? { effort: config.effort }
      : {}),
  }
  if (Object.keys(validFields).length === 0) return
  const current = readRawMap(homeDir)
  const prev = current[lunaThreadId]
  current[lunaThreadId] = {
    ...(prev !== undefined ? prev : {}),
    ...validFields,
  }
  try {
    writeRawMap(homeDir, current)
  } catch {
    // Best-effort.
  }
}

export const clearThreadSessionEntry = (
  homeDir: string,
  lunaThreadId: string,
): void => {
  if (!LUNA_THREAD_ID.test(lunaThreadId)) return
  const current = readRawMap(homeDir)
  if (!(lunaThreadId in current)) return
  delete current[lunaThreadId]
  try {
    writeRawMap(homeDir, current)
  } catch {
    // Best-effort.
  }
}
