/**
 * broker-env-overlay.test.ts — the single secret-unwrap helper.
 * Asserts per-kind auth-var selection, base-URL presence/absence, extraEnv
 * merge, and that the redacted secret is unwrapped into the overlay value.
 */
import { describe, expect, it } from "vitest"
import { Redacted } from "effect"
import type { ProviderProfile } from "@luna/core"
import {
  buildBrokerBaseEnv,
  buildBrokerEnvOverlay,
} from "../src/broker-env-overlay.js"

describe("buildBrokerEnvOverlay", () => {
  it("google profile → ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL + extraEnv", () => {
    const profile: ProviderProfile = {
      kind: "google",
      baseUrl: "http://gw:4000",
      authVar: "ANTHROPIC_AUTH_TOKEN",
      extraEnv: { X: "1" },
      capabilities: {
        promptCaching: false,
        toolChoice: true,
        structuredOutput: "gemini-response-schema",
      },
    }
    const env = buildBrokerEnvOverlay(profile, Redacted.make("tok-x"))
    expect(env["ANTHROPIC_AUTH_TOKEN"]).toBe("tok-x")
    expect(env["ANTHROPIC_BASE_URL"]).toBe("http://gw:4000")
    expect(env["X"]).toBe("1")
    expect(env["CLAUDE_CODE_OAUTH_TOKEN"]).toBeUndefined()
  })

  it("anthropic profile → only CLAUDE_CODE_OAUTH_TOKEN, no base URL (back-compat)", () => {
    const profile: ProviderProfile = {
      kind: "anthropic",
      authVar: "CLAUDE_CODE_OAUTH_TOKEN",
      capabilities: {
        promptCaching: true,
        toolChoice: true,
        structuredOutput: "anthropic",
      },
    }
    const env = buildBrokerEnvOverlay(profile, Redacted.make("oauth-tok"))
    expect(env["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("oauth-tok")
    expect(env["ANTHROPIC_BASE_URL"]).toBeUndefined()
    expect(Object.keys(env)).toEqual(["CLAUDE_CODE_OAUTH_TOKEN"])
  })
})

describe("buildBrokerBaseEnv — full subprocess env (SDK Options.env is REPLACE)", () => {
  it("inherits process.env (PATH/HOME survive for tools + MCP servers)", () => {
    const env = buildBrokerBaseEnv()
    expect(env["PATH"]).toBe(process.env["PATH"])
    // HOME exists on every platform this runs on; assert it rides along.
    expect(env["HOME"]).toBe(process.env["HOME"])
  })

  it("scrubs ambient auth/routing vars so the operator's login cannot leak into a brokered turn", () => {
    const saved = {
      CLAUDE_CODE_OAUTH_TOKEN: process.env["CLAUDE_CODE_OAUTH_TOKEN"],
      ANTHROPIC_AUTH_TOKEN: process.env["ANTHROPIC_AUTH_TOKEN"],
      ANTHROPIC_API_KEY: process.env["ANTHROPIC_API_KEY"],
      ANTHROPIC_BASE_URL: process.env["ANTHROPIC_BASE_URL"],
    }
    try {
      process.env["CLAUDE_CODE_OAUTH_TOKEN"] = "ambient-oauth"
      process.env["ANTHROPIC_AUTH_TOKEN"] = "ambient-auth"
      process.env["ANTHROPIC_API_KEY"] = "ambient-key"
      process.env["ANTHROPIC_BASE_URL"] = "https://ambient.example"
      const env = buildBrokerBaseEnv()
      expect(env["CLAUDE_CODE_OAUTH_TOKEN"]).toBeUndefined()
      expect(env["ANTHROPIC_AUTH_TOKEN"]).toBeUndefined()
      expect(env["ANTHROPIC_API_KEY"]).toBeUndefined()
      expect(env["ANTHROPIC_BASE_URL"]).toBeUndefined()
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })

  it("caller env wins over inherited; overlay applied on top wins over both", () => {
    const env = buildBrokerBaseEnv({ PATH: "/caller/bin", X_CALLER: "1" })
    expect(env["PATH"]).toBe("/caller/bin")
    expect(env["X_CALLER"]).toBe("1")
    // Call-site composition: overlay spread above the base must win.
    const composed = { ...env, ANTHROPIC_AUTH_TOKEN: "broker-tok" }
    expect(composed["ANTHROPIC_AUTH_TOKEN"]).toBe("broker-tok")
  })
})
