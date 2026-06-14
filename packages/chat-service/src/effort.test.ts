import { describe, it, expect } from "vitest"
import {
  EFFORT_LEVELS,
  effortsForModel,
  clampEffort,
  effortOptionsForModel,
  modelSupportsUltracode,
  isEffort,
  isUltracode,
  ULTRACODE,
  ultracodeFlagSettings,
} from "./effort.js"

const XHIGH_CAPABLE = ["claude-opus-4-8", "claude-opus-4-7", "claude-fable-5"]
const NOT_CAPABLE = ["claude-sonnet-4-6", "claude-haiku-4-5", "some-unknown-model"]

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
