/**
 * Pins the boot-dial helpers that unblock SYN when Tauri invoke hangs.
 *
 * Round-3 Mac: Disconnected + "waking up…" + zero WebKit TCP while
 * luna_ws_url stayed ws://luna-host:4753/ui. That paint is the HTML/MoonBar
 * DEFAULT before connect()'s updateStatus — i.e. boot never left the
 * await migrate/load_connection window. These unit tests lock the timeout
 * + URL/token pickers that let dial proceed with the cached luna-host URL.
 */
import { describe, it, expect, vi, afterEach } from "vitest"
import {
  BOOT_INVOKE_MS,
  invokeWithTimeout,
  isUsableBearerToken,
  pickBootWsUrl,
} from "../frontend-react/src/tauriBoot"
import { readFileSync } from "node:fs"
import * as path from "node:path"

describe("tauriBoot — invokeWithTimeout", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("resolves when invoke settles before the ceiling", async () => {
    const invoke = vi.fn(async () => ({ wsUrl: "ws://luna-host:4753/ui" }))
    await expect(invokeWithTimeout(invoke, "load_connection", undefined, 500)).resolves.toEqual({
      wsUrl: "ws://luna-host:4753/ui",
    })
    expect(invoke).toHaveBeenCalledWith("load_connection", undefined)
  })

  it("rejects with boot-timeout: when invoke never settles", async () => {
    vi.useFakeTimers()
    const invoke = vi.fn(() => new Promise(() => {}))
    const p = invokeWithTimeout(invoke, "migrate_legacy_connection", undefined, 100)
    const assertion = expect(p).rejects.toThrow(/boot-timeout: migrate_legacy_connection/)
    await vi.advanceTimersByTimeAsync(100)
    await assertion
  })

  it("exports a 2s default ceiling used by hub/chat boot", () => {
    expect(BOOT_INVOKE_MS).toBe(2000)
  })
})

describe("tauriBoot — isUsableBearerToken", () => {
  it("accepts literal bearers including empty string (auth-disabled servers)", () => {
    expect(isUsableBearerToken("abc123")).toBe(true)
    expect(isUsableBearerToken("")).toBe(true)
  })

  it("rejects legacy sentinel and scheme refs", () => {
    expect(isUsableBearerToken("legacy")).toBe(false)
    expect(isUsableBearerToken("env:UI_WS_TOKEN")).toBe(false)
    expect(isUsableBearerToken("file:/tmp/tok")).toBe(false)
    expect(isUsableBearerToken("op://vault/item")).toBe(false)
    expect(isUsableBearerToken(null)).toBe(false)
  })
})

describe("tauriBoot — pickBootWsUrl", () => {
  it("keeps luna-host from localStorage when load_connection timed out", () => {
    const url = pickBootWsUrl(null, (k) => (k === "luna_ws_url" ? "ws://luna-host:4753/ui" : null))
    expect(url).toBe("ws://luna-host:4753/ui")
  })

  it("prefers a loaded URL over the cache", () => {
    const url = pickBootWsUrl("ws://other:4753/ui", () => "ws://luna-host:4753/ui")
    expect(url).toBe("ws://other:4753/ui")
  })

  it("does not invent localhost when a cache exists", () => {
    const url = pickBootWsUrl(undefined, (k) => (k === "luna_ws_url" ? "ws://luna-host:4753/ui" : null))
    expect(url).not.toMatch(/127\.0\.0\.1|localhost/)
    expect(url).toBe("ws://luna-host:4753/ui")
  })
})

describe("tauriBoot — production call sites still dial after timeout helpers", () => {
  const root = path.resolve(__dirname, "..")

  it("hub loadSettings uses invokeWithTimeout for migrate + load_connection", () => {
    const src = readFileSync(
      path.join(root, "frontend-react/src/hub/hubEngines.ts"),
      "utf8",
    )
    expect(src).toContain("invokeWithTimeout")
    expect(src).toContain("pickBootWsUrl")
    expect(src).toMatch(/migrate_legacy_connection/)
    expect(src).toMatch(/load_connection/)
  })

  it("chat loadConnectionAndConnect uses invokeWithTimeout + pickBootWsUrl", () => {
    const src = readFileSync(path.join(root, "frontend-react/src/chat/wire.ts"), "utf8")
    expect(src).toContain("invokeWithTimeout")
    expect(src).toContain("pickBootWsUrl")
    expect(src).toMatch(/boot-timeout: resolveBootRoute/)
  })

  it("CSP connect-src explicitly allows ipc: so boot invokes are not CSP-blocked", () => {
    const conf = JSON.parse(
      readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8"),
    ) as { app: { security: { csp: string } } }
    const csp = conf.app.security.csp
    expect(csp).toMatch(/connect-src[^;]*\bipc:/)
    expect(csp).toMatch(/connect-src[^;]*http:\/\/ipc\.localhost/)
    expect(csp).toMatch(/connect-src[^;]*\bws:/)
  })
})
