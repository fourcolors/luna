import { describe, expect, it } from "vitest"
import { onDeepLinkThread, parseThreadDeepLink, takeLaunchThreadId } from "./deep-link"

describe("parseThreadDeepLink", () => {
  it("extracts the id from a canonical thread link", () => {
    expect(parseThreadDeepLink("luna://thread/abc")).toBe("abc")
  })

  it("returns null for an empty thread id", () => {
    expect(parseThreadDeepLink("luna://thread/")).toBeNull()
  })

  it("rejects a non-thread luna host", () => {
    expect(parseThreadDeepLink("luna://connect?x=1")).toBeNull()
  })

  it("rejects a non-luna scheme", () => {
    expect(parseThreadDeepLink("https://x")).toBeNull()
  })

  it("decodes a percent-encoded id", () => {
    expect(parseThreadDeepLink("luna://thread/a%2Fb")).toBe("a/b")
  })

  it("returns null for non-string input", () => {
    expect(parseThreadDeepLink(null)).toBeNull()
    expect(parseThreadDeepLink(42)).toBeNull()
    expect(parseThreadDeepLink(undefined)).toBeNull()
  })
})

describe("global-Tauri bridge no-ops outside Tauri", () => {
  it("takeLaunchThreadId resolves null with no __TAURI__ global", async () => {
    expect((globalThis as { __TAURI__?: unknown }).__TAURI__).toBeUndefined()
    await expect(takeLaunchThreadId()).resolves.toBeNull()
  })

  it("onDeepLinkThread returns a synchronous no-op disposer", () => {
    const dispose = onDeepLinkThread(() => {})
    expect(typeof dispose).toBe("function")
    expect(() => dispose()).not.toThrow()
  })
})
