import { describe, it, expect } from "vitest"
import {
  EFFORT_LEVELS,
  effortsForModel,
  clampEffort,
  defaultEffortForModel,
  effortOptionsForModel,
  modelSupportsUltracode,
  isEffort,
  isUltracode,
  ULTRACODE,
  ultracodeFlagSettings,
} from "./effort.js"

// SDK @anthropic-ai/claude-agent-sdk@0.3.202/0.3.219: xhigh_effort capability
// fable-5, opus-4-7, opus-4-8, opus-5, sonnet-5 all have xhigh_effort
const XHIGH_CAPABLE = [
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-fable-5",
  "claude-fable-5-1",  // SDK 0.3.257: same xhigh_effort capability as fable-5
  "claude-opus-5",
  "claude-sonnet-5",
]
// These models have no xhigh: haiku (no effort), sonnet-4-6 (max only),
// mythos-5 (no effort), unknown models
const NOT_CAPABLE = [
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
  "claude-mythos-5",
  "some-unknown-model",
]

describe("ultracode menu/token helpers", () => {
  it("advertises ultracode only for xhigh-capable models, appended last", () => {
    for (const id of XHIGH_CAPABLE) {
      const opts = effortOptionsForModel(id)
      expect(opts).toContain(ULTRACODE)
      // Strongest = last, so it is never the <select>'s default (options[0]).
      expect(opts[opts.length - 1]).toBe(ULTRACODE)
      expect(opts[0]).not.toBe(ULTRACODE)
      expect(modelSupportsUltracode(id)).toBe(true)
    }
  })

  it("never advertises ultracode for non-xhigh models", () => {
    for (const id of NOT_CAPABLE) {
      expect(effortOptionsForModel(id)).not.toContain(ULTRACODE)
      expect(modelSupportsUltracode(id)).toBe(false)
    }
  })

  it("keeps ultracode OUT of the real-effort matrix (no illegal SDK effort leak)", () => {
    // The clamp/Options.effort matrix must stay the five real levels.
    expect(EFFORT_LEVELS as readonly string[]).not.toContain("ultracode")
    expect(effortsForModel("claude-opus-4-8")).not.toContain("ultracode")
    // clampEffort must fall back to the strongest REAL effort, never a token:
    // sonnet has no xhigh, so xhigh clamps to "max" — not "ultracode".
    expect(clampEffort("claude-sonnet-4-6", "xhigh").effort).toBe("max")
    // The guards keep the two worlds apart.
    expect(isEffort(ULTRACODE)).toBe(false)
    expect(isUltracode(ULTRACODE)).toBe(true)
    expect(isUltracode("high")).toBe(false)
  })
})

describe("ultracodeFlagSettings — the ultracode Settings demux", () => {
  it("returns a Settings partial that enables workflows + ultracode", () => {
    const s = ultracodeFlagSettings()
    expect(s.enableWorkflows).toBe(true)
    expect(s.ultracode).toBe(true)
  })
})

describe("Sonnet 5 effort matrix", () => {
  // SDK @anthropic-ai/claude-agent-sdk@0.3.202: claude-sonnet-5 has
  // xhigh_effort capability (unlike sonnet-4-6 which only has max_effort).
  it("exposes all five effort levels including xhigh (SDK: xhigh_effort cap)", () => {
    expect(effortsForModel("claude-sonnet-5")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ])
  })

  it("does NOT match the prior-gen claude-sonnet-4-5 (matrix-less)", () => {
    // "claude-sonnet-4-5" contains the substring "sonnet-4-5", not "sonnet-5",
    // so the /sonnet-5/ branch must not fire for it.
    expect(effortsForModel("claude-sonnet-4-5")).toEqual([])
  })

  it("passes xhigh through for sonnet-5 (now supported)", () => {
    expect(clampEffort("claude-sonnet-5", "xhigh").effort).toBe("xhigh")
  })
})

describe("Sonnet 4.6 effort matrix", () => {
  // SDK: claude-sonnet-4-6 has effort+max_effort but NOT xhigh_effort.
  it("exposes low/medium/high/max (no xhigh)", () => {
    expect(effortsForModel("claude-sonnet-4-6")).toEqual([
      "low",
      "medium",
      "high",
      "max",
    ])
  })

  it("clamps an unsupported xhigh down to max for sonnet-4-6", () => {
    expect(clampEffort("claude-sonnet-4-6", "xhigh").effort).toBe("max")
  })
})

describe("Mythos 5 effort matrix", () => {
  // SDK: claude-mythos-5 has empty capabilities[] — no effort param supported.
  it("returns no effort levels for mythos-5", () => {
    expect(effortsForModel("claude-mythos-5")).toEqual([])
  })

  it("drops effort when passed to mythos-5 (clamp → dropped)", () => {
    expect(clampEffort("claude-mythos-5", "high").dropped).toBe(true)
  })
})

describe("defaultEffortForModel — per-model default effort", () => {
  // SDK: claude-sonnet-5 default_effort "high"; claude-fable-5 default_effort "high"
  it("defaults Sonnet 5 to 'high'", () => {
    expect(defaultEffortForModel("claude-sonnet-5")).toBe("high")
  })

  it("defaults Fable 5 to 'high' (SDK: default_effort: high)", () => {
    expect(defaultEffortForModel("claude-fable-5")).toBe("high")
  })

  it("defaults Fable 5.1 to 'high' (SDK 0.3.257: same default_effort as fable-5)", () => {
    expect(defaultEffortForModel("claude-fable-5-1")).toBe("high")
  })

  it("defaults Opus 5 to 'high' (SDK 0.3.219: default_effort: high)", () => {
    expect(defaultEffortForModel("claude-opus-5")).toBe("high")
  })

  it("returns a value that is always a member of the model's effort matrix", () => {
    for (const id of ["claude-sonnet-5", "claude-fable-5", "claude-opus-5"]) {
      const dflt = defaultEffortForModel(id)
      expect(dflt).toBeDefined()
      expect(effortsForModel(id)).toContain(dflt!)
    }
  })

  it("has no opinion (undefined) for other models", () => {
    for (const id of [
      "claude-opus-4-8",
      "claude-sonnet-4-6",
      "claude-sonnet-4-5",
      "claude-haiku-4-5",
      "claude-mythos-5",
      "some-unknown-model",
    ]) {
      expect(defaultEffortForModel(id)).toBeUndefined()
    }
  })

  it("never returns the ultracode token", () => {
    expect(isUltracode(defaultEffortForModel("claude-sonnet-5"))).toBe(false)
    expect(isUltracode(defaultEffortForModel("claude-fable-5"))).toBe(false)
  })
})
