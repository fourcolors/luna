import { describe, expect, it } from "vitest"
import {
  DEEP_LINK_CONFIRM_GRACE_MS,
  deepLinkShieldDecision,
  onDeepLinkThread,
  parseThreadDeepLink,
  takeLaunchThreadId,
} from "./deep-link"

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

describe("deepLinkShieldDecision", () => {
  const base = {
    selectedThreadId: "deep-1",
    routedDeepLinkId: "deep-1",
    graceUntilMs: 1_000,
  }

  it("is not applicable when selection is not the routed deep link", () => {
    expect(
      deepLinkShieldDecision({
        ...base,
        selectedThreadId: "other",
        confirmed: false,
        nowMs: 0,
      }),
    ).toEqual({ action: "not-applicable" })
  })

  it("keeps a confirmed deep link forever (covers top-50 windowing)", () => {
    expect(
      deepLinkShieldDecision({
        ...base,
        confirmed: true,
        nowMs: base.graceUntilMs + 60_000,
      }),
    ).toEqual({ action: "keep" })
  })

  it("keeps an unconfirmed deep link during the grace window", () => {
    expect(
      deepLinkShieldDecision({
        ...base,
        confirmed: false,
        nowMs: base.graceUntilMs - 1,
      }),
    ).toEqual({ action: "keep" })
  })

  it("clears an unconfirmed deep link after the grace window", () => {
    expect(
      deepLinkShieldDecision({
        ...base,
        confirmed: false,
        nowMs: base.graceUntilMs,
      }),
    ).toEqual({ action: "clear-and-fallthrough" })
  })

  it("exposes a 15-second grace constant for subscribe snapshot latency (#364)", () => {
    expect(DEEP_LINK_CONFIRM_GRACE_MS).toBe(15_000)
  })
})
