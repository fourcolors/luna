import { afterAll, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  applyClaudeExecutablePreflight,
  detectClaudeExecutable,
  resolveClaudeExecutable,
} from "../claude-executable.js"

describe("resolveClaudeExecutable", () => {
  const yes = () => true
  const no = () => false

  it("keeps a pin that is executable (source 'env'), never calling detect", () => {
    let detectCalls = 0
    const res = resolveClaudeExecutable({
      envValue: "/usr/local/bin/claude",
      isExecutable: yes,
      detect: () => {
        detectCalls++
        return "/should/not/be/used"
      },
    })
    expect(res).toEqual({ path: "/usr/local/bin/claude", source: "env" })
    expect(detectCalls).toBe(0)
  })

  it("trims the pin before testing executability", () => {
    const seen: string[] = []
    const res = resolveClaudeExecutable({
      envValue: "  /usr/local/bin/claude  ",
      isExecutable: (p) => {
        seen.push(p)
        return true
      },
      detect: () => null,
    })
    expect(res.path).toBe("/usr/local/bin/claude")
    expect(seen).toEqual(["/usr/local/bin/claude"])
  })

  it("detects when the pin is missing/non-executable (the incident case)", () => {
    const res = resolveClaudeExecutable({
      envValue: "/usr/local/bin/claude", // present in env but file is gone
      isExecutable: no,
      detect: () => "/root/luna/node_modules/.../claude-agent-sdk-linux-x64/claude",
    })
    expect(res).toEqual({
      path: "/root/luna/node_modules/.../claude-agent-sdk-linux-x64/claude",
      source: "detected",
      previous: "/usr/local/bin/claude",
    })
  })

  it("detects when the pin is unset (no previous recorded)", () => {
    const res = resolveClaudeExecutable({
      envValue: undefined,
      isExecutable: no,
      detect: () => "/detected/claude",
    })
    expect(res).toEqual({ path: "/detected/claude", source: "detected" })
    expect(res.previous).toBeUndefined()
  })

  it("returns source 'none' when the pin is broken and nothing is detected", () => {
    const res = resolveClaudeExecutable({
      envValue: "/usr/local/bin/claude",
      isExecutable: no,
      detect: () => null,
    })
    expect(res).toEqual({
      path: null,
      source: "none",
      previous: "/usr/local/bin/claude",
    })
  })

  it("treats a blank pin as unset", () => {
    const res = resolveClaudeExecutable({
      envValue: "   ",
      isExecutable: () => {
        throw new Error("must not test a blank pin")
      },
      detect: () => "/detected/claude",
    })
    expect(res).toEqual({ path: "/detected/claude", source: "detected" })
  })
})

