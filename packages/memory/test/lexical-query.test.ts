import { describe, expect, it } from "vitest"
import {
  MAX_EXPANSION_PHRASES,
  MAX_LEXICAL_TERMS,
  expansionMatch,
  extractTerms,
  minMatchTermsMatch,
  quoteFts,
  termsMatch,
  weightedRrf,
} from "../src/lexical-query.js"

describe("lexical-query", () => {
  it("extractTerms: unicode words, lower-cased, deduped, first-seen order", () => {
    expect(extractTerms("Café CAFÉ naïve 東京 x_y don't")).toEqual(["café", "naïve", "東京", "x", "y", "don", "t"])
  })

  it("extractTerms: combining marks stay inside words; NFKC folds compatibility forms", () => {
    expect(extractTerms("नमस्ते")).toEqual(["नमस्ते"])
    expect(extractTerms("ｆｕｌｌ ﬁle")).toEqual(["full", "file"])
    expect(extractTerms("cafe\u0301")).toEqual(["café"])
  })

  it("extractTerms: stopword sets keep question words", () => {
    const q = "What did I tell you about the dog when we moved?"
    expect(extractTerms(q, "none")).toContain("the")
    expect(extractTerms(q, "lucene")).toEqual(["what", "did", "i", "tell", "you", "about", "dog", "when", "we", "moved"])
    expect(extractTerms(q, "extended")).toEqual(["what", "tell", "dog", "when", "moved"])
    expect(extractTerms(q, "question")).toEqual(["tell", "dog", "moved"])
  })

  it("extractTerms: caps long inputs (whole chat messages) at MAX_LEXICAL_TERMS", () => {
    const long = Array.from({ length: 100 }, (_, i) => `w${i}`).join(" ")
    expect(extractTerms(long)).toHaveLength(MAX_LEXICAL_TERMS)
  })

  it("quoteFts / termsMatch: every token quoted, embedded quotes doubled, empty stays empty", () => {
    expect(quoteFts('say "hi"')).toBe('"say ""hi"""')
    expect(termsMatch(["a", "b"])).toBe('"a" OR "b"')
    expect(termsMatch([])).toBe("")
  })

  it("expansionMatch: multi-word keywords become phrases; FTS5 syntax is stripped; dupes dropped", () => {
    expect(expansionMatch(["golden retriever", "Golden  Retriever!", 'dog*" OR NEAR(', "   "])).toBe(
      '"golden retriever" OR "dog or near"',
    )
    expect(expansionMatch(["the", "of"], "lucene")).toBe("")
  })

  it("expansionMatch: drops keywords that restate a query term; caps phrases and words", () => {
    expect(expansionMatch(["dog", "puppy", "Dog"], "none", ["dog"])).toBe('"puppy"')
    const many = Array.from({ length: 20 }, (_, i) => `k${i}`)
    expect(expansionMatch(many).split(" OR ")).toHaveLength(MAX_EXPANSION_PHRASES)
    expect(expansionMatch(["a b c d e f g h"])).toBe('"a b c d e f"')
  })

  it("weightedRrf: sum of weight/(k+rank); zero-weight lists ignored; ties keep first-list order", () => {
    const fused = weightedRrf(
      [
        { ids: ["a", "b"], weight: 1 },
        { ids: ["b", "c"], weight: 0.5 },
        { ids: ["z"], weight: 0 },
      ],
      60,
    )
    expect(fused.map((f) => f.id)).toEqual(["b", "a", "c"])
    expect(fused[0]!.score).toBeCloseTo(1 / 62 + 0.5 / 61, 12)
    expect(fused.find((f) => f.id === "z")).toBeUndefined()
    expect(weightedRrf([{ ids: ["x", "y"], weight: 1 }, { ids: ["y", "x"], weight: 1 }]).map((f) => f.id)).toEqual(["x", "y"])
  })

  it("minMatchTermsMatch: 1 = plain OR; 2 = OR of AND-pairs; single term falls back; pairs capped", () => {
    expect(minMatchTermsMatch(["a", "b"], 1)).toBe('"a" OR "b"')
    expect(minMatchTermsMatch(["a", "b", "c"], 2)).toBe('("a" AND "b") OR ("a" AND "c") OR ("b" AND "c")')
    expect(minMatchTermsMatch(["a"], 2)).toBe('"a"')
    const many = Array.from({ length: 20 }, (_, i) => `t${i}`)
    expect(minMatchTermsMatch(many, 2).split(" OR ")).toHaveLength(66)
    expect(() => minMatchTermsMatch(["a", "b"], 3)).toThrow(/unsupported/)
  })
})
