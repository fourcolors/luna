// packages/core/src/provider-profile.ts
//
// Provider routing (the "thin seam", concept Piece 1). A data-only registry
// mapping a provider `kind` — which is ALSO the account `kind` the AccountBroker
// pool routes by — to how the Claude Agent SDK should be pointed at that
// provider: the endpoint base URL, the env var the resolved account secret is
// injected into, and capability flags. Plus `resolveProfile`, which maps a model
// string to its profile.
//
// SDK-FREE BY DESIGN: core must not import the Agent SDK (§ no core→adapter-sdk
// cycle). This module is plain data + pure functions. The adapter (adapter-sdk)
// consumes a profile to assemble the SDK `options.env` overlay AT ITS SINGLE
// secret-unwrap site — the profile only names the var; it never touches secrets.
//
// SCOPE (this increment): point the SDK at a provider. The overflow-chain and
// spend-meter (rev-2 concept) are intentionally NOT here.

/** How structured output is enforced for a provider (consumed later by the
 * config-time validation / wake-reasoner hardening — reserved, not built yet). */
export type StructuredOutputMode = "anthropic" | "gemini-response-schema" | "none"

/** Env var the resolved account secret is injected into for a provider.
 * `anthropic` (native) uses the Claude Code OAuth token; gateway / native-compat
 * providers use the generic bearer the SDK forwards as `Authorization`. */
export type AuthEnvVar = "CLAUDE_CODE_OAUTH_TOKEN" | "ANTHROPIC_AUTH_TOKEN"

export interface ProviderCapabilities {
  /** Anthropic-style prompt caching (`cache_control`). Off for non-Claude. */
  readonly promptCaching: boolean
  /** Can force/disable a specific tool (`tool_choice`). Off for Ollama. */
  readonly toolChoice: boolean
  readonly structuredOutput: StructuredOutputMode
}

export interface ProviderProfile {
  /** Provider id; also the account `kind` the broker pool routes by. */
  readonly kind: string
  /** Endpoint root. `undefined` ⇒ the SDK's native Anthropic endpoint
   * (api.anthropic.com) — i.e. exactly today's behavior, no `ANTHROPIC_BASE_URL`. */
  readonly baseUrl?: string
  /** Name of the env var the unwrapped secret is injected into. */
  readonly authVar: AuthEnvVar
  /** Extra NON-SECRET env to set for this provider (empty for all kinds today;
   * the spike proved `?beta=true` round-trips through LiteLLM, so betas are left
   * on). Reserved for per-provider tweaks without a code change. */
  readonly extraEnv?: Readonly<Record<string, string>>
  readonly capabilities: ProviderCapabilities
}

/** The canonical provider kind — the broker's historical default and the
 * back-compat target for any unrecognized model string. */
export const ANTHROPIC_KIND = "anthropic"

/** Knobs resolved from the environment (deployment-specific endpoints + an
 * optional explicit model→kind override map). Defaulted so `resolveProfile(model)`
 * works with no config and reproduces today's Anthropic-only behavior. */
export interface ProviderEnv {
  /** Anthropic-format gateway (e.g. LiteLLM) base URL for gateway-routed kinds. */
  readonly gatewayBaseUrl: string
  /** Ollama Cloud base URL (native Anthropic-compat `/v1/messages`). */
  readonly ollamaCloudBaseUrl: string
  /** Local Ollama base URL (native Anthropic-compat). */
  readonly ollamaLocalBaseUrl: string
  /** Explicit `model=kind,model2=kind2` overrides; highest precedence. */
  readonly modelKindMap: Readonly<Record<string, string>>
}

const DEFAULT_GATEWAY_URL = "http://127.0.0.1:4000"
const DEFAULT_OLLAMA_CLOUD_URL = "https://ollama.com"
const DEFAULT_OLLAMA_LOCAL_URL = "http://127.0.0.1:11434"

/** Bare model aliases that mean "the default Claude model" — the broker is
 * called with `"default"` when the caller omits a model, and the SDK accepts
 * these short names. All route to `anthropic` so existing behavior is preserved. */
const ANTHROPIC_ALIASES = new Set(["default", "opus", "sonnet", "haiku"])

function parseModelKindMap(raw: string | undefined): Record<string, string> {
  if (!raw) return {}
  const out: Record<string, string> = {}
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=")
    if (eq <= 0) continue
    const model = pair.slice(0, eq).trim()
    const kind = pair.slice(eq + 1).trim()
    if (model && kind) out[model] = kind
  }
  return out
}

