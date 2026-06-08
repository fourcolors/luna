/**
 * agent-memory-loader — unit tests for Luna's main-thread MEMORY.md loader.
 *
 * Mirrors the dna-loader test pattern: isolate path resolution via
 * LUNA_HOME, exercise the cap, the absent-file path, the block builder.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  buildMainMemoryBlock,
  capContent,
  loadMainMemory,
  MAIN_MEMORY_CAP_BYTES,
  MAIN_MEMORY_CAP_LINES,
  resolveMainMemoryPath,
} from "../agent-memory-loader.js"

let lunaHome: string
let prevHome: string | undefined

beforeEach(() => {
  lunaHome = mkdtempSync(join(tmpdir(), "luna-home-mem-"))
  prevHome = process.env.LUNA_HOME
  process.env.LUNA_HOME = lunaHome
})

afterEach(() => {
  if (prevHome === undefined) delete process.env.LUNA_HOME
  else process.env.LUNA_HOME = prevHome
  rmSync(lunaHome, { recursive: true, force: true })
})

const writeMem = (body: string) => {
  const dir = join(lunaHome, "agent-memory", "luna-main")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "MEMORY.md"), body, "utf8")
}

describe("resolveMainMemoryPath", () => {
  it("honours LUNA_HOME", () => {
    expect(resolveMainMemoryPath()).toBe(
      join(lunaHome, "agent-memory", "luna-main", "MEMORY.md"),
    )
  })

  it("explicit homeOverride wins over env", () => {
    expect(resolveMainMemoryPath("/x")).toBe(
      "/x/agent-memory/luna-main/MEMORY.md",
    )
  })
})

describe("loadMainMemory", () => {
  it("returns null when the file is absent", () => {
    expect(loadMainMemory()).toBeNull()
  })

  it("returns empty string when the file exists but is empty", () => {
    writeMem("")
    expect(loadMainMemory()).toBe("")
  })

  it("returns the file content when present", () => {
    writeMem("# Hello\n* 🔴 first observation")
    expect(loadMainMemory()).toBe("# Hello\n* 🔴 first observation")
  })

  it("caps to 200 lines", () => {
    const lines = Array.from({ length: 350 }, (_, i) => `line${i}`)
    writeMem(lines.join("\n"))
    const got = loadMainMemory()!
    expect(got.split("\n").length).toBe(MAIN_MEMORY_CAP_LINES)
    expect(got).toContain("line0")
    expect(got).toContain(`line${MAIN_MEMORY_CAP_LINES - 1}`)
    expect(got).not.toContain("line200")
    expect(got).not.toContain("line349")
  })

  it("caps to byte budget when individual lines are huge", () => {
    // 50 lines of 1024 bytes each ⇒ 51,200 bytes ⇒ over the 25 KB cap.
    // After line cap (200 lines, kept all), byte cap should kick in and
    // halve down until under MAIN_MEMORY_CAP_BYTES.
    const fatLine = "x".repeat(1024)
    const lines = Array.from({ length: 50 }, () => fatLine)
    writeMem(lines.join("\n"))
    const got = loadMainMemory()!
    expect(Buffer.byteLength(got, "utf8")).toBeLessThanOrEqual(
      MAIN_MEMORY_CAP_BYTES,
    )
  })
})

describe("capContent", () => {
  it("no-op when under both caps", () => {
    expect(capContent("a\nb\nc")).toBe("a\nb\nc")
  })

  it("respects multi-byte UTF-8 in byte cap accounting", () => {
    // Emoji is 4 bytes in UTF-8. Build content that's under the line cap
    // but right at the byte cap boundary.
    const emojiLine = "🔴".repeat(1024) // 4 KB per line
    const lines = Array.from({ length: 10 }, () => emojiLine) // 40 KB total
    const got = capContent(lines.join("\n"))
    expect(Buffer.byteLength(got, "utf8")).toBeLessThanOrEqual(
      MAIN_MEMORY_CAP_BYTES,
    )
  })
})

describe("buildMainMemoryBlock", () => {
  it("returns null for null content", () => {
    expect(buildMainMemoryBlock(null)).toBeNull()
  })

  it("returns null for whitespace-only content (avoid empty header noise)", () => {
    expect(buildMainMemoryBlock("   \n\n  ")).toBeNull()
  })

  it("includes the SKILL.md pointer + the memory path + the content", () => {
    const block = buildMainMemoryBlock(
      "* 🔴 a real observation",
      "/custom/path/MEMORY.md",
    )!
    expect(block).toContain("Your observational memory")
    expect(block).toContain("subagent-memory/SKILL.md")
    expect(block).toContain("/custom/path/MEMORY.md")
    expect(block).toContain("a real observation")
    expect(block).toContain("🔴🟡🟢✅")
  })
})
