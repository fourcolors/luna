/**
 * pricing.test.ts — Tier-1 unit tests for the per-model spend-meter pricing.
 *
 * Pure functions, zero network, env injected explicitly. The load-bearing
 * invariants: the dollar formula matches observability.ts (cacheRead ×0.1,
 * cacheWrite ×1.25, both off pricePerMInput, all over 1e6); unknown models fall
 * back to Sonnet {3,15}; any ollama* kind is always free.
 */
import { describe, expect, it } from "vitest"
import {
  RATE_TABLE,
  rateFor,
  priceTurnUsd,
  readRateTable,
  type ModelRate,
} from "../src/pricing.js"

describe("rateFor — model resolution precedence", () => {
  it("resolves known Anthropic models by prefix", () => {
    expect(rateFor("claude-opus-4-8", "anthropic")).toEqual({
      pricePerMInput: 5,
      pricePerMOutput: 25,
    })
    expect(rateFor("claude-sonnet-4-5", "anthropic")).toEqual({
      pricePerMInput: 3,
      pricePerMOutput: 15,
    })
    expect(rateFor("claude-haiku-4", "anthropic")).toEqual({
      pricePerMInput: 1,
      pricePerMOutput: 5,
    })
  })

  it("resolves fable and mythos by their new RATE_TABLE prefixes (UNKNOWN=0/0 until overridden)", () => {
    // Pricing for these models is not yet published (2026-07); marked as 0/0
    // in the table. Override via LUNA_MODEL_RATES env var when known.
    expect(rateFor("claude-fable-5", "anthropic")).toEqual({
      pricePerMInput: 0,
      pricePerMOutput: 0,
    })
    expect(rateFor("claude-mythos-5", "anthropic")).toEqual({
      pricePerMInput: 0,
      pricePerMOutput: 0,
    })
  })

  it("prices the 'fable' tier alias at the fable table entry", () => {
    expect(rateFor("fable", "anthropic")).toEqual({
      pricePerMInput: 0,
      pricePerMOutput: 0,
    })
  })

  it("resolves known Gemini + GPT/Codex models", () => {
    expect(rateFor("gemini-2.5-flash", "google")).toEqual({
      pricePerMInput: 0.3,
      pricePerMOutput: 2.5,
    })
    expect(rateFor("gemini-3.5-flash-latest", "google")).toEqual({
      pricePerMInput: 1.5,
      pricePerMOutput: 9,
    })
    expect(rateFor("gpt-4.1", "openai")).toEqual({
      pricePerMInput: 2.5,
      pricePerMOutput: 10,
    })
    expect(rateFor("codex-mini", "openai")).toEqual({
      pricePerMInput: 2.5,
      pricePerMOutput: 10,
    })
  })

  it("falls back to Sonnet {3,15} for an unknown model + unknown kind", () => {
    // matches observability.ts's DEFAULT_PRICE_PER_M_INPUT/OUTPUT (3/15)
    expect(rateFor("totally-unknown-model", "mystery-kind")).toEqual({
      pricePerMInput: 3,
      pricePerMOutput: 15,
    })
  })

  it("falls back to the kind-default when the model id is unknown but kind is known", () => {
    // unknown model id, known openai kind -> openai kind-default 2.5/10
    expect(rateFor("o3-secret", "openai")).toEqual({
      pricePerMInput: 2.5,
      pricePerMOutput: 10,
    })
    // unknown model id, known google kind -> gemini-2.5-flash floor 0.30/2.50
    expect(rateFor("gemini-future-pro", "google")).toEqual({
      pricePerMInput: 0.3,
      pricePerMOutput: 2.5,
    })
  })

  it("prices any ollama* kind at {0,0} regardless of the model string", () => {
    expect(rateFor("qwen2.5:cloud", "ollama-cloud")).toEqual({
      pricePerMInput: 0,
      pricePerMOutput: 0,
    })
    expect(rateFor("local/llama3", "ollama-local")).toEqual({
      pricePerMInput: 0,
      pricePerMOutput: 0,
    })
    // even a "claude" model string can't escape the free ollama short-circuit
    expect(rateFor("claude-opus-4-8", "ollama-local")).toEqual({
      pricePerMInput: 0,
      pricePerMOutput: 0,
    })
  })

  it("is case-insensitive on the model id and picks the longest prefix", () => {
    expect(rateFor("CLAUDE-OPUS-4-8", "anthropic")).toEqual({
      pricePerMInput: 5,
      pricePerMOutput: 25,
    })
  })

  it("prices tier ALIASES at their real tier rate, not the kind-default", () => {
    // Regression: "opus" matched no RATE_TABLE prefix → fell to the anthropic
    // kind-default {3,15} (Sonnet) → Opus turns under-metered 40%+.
    expect(rateFor("opus", "anthropic")).toEqual({
      pricePerMInput: 5,
      pricePerMOutput: 25,
    })
    expect(rateFor("sonnet", "anthropic")).toEqual({
      pricePerMInput: 3,
      pricePerMOutput: 15,
    })
    expect(rateFor("haiku", "anthropic")).toEqual({
      pricePerMInput: 1,
      pricePerMOutput: 5,
    })
    // "default" stays at the kind-default floor — the SDK's own default model
    // is unknowable statically; modelUsage-derived real ids correct it live.
    expect(rateFor("default", "anthropic")).toEqual({
      pricePerMInput: 3,
      pricePerMOutput: 15,
    })
    // "fable" alias maps to the claude-fable prefix (0/0 — UNKNOWN price until
    // official pricing is published; operator overrides via LUNA_MODEL_RATES).
    expect(rateFor("fable", "anthropic")).toEqual({
      pricePerMInput: 0,
      pricePerMOutput: 0,
    })
  })
})

