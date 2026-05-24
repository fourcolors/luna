import { describe, expect, it } from "vitest"
import { resolveUiWsToken } from "../ui-ws-token.js"

describe("resolveUiWsToken", () => {
  it("prefers UI_WS_TOKEN over LUNA_UI_WS_TOKEN", () => {
    expect(
      resolveUiWsToken({
        UI_WS_TOKEN: "ui-token-123456789",
        LUNA_UI_WS_TOKEN: "luna-token-123456",
      }),
    ).toBe("ui-token-123456789")
    expect(
      resolveUiWsToken({
        UI_WS_TOKEN: "  ui-token-123456789  ",
        LUNA_UI_WS_TOKEN: "luna-token-123456",
      }),
    ).toBe("  ui-token-123456789  ")
  })

  it("falls back to LUNA_UI_WS_TOKEN", () => {
    expect(
      resolveUiWsToken({
        LUNA_UI_WS_TOKEN: "luna-token-123456",
      }),
    ).toBe("luna-token-123456")
  })

  it("throws when both token env vars are missing or empty", () => {
    expect(() => resolveUiWsToken({})).toThrow(
      "UI_WS_TOKEN or LUNA_UI_WS_TOKEN must be set",
    )
    expect(() =>
      resolveUiWsToken({ UI_WS_TOKEN: "", LUNA_UI_WS_TOKEN: "   " }),
    ).toThrow("UI_WS_TOKEN or LUNA_UI_WS_TOKEN must be set")
  })

  it("does not fall back when UI_WS_TOKEN is present but empty", () => {
    expect(() =>
      resolveUiWsToken({
        UI_WS_TOKEN: "",
        LUNA_UI_WS_TOKEN: "luna-token-123456",
      }),
    ).toThrow("UI_WS_TOKEN or LUNA_UI_WS_TOKEN must be set")
    expect(() =>
      resolveUiWsToken({
        UI_WS_TOKEN: "   ",
        LUNA_UI_WS_TOKEN: "luna-token-123456",
      }),
    ).toThrow("UI_WS_TOKEN or LUNA_UI_WS_TOKEN must be set")
  })

  it("throws when the resolved token is shorter than 16 characters", () => {
    expect(() => resolveUiWsToken({ UI_WS_TOKEN: "short-token" })).toThrow(
      /at least 16 characters/,
    )
  })
})
