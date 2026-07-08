/**
 * Unit tests for the tRPC control router.
 *
 * Uses `appRouter.createCaller` (tRPC v11 API — the factory lives on the
 * router itself) to call procedures directly without spinning up an HTTP
 * server.  `spawnSync` is mocked via `vi.mock` so the restart test never
 * actually touches launchctl.
 */
import { afterEach, describe, it, expect, vi } from "vitest"
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
  // The handler genuinely branches on process.platform (darwin → launchctl,
  // else → SIGTERM under the supervisor), so every test pins the platform
  // explicitly — the suite must pass identically on macOS dev and Linux CI.
  const realPlatform = process.platform
  const setPlatform = (value: string): void => {
    Object.defineProperty(process, "platform", { value, configurable: true })
  }

  afterEach(() => {
    setPlatform(realPlatform)
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  const getSpawnMock = async () => {
    const { spawnSync } = await import("node:child_process")
    const mock = spawnSync as unknown as ReturnType<typeof vi.fn>
    mock.mockClear()
    mock.mockReturnValue({ status: 0, stdout: "", stderr: "" })
    return mock
  }

  it("darwin: returns ok with the launchd label and kickstarts after the delay", async () => {
    setPlatform("darwin")
    vi.useFakeTimers()
    vi.clearAllTimers()
    const spawnMock = await getSpawnMock()

    const result = await caller.control.restart()
    expect(result.ok).toBe(true)
    expect(result.message).toContain("com.user.luna-chat-server")

    // Not called yet — the timeout hasn't fired
    expect(spawnMock).not.toHaveBeenCalled()
    vi.advanceTimersByTime(600)
    expect(spawnMock).toHaveBeenCalledOnce()
    expect(spawnMock).toHaveBeenCalledWith(
      "launchctl",
      expect.arrayContaining(["kickstart", "-k"]),
      expect.objectContaining({ stdio: "ignore" }),
    )
  })

  it("darwin: logs instead of swallowing when kickstart fails", async () => {
    setPlatform("darwin")
    vi.useFakeTimers()
    vi.clearAllTimers()
    const spawnMock = await getSpawnMock()
    spawnMock.mockReturnValue({ status: 1, stdout: "", stderr: "" })
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    await caller.control.restart()
    vi.advanceTimersByTime(600)

    expect(errorSpy).toHaveBeenCalledOnce()
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain(
      "launchctl kickstart failed",
    )
  })

  it("linux (supervised): returns ok, SIGTERMs itself after the delay, and never touches launchctl", async () => {
    setPlatform("linux")
    vi.stubEnv("INVOCATION_ID", "abc-123") // systemd sets this for every service
    vi.useFakeTimers()
    vi.clearAllTimers()
    const spawnMock = await getSpawnMock()
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true)
    vi.spyOn(console, "log").mockImplementation(() => {})

    const result = await caller.control.restart()
    expect(result.ok).toBe(true)
    expect(result.message).toContain("SIGTERM")
    expect(result.message).not.toContain("launchctl")

    // Not fired yet — the HTTP response must flush first.
    expect(killSpy).not.toHaveBeenCalled()
    vi.advanceTimersByTime(600)
    expect(killSpy).toHaveBeenCalledOnce()
    expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGTERM")
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it("linux (unsupervised): refuses the restart instead of committing SIGTERM suicide", async () => {
    setPlatform("linux")
    vi.stubEnv("INVOCATION_ID", "")
    vi.stubEnv("NOTIFY_SOCKET", "")
    vi.useFakeTimers()
    vi.clearAllTimers()
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true)
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    const result = await caller.control.restart()
    expect(result.ok).toBe(false)
    expect(result.message).toContain("no supervisor")

    vi.advanceTimersByTime(600)
    expect(killSpy).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledOnce()
  })

  it("darwin: logs the spawn-level error arm (launchctl missing entirely)", async () => {
    setPlatform("darwin")
    vi.useFakeTimers()
    vi.clearAllTimers()
    const spawnMock = await getSpawnMock()
    spawnMock.mockReturnValue({
      status: null,
      error: new Error("spawnSync launchctl ENOENT"),
    })
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    await caller.control.restart()
    vi.advanceTimersByTime(600)

    expect(errorSpy).toHaveBeenCalledOnce()
    const logged = String(errorSpy.mock.calls[0]?.[0])
    expect(logged).toContain("ENOENT")
    expect(logged).toContain("launchd job installed")
  })
})
