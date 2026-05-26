/**
 * thread-session-map — persists `lunaThreadId → sdkSessionId` so resume
 * across chat-server restarts is possible.
 *
 * The SDK persists conversation history per-sdk-session-id as JSONL under
 * its config dir; what's missing is Luna remembering which JSONL belongs
 * to which Luna thread after a restart. This map closes that gap.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  appendThreadSessionEntry,
  clearThreadSessionEntry,
  loadThreadSessionMap,
  threadSessionMapPath,
} from "../src/thread-session-map.js"

describe("thread-session-map", () => {
  it("round-trips a single entry through disk", () => {
    const home = mkdtempSync(join(tmpdir(), "luna-tsmap-"))
    try {
      appendThreadSessionEntry(home, "thr_abc", "sdk-uuid-xyz")
      expect(existsSync(threadSessionMapPath(home))).toBe(true)
      const map = loadThreadSessionMap(home)
      expect(map["thr_abc"]).toBe("sdk-uuid-xyz")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("preserves prior entries when appending new ones", () => {
    const home = mkdtempSync(join(tmpdir(), "luna-tsmap-"))
    try {
      appendThreadSessionEntry(home, "thr_one", "sdk-1")
      appendThreadSessionEntry(home, "thr_two", "sdk-2")
      appendThreadSessionEntry(home, "thr_three", "sdk-3")
      const map = loadThreadSessionMap(home)
      expect(map).toEqual({
        thr_one: "sdk-1",
        thr_two: "sdk-2",
        thr_three: "sdk-3",
      })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("updates the sdkSessionId when the same lunaThreadId is appended twice", () => {
    const home = mkdtempSync(join(tmpdir(), "luna-tsmap-"))
    try {
      appendThreadSessionEntry(home, "thr_abc", "sdk-old")
      appendThreadSessionEntry(home, "thr_abc", "sdk-new")
      expect(loadThreadSessionMap(home)["thr_abc"]).toBe("sdk-new")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("returns an empty map when the file does not exist", () => {
    const home = mkdtempSync(join(tmpdir(), "luna-tsmap-"))
    try {
      expect(loadThreadSessionMap(home)).toEqual({})
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("clearThreadSessionEntry removes an entry without disturbing others", () => {
    const home = mkdtempSync(join(tmpdir(), "luna-tsmap-"))
    try {
      appendThreadSessionEntry(home, "thr_keep", "sdk-keep")
      appendThreadSessionEntry(home, "thr_drop", "sdk-drop")
      clearThreadSessionEntry(home, "thr_drop")
      const map = loadThreadSessionMap(home)
      expect(map).toEqual({ thr_keep: "sdk-keep" })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("rejects malformed JSON without throwing", () => {
    const home = mkdtempSync(join(tmpdir(), "luna-tsmap-"))
    try {
      const path = threadSessionMapPath(home)
      // Force-write garbage; loader must treat it as empty.
      const fs = require("node:fs") as typeof import("node:fs")
      fs.mkdirSync(join(home, ".luna"), { recursive: true })
      fs.writeFileSync(path, "{ not valid json", { mode: 0o600 })
      expect(loadThreadSessionMap(home)).toEqual({})
      void readFileSync
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("ignores entries with malformed ids", () => {
    const home = mkdtempSync(join(tmpdir(), "luna-tsmap-"))
    try {
      appendThreadSessionEntry(home, "thr_ok", "sdk-ok")
      appendThreadSessionEntry(home, "../escape", "sdk-bad") // bad lunaThreadId
      appendThreadSessionEntry(home, "thr_other", "") // empty sdkId
      const map = loadThreadSessionMap(home)
      expect(map).toEqual({ thr_ok: "sdk-ok" })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
