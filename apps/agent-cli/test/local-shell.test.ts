import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  executeLocalCommand,
  makeLocalShellState,
  setLocalShellEnabled,
  truncateOutput,
} from "../src/chat/local-shell.js"

describe("local shell state", () => {
  it("starts disabled and toggles enabled without mutating the original", () => {
    const cwd = "/tmp/luna"
    const state = makeLocalShellState({ enabled: false, cwd })
    expect(state.enabled).toBe(false)
    expect(state.cwd).toBe(cwd)
    expect(state.clientId).toMatch(/^cli_/)
    expect(state.platform).toBe(process.platform)

    const enabled = setLocalShellEnabled(state, true)
    expect(enabled.enabled).toBe(true)
    expect(enabled.cwd).toBe(cwd)
    expect(enabled.clientId).toBe(state.clientId)
    expect(enabled.platform).toBe(state.platform)
    expect(state.enabled).toBe(false)
  })
})

describe("truncateOutput", () => {
  it("adds a byte-count marker when output is truncated", () => {
    expect(truncateOutput("abcdef", 4)).toBe("abcd\n[truncated 2 bytes]")
  })

  it("leaves output unchanged when within the limit", () => {
    expect(truncateOutput("abcd", 4)).toBe("abcd")
  })
})

describe("executeLocalCommand", () => {
  let cwd: string

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "luna-local-shell-"))
  })

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
  })

  it("returns denied without running the command", async () => {
    const approve = vi.fn(() => false)
    const deniedPath = join(cwd, "denied-command-ran")
    const result = await executeLocalCommand(
      { command: `touch ${deniedPath}` },
      { cwd, approve },
    )

    expect(approve).toHaveBeenCalledWith(`touch ${deniedPath}`)
    expect(result).toEqual({
      command: `touch ${deniedPath}`,
      approved: false,
      exitCode: null,
      stdout: "",
      stderr: "denied by user",
      timedOut: false,
    })
    expect(existsSync(deniedPath)).toBe(false)
  })

  it("captures stdout for successful commands", async () => {
    const result = await executeLocalCommand(
      { command: "printf hello" },
      { cwd, approve: () => true },
    )

    expect(result.approved).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("hello")
    expect(result.stderr).toBe("")
    expect(result.timedOut).toBe(false)
  })

  it("preserves non-zero exit codes", async () => {
    const result = await executeLocalCommand(
      { command: "printf failure >&2; exit 7" },
      { cwd, approve: () => true },
    )

    expect(result.approved).toBe(true)
    expect(result.exitCode).toBe(7)
    expect(result.stdout).toBe("")
    expect(result.stderr).toBe("failure")
    expect(result.timedOut).toBe(false)
  })

  it("returns timedOut and terminates long-running commands", async () => {
    const startedAt = Date.now()
    const result = await executeLocalCommand(
      { command: "sleep 2" },
      { cwd, approve: () => true, timeoutMs: 50 },
    )

    expect(Date.now() - startedAt).toBeLessThan(1_500)
    expect(result.approved).toBe(true)
    expect(result.exitCode).toBeNull()
    expect(result.stdout).toBe("")
    expect(result.stderr).toBe("")
    expect(result.timedOut).toBe(true)
  })
})
