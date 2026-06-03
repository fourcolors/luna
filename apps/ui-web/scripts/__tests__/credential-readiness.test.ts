import { describe, expect, it } from "vitest"
import { decideMode, probeCredentialReadiness } from "../credential-readiness.js"

describe("decideMode", () => {
  it("ready → normal, not-ready → setup", () => {
    expect(decideMode({ ready: true, reason: "claude-login-ok" })).toBe("normal")
    expect(decideMode({ ready: false, reason: "no-accounts" })).toBe("setup")
  })
})

describe("probeCredentialReadiness", () => {
  const base = { dbPath: "/x/luna.db", claudeExe: "claude" }

  it("no accounts → not ready", () => {
    const r = probeCredentialReadiness({ ...base, _readAccounts: () => [] })
    expect(r.ready).toBe(false)
    expect(r.reason).toBe("no-accounts")
  })

  it("claude-code:login + auth status loggedIn → ready", () => {
    const r = probeCredentialReadiness({
      ...base,
      _readAccounts: () => [{ kind: "anthropic", secret_ref: "claude-code:login" }],
      _authStatus: () => ({ ok: true }),
    })
    expect(r.ready).toBe(true)
    expect(r.reason).toBe("claude-login-ok")
  })

  it("claude-code:login + auth status NOT loggedIn → not ready (lapse)", () => {
    const r = probeCredentialReadiness({
      ...base,
      _readAccounts: () => [{ kind: "anthropic", secret_ref: "claude-code:login" }],
      _authStatus: () => ({ ok: false }),
    })
    expect(r.ready).toBe(false)
    expect(r.reason).toBe("claude-login-lapsed")
  })

  it("env:/op:// account → ready in v1 (deep-resolve deferred to doctor)", () => {
    const r = probeCredentialReadiness({
      ...base,
      _readAccounts: () => [{ kind: "anthropic", secret_ref: "env:ANTHROPIC_API_KEY" }],
    })
    expect(r.ready).toBe(true)
    expect(r.reason).toBe("non-login-account-present")
  })
})
