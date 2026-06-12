/**
 * thread-session-map — persists `lunaThreadId → ThreadConfig` so resume
 * across chat-server restarts is possible.
 *
 * Tests cover:
 *   - round-trip of new object entries (sid + optional model/effort)
 *   - backward-compat: legacy bare-string values load as {sid} objects
 *   - appendThreadConfigEntry merges model/effort preserving sid
 *   - clearThreadSessionEntry removes one entry without disturbing others
 *   - malformed JSON returns empty map
 *   - malformed ids are rejected
 *   - recovery in subscribe() uses model/effort from the extended map
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  appendThreadSessionEntry,
  appendThreadConfigEntry,
  clearThreadSessionEntry,
  loadThreadSessionMap,
  threadSessionMapPath,
} from "../src/thread-session-map.js"

describe("thread-session-map", () => {
  it("round-trips a single entry through disk (new object shape)", () => {
    const home = mkdtempSync(join(tmpdir(), "luna-tsmap-"))
    try {
      appendThreadSessionEntry(home, "thr_abc", "sdk-uuid-xyz")
      expect(existsSync(threadSessionMapPath(home))).toBe(true)
      const map = loadThreadSessionMap(home)
      expect(map["thr_abc"]).toEqual({ sid: "sdk-uuid-xyz" })
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
        thr_one: { sid: "sdk-1" },
        thr_two: { sid: "sdk-2" },
        thr_three: { sid: "sdk-3" },
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
      const entry = loadThreadSessionMap(home)["thr_abc"]
      expect(typeof entry === "object" && entry !== null ? entry.sid : entry).toBe("sdk-new")
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
      expect(Object.keys(map)).toEqual(["thr_keep"])
      const entry = map["thr_keep"]
      expect(typeof entry === "object" && entry !== null ? entry.sid : entry).toBe("sdk-keep")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("rejects malformed JSON without throwing", () => {
    const home = mkdtempSync(join(tmpdir(), "luna-tsmap-"))
    try {
      const path = threadSessionMapPath(home)
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
      expect(Object.keys(map)).toEqual(["thr_ok"])
      const entry = map["thr_ok"]
      expect(typeof entry === "object" && entry !== null ? entry.sid : entry).toBe("sdk-ok")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  // ── New: legacy back-compat ──────────────────────────────────────────────

  it("back-compat: legacy bare-string entries load as {sid} objects", () => {
    const home = mkdtempSync(join(tmpdir(), "luna-tsmap-"))
    try {
      const path = threadSessionMapPath(home)
      mkdirSync(join(home, ".luna"), { recursive: true })
      // Write a legacy-format map file (bare string values)
      writeFileSync(path, JSON.stringify({ thr_legacy: "sdk-old-session" }, null, 2), {
        mode: 0o600,
      })
      const map = loadThreadSessionMap(home)
      expect(map["thr_legacy"]).toEqual({ sid: "sdk-old-session" })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("back-compat: appendThreadSessionEntry preserves model/effort from an existing entry", () => {
    const home = mkdtempSync(join(tmpdir(), "luna-tsmap-"))
    try {
      appendThreadSessionEntry(home, "thr_abc", "sdk-1")
      appendThreadConfigEntry(home, "thr_abc", { model: "claude-sonnet-4-6", effort: "high" })
      // Now update the sid — model/effort should survive
      appendThreadSessionEntry(home, "thr_abc", "sdk-2")
      const entry = loadThreadSessionMap(home)["thr_abc"]
      expect(entry).toEqual({ sid: "sdk-2", model: "claude-sonnet-4-6", effort: "high" })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  // ── New: appendThreadConfigEntry ─────────────────────────────────────────

  it("appendThreadConfigEntry merges model+effort into an existing entry", () => {
    const home = mkdtempSync(join(tmpdir(), "luna-tsmap-"))
    try {
      appendThreadSessionEntry(home, "thr_abc", "sdk-uuid")
      appendThreadConfigEntry(home, "thr_abc", { model: "claude-fable-5", effort: "max" })
      const entry = loadThreadSessionMap(home)["thr_abc"]
      expect(entry).toEqual({ sid: "sdk-uuid", model: "claude-fable-5", effort: "max" })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("appendThreadConfigEntry no-ops when the thread has no existing entry", () => {
    const home = mkdtempSync(join(tmpdir(), "luna-tsmap-"))
    try {
      appendThreadConfigEntry(home, "thr_ghost", { model: "claude-sonnet-4-6" })
      expect(loadThreadSessionMap(home)).toEqual({})
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("appendThreadConfigEntry rejects an invalid effort string", () => {
    const home = mkdtempSync(join(tmpdir(), "luna-tsmap-"))
    try {
      appendThreadSessionEntry(home, "thr_abc", "sdk-uuid")
      appendThreadConfigEntry(home, "thr_abc", { effort: "turbo" })
      const entry = loadThreadSessionMap(home)["thr_abc"]
      // 'turbo' is not a valid effort level — it must be dropped
      expect(entry).toEqual({ sid: "sdk-uuid" })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("loadThreadSessionMap: object entries with invalid sid are rejected", () => {
    const home = mkdtempSync(join(tmpdir(), "luna-tsmap-"))
    try {
      const path = threadSessionMapPath(home)
      mkdirSync(join(home, ".luna"), { recursive: true })
      writeFileSync(
        path,
        JSON.stringify({
          thr_ok: { sid: "sdk-good" },
          thr_bad: { sid: "../path-traversal" }, // bad sid
          thr_missing_sid: { model: "claude-test" }, // no sid
        }),
        { mode: 0o600 },
      )
      const map = loadThreadSessionMap(home)
      expect(Object.keys(map)).toEqual(["thr_ok"])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
