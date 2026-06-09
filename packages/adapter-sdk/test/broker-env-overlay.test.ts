/**
 * broker-env-overlay.test.ts — the single secret-unwrap helper.
 * Asserts per-kind auth-var selection, base-URL presence/absence, extraEnv
 * merge, and that the redacted secret is unwrapped into the overlay value.
 */
import { describe, expect, it } from "vitest"
import { Redacted } from "effect"
import type { ProviderProfile } from "@luna/core"
import { buildBrokerEnvOverlay } from "../src/broker-env-overlay.js"

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
