import { describe, expect, it } from "vitest"
import {
  JournalRateLimiter,
  resolveJournalToken,
  validateJournalEntry,
} from "../src/journal-route.js"

const NOW = Date.parse("2026-10-06T12:00:00Z")

const base = (): Record<string, unknown> => ({
  v: 1,
  source: "claude-code",
  session_id: "sess-0001",
  entry_id: "entry-0001",
  repo: "luna",
  repo_path: "/Users/op/luna",
  branch: "master",
  started_at: "2026-10-06T10:00:00Z",
  ended_at: "2026-10-06T10:05:00Z",
  summary: "Did a thing.",
  host: "mac",
  client: "claude-code-cli",
})

const v = (patch: Record<string, unknown>) => validateJournalEntry({ ...base(), ...patch }, NOW)
const errs = (patch: Record<string, unknown>): string => {
  const r = v(patch)
  return r.ok ? "" : r.errors.join(" | ")
}

describe("validateJournalEntry", () => {
  it("accepts a minimal entry and drops unknown keys", () => {
    const r = v({ extra: "nope", __proto__x: 1 })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(Object.keys(r.entry)).not.toContain("extra")
      expect(r.entry.summary).toBe("Did a thing.")
    }
  })

  it("accepts every optional field", () => {
    const r = v({
      head_sha: "abc1234",
      files_changed: ["a.ts"],
      files_total: 1,
      turns: 3,
      end_reason: "crash-recovered",
      client_version: "2.1.291",
      summary_model: "haiku",
    })
    expect(r.ok).toBe(true)
  })

  it("rejects non-objects", () => {
    expect(validateJournalEntry(null, NOW).ok).toBe(false)
    expect(validateJournalEntry([], NOW).ok).toBe(false)
    expect(validateJournalEntry("x", NOW).ok).toBe(false)
  })

  it("requires v=1 and source", () => {
    expect(errs({ v: 2 })).toContain("v:")
    expect(errs({ source: "other" })).toContain("source:")
  })

  it("session_id: charset and length boundaries", () => {
    expect(errs({ session_id: "a".repeat(8) })).toBe("")
    expect(errs({ session_id: "a".repeat(7) })).toContain("session_id")
    expect(errs({ session_id: "a".repeat(128) })).toBe("")
    expect(errs({ session_id: "a".repeat(129) })).toContain("session_id")
    expect(errs({ session_id: "abc/def../x" })).toContain("session_id")
    expect(errs({ session_id: "abcdefgh ij" })).toContain("session_id")
  })

  it("entry_id boundaries", () => {
    expect(errs({ entry_id: "e".repeat(64) })).toBe("")
    expect(errs({ entry_id: "e".repeat(65) })).toContain("entry_id")
    expect(errs({ entry_id: undefined })).toContain("entry_id: required")
  })

  it("string caps at the boundary and one past", () => {
    for (const [k, max] of [["repo", 100], ["repo_path", 300], ["branch", 200], ["host", 64], ["client_version", 32], ["summary_model", 64]] as const) {
      expect(errs({ [k]: "x".repeat(max) })).toBe("")
      expect(errs({ [k]: "x".repeat(max + 1) })).toContain(k)
    }
    expect(errs({ repo: 5 })).toContain("repo")
  })

  it("head_sha format", () => {
    expect(errs({ head_sha: "a".repeat(40) })).toBe("")
    expect(errs({ head_sha: "a".repeat(41) })).toContain("head_sha")
    expect(errs({ head_sha: "ABC1234" })).toContain("head_sha")
    expect(errs({ head_sha: "abc12" })).toContain("head_sha")
  })

  it("dates: ISO only, ordered, not far future", () => {
    expect(errs({ started_at: "yesterday" })).toContain("started_at")
    expect(errs({ started_at: "Tue, 06 Oct 2026 10:00:00 GMT" })).toContain("started_at")
    expect(errs({ started_at: "2026-10-06T10:00:00.123+02:00", ended_at: "2026-10-06T10:00:00Z" })).toBe("")
    expect(errs({ ended_at: "2026-10-06T09:00:00Z" })).toContain("ended_at: must not be before")
    expect(errs({ ended_at: "2026-10-07T11:59:00Z" })).toBe("")
    expect(errs({ ended_at: "2026-10-07T12:01:00Z" })).toContain("future")
  })

  it("summary: 1-1200 chars, at most 6 lines", () => {
    expect(errs({ summary: undefined })).toContain("summary")
    expect(errs({ summary: "" })).toContain("summary")
    expect(errs({ summary: "   " })).toContain("summary")
    expect(errs({ summary: "x".repeat(1200) })).toBe("")
    expect(errs({ summary: "x".repeat(1201) })).toContain("summary")
    expect(errs({ summary: "1\n2\n3\n4\n5\n6" })).toBe("")
    expect(errs({ summary: "1\n2\n3\n4\n5\n6\n7" })).toContain("summary")
  })

  it("files_changed: at most 200 items of at most 300 chars", () => {
    expect(errs({ files_changed: Array.from({ length: 200 }, (_, i) => `f${i}`) })).toBe("")
    expect(errs({ files_changed: Array.from({ length: 201 }, (_, i) => `f${i}`) })).toContain("files_changed")
    expect(errs({ files_changed: ["x".repeat(300)] })).toBe("")
    expect(errs({ files_changed: ["x".repeat(301)] })).toContain("files_changed")
    expect(errs({ files_changed: [1] })).toContain("files_changed")
    expect(errs({ files_changed: "a.ts" })).toContain("files_changed")
  })

  it("integers and enums", () => {
    expect(errs({ turns: 10000 })).toBe("")
    expect(errs({ turns: 10001 })).toContain("turns")
    expect(errs({ turns: 1.5 })).toContain("turns")
    expect(errs({ files_total: -1 })).toContain("files_total")
    expect(errs({ end_reason: "exploded" })).toContain("end_reason")
    expect(errs({ client: "vim" })).toContain("client")
  })
})

