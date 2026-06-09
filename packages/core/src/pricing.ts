// packages/core/src/pricing.ts
//
// Per-model token→USD pricing (concept "spend-meter", rev-2). A data-only rate
// table + pure pricing functions, deliberately split out of observability so the
// account-broker / overflow-chain can price a turn WITHOUT pulling in the
// Effect-based ObservabilityApi.
//
// SDK-FREE BY DESIGN: no `@anthropic-ai/*`, no adapter-sdk — plain data + pure
// functions, mirroring provider-profile.ts. The dollar formula is the SAME one
// observability.ts uses at its `recordCost` site (token×price + cacheRead×0.1 +
// cacheWrite×1.25, all over 1e6), kept in lock-step so both surfaces agree.

/** USD price per MILLION tokens, split by direction. */
export interface ModelRate {
  readonly pricePerMInput: number
  readonly pricePerMOutput: number
}

/**
 * RATE_TABLE keys are MODEL-ID PREFIXES, matched case-insensitively and
 * longest-prefix-first by `rateFor` (e.g. the literal `"claude-opus-4"`
 * matches any `claude-opus-4-*` id). They are NOT provider `kind`s — the
 * kind-default tier is served by KIND_DEFAULTS below. Prices are $/M-tokens
 * (input / output) as of 2026-06; refine via LUNA_MODEL_RATES at runtime.
 */
export const RATE_TABLE: Record<string, ModelRate> = {
  // Anthropic Claude
  "claude-opus": { pricePerMInput: 5, pricePerMOutput: 25 },
  "claude-sonnet": { pricePerMInput: 3, pricePerMOutput: 15 },
  "claude-haiku": { pricePerMInput: 1, pricePerMOutput: 5 },
  // Google Gemini
  "gemini-2.5-flash": { pricePerMInput: 0.3, pricePerMOutput: 2.5 },
  "gemini-3.5-flash": { pricePerMInput: 1.5, pricePerMOutput: 9 },
  // OpenAI GPT / Codex
  gpt: { pricePerMInput: 2.5, pricePerMOutput: 10 },
  codex: { pricePerMInput: 2.5, pricePerMOutput: 10 },
  // Ollama (self-hosted / free)
  ollama: { pricePerMInput: 0, pricePerMOutput: 0 },
}

/** Sonnet fallback — matches observability.ts's unknown-model default (3/15). */
const FALLBACK_RATE: ModelRate = { pricePerMInput: 3, pricePerMOutput: 15 }

const FREE_RATE: ModelRate = { pricePerMInput: 0, pricePerMOutput: 0 }

/**
 * Representative rate per provider `kind` (the broker's routing key, see
 * provider-profile.ts). Used when the exact model id isn't in RATE_TABLE but the
 * kind is known. `google` is ambiguous (two geminis priced); we default it to
 * the cheaper gemini-2.5-flash (0.30/2.50) as the conservative floor estimate.
 */
const KIND_DEFAULTS: Record<string, ModelRate> = {
  anthropic: { pricePerMInput: 3, pricePerMOutput: 15 }, // Sonnet-class default
  google: { pricePerMInput: 0.3, pricePerMOutput: 2.5 }, // gemini-2.5-flash floor
  openai: { pricePerMInput: 2.5, pricePerMOutput: 10 }, // gpt/codex
  // ollama-* handled by the explicit short-circuit in rateFor (always free).
}

/**
 * Resolve a {@link ModelRate} for a model id + provider kind.
 *
 * Precedence:
 *   1. Any `ollama*` kind → {0,0} (free, regardless of model string).
 *   2. Exact model match — longest RATE_TABLE prefix the (lowercased) id has.
 *   3. Kind-default (KIND_DEFAULTS).
 *   4. Sonnet fallback {3,15} — matches observability's unknown default.
 */
export function rateFor(model: string, kind: string): ModelRate {
  // (1) ollama-cloud / ollama-local / any future ollama* kind → free.
  if (kind.toLowerCase().startsWith("ollama")) return FREE_RATE

  // (2) exact model → longest matching prefix wins (so "claude-opus" beats a
  // hypothetical shorter "claude").
  const m = model.trim().toLowerCase()
  let best: ModelRate | undefined
  let bestLen = -1
  for (const [prefix, rate] of Object.entries(RATE_TABLE)) {
    if (m.startsWith(prefix.toLowerCase()) && prefix.length > bestLen) {
      best = rate
      bestLen = prefix.length
    }
  }
  if (best) return best

  // (3) kind-default.
  const byKind = KIND_DEFAULTS[kind]
  if (byKind) return byKind

  // (4) Sonnet fallback.
  return FALLBACK_RATE
}

/**
 * Price one turn's token usage in USD. Mirrors observability.ts's `recordCost`
 * formula EXACTLY: cache-read tokens are billed at 10% of the input rate, and
 * cache-write tokens at 125% of the input rate (both relative to
 * `pricePerMInput`, never the output rate). `rate` is passed in (resolve it via
 * {@link rateFor} at the call site) so this stays a pure arithmetic function.
 */
export function priceTurnUsd(
  u: {
    tokensIn: number
    tokensOut: number
    cacheRead?: number
    cacheWrite?: number
  },
  rate: ModelRate,
): number {
  return (
    (u.tokensIn * rate.pricePerMInput +
      u.tokensOut * rate.pricePerMOutput +
      (u.cacheRead ?? 0) * rate.pricePerMInput * 0.1 +
      (u.cacheWrite ?? 0) * rate.pricePerMInput * 1.25) /
    1_000_000
  )
}

/**
 * Read the effective rate table, allowing a runtime override via the
 * `LUNA_MODEL_RATES` env var (a JSON object of `{ "<model-prefix>": {
 * "pricePerMInput": n, "pricePerMOutput": n } }`). Overrides are MERGED over the
 * built-in RATE_TABLE (per-key replace), so an operator can re-price one model
 * without restating the whole table. Mirrors readProviderEnv's injectable-env
 * style; malformed / missing JSON falls back to RATE_TABLE without throwing.
 */
export function readRateTable(
  env: Record<string, string | undefined> = process.env,
): Record<string, ModelRate> {
  const raw = env["LUNA_MODEL_RATES"]?.trim()
  if (!raw) return RATE_TABLE
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== "object") return RATE_TABLE
    const merged: Record<string, ModelRate> = { ...RATE_TABLE }
    for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
      if (val === null || typeof val !== "object") continue
      const v = val as { pricePerMInput?: unknown; pricePerMOutput?: unknown }
      if (
        typeof v.pricePerMInput === "number" &&
        typeof v.pricePerMOutput === "number"
      ) {
        merged[key] = {
          pricePerMInput: v.pricePerMInput,
          pricePerMOutput: v.pricePerMOutput,
        }
      }
    }
    return merged
  } catch {
    return RATE_TABLE
  }
}
