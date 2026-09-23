/**
 * Unit tests for parseUiModels + buildAvailableModels + effortsForModel +
 * clampEffort (chat-server.ts).
 *
 * Coverage:
 *   - parseUiModels: happy path, no-label pair (id=label), pair-without-=,
 *     malformed / empty entries, whitespace trimming.
 *   - buildAvailableModels: base list only, extras-first ordering, dedupe by id,
 *     env injection, LUNA_UI_MODELS absent.
 *   - effortsForModel: effort matrix per model family.
 *   - clampEffort: valid / dropped / fallback cases.
 */
import { describe, expect, it } from "vitest"
import {
  parseUiModels,
  buildAvailableModels,
  effortsForModel,
  clampEffort,
  ALL_EFFORTS,
} from "../chat-server.js"

describe("parseUiModels", () => {
  it("returns empty array when input is undefined or empty string", () => {
    expect(parseUiModels(undefined)).toEqual([])
    expect(parseUiModels("")).toEqual([])
    expect(parseUiModels("   ")).toEqual([])
  })

  it("parses a single id=label pair", () => {
    expect(parseUiModels("gemini-2.5-flash=Gemini 2.5 Flash")).toEqual([
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    ])
  })

  it("parses multiple id=label pairs separated by commas", () => {
    expect(
      parseUiModels("model-a=Model A,model-b=Model B"),
    ).toEqual([
      { id: "model-a", label: "Model A" },
      { id: "model-b", label: "Model B" },
    ])
  })

  it("uses id as label when the pair has no = separator", () => {
    expect(parseUiModels("my-model")).toEqual([
      { id: "my-model", label: "my-model" },
    ])
  })

  it("uses id as label when the label portion is empty after =", () => {
    // An entry like "my-model=" should use the id as the label.
    expect(parseUiModels("my-model=")).toEqual([
      { id: "my-model", label: "my-model" },
    ])
  })

  it("trims whitespace around the entry and around =", () => {
    expect(parseUiModels("  model-a  =  Model A  ")).toEqual([
      { id: "model-a", label: "Model A" },
    ])
  })

  it("skips empty entries caused by stray commas", () => {
    expect(parseUiModels(",model-a=A,,model-b=B,")).toEqual([
      { id: "model-a", label: "A" },
      { id: "model-b", label: "B" },
    ])
  })

  it("skips entries whose id is empty after trimming", () => {
    // "=some-label" → id="" → skip
    expect(parseUiModels("=orphan-label")).toEqual([])
  })

  it("handles model ids that contain colons and slashes (local model paths)", () => {
    // e.g. "local/qwen2.5:14b=Qwen 14B (local)"
    expect(parseUiModels("local/qwen2.5:14b=Qwen 14B (local)")).toEqual([
      { id: "local/qwen2.5:14b", label: "Qwen 14B (local)" },
    ])
  })

  it("never throws on completely malformed input", () => {
    // The function must be defensive — bad operators must not crash the server.
    expect(() => parseUiModels("✓✗∞")).not.toThrow()
    expect(() => parseUiModels("a,b,c")).not.toThrow()
  })
})

describe("effortsForModel", () => {
  it("returns [] for Haiku (effort param is a no-op)", () => {
    expect(effortsForModel("claude-haiku-4-5")).toEqual([])
    expect(effortsForModel("claude-haiku-3")).toEqual([])
  })

  it("returns all 5 levels for Fable (maximum-reasoning model)", () => {
    expect(effortsForModel("claude-fable-5")).toEqual(ALL_EFFORTS)
  })

  it("returns all 5 levels for Opus 4.8 (maximum-reasoning model)", () => {
    expect(effortsForModel("claude-opus-4-8")).toEqual(ALL_EFFORTS)
    // dot form
    expect(effortsForModel("claude-opus-4.8")).toEqual(ALL_EFFORTS)
  })

  it("returns all 5 levels for Opus 4.7 (plan §2 frozen matrix: opus-4-(7|8))", () => {
    // The SDK documents xhigh for Opus 4.7+ and max for Opus 4.6+ — an
    // operator configuring claude-opus-4-7 via LUNA_UI_MODELS must get the
    // full effort control, same as 4.8.
    expect(effortsForModel("claude-opus-4-7")).toEqual(ALL_EFFORTS)
    // dot form
    expect(effortsForModel("claude-opus-4.7")).toEqual(ALL_EFFORTS)
  })

  it("returns [low, medium, high, max] for Sonnet 4.6 (no xhigh)", () => {
    expect(effortsForModel("claude-sonnet-4-6")).toEqual(["low", "medium", "high", "max"])
    // dot form
    expect(effortsForModel("claude-sonnet-4.6")).toEqual(["low", "medium", "high", "max"])
  })

  it("returns [] for unknown models (safe default)", () => {
    expect(effortsForModel("gemini-2.5-flash")).toEqual([])
    expect(effortsForModel("local/qwen2.5:14b")).toEqual([])
    expect(effortsForModel("")).toEqual([])
  })

  it("is case-insensitive", () => {
    expect(effortsForModel("CLAUDE-HAIKU-4-5")).toEqual([])
    expect(effortsForModel("Claude-Sonnet-4-6")).toEqual(["low", "medium", "high", "max"])
  })
})