describe("detectClaudeExecutable", () => {
  it("prefers the version-matched glibc package binary when executable", () => {
    const got = detectClaudeExecutable(
      (p) => p === "/pkg/claude",
      { PATH: "/bin" },
      "/nowhere",
      () => "/pkg/claude",
    )
    expect(got).toBe("/pkg/claude")
  })

  it("falls back to PATH when the package bin is absent/non-executable", () => {
    const got = detectClaudeExecutable(
      (p) => p === "/fake/bin/claude",
      { PATH: ["/empty", "/fake/bin"].join(":") },
      "/nonexistent-cwd-xyz",
      () => null, // no glibc package resolvable (e.g. darwin dev box)
    )
    expect(got).toBe("/fake/bin/claude")
  })

  it("returns null when no candidate is executable anywhere", () => {
    const got = detectClaudeExecutable(
      () => false,
      { PATH: "/a:/b" },
      "/nonexistent-cwd-xyz",
      () => null,
    )
    expect(got).toBeNull()
  })

  describe("node_modules bun-store scan (real dirs, injected executability)", () => {
    const root = mkdtempSync(join(tmpdir(), "luna-claude-exe-"))
    const bun = join(root, "node_modules", ".bun")
    const glibcRel = join(
      "node_modules",
      "@anthropic-ai",
      "claude-agent-sdk-linux-x64",
      "claude",
    )
    for (const e of [
      "@anthropic-ai+claude-agent-sdk-linux-x64@0.3.167",
      "@anthropic-ai+claude-agent-sdk-linux-x64@0.3.175",
      "@anthropic-ai+claude-agent-sdk-linux-x64-musl@0.3.175", // must be ignored
    ]) {
      mkdirSync(join(bun, e, "node_modules", "@anthropic-ai"), { recursive: true })
    }
    afterAll(() => rmSync(root, { recursive: true, force: true }))

    it("picks the newest glibc store entry and never the -musl twin", () => {
      const muslPath = join(
        bun,
        "@anthropic-ai+claude-agent-sdk-linux-x64-musl@0.3.175",
        glibcRel,
      )
      const got = detectClaudeExecutable(
        // only the bun-store glibc binaries "exist" (no hoisted copy here), so
        // this exercises the .bun scan + newest-wins + musl-exclusion.
        (p) => p.includes("/.bun/") && p.endsWith("claude-agent-sdk-linux-x64/claude"),
        { PATH: "" },
        root,
        () => null,
      )
      expect(got).toBe(
        join(bun, "@anthropic-ai+claude-agent-sdk-linux-x64@0.3.175", glibcRel),
      )
      expect(got).not.toBe(muslPath)
    })
  })
})

describe("applyClaudeExecutablePreflight", () => {
  it("leaves a healthy pin untouched and logs nothing", () => {
    const env: NodeJS.ProcessEnv = {
      LUNA_CLAUDE_CODE_EXECUTABLE: "/usr/local/bin/claude",
    }
    const logs: Array<[string, string]> = []
    const res = applyClaudeExecutablePreflight(env, {
      isExecutable: () => true,
      detect: () => "/should/not/be/used",
      log: (lvl, msg) => logs.push([lvl, msg]),
    })
    expect(res.source).toBe("env")
    expect(env.LUNA_CLAUDE_CODE_EXECUTABLE).toBe("/usr/local/bin/claude")
    expect(logs).toEqual([])
  })

  it("rewrites a broken pin to the detected binary and WARNs", () => {
    const env: NodeJS.ProcessEnv = {
      LUNA_CLAUDE_CODE_EXECUTABLE: "/usr/local/bin/claude", // gone
    }
    const logs: Array<[string, string]> = []
    const res = applyClaudeExecutablePreflight(env, {
      isExecutable: () => false,
      detect: () => "/root/luna/node_modules/glibc/claude",
      log: (lvl, msg) => logs.push([lvl, msg]),
    })
    expect(res.source).toBe("detected")
    expect(env.LUNA_CLAUDE_CODE_EXECUTABLE).toBe(
      "/root/luna/node_modules/glibc/claude",
    )
    expect(logs).toHaveLength(1)
    expect(logs[0]?.[0]).toBe("warn")
    expect(logs[0]?.[1]).toContain("auto-detected")
    expect(logs[0]?.[1]).toContain("/usr/local/bin/claude") // the replaced pin
  })

  it("ERRORs (loud) and leaves env as-is when nothing is found", () => {
    const env: NodeJS.ProcessEnv = {
      LUNA_CLAUDE_CODE_EXECUTABLE: "/usr/local/bin/claude",
    }
    const logs: Array<[string, string]> = []
    const res = applyClaudeExecutablePreflight(env, {
      isExecutable: () => false,
      detect: () => null,
      log: (lvl, msg) => logs.push([lvl, msg]),
    })
    expect(res.source).toBe("none")
    expect(env.LUNA_CLAUDE_CODE_EXECUTABLE).toBe("/usr/local/bin/claude")
    expect(logs).toHaveLength(1)
    expect(logs[0]?.[0]).toBe("error")
    expect(logs[0]?.[1]).toContain("new chat threads will fail")
  })
})
