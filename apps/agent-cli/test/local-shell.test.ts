import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  executeLocalCommand,
  makeLocalShellState,
  sanitizeLocalCommandEnv,
  setLocalShellEnabled,
  truncateOutput,
} from "../src/chat/local-shell.js"

const baseCommandOptions = (cwd: string) => ({
  request: {
    requestId: "req-1",
    threadId: "thread-1",
    command: "printf hello",
  },
  cwd,
  timeoutMs: 2_000,
  maxOutputBytes: 64 * 1024,
  approve: async () => true,
})

const waitFor = async <T>(promise: Promise<T>, timeoutMs = 1_000): Promise<T> => {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error("timed out waiting")), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

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

  it("tracks omitted bytes for output larger than the retained stream buffer", async () => {
    const result = await executeLocalCommand({
      ...baseCommandOptions(process.cwd()),
      request: {
        ...baseCommandOptions(process.cwd()).request,
        command: "head -c 100000 /dev/zero | tr '\\0' a",
      },
      maxOutputBytes: 4,
    })

    expect(result.stdout).toBe("aaaa\n[truncated 99996 bytes]")
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
    const result = await executeLocalCommand({
      ...baseCommandOptions(cwd),
      request: {
        ...baseCommandOptions(cwd).request,
        command: `touch ${deniedPath}`,
        cwd,
      },
      approve,
    })

    expect(approve).toHaveBeenCalledWith(`touch ${deniedPath}`)
    expect(result).toEqual({
      type: "local-shell-result",
      requestId: "req-1",
      threadId: "thread-1",
      approved: false,
      exitCode: null,
      stdout: "",
      stderr: "denied by user",
      durationMs: expect.any(Number),
      timedOut: false,
    })
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(existsSync(deniedPath)).toBe(false)
  })

  it("captures stdout for successful commands", async () => {
    const result = await executeLocalCommand({
      ...baseCommandOptions(cwd),
      request: {
        ...baseCommandOptions(cwd).request,
        command: "printf hello",
        cwd,
      },
    })

    expect(result.type).toBe("local-shell-result")
    expect(result.requestId).toBe("req-1")
    expect(result.threadId).toBe("thread-1")
    expect(result.approved).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("hello")
    expect(result.stderr).toBe("")
    expect(result.timedOut).toBe(false)
  })

  it("does not expose Luna token environment to local commands", async () => {
    const result = await executeLocalCommand({
      ...baseCommandOptions(cwd),
      request: {
        ...baseCommandOptions(cwd).request,
        command: "printf \"${LUNA_UI_WS_TOKEN:-missing}\"",
        cwd,
      },
      env: sanitizeLocalCommandEnv({
        PATH: process.env["PATH"],
        LUNA_UI_WS_TOKEN: "secret-token-value",
      }),
    })

    expect(result.approved).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("missing")
  })

  it("preserves non-zero exit codes", async () => {
    const result = await executeLocalCommand({
      ...baseCommandOptions(cwd),
      request: {
        ...baseCommandOptions(cwd).request,
        command: "printf failure >&2; exit 7",
        cwd,
      },
    })

    expect(result.approved).toBe(true)
    expect(result.exitCode).toBe(7)
    expect(result.stdout).toBe("")
    expect(result.stderr).toBe("failure")
    expect(result.timedOut).toBe(false)
  })

  it("returns timedOut and terminates long-running commands", async () => {
    const startedAt = Date.now()
    const result = await executeLocalCommand({
      ...baseCommandOptions(cwd),
      request: {
        ...baseCommandOptions(cwd).request,
        command: "sleep 2",
        cwd,
        timeoutMs: 50,
      },
    })

    expect(Date.now() - startedAt).toBeLessThan(1_500)
    expect(result.approved).toBe(true)
    expect(result.exitCode).toBeNull()
    expect(result.stdout).toBe("")
    expect(result.stderr).toBe("")
    expect(result.timedOut).toBe(true)
  })

  it("resolves after a bounded grace period when a command traps TERM", async () => {
    const startedAt = Date.now()
    const result = await executeLocalCommand({
      ...baseCommandOptions(cwd),
      request: {
        ...baseCommandOptions(cwd).request,
        command: "trap '' TERM; sleep 10",
        cwd,
        timeoutMs: 50,
      },
    })

    expect(Date.now() - startedAt).toBeLessThan(1_500)
    expect(result.approved).toBe(true)
    expect(result.exitCode).toBeNull()
    expect(result.timedOut).toBe(true)
  })

  it("uses per-request cwd and timeout overrides", async () => {
    const result = await executeLocalCommand({
      request: {
        requestId: "req-2",
        threadId: "thread-2",
        command: "pwd",
        cwd: "/",
        timeoutMs: 1_000,
      },
      cwd,
      timeoutMs: 30_000,
      maxOutputBytes: 64 * 1024,
      approve: async () => true,
    })

    expect(result.requestId).toBe("req-2")
    expect(result.threadId).toBe("thread-2")
    expect(result.stdout.trim()).toBe("/")
  })

  it("aborts an approved running command promptly", async () => {
    const controller = new AbortController()
    const startedAt = Date.now()
    const pending = executeLocalCommand({
      ...baseCommandOptions(cwd),
      request: {
        ...baseCommandOptions(cwd).request,
        command: "sleep 5",
        cwd,
      },
      signal: controller.signal,
    })

    setTimeout(() => controller.abort(), 50)
    const result = await waitFor(pending, 500)

    expect(Date.now() - startedAt).toBeLessThan(1_000)
    expect(result.approved).toBe(true)
    expect(result.exitCode).toBeNull()
    expect(result.timedOut).toBe(true)
    expect(result.stderr).toContain("aborted")
  })
})