describe("clampEffort", () => {
  it("returns { dropped: false } when effort is undefined", () => {
    expect(clampEffort("claude-sonnet-4-6", undefined)).toEqual({ dropped: false })
  })

  it("passes through valid effort unchanged", () => {
    expect(clampEffort("claude-sonnet-4-6", "high")).toEqual({ effort: "high", dropped: false })
  })

  it("drops effort when model has no effort support (e.g. Haiku)", () => {
    expect(clampEffort("claude-haiku-4-5", "high")).toEqual({ dropped: true })
  })

  it("falls back to highest supported level when effort is unsupported for model", () => {
    // Sonnet 4.6 supports [low, medium, high, max] but NOT xhigh
    expect(clampEffort("claude-sonnet-4-6", "xhigh")).toEqual({ effort: "max", dropped: false })
  })

  it("passes through effort unchanged when modelId is undefined", () => {
    expect(clampEffort(undefined, "max")).toEqual({ effort: "max", dropped: false })
  })

  it("passes through all valid efforts for Fable", () => {
    for (const effort of ALL_EFFORTS) {
      const result = clampEffort("claude-fable-5", effort)
      expect(result).toEqual({ effort, dropped: false })
    }
  })
})

describe("buildAvailableModels", () => {
  // The shipped catalog, asserted exactly. This is a DELIBERATE guard: an
  // unintended change to what the UI offers should fail here. When the catalog
  // legitimately changes (as in #387, which added Mythos 5 / Opus 5 and made
  // Sonnet 5 xhigh-capable), update this list in the same commit.
  const ALL_LEVELS_PLUS_ULTRACODE = ["low", "medium", "high", "xhigh", "max", "ultracode"]
  const THROUGH_MAX = ["low", "medium", "high", "max"]

  it("returns the built-in base list when LUNA_UI_MODELS is absent", () => {
    const result = buildAvailableModels({})
    // Order is: Opus 5.5 (default), Sonnet 5, Fable 5, Fable 5.1, Mythos 5,
    // Opus 5, Opus 4.8, Sonnet 4.6, Haiku 4.5. Mythos 5 and Haiku 4.5 take no
    // effort param. Opus 5.5 is the only model defaulting to "medium".
    expect(result).toEqual([
      { id: "claude-opus-5-5",   label: "Claude Opus 5.5 — recommended default",   efforts: ALL_LEVELS_PLUS_ULTRACODE, defaultEffort: "medium" },
      { id: "claude-sonnet-5",   label: "Claude Sonnet 5 — balanced",              efforts: ALL_LEVELS_PLUS_ULTRACODE, defaultEffort: "high" },
      { id: "claude-fable-5",    label: "Fable 5 (1M context, xhigh reasoning)",   efforts: ALL_LEVELS_PLUS_ULTRACODE, defaultEffort: "high" },
      { id: "claude-fable-5-1",  label: "Fable 5.1 (1M context, xhigh reasoning)", efforts: ALL_LEVELS_PLUS_ULTRACODE, defaultEffort: "high" },
      { id: "claude-mythos-5",   label: "Mythos 5 (1M context, first-party only)", efforts: [] },
      { id: "claude-opus-5",     label: "Opus 5 (1M context, xhigh reasoning)",    efforts: ALL_LEVELS_PLUS_ULTRACODE, defaultEffort: "high" },
      { id: "claude-opus-4-8",   label: "Claude Opus 4.8 — prior gen",             efforts: ALL_LEVELS_PLUS_ULTRACODE },
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 — prior gen",           efforts: THROUGH_MAX },
      { id: "claude-haiku-4-5",  label: "Claude Haiku 4.5 — fastest",              efforts: [] },
    ])
  })

  it("prepends LUNA_UI_MODELS extras before the base list (extras-first ordering)", () => {
    const result = buildAvailableModels({
      LUNA_UI_MODELS: "gemini-2.5-flash=Gemini 2.5 Flash",
    })
    // Extra is first (recommended default), base models follow.
    expect(result[0]).toEqual({ id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", efforts: [] })
    expect(result[1]).toEqual({ id: "claude-opus-5-5", label: "Claude Opus 5.5 — recommended default", efforts: ALL_LEVELS_PLUS_ULTRACODE, defaultEffort: "medium" })
  })

  it("dedupes by id — extra overrides base model of same id (keeps extra's position and label)", () => {
    // Override the built-in Sonnet entry with a custom label.
    const result = buildAvailableModels({
      LUNA_UI_MODELS: "claude-sonnet-4-6=My Custom Sonnet Label",
    })
    // The override appears first (extras-first); the base Sonnet is deduplicated.
    const sonnetEntries = result.filter((m) => m.id === "claude-sonnet-4-6")
    expect(sonnetEntries).toHaveLength(1)
    expect(sonnetEntries[0]).toEqual({
      id: "claude-sonnet-4-6",
      label: "My Custom Sonnet Label",
      efforts: ["low", "medium", "high", "max"],
    })
    // Base Fable, Opus, and Haiku still present (not overridden).
    expect(result.map((m) => m.id)).toContain("claude-fable-5")
    expect(result.map((m) => m.id)).toContain("claude-opus-4-8")
    expect(result.map((m) => m.id)).toContain("claude-haiku-4-5")
  })

  it("returns a non-empty list even when LUNA_UI_MODELS is empty/whitespace", () => {
    const result = buildAvailableModels({ LUNA_UI_MODELS: "   " })
    // Falls back to the base list.
    expect(result.length).toBeGreaterThan(0)
    expect(result[0]?.id).toBe("claude-opus-5-5")
  })

  it("preserves multiple extras in declaration order before base models", () => {
    const result = buildAvailableModels({
      LUNA_UI_MODELS: "extra-a=Extra A,extra-b=Extra B",
    })
    expect(result[0]?.id).toBe("extra-a")
    expect(result[1]?.id).toBe("extra-b")
    // Base models follow after the extras.
    expect(result[2]?.id).toBe("claude-opus-5-5")
  })

  it("attaches effort matrix to extras via effortsForModel", () => {
    // Extra using a known model id should get its effort matrix filled in.
    const result = buildAvailableModels({
      LUNA_UI_MODELS: "claude-opus-4-8=My Opus",
    })
    const entry = result.find((m) => m.id === "claude-opus-4-8")
    expect(entry?.efforts).toEqual(["low", "medium", "high", "xhigh", "max", "ultracode"])
  })

  it("advertises a defaultEffort for exactly the xhigh-reasoning Claude 5 models", () => {
    const result = buildAvailableModels({})
    // Fable 5 / Fable 5.1 / Opus 5 / Sonnet 5 carry default_effort "high".
    // Opus 5.5 is the deliberate exception: it is the recommended default
    // model, so it starts one notch lower at "medium" to keep the default
    // thread's cost and latency reasonable. Every other base model has no
    // opinion and advertises no defaultEffort at all.
    const withDefault = result.filter((m) => m.defaultEffort !== undefined)
    expect(withDefault.map((m) => m.id).sort()).toEqual([
      "claude-fable-5",
      "claude-fable-5-1",
      "claude-opus-5",
      "claude-opus-5-5",
      "claude-sonnet-5",
    ])
    for (const m of withDefault) {
      expect(m.defaultEffort).toBe(m.id === "claude-opus-5-5" ? "medium" : "high")
    }
  })

  // Regression pin for a substring-precedence trap: "opus-5" is a SUBSTRING of
  // "claude-opus-5-5", so the generic /opus-5/ branch in defaultEffortForModel
  // matches 5.5 too. If the 5.5 branch is ever reordered after it, 5.5 would
  // silently inherit "high" and this test is the thing that catches it.
  it("Opus 5.5 does not inherit Opus 5's 'high' default via substring match", () => {
    const result = buildAvailableModels({})
    const opus55 = result.find((m) => m.id === "claude-opus-5-5")
    const opus5 = result.find((m) => m.id === "claude-opus-5")
    expect(opus55?.defaultEffort).toBe("medium")
    expect(opus5?.defaultEffort).toBe("high")
    // ...and 5.5 still gets the full xhigh-capable effort matrix from the same
    // generic branch, so the narrower default did not cost it any capability.
    expect(opus55?.efforts).toEqual(ALL_LEVELS_PLUS_ULTRACODE)
  })

  // Contract test rather than a catalog snapshot: this holds for ANY future
  // model, so adding one to BASE_MODELS cannot rot it - but shipping a default
  // the model does not actually support still fails here. Guards the invariant
  // documented on defaultEffortForModel ("a defined return value is ALWAYS a
  // member of effortsForModel(id)"), which otherwise only bites at runtime when
  // clampEffort silently rewrites the advertised default.
  it("every advertised defaultEffort is one of that model's own efforts", () => {
    for (const m of buildAvailableModels({})) {
      if (m.defaultEffort === undefined) continue
      expect(m.efforts).toContain(m.defaultEffort)
    }
  })

  // A model with no effort matrix must not advertise a default either, or the
  // client would render a default for a dropdown that has no options.
  it("a model with no efforts never advertises a defaultEffort", () => {
    for (const m of buildAvailableModels({})) {
      if (m.efforts.length === 0) expect(m.defaultEffort).toBeUndefined()
    }
  })
})
