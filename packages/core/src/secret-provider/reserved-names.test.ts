/**
 * reserved-names unit tests - pins the canonical reserved-name policy:
 * `UI_WS_TOKEN` (case-insensitive) and any `LUNA_*` name (case-insensitive),
 * everything else benign.
 */
import { describe, expect, it } from "vitest"
import { isReservedSecretName } from "./reserved-names.js"

describe("isReservedSecretName", () => {
  it("reserves the literal UI_WS_TOKEN", () => {
    expect(isReservedSecretName("UI_WS_TOKEN")).toBe(true)
  })

  it("reserves UI_WS_TOKEN case-insensitively (lookalikes)", () => {
    expect(isReservedSecretName("ui_ws_token")).toBe(true)
    expect(isReservedSecretName("Ui_Ws_Token")).toBe(true)
  })

  it("reserves LUNA_* names", () => {
    expect(isReservedSecretName("LUNA_X")).toBe(true)
    expect(isReservedSecretName("LUNA_OP_TOKEN_PRIMARY")).toBe(true)
  })

  it("reserves LUNA_* case-insensitively (lookalikes)", () => {
    expect(isReservedSecretName("luna_x")).toBe(true)
    expect(isReservedSecretName("Luna_X")).toBe(true)
  })

  it("does not reserve benign names", () => {
    expect(isReservedSecretName("BENIGN")).toBe(false)
    expect(isReservedSecretName("OPENAI_API_KEY")).toBe(false)
    expect(isReservedSecretName("ANTHROPIC_TOKEN")).toBe(false)
    // "LUNAR" starts with LUNA but not the LUNA_ prefix - benign.
    expect(isReservedSecretName("LUNAR")).toBe(false)
    expect(isReservedSecretName("LUNA")).toBe(false)
  })
})