/** Build the resolved `ProviderEnv` from a raw env bag (defaults to `process.env`).
 * Reading env via an injectable param keeps `resolveProfile` pure + unit-testable. */
export function readProviderEnv(
  env: Record<string, string | undefined> = process.env,
): ProviderEnv {
  return {
    gatewayBaseUrl: env["LUNA_LLM_GATEWAY_URL"]?.trim() || DEFAULT_GATEWAY_URL,
    ollamaCloudBaseUrl:
      env["LUNA_OLLAMA_CLOUD_URL"]?.trim() || DEFAULT_OLLAMA_CLOUD_URL,
    ollamaLocalBaseUrl:
      env["LUNA_OLLAMA_BASE_URL"]?.trim() || DEFAULT_OLLAMA_LOCAL_URL,
    modelKindMap: parseModelKindMap(env["LUNA_MODEL_PROVIDER_MAP"]),
  }
}

/** Map a model string → provider `kind`. Precedence: explicit override map →
 * well-known prefix rules → `anthropic` (back-compat default for anything
 * unrecognized, so today's callers are unaffected). */
export function resolveKind(model: string, providerEnv: ProviderEnv): string {
  const m = model.trim()
  const override = providerEnv.modelKindMap[m]
  if (override) return override
  if (/^claude/i.test(m) || /^anthropic/i.test(m) || ANTHROPIC_ALIASES.has(m)) {
    return ANTHROPIC_KIND
  }
  if (/^gemini/i.test(m)) return "google"
  if (/^gpt/i.test(m) || /^o[0-9]/i.test(m)) return "openai"
  if (/:cloud$/i.test(m)) return "ollama-cloud"
  if (/^local\//i.test(m)) return "ollama-local"
  return ANTHROPIC_KIND
}

/** Build the `ProviderProfile` for a `kind`. Unknown kinds fall through to a
 * conservative gateway profile, so a new provider added via `LUNA_MODEL_PROVIDER_MAP`
 * still routes through the gateway without a code change. */
export function profileForKind(kind: string, providerEnv: ProviderEnv): ProviderProfile {
  switch (kind) {
    case ANTHROPIC_KIND:
      // Native Anthropic — no base URL, OAuth token, full Claude capabilities.
      // This branch reproduces the harness's pre-seam behavior exactly.
      return {
        kind,
        authVar: "CLAUDE_CODE_OAUTH_TOKEN",
        capabilities: {
          promptCaching: true,
          toolChoice: true,
          structuredOutput: "anthropic",
        },
      }
    case "google":
      return {
        kind,
        baseUrl: providerEnv.gatewayBaseUrl,
        authVar: "ANTHROPIC_AUTH_TOKEN",
        capabilities: {
          promptCaching: false,
          toolChoice: true,
          structuredOutput: "gemini-response-schema",
        },
      }
    case "openai":
      return {
        kind,
        baseUrl: providerEnv.gatewayBaseUrl,
        authVar: "ANTHROPIC_AUTH_TOKEN",
        capabilities: {
          promptCaching: false,
          toolChoice: true,
          structuredOutput: "none",
        },
      }
    case "ollama-cloud":
      return {
        kind,
        baseUrl: providerEnv.ollamaCloudBaseUrl,
        authVar: "ANTHROPIC_AUTH_TOKEN",
        capabilities: {
          promptCaching: false,
          toolChoice: false,
          structuredOutput: "none",
        },
      }
    case "ollama-local":
      return {
        kind,
        baseUrl: providerEnv.ollamaLocalBaseUrl,
        authVar: "ANTHROPIC_AUTH_TOKEN",
        capabilities: {
          promptCaching: false,
          toolChoice: false,
          structuredOutput: "none",
        },
      }
    default:
      // Unknown kind → route through the gateway (extensible escape hatch).
      return {
        kind,
        baseUrl: providerEnv.gatewayBaseUrl,
        authVar: "ANTHROPIC_AUTH_TOKEN",
        capabilities: {
          promptCaching: false,
          toolChoice: false,
          structuredOutput: "none",
        },
      }
  }
}

/** Resolve a model string to the provider profile that tells the adapter how to
 * point the SDK. `env` is injectable for tests; defaults to `process.env`. */
export function resolveProfile(
  model: string,
  env: Record<string, string | undefined> = process.env,
): ProviderProfile {
  const providerEnv = readProviderEnv(env)
  return profileForKind(resolveKind(model, providerEnv), providerEnv)
}
