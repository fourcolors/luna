import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  makeSpawnNotifySender,
  notifyStopping,
  resolveProbeHost,
  resolveWatchdogIntervalMs,
  sdNotifyActive,
  shouldBeat,
  startSdWatchdog,
} from "./sd-notify.js"

describe("resolveWatchdogIntervalMs", () => {
  it("defaults to 30s without WATCHDOG_USEC", () => {
    expect(resolveWatchdogIntervalMs({})).toBe(30_000)
    expect(resolveWatchdogIntervalMs({ WATCHDOG_USEC: "" })).toBe(30_000)
    expect(resolveWatchdogIntervalMs({ WATCHDOG_USEC: "bogus" })).toBe(30_000)
    expect(resolveWatchdogIntervalMs({ WATCHDOG_USEC: "-5" })).toBe(30_000)
  })

  it("beats at a third of the budget (WatchdogSec=90 → 30s)", () => {
    expect(resolveWatchdogIntervalMs({ WATCHDOG_USEC: "90000000" })).toBe(
      30_000,
    )
  })

  it("clamps to [5s, 30s]", () => {
    // WatchdogSec=6 → third = 2s → clamped up to 5s
    expect(resolveWatchdogIntervalMs({ WATCHDOG_USEC: "6000000" })).toBe(5_000)
    // WatchdogSec=600 → third = 200s → clamped down to 30s
    expect(resolveWatchdogIntervalMs({ WATCHDOG_USEC: "600000000" })).toBe(
      30_000,
    )
  })
})

describe("sdNotifyActive", () => {
  it("is active only when NOTIFY_SOCKET is a non-empty string", () => {
    expect(sdNotifyActive({})).toBe(false)
    expect(sdNotifyActive({ NOTIFY_SOCKET: "" })).toBe(false)
    expect(sdNotifyActive({ NOTIFY_SOCKET: "/run/systemd/notify" })).toBe(true)
  })
})

describe("shouldBeat", () => {
  const healthy = { healthzOk: true, stateDirWritable: true, wakeLagMs: 0 }

  it("beats when all probes pass", () => {
    expect(shouldBeat(healthy)).toBe(true)
  })

  it("skips when healthz fails", () => {
    expect(shouldBeat({ ...healthy, healthzOk: false })).toBe(false)
  })

  it("skips when the state dir is not writable", () => {
    expect(shouldBeat({ ...healthy, stateDirWritable: false })).toBe(false)
  })

  it("skips on excessive wake lag but tolerates busy-loop lag", () => {
    expect(shouldBeat({ ...healthy, wakeLagMs: 10_000 })).toBe(false)
    expect(shouldBeat({ ...healthy, wakeLagMs: 9_999 })).toBe(true)
    expect(shouldBeat({ ...healthy, wakeLagMs: 3_000 }, 2_000)).toBe(false)
  })
})

describe("makeSpawnNotifySender", () => {
  it("reports success on exit 0 and failure on non-zero without latching", () => {
    const spawn = vi
      .fn()
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({ status: 1 })
      .mockReturnValueOnce({ status: 0 })
    const sender = makeSpawnNotifySender({ spawn: spawn as never })
    expect(sender("READY=1")).toBe(true)
    expect(sender("WATCHDOG=1")).toBe(false)
    expect(sender("WATCHDOG=1")).toBe(true)
    expect(spawn).toHaveBeenCalledTimes(3)
    // --pid=parent attributes the message to the main pid (root-run units),
    // sidestepping the short-lived-child attribution race on systemd >= 246.
    expect(spawn).toHaveBeenCalledWith(
      "systemd-notify",
      ["--pid=parent", "READY=1"],
      expect.objectContaining({ stdio: "ignore" }),
    )
  })

  it("latches off ONLY on ENOENT (binary missing — the permanent case)", () => {
    const log = vi.fn()
    const enoent = Object.assign(new Error("spawnSync systemd-notify ENOENT"), {
      code: "ENOENT",
    })
    const spawn = vi.fn().mockReturnValue({ status: null, error: enoent })
    const sender = makeSpawnNotifySender({ spawn: spawn as never, log })
    expect(sender("READY=1")).toBe(false)
    expect(sender("WATCHDOG=1")).toBe(false)
    expect(spawn).toHaveBeenCalledTimes(1) // second call short-circuits
    expect(log).toHaveBeenCalledTimes(1)
  })

  it("does NOT latch on a transient spawn error (ETIMEDOUT) — retries next beat", () => {
    const log = vi.fn()
    const etimedout = Object.assign(new Error("spawnSync ETIMEDOUT"), {
      code: "ETIMEDOUT",
    })
    const spawn = vi
      .fn()
      .mockReturnValueOnce({ status: null, error: etimedout })
      .mockReturnValueOnce({ status: 0 })
    const sender = makeSpawnNotifySender({ spawn: spawn as never, log })
    // One 5s pid-1 hiccup must not permanently kill the heartbeat: that
    // would guarantee a watchdog SIGABRT of a healthy server ~90s later.
    expect(sender("WATCHDOG=1")).toBe(false)
    expect(sender("WATCHDOG=1")).toBe(true)
    expect(spawn).toHaveBeenCalledTimes(2)
  })
})

