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

  // Finding #6 resolution matrix — CHARACTERIZATION of current behavior so a
  // future refactor cannot silently break server-side auth. The server resolver
  // only knows two names (UI_WS_TOKEN ?? LUNA_UI_WS_TOKEN); it has NO profile
  // concept and physically cannot see LUNA_STABLE_UI_WS_TOKEN. These tests must
  // stay green as-is — a failure means current behavior changed; do NOT "fix"
  // the resolver to satisfy a new expectation (that would break the invariant).
  describe("resolution matrix (server-side, profile-agnostic)", () => {
    const T = "x".repeat(16)

    it("UI_WS_TOKEN-only → resolves (the canonical single-box name)", () => {
      expect(resolveUiWsToken({ UI_WS_TOKEN: T })).toBe(T)
    })

    it("LUNA_UI_WS_TOKEN-only → resolves via the back-compat alias", () => {
      expect(resolveUiWsToken({ LUNA_UI_WS_TOKEN: T })).toBe(T)
    })

    it("LUNA_STABLE_UI_WS_TOKEN-only → THROWS (a client-side name the server resolver never reads)", () => {
      // This locks the design split: LUNA_STABLE_UI_WS_TOKEN is the CLI's
      // per-profile name, invisible to the server's own token resolver. The
      // single-box installer therefore writes UI_WS_TOKEN, not this name.
      expect(() => resolveUiWsToken({ LUNA_STABLE_UI_WS_TOKEN: T })).toThrow(
        "UI_WS_TOKEN or LUNA_UI_WS_TOKEN must be set",
      )
    })

    it("all-present → UI_WS_TOKEN wins over LUNA_UI_WS_TOKEN (LUNA_STABLE ignored)", () => {
      expect(
        resolveUiWsToken({
          UI_WS_TOKEN: "canonical-1234567",
          LUNA_UI_WS_TOKEN: "alias-12345678901",
          LUNA_STABLE_UI_WS_TOKEN: "ignored-123456789",
        }),
      ).toBe("canonical-1234567")
    })
  })
})
