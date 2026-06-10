/**
 * Unit tests for parseUiModels + buildAvailableModels (chat-server.ts).
 *
 * Coverage:
 *   - parseUiModels: happy path, no-label pair (id=label), pair-without-=,
 *     malformed / empty entries, whitespace trimming.
 *   - buildAvailableModels: base list only, extras-first ordering, dedupe by id,
 *     env injection, LUNA_UI_MODELS absent.
 */
import { describe, expect, it } from "vitest"
import { parseUiModels, buildAvailableModels } from "../chat-server.js"

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

describe("buildAvailableModels", () => {
  it("returns the built-in base list when LUNA_UI_MODELS is absent", () => {
    const result = buildAvailableModels({})
    // Base list has exactly 3 entries; order is: Sonnet, Opus, Haiku.
    expect(result).toEqual([
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 — balanced" },
      { id: "claude-opus-4-7",   label: "Claude Opus 4.7 — most capable" },
      { id: "claude-haiku-4-5",  label: "Claude Haiku 4.5 — fastest" },
    ])
  })

  it("prepends LUNA_UI_MODELS extras before the base list (extras-first ordering)", () => {
    const result = buildAvailableModels({
      LUNA_UI_MODELS: "gemini-2.5-flash=Gemini 2.5 Flash",
    })
    // Extra is first (recommended default), base models follow.
    expect(result[0]).toEqual({ id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" })
    expect(result[1]).toEqual({ id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 — balanced" })
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
    })
    // Base Opus and Haiku still present (not overridden).
    expect(result.map((m) => m.id)).toContain("claude-opus-4-7")
    expect(result.map((m) => m.id)).toContain("claude-haiku-4-5")
  })

  it("returns a non-empty list even when LUNA_UI_MODELS is empty/whitespace", () => {
    const result = buildAvailableModels({ LUNA_UI_MODELS: "   " })
    // Falls back to the base list.
    expect(result.length).toBeGreaterThan(0)
    expect(result[0]?.id).toBe("claude-sonnet-4-6")
  })

  it("preserves multiple extras in declaration order before base models", () => {
    const result = buildAvailableModels({
      LUNA_UI_MODELS: "extra-a=Extra A,extra-b=Extra B",
    })
    expect(result[0]?.id).toBe("extra-a")
    expect(result[1]?.id).toBe("extra-b")
    // Base models follow after the extras.
    expect(result[2]?.id).toBe("claude-sonnet-4-6")
  })
})
