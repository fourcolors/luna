/**
 * provider-profile.test.ts — Tier-1 unit tests for the provider routing seam.
 *
 * Pure functions, zero network. `env` is injected explicitly (never reads the
 * real process.env) so the routing rules are deterministic. The load-bearing
 * invariant under test: an unrecognized model (and the "default" alias) routes
 * to `anthropic` with the OAuth-token var and NO base URL — i.e. the seam
 * reproduces the harness's pre-existing Anthropic-only behavior exactly.
 */
import { describe, expect, it } from "vitest"
import {
  resolveProfile,
  ANTHROPIC_KIND,
} from "../src/provider-profile.js"

const GW = { LUNA_LLM_GATEWAY_URL: "http://gw:4000" }

describe("resolveProfile", () => {
  it("routes 'default' to anthropic — native, OAuth token, no base URL (back-compat)", () => {
    const p = resolveProfile("default", {})
    expect(p.kind).toBe(ANTHROPIC_KIND)
    expect(p.authVar).toBe("CLAUDE_CODE_OAUTH_TOKEN")
    expect(p.baseUrl).toBeUndefined()
    expect(p.capabilities.promptCaching).toBe(true)
    expect(p.capabilities.structuredOutput).toBe("anthropic")
  })

  it("routes claude-* to anthropic", () => {
    expect(resolveProfile("claude-opus-4-8", {}).kind).toBe(ANTHROPIC_KIND)
    expect(resolveProfile("claude-sonnet-4-6", {}).baseUrl).toBeUndefined()
  })

  it("routes gemini-* to google via the gateway", () => {
    const p = resolveProfile("gemini-2.5-flash", GW)
    expect(p.kind).toBe("google")
    expect(p.baseUrl).toBe("http://gw:4000")
    expect(p.authVar).toBe("ANTHROPIC_AUTH_TOKEN")
    expect(p.capabilities.promptCaching).toBe(false)
    expect(p.capabilities.structuredOutput).toBe("gemini-response-schema")
  })

  it("routes *:cloud to ollama-cloud — native compat, no tool_choice", () => {
    const p = resolveProfile("qwen3-coder:cloud", {})
    expect(p.kind).toBe("ollama-cloud")
    expect(p.baseUrl).toBe("https://ollama.com")
    expect(p.authVar).toBe("ANTHROPIC_AUTH_TOKEN")
    expect(p.capabilities.toolChoice).toBe(false)
  })

  it("routes gpt-* to openai via the gateway", () => {
    expect(resolveProfile("gpt-4o", GW).kind).toBe("openai")
    expect(resolveProfile("gpt-4o", GW).baseUrl).toBe("http://gw:4000")
  })

  it("honors an explicit model->kind override map (highest precedence)", () => {
    const p = resolveProfile("qwen3-coder", {
      LUNA_MODEL_PROVIDER_MAP: "qwen3-coder=ollama-cloud,foo=google",
    })
    expect(p.kind).toBe("ollama-cloud")
  })

  it("defaults an unrecognized model to anthropic (back-compat)", () => {
    expect(resolveProfile("some-random-model", {}).kind).toBe(ANTHROPIC_KIND)
  })

  it("uses the default gateway URL when LUNA_LLM_GATEWAY_URL is unset", () => {
    expect(resolveProfile("gemini-2.5-flash", {}).baseUrl).toBe(
      "http://127.0.0.1:4000",
    )
  })

  it("routes local/* to ollama-local with the configured base URL", () => {
    const p = resolveProfile("local/llama3", {
      LUNA_OLLAMA_BASE_URL: "http://10.0.0.5:11434",
    })
    expect(p.kind).toBe("ollama-local")
    expect(p.baseUrl).toBe("http://10.0.0.5:11434")
  })

  it("an unknown override kind still routes through the gateway (escape hatch)", () => {
    const p = resolveProfile("mix-1", {
      LUNA_MODEL_PROVIDER_MAP: "mix-1=mistral",
      LUNA_LLM_GATEWAY_URL: "http://gw:4000",
    })
    expect(p.kind).toBe("mistral")
    expect(p.baseUrl).toBe("http://gw:4000")
    expect(p.authVar).toBe("ANTHROPIC_AUTH_TOKEN")
  })
})
