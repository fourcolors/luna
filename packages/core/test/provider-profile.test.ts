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
  toWireModel,
  ANTHROPIC_KIND,
  laneSupportsStructuredOutput,
  profileForKind,
  readProviderEnv,
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

describe("toWireModel — strips luna's routing token from the wire name", () => {
  // Regression for a LIVE-PROVEN bug: a real Agent SDK turn sent
  // `local/qwen3.6:35b` verbatim and Ollama replied
  // `not_found_error: model 'local/qwen3.6:35b' not found`, making the
  // ollama-local lane non-functional. The `local/` prefix is BOTH the route
  // selector (resolveKind) AND part of the wire name — it must be stripped
  // for the request after it has done its routing job.
  it("strips the leading 'local/' prefix for ollama-local", () => {
    expect(toWireModel("local/qwen3.6:35b", "ollama-local")).toBe("qwen3.6:35b")
    expect(toWireModel("local/llama3", "ollama-local")).toBe("llama3")
  })

  it("strips a trailing ':cloud' suffix for ollama-cloud", () => {
    expect(toWireModel("qwen3-coder:480b:cloud", "ollama-cloud")).toBe(
      "qwen3-coder:480b",
    )
  })

  it("is case-insensitive on the routing token (matches resolveKind)", () => {
    expect(toWireModel("LOCAL/Foo", "ollama-local")).toBe("Foo")
    expect(toWireModel("foo:CLOUD", "ollama-cloud")).toBe("foo")
  })

  it("leaves gateway and anthropic names VERBATIM (LiteLLM matches on them)", () => {
    // google / openai / unknown route through the gateway — the operator's
    // configured model_name must reach LiteLLM unchanged.
    expect(toWireModel("gemini-2.5-flash", "google")).toBe("gemini-2.5-flash")
    expect(toWireModel("gpt-4o", "openai")).toBe("gpt-4o")
    expect(toWireModel("claude-sonnet-4-6", "anthropic")).toBe(
      "claude-sonnet-4-6",
    )
    expect(toWireModel("mistral-large", "mistral")).toBe("mistral-large")
  })

  it("only strips the token at its routing position, not mid-string", () => {
    // a ':cloud' that is NOT a trailing suffix, and a 'local/' that is NOT a
    // leading prefix, are part of the real name on a non-ollama kind → untouched.
    expect(toWireModel("my-local/model", "google")).toBe("my-local/model")
    expect(toWireModel("cloud:thing", "ollama-cloud")).toBe("cloud:thing")
  })
})

describe("laneSupportsStructuredOutput — single definition of JSON-capable", () => {
  // Deterministic provider env (no real process.env): all defaults.
  const PROVIDER_ENV = readProviderEnv({})

  it("anthropic can emit structured output", () => {
    expect(
      laneSupportsStructuredOutput(profileForKind(ANTHROPIC_KIND, PROVIDER_ENV)),
    ).toBe(true)
  })

  it("google (gemini) can emit structured output", () => {
    expect(laneSupportsStructuredOutput(profileForKind("google", PROVIDER_ENV))).toBe(
      true,
    )
  })

  it("openai cannot emit structured output (gateway lane)", () => {
    expect(laneSupportsStructuredOutput(profileForKind("openai", PROVIDER_ENV))).toBe(
      false,
    )
  })

  it("ollama-cloud cannot emit structured output", () => {
    expect(
      laneSupportsStructuredOutput(profileForKind("ollama-cloud", PROVIDER_ENV)),
    ).toBe(false)
  })

  it("ollama-local cannot emit structured output", () => {
    expect(
      laneSupportsStructuredOutput(profileForKind("ollama-local", PROVIDER_ENV)),
    ).toBe(false)
  })

  it("an unrecognized kind falls through to the gateway default and cannot emit structured output", () => {
    expect(
      laneSupportsStructuredOutput(profileForKind("mistral", PROVIDER_ENV)),
    ).toBe(false)
  })
})