describe("resolveProbeHost", () => {
  it("maps absence and wildcard binds to loopback", () => {
    expect(resolveProbeHost(undefined)).toBe("127.0.0.1")
    expect(resolveProbeHost("")).toBe("127.0.0.1")
    expect(resolveProbeHost("0.0.0.0")).toBe("127.0.0.1")
    expect(resolveProbeHost("::")).toBe("127.0.0.1")
  })

  it("keeps a concrete bind host (production binds the tailnet IP ONLY — probing loopback there would kill a healthy server)", () => {
    expect(resolveProbeHost("100.64.0.7")).toBe("100.64.0.7")
    expect(resolveProbeHost("127.0.0.1")).toBe("127.0.0.1")
  })
})

describe("notifyStopping", () => {
  it("no-ops without NOTIFY_SOCKET", () => {
    const sender = vi.fn()
    notifyStopping({}, sender)
    expect(sender).not.toHaveBeenCalled()
  })

  it("sends STOPPING=1 under systemd", () => {
    const sender = vi.fn().mockReturnValue(true)
    notifyStopping({ NOTIFY_SOCKET: "/run/systemd/notify" }, sender)
    expect(sender).toHaveBeenCalledWith("STOPPING=1")
  })
})

describe("startSdWatchdog", () => {
  let lunaHome: string

  beforeEach(() => {
    vi.useFakeTimers()
    lunaHome = mkdtempSync(join(tmpdir(), "sd-notify-test-"))
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(lunaHome, { recursive: true, force: true })
  })

  const okFetch = (() =>
    Promise.resolve({ ok: true } as Response)) as typeof fetch

  it("is an inert no-op without NOTIFY_SOCKET", () => {
    const sender = vi.fn()
    const handle = startSdWatchdog({
      port: 4753,
      lunaHome,
      env: {},
      sender,
      fetchFn: okFetch,
      log: () => {},
    })
    expect(handle.active).toBe(false)
    expect(sender).not.toHaveBeenCalled()
  })

  it("sends READY=1 immediately and gated WATCHDOG=1 beats on the interval", async () => {
    const sender = vi.fn().mockReturnValue(true)
    const handle = startSdWatchdog({
      port: 4753,
      lunaHome,
      env: { NOTIFY_SOCKET: "/run/systemd/notify", WATCHDOG_USEC: "90000000" },
      sender,
      fetchFn: okFetch,
      log: () => {},
    })
    expect(handle.active).toBe(true)
    expect(sender).toHaveBeenCalledWith("READY=1")

    await vi.advanceTimersByTimeAsync(30_000)
    expect(sender).toHaveBeenCalledWith("WATCHDOG=1")
    await vi.advanceTimersByTimeAsync(60_000)
    const beats = sender.mock.calls.filter(([s]) => s === "WATCHDOG=1")
    expect(beats).toHaveLength(3)
    handle.stop()
  })

  it("probes the BOUND host, not hardcoded loopback (the tailnet-bind blocker)", async () => {
    const sender = vi.fn().mockReturnValue(true)
    const urls: string[] = []
    const captureFetch = ((url: string) => {
      urls.push(String(url))
      return Promise.resolve({ ok: true } as Response)
    }) as unknown as typeof fetch
    const handle = startSdWatchdog({
      port: 4753,
      host: "100.64.0.7",
      lunaHome,
      env: { NOTIFY_SOCKET: "/run/systemd/notify" },
      sender,
      fetchFn: captureFetch,
      log: () => {},
    })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(urls).toContain("http://100.64.0.7:4753/healthz")
    expect(urls.some((u) => u.includes("127.0.0.1"))).toBe(false)
    handle.stop()
  })

  it("maps a wildcard bind to a loopback probe", async () => {
    const sender = vi.fn().mockReturnValue(true)
    const urls: string[] = []
    const captureFetch = ((url: string) => {
      urls.push(String(url))
      return Promise.resolve({ ok: true } as Response)
    }) as unknown as typeof fetch
    const handle = startSdWatchdog({
      port: 4753,
      host: "0.0.0.0",
      lunaHome,
      env: { NOTIFY_SOCKET: "/run/systemd/notify" },
      sender,
      fetchFn: captureFetch,
      log: () => {},
    })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(urls).toContain("http://127.0.0.1:4753/healthz")
    handle.stop()
  })

  it("counts a still-in-flight probe as a skip instead of silently starving beats", async () => {
    const sender = vi.fn().mockReturnValue(true)
    const log = vi.fn()
    // Never-resolving probe: the first tick's probe hangs forever, so every
    // subsequent tick must take the inFlight path and log a skip.
    const hangFetch = (() => new Promise(() => {})) as unknown as typeof fetch
    const handle = startSdWatchdog({
      port: 4753,
      lunaHome,
      env: { NOTIFY_SOCKET: "/run/systemd/notify" },
      sender,
      fetchFn: hangFetch,
      log,
    })
    await vi.advanceTimersByTimeAsync(90_000)
    const beats = sender.mock.calls.filter(([s]) => s === "WATCHDOG=1")
    expect(beats).toHaveLength(0)
    expect(
      log.mock.calls.some(([m]) =>
        String(m).includes("probe-still-in-flight"),
      ),
    ).toBe(true)
    handle.stop()
  })

  it("withholds the beat when the healthz probe fails", async () => {
    const sender = vi.fn().mockReturnValue(true)
    const log = vi.fn()
    const failFetch = (() =>
      Promise.resolve({ ok: false } as Response)) as typeof fetch
    const handle = startSdWatchdog({
      port: 4753,
      lunaHome,
      env: { NOTIFY_SOCKET: "/run/systemd/notify" },
      sender,
      fetchFn: failFetch,
      log,
    })
    await vi.advanceTimersByTimeAsync(90_000)
    const beats = sender.mock.calls.filter(([s]) => s === "WATCHDOG=1")
    expect(beats).toHaveLength(0)
    expect(log.mock.calls.some(([m]) => String(m).includes("SKIPPED"))).toBe(
      true,
    )
    handle.stop()
  })

  it("withholds the beat when the state dir is missing/unwritable", async () => {
    const sender = vi.fn().mockReturnValue(true)
    const handle = startSdWatchdog({
      port: 4753,
      lunaHome: join(lunaHome, "does-not-exist"),
      env: { NOTIFY_SOCKET: "/run/systemd/notify" },
      sender,
      fetchFn: okFetch,
      log: () => {},
    })
    await vi.advanceTimersByTimeAsync(90_000)
    const beats = sender.mock.calls.filter(([s]) => s === "WATCHDOG=1")
    expect(beats).toHaveLength(0)
    handle.stop()
  })

  it("withholds the beat when the healthz probe rejects (connection refused)", async () => {
    const sender = vi.fn().mockReturnValue(true)
    const rejectFetch = (() =>
      Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch
    const handle = startSdWatchdog({
      port: 4753,
      lunaHome,
      env: { NOTIFY_SOCKET: "/run/systemd/notify" },
      sender,
      fetchFn: rejectFetch,
      log: () => {},
    })
    await vi.advanceTimersByTimeAsync(60_000)
    const beats = sender.mock.calls.filter(([s]) => s === "WATCHDOG=1")
    expect(beats).toHaveLength(0)
    handle.stop()
  })

  it("withholds the beat when the wake drift exceeds the lag threshold (wedged event loop)", async () => {
    const sender = vi.fn().mockReturnValue(true)
    const log = vi.fn()
    // Scripted clock: tick 1 punctual, tick 2 wakes 45s LATE (wedged loop),
    // tick 3 punctual again. Interval = 30s.
    const times = [
      0, // start
      30_000, // tick 1: lag 0 → beat
      105_000, // tick 2: 45s late (105 - 30 - 30 = 45s lag) → skip
      135_000, // tick 3: 135 - 105 - 30 = 0 lag → beat
    ]
    let i = 0
    const scriptedNow = () => times[Math.min(i++, times.length - 1)] as number
    const handle = startSdWatchdog({
      port: 4753,
      lunaHome,
      env: { NOTIFY_SOCKET: "/run/systemd/notify" },
      sender,
      fetchFn: okFetch,
      now: scriptedNow,
      log,
    })
    await vi.advanceTimersByTimeAsync(90_000)
    const beats = sender.mock.calls.filter(([s]) => s === "WATCHDOG=1")
    expect(beats).toHaveLength(2) // ticks 1 and 3; tick 2 skipped
    expect(
      log.mock.calls.some(([m]) => String(m).includes("lagMs=45000")),
    ).toBe(true)
    handle.stop()
  })

  it("logs loudly when the READY=1 send itself fails", () => {
    const sender = vi.fn().mockReturnValue(false)
    const log = vi.fn()
    const handle = startSdWatchdog({
      port: 4753,
      lunaHome,
      env: { NOTIFY_SOCKET: "/run/systemd/notify" },
      sender,
      fetchFn: okFetch,
      log,
    })
    expect(handle.active).toBe(true)
    expect(
      log.mock.calls.some(([m]) => String(m).includes("READY=1 send FAILED")),
    ).toBe(true)
    handle.stop()
  })

  it("stop() halts the loop", async () => {
    const sender = vi.fn().mockReturnValue(true)
    const handle = startSdWatchdog({
      port: 4753,
      lunaHome,
      env: { NOTIFY_SOCKET: "/run/systemd/notify" },
      sender,
      fetchFn: okFetch,
      log: () => {},
    })
    handle.stop()
    await vi.advanceTimersByTimeAsync(120_000)
    const beats = sender.mock.calls.filter(([s]) => s === "WATCHDOG=1")
    expect(beats).toHaveLength(0)
  })
})
