/**
 * Unit tests for mapConnectionState in pooled-transport.ts.
 *
 * Pins:
 *   (1) connecting → {kind:"connecting"}
 *   (2) ready      → {kind:"open"}
 *   (3) recovering → {kind:"connecting"} (transparent self-heal, no banner)
 *   (4) down       → {kind:"closed"} (terminal — shows disconnect banner + Reconnect)
 *   (5) auth-failed → {kind:"error"} (error banner, token refresh needed)
 */
import { describe, expect, it } from "vitest"
import { mapConnectionState } from "../src/pooled-transport.js"

describe("mapConnectionState", () => {
  it("connecting maps to {kind:\"connecting\"}", () => {
    const result = mapConnectionState({ status: "connecting" })
    expect(result).toEqual({ kind: "connecting" })
  })

  it("ready maps to {kind:\"open\"}", () => {
    const result = mapConnectionState({ status: "ready" })
    expect(result).toEqual({ kind: "open" })
  })

  it("recovering maps to {kind:\"connecting\"} (transparent self-heal)", () => {
    const result = mapConnectionState({ status: "recovering", reason: "code=1006 reason=" })
    expect(result).toEqual({ kind: "connecting" })
  })

  it("down (terminal) maps to {kind:\"closed\"}", () => {
    const result = mapConnectionState({ status: "down", reason: "max reconnect attempts exceeded" })
    expect(result).toEqual({
      kind: "closed",
      code: 1000,
      reason: "max reconnect attempts exceeded",
    })
  })

  it("down without reason uses fallback reason string", () => {
    const result = mapConnectionState({ status: "down" })
    expect(result).toEqual({ kind: "closed", code: 1000, reason: "server unreachable" })
  })

  it("auth-failed maps to {kind:\"error\"} with prefixed reason", () => {
    const result = mapConnectionState({ status: "auth-failed", reason: "code=1008 reason=Unauthorized" })
    expect(result).toEqual({
      kind: "error",
      message: "auth-failed: code=1008 reason=Unauthorized",
    })
  })

  it("auth-failed without reason maps to plain auth-failed message", () => {
    const result = mapConnectionState({ status: "auth-failed" })
    expect(result).toEqual({ kind: "error", message: "auth-failed" })
  })
})
