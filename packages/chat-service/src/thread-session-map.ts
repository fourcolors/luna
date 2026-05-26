/**
 * thread-session-map — durable on-disk mapping from Luna thread id to the
 * Claude SDK's own session UUID.
 *
 * Why: the Claude Agent SDK persists conversation history per-SDK-session-id
 * as JSONL files under its config dir. When the Luna chat-server restarts,
 * the in-memory `Ref<Map>` tracking thread ↔ runtime-state is wiped, so
 * resuming a thread requires knowing which SDK session UUID it corresponds
 * to. This map closes that gap.
 *
 * Shape: a single JSON file `~/.luna/thread-session-map.json` whose top-level
 * keys are Luna thread ids (`thr_<base36>_<rand>`) and values are SDK session
 * UUIDs. Read on chat-server boot; appended every time the adapter captures
 * a new SDK session id via `onSdkSessionId`.
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

const LUNA_THREAD_ID = /^thr_[A-Za-z0-9_]{1,64}$/
const SDK_SESSION_ID = /^[A-Za-z0-9_-]{4,128}$/

export type ThreadSessionMap = Readonly<Record<string, string>>

export const threadSessionMapPath = (homeDir: string): string =>
  join(homeDir, ".luna", "thread-session-map.json")

const readRawMap = (homeDir: string): Record<string, string> => {
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
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (LUNA_THREAD_ID.test(k) && typeof v === "string" && SDK_SESSION_ID.test(v)) {
        out[k] = v
      }
    }
    return out
  } catch {
    return {}
  }
}

const writeRawMap = (homeDir: string, map: Record<string, string>): void => {
  const path = threadSessionMapPath(homeDir)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, JSON.stringify(map, null, 2) + "\n", { mode: 0o600 })
}

export const loadThreadSessionMap = (homeDir: string): ThreadSessionMap =>
  readRawMap(homeDir)

export const appendThreadSessionEntry = (
  homeDir: string,
  lunaThreadId: string,
  sdkSessionId: string,
): void => {
  if (!LUNA_THREAD_ID.test(lunaThreadId)) return
  if (!SDK_SESSION_ID.test(sdkSessionId)) return
  const current = readRawMap(homeDir)
  current[lunaThreadId] = sdkSessionId
  try {
    writeRawMap(homeDir, current)
  } catch {
    // Best-effort: if disk write fails, the live session continues. Resume
    // across restart won't work for THIS thread but won't poison others.
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
