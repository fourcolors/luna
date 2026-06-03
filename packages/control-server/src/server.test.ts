import { describe, expect, it } from "vitest"
import { isAuthorized } from "./server.js"

// Mirrors the ui-ws server's bearer-token contract so the same
// LUNA_UI_WS_TOKEN gates both surfaces.
const TOKEN = "s3cr3t-control-token-0123456789"

describe("control-server isAuthorized", () => {
  it("accepts a correct Bearer token", () => {
    expect(isAuthorized(`Bearer ${TOKEN}`, TOKEN)).toBe(true)
  })

  it("rejects a missing or empty Authorization header", () => {
    expect(isAuthorized(null, TOKEN)).toBe(false)
    expect(isAuthorized("", TOKEN)).toBe(false)
  })

  it("rejects a wrong token", () => {
    expect(isAuthorized("Bearer wrong-token", TOKEN)).toBe(false)
  })

  it("rejects a token of the wrong length (constant-time guard)", () => {
    expect(isAuthorized(`Bearer ${TOKEN}x`, TOKEN)).toBe(false)
  })

  it("rejects a non-Bearer scheme", () => {
    expect(isAuthorized(`Basic ${TOKEN}`, TOKEN)).toBe(false)
  })
})