describe("resolveJournalToken", () => {
  it("disables the route for unset or short tokens", () => {
    const warnings: string[] = []
    expect(resolveJournalToken(undefined)).toBeNull()
    expect(resolveJournalToken("")).toBeNull()
    expect(resolveJournalToken("x".repeat(31), (m) => warnings.push(m))).toBeNull()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).not.toContain("x".repeat(31))
    expect(resolveJournalToken("y".repeat(32))).toBe("y".repeat(32))
  })
})

describe("JournalRateLimiter", () => {
  it("enforces per-minute, per-day and global windows", () => {
    let t = NOW
    const rl = new JournalRateLimiter({ perMinute: 2, perDay: 3, globalPerDay: 4, now: () => t })
    expect(rl.check("a").ok).toBe(true)
    expect(rl.check("a").ok).toBe(true)
    const third = rl.check("a")
    expect(third.ok).toBe(false)
    if (!third.ok) expect(third.retryAfterSec).toBeGreaterThan(0)
    t += 60_000
    expect(rl.check("a").ok).toBe(true)
    t += 60_000
    expect(rl.check("a").ok).toBe(false)
    expect(rl.check("b").ok).toBe(true)
    expect(rl.check("c").ok).toBe(false)
    t += 86_400_000
    expect(rl.check("c").ok).toBe(true)
  })

  it("logs auth failures at most once a minute and reports the swallowed count", () => {
    let t = NOW
    const rl = new JournalRateLimiter({ now: () => t })
    expect(rl.authFailureLog()).toEqual({ log: true, suppressed: 0 })
    for (let i = 0; i < 50; i++) expect(rl.authFailureLog().log).toBe(false)
    t += 60_000
    expect(rl.authFailureLog()).toEqual({ log: true, suppressed: 50 })
    expect(rl.authFailureLog().log).toBe(false)
  })
})
