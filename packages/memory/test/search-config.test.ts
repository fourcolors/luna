import { describe, expect, it } from "vitest"
import { expansionFor, parseSearchConfig, parseSearchConfigs, type ExpansionSidecar } from "../src/search-config.js"

describe("search-config", () => {
  it("parses plain modes and hybrid-weighted knobs", () => {
    expect(parseSearchConfig("hybrid")).toEqual({ label: "hybrid", mode: "hybrid" })
    expect(parseSearchConfig("hybrid-weighted:w=0.25:s=extended:e=0.5:kw=haiku#2")).toEqual({
      label: "hybrid-weighted:w=0.25:s=extended:e=0.5:kw=haiku#2",
      mode: "hybrid-weighted",
      fusion: { lexicalWeight: 0.25, stopwords: "extended", expansionWeight: 0.5 },
      expansion: { model: "haiku", sample: 2 },
    })
  })

  it("rejects bad modes, knobs on the wrong mode, bad values, and duplicates", () => {
    expect(() => parseSearchConfig("hybrd")).toThrow(/unknown mode/)
    expect(() => parseSearchConfig("hybrid:w=1")).toThrow(/only applies to hybrid-weighted/)
    expect(() => parseSearchConfig("hybrid-weighted:w=-1")).toThrow(/>= 0/)
    expect(() => parseSearchConfig("hybrid-weighted:w=")).toThrow(/>= 0/)
    expect(() => parseSearchConfig("hybrid-weighted:s=klingon")).toThrow(/s must be one of/)
    expect(() => parseSearchConfig("hybrid-weighted:kw=haiku")).toThrow(/<model>#<sample>/)
    expect(() => parseSearchConfig("vec:kw=haiku#0")).toThrow(/only has an effect/)
    expect(() => parseSearchConfigs("hybrid, hybrid")).toThrow(/twice/)
    expect(() => parseSearchConfigs(" , ")).toThrow(/no search configs/)
  })

  it("expansionFor: none without kw, the named sample with it, loud error when missing", () => {
    const sidecar: ExpansionSidecar = {
      source: "x",
      model: "haiku",
      promptHash: "h",
      samples: 2,
      keywords: { q1: [["a"], ["b", "c"]] },
    }
    const sidecars = new Map([["haiku", sidecar]])
    expect(expansionFor(parseSearchConfig("hybrid-weighted"), "q1", sidecars)).toBeUndefined()
    expect(expansionFor(parseSearchConfig("hybrid-weighted:kw=haiku#1"), "q1", sidecars)).toEqual(["b", "c"])
    expect(() => expansionFor(parseSearchConfig("hybrid-weighted:kw=haiku#1"), "q2", sidecars)).toThrow(/no sample/)
    expect(() => expansionFor(parseSearchConfig("hybrid-weighted:kw=sonnet#0"), "q1", sidecars)).toThrow(/no expansion sidecar/)
  })
})