describe("priceTurnUsd — formula correctness", () => {
  const sonnet: ModelRate = { pricePerMInput: 3, pricePerMOutput: 15 }

  it("prices plain input + output tokens", () => {
    // 1_000_000 in @3 + 1_000_000 out @15 = $3 + $15 = $18
    expect(
      priceTurnUsd({ tokensIn: 1_000_000, tokensOut: 1_000_000 }, sonnet),
    ).toBeCloseTo(18, 10)
  })

  it("bills cacheRead at 10% of the input rate", () => {
    // 1_000_000 cacheRead @ (3 * 0.1) = $0.30
    expect(
      priceTurnUsd({ tokensIn: 0, tokensOut: 0, cacheRead: 1_000_000 }, sonnet),
    ).toBeCloseTo(0.3, 10)
  })

  it("bills cacheWrite at 125% of the input rate", () => {
    // 1_000_000 cacheWrite @ (3 * 1.25) = $3.75
    expect(
      priceTurnUsd({ tokensIn: 0, tokensOut: 0, cacheWrite: 1_000_000 }, sonnet),
    ).toBeCloseTo(3.75, 10)
  })

  it("combines all four terms exactly like observability.ts", () => {
    // in=2e5@3, out=1e5@15, cacheRead=4e5@0.3, cacheWrite=1e5@3.75
    //  = (200000*3 + 100000*15 + 400000*0.3 + 100000*3.75) / 1e6
    //  = (600000 + 1500000 + 120000 + 375000) / 1e6 = 2595000/1e6 = 2.595
    expect(
      priceTurnUsd(
        {
          tokensIn: 200_000,
          tokensOut: 100_000,
          cacheRead: 400_000,
          cacheWrite: 100_000,
        },
        sonnet,
      ),
    ).toBeCloseTo(2.595, 10)
  })

  it("treats omitted cache fields as zero", () => {
    expect(
      priceTurnUsd({ tokensIn: 1_000_000, tokensOut: 0 }, sonnet),
    ).toBeCloseTo(3, 10)
  })

  it("prices everything to $0 with a free (ollama) rate", () => {
    const free = rateFor("local/llama3", "ollama-local")
    expect(
      priceTurnUsd(
        { tokensIn: 9e6, tokensOut: 9e6, cacheRead: 9e6, cacheWrite: 9e6 },
        free,
      ),
    ).toBe(0)
  })
})

describe("readRateTable — LUNA_MODEL_RATES override", () => {
  it("returns the built-in RATE_TABLE when the env var is missing", () => {
    expect(readRateTable({})).toBe(RATE_TABLE)
  })

  it("merges a JSON override over the default table (per-key replace)", () => {
    const table = readRateTable({
      LUNA_MODEL_RATES: JSON.stringify({
        "claude-opus": { pricePerMInput: 99, pricePerMOutput: 199 },
      }),
    })
    // overridden key replaced
    expect(table["claude-opus"]).toEqual({
      pricePerMInput: 99,
      pricePerMOutput: 199,
    })
    // untouched key still present from the default table
    expect(table["claude-sonnet"]).toEqual({
      pricePerMInput: 3,
      pricePerMOutput: 15,
    })
  })

  it("falls back to RATE_TABLE on malformed JSON (never throws)", () => {
    expect(readRateTable({ LUNA_MODEL_RATES: "{not json" })).toBe(RATE_TABLE)
  })

  it("ignores malformed entries but keeps well-typed ones", () => {
    const table = readRateTable({
      LUNA_MODEL_RATES: JSON.stringify({
        "claude-opus": { pricePerMInput: "nope" }, // bad -> ignored
        "new-model": { pricePerMInput: 7, pricePerMOutput: 14 }, // good -> kept
      }),
    })
    expect(table["claude-opus"]).toEqual({ pricePerMInput: 5, pricePerMOutput: 25 })
    expect(table["new-model"]).toEqual({ pricePerMInput: 7, pricePerMOutput: 14 })
  })
})
