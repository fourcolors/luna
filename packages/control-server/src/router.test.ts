/**
 * Unit tests for the tRPC control router.
 *
 * Uses `appRouter.createCaller` (tRPC v11 API — the factory lives on the
 * router itself) to call procedures directly without spinning up an HTTP
 * server.  `spawnSync` is mocked via `vi.mock` so the restart test never
 * actually touches launchctl.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { appRouter } from "./router.js"

// ── Mock child_process.spawnSync so restart never calls launchctl ──────────
vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
}))

// ── Helpers ────────────────────────────────────────────────────────────────

const caller = appRouter.createCaller({})

// ── Tests ──────────────────────────────────────────────────────────────────

describe("control.status", () => {
  it("returns uptime as a non-negative number", async () => {
    const result = await caller.control.status()
    expect(typeof result.uptime).toBe("number")
    expect(result.uptime).toBeGreaterThanOrEqual(0)
  })

  it("returns startedAt as a valid ISO 8601 string", async () => {
    const result = await caller.control.status()
    expect(typeof result.startedAt).toBe("string")
    // Must parse as a finite timestamp
    const ts = new Date(result.startedAt).getTime()
    expect(Number.isFinite(ts)).toBe(true)
    expect(ts).toBeGreaterThan(0)
  })

  it("returns version as a non-empty string", async () => {
    const result = await caller.control.status()
    expect(typeof result.version).toBe("string")
    expect(result.version.length).toBeGreaterThan(0)
  })
})

describe("control.version", () => {
  it("returns { version: string }", async () => {
    const result = await caller.control.version()
    expect(typeof result.version).toBe("string")
    expect(result.version.length).toBeGreaterThan(0)
  })

  it("version matches status.version", async () => {
    const [v, s] = await Promise.all([
      caller.control.version(),
      caller.control.status(),
    ])
    expect(v.version).toBe(s.version)
  })
})

describe("control.restart", () => {
  it("returns { ok: true, message: string }", async () => {
    const result = await caller.control.restart()
    expect(result.ok).toBe(true)
    expect(typeof result.message).toBe("string")
    expect(result.message.length).toBeGreaterThan(0)
  })

  it("message contains the service label", async () => {
    const result = await caller.control.restart()
    expect(result.message).toContain("com.user.luna-chat-server")
  })

  it("spawnSync is called after the 500ms delay", async () => {
    // Isolate timer state: install fake timers, clear any pending timers from
    // previous test calls (the module-level caller shares the JS event loop).
    vi.useFakeTimers()
    vi.clearAllTimers()

    const { spawnSync } = await import("node:child_process")
    const spy = spawnSync as unknown as { mockClear: () => void }
    spy.mockClear()

    try {
      await caller.control.restart()

      // Not called yet — the timeout hasn't fired
      expect(spawnSync).not.toHaveBeenCalled()

      // Advance timers past the 500ms delay
      vi.advanceTimersByTime(600)
      expect(spawnSync).toHaveBeenCalledOnce()
      expect(spawnSync).toHaveBeenCalledWith(
        "launchctl",
        expect.arrayContaining(["kickstart", "-k"]),
        expect.objectContaining({ stdio: "ignore" }),
      )
    } finally {
      vi.useRealTimers()
    }
  })
})
