import { describe, expect, it, vi } from "vitest"
import { loadNativeLocalConnection, shouldHydrateNativeLocal } from "./native-connection"
import type { PersistedConfig } from "./config"

const config = (overrides: Partial<PersistedConfig> = {}): PersistedConfig => ({
  url: "ws://127.0.0.1:4753/ui",
  token: "",
  model: "claude-sonnet-5",
  enterToSend: false,
  selectedAccountId: null,
  ...overrides,
})

describe("native local connection bootstrap", () => {
  it("hydrates only an unconfigured loopback connection", () => {
    expect(shouldHydrateNativeLocal(config())).toBe(true)
    expect(shouldHydrateNativeLocal(config({ token: "1234567890abcdef" }))).toBe(false)
    expect(shouldHydrateNativeLocal(config({ url: "ws://jax-box:4753/ui" }))).toBe(false)
  })

  it("loads and validates the native command result", async () => {
    const invoke = vi.fn().mockResolvedValue({
      url: "ws://127.0.0.1:4753/ui",
      token: "1234567890abcdef",
    })
    await expect(loadNativeLocalConnection(invoke)).resolves.toEqual({
      url: "ws://127.0.0.1:4753/ui",
      token: "1234567890abcdef",
    })
    expect(invoke).toHaveBeenCalledWith("load_local_connection")
  })

  it("fails soft outside Tauri or on malformed native data", async () => {
    await expect(loadNativeLocalConnection(null)).resolves.toBeNull()
    await expect(loadNativeLocalConnection(vi.fn().mockResolvedValue({ url: "nope", token: "short" }))).resolves.toBeNull()
    await expect(loadNativeLocalConnection(vi.fn().mockRejectedValue(new Error("missing")))).resolves.toBeNull()
  })
})
