/**
 * thread-session-map — durable on-disk mapping from Luna thread id to the
 * Claude SDK's own session UUID, plus optional model and effort overrides.
 *
 * Why: the Claude Agent SDK persists conversation history per-SDK-session-id
 * as JSONL files under its config dir. When the Luna chat-server restarts,
 * the in-memory `Ref<Map>` tracking thread ↔ runtime-state is wiped, so
 * resuming a thread requires knowing which SDK session UUID it corresponds
 * to. This map closes that gap.
 *
 * Shape: a single JSON file `~/.luna/thread-session-map.json` whose top-level
 * keys are Luna thread ids (`thr_<base36>_<rand>`) and values are EITHER:
 *   - A bare string (legacy format) — the SDK session UUID.
 *   - An object `{sid: string, model?: string, effort?: string}` — the SDK
 *     session UUID plus the thread's last-known model and effort selections.
 *     The recovery path (subscribe cache-miss) rebuilds createThread with
 *     these so a recovered thread uses the right model + effort.
 *
 * Best-effort by design — disk failures must not break a live chat session.
 * Schema is intentionally tiny so corruption recovery is "delete the file
 * and the next chat round repopulates."
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { isEffort } from "./effort.js"

const LUNA_THREAD_ID = /^thr_[A-Za-z0-9_]{1,64}$/
const SDK_SESSION_ID = /^[A-Za-z0-9_-]{4,128}$/
/** Loose model id pattern — must be a non-empty string with no path traversal. */
const MODEL_ID = /^[A-Za-z0-9][\w\-./]{0,127}$/

/** Per-thread config persisted alongside the SDK session id. */
export interface ThreadConfig {
  /** The Claude SDK session UUID. */
  readonly sid: string
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
  // New: object with at least a `sid` field
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    const obj = v as Record<string, unknown>
    if (typeof obj["sid"] !== "string" || !SDK_SESSION_ID.test(obj["sid"])) {
      return undefined
    }
    const entry: ThreadConfig = { sid: obj["sid"] }
    if (typeof obj["model"] === "string" && MODEL_ID.test(obj["model"])) {
      Object.assign(entry, { model: obj["model"] })
    }
    if (isEffort(obj["effort"])) {
      Object.assign(entry, { effort: obj["effort"] })
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
 * No-ops if the thread has no existing entry (the SDK session id must be
 * appended first via appendThreadSessionEntry before calling this).
 */
export const appendThreadConfigEntry = (
  homeDir: string,
  lunaThreadId: string,
  config: { model?: string; effort?: string },
): void => {
  if (!LUNA_THREAD_ID.test(lunaThreadId)) return
  const current = readRawMap(homeDir)
  const prev = current[lunaThreadId]
  if (prev === undefined) return // no entry to merge into
  const updated: ThreadConfig = {
    ...prev,
    ...(config.model !== undefined && MODEL_ID.test(config.model)
      ? { model: config.model }
      : {}),
    ...(config.effort !== undefined && isEffort(config.effort)
      ? { effort: config.effort }
      : {}),
  }
  current[lunaThreadId] = updated
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
