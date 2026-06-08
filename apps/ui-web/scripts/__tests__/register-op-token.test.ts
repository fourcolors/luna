import { describe, expect, it, vi } from "vitest"
import {
  makeRegisterOpToken,
  type RegisterOpTokenDeps,
} from "../register-op-token.js"

/** Build deps with sensible passing defaults; override per test. */
const deps = (over: Partial<RegisterOpTokenDeps> = {}): RegisterOpTokenDeps => ({
  isLabelRegistered: vi.fn(() => true),
  validateToken: vi.fn(async () => ({ ok: true }) as const),
  persist: vi.fn(async () => {}),
  scheduleRestart: vi.fn(),
  log: vi.fn(),
  ...over,
})

describe("makeRegisterOpToken", () => {
  it("happy path: verifies, persists (trimmed), then restarts", async () => {
    const d = deps()
    const result = await makeRegisterOpToken(d)({
      label: " primary ",
      token: "  ops_realtoken \n",
    })
    expect(result.ok).toBe(true)
    expect(d.validateToken).toHaveBeenCalledWith("ops_realtoken")
    expect(d.persist).toHaveBeenCalledWith("primary", "ops_realtoken")
    expect(d.scheduleRestart).toHaveBeenCalledOnce()
  })

  it("never leaks the token into the returned message", async () => {
    const d = deps()
    const result = await makeRegisterOpToken(d)({
      label: "primary",
      token: "ops_supersecret",
    })
    expect(result.message).not.toContain("ops_supersecret")
  })

  it("rejects an invalid label without validating, persisting, or restarting", async () => {
    const d = deps()
    const result = await makeRegisterOpToken(d)({ label: "Primary", token: "ops_x" })
    expect(result.ok).toBe(false)
    expect(d.validateToken).not.toHaveBeenCalled()
    expect(d.persist).not.toHaveBeenCalled()
    expect(d.scheduleRestart).not.toHaveBeenCalled()
  })

  it("rejects a reserved label", async () => {
    const d = deps()
    const result = await makeRegisterOpToken(d)({ label: "env", token: "ops_x" })
    expect(result.ok).toBe(false)
    expect(d.persist).not.toHaveBeenCalled()
  })

  it("rejects a label not in LUNA_OP_ACCOUNTS (orphan guard) without validating or persisting", async () => {
    const d = deps({ isLabelRegistered: vi.fn(() => false) })
    const result = await makeRegisterOpToken(d)({ label: "ghost", token: "ops_x" })
    expect(result.ok).toBe(false)
    expect(result.message).toContain("LUNA_OP_ACCOUNTS")
    expect(d.validateToken).not.toHaveBeenCalled()
    expect(d.persist).not.toHaveBeenCalled()
    expect(d.scheduleRestart).not.toHaveBeenCalled()
  })

  it("rejects an empty token before validating", async () => {
    const d = deps()
    const result = await makeRegisterOpToken(d)({ label: "primary", token: "   " })
    expect(result.ok).toBe(false)
    expect(d.validateToken).not.toHaveBeenCalled()
    expect(d.scheduleRestart).not.toHaveBeenCalled()
  })

  it("a rejected token does NOT persist or restart, and surfaces the reason", async () => {
    const d = deps({
      validateToken: vi.fn(async () => ({
        ok: false,
        message: "1Password rejected this token",
      })),
    })
    const result = await makeRegisterOpToken(d)({ label: "primary", token: "ops_bad" })
    expect(result).toEqual({ ok: false, message: "1Password rejected this token" })
    expect(d.persist).not.toHaveBeenCalled()
    expect(d.scheduleRestart).not.toHaveBeenCalled()
  })

  it("a persist failure does NOT restart and stays opaque", async () => {
    const d = deps({
      persist: vi.fn(async () => {
        throw new Error("disk full: ops_leak")
      }),
    })
    const result = await makeRegisterOpToken(d)({ label: "primary", token: "ops_x" })
    expect(result.ok).toBe(false)
    expect(result.message).not.toContain("ops_leak")
    expect(d.scheduleRestart).not.toHaveBeenCalled()
  })
})
