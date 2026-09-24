/**
 * The shared Jev request is the exact one the held-out comparison measured;
 * pin it byte for byte so a wording "tweak" cannot silently invalidate the
 * evidence behind LUNA_RERANK_ENGINE=jev.
 */
import { describe, expect, it } from "vitest"
import { JEV_MODEL, estimateJevTokens, jevRequestBatches, jevRerankRequest, parseJevRerankAnswers } from "./jev.js"

describe("jevRerankRequest", () => {
  it("is the benchmarked request: state = the query, one Noul per memory, memories capped at 2,000 characters", () => {
    expect(JSON.stringify(jevRerankRequest("dog name?", ["My dog is Biscuit.", "x".repeat(2_500)]))).toBe(
      JSON.stringify({
        model: JEV_MODEL,
        state: { query: "dog name?" },
        questions: {
          c0: {
            type: "noul",
            instructions: {
              task: "Is the `memory` relevant to the search `query` (in state): does it contain what the query asks about or describes?",
              memory: "My dog is Biscuit.",
            },
            criteria: {
              true: "The memory states facts that answer, match, or directly bear on what the query asks about or describes.",
              false: "The memory is about something else, or only shares words or a topic with the query.",
            },
          },
          c1: {
            type: "noul",
            instructions: {
              task: "Is the `memory` relevant to the search `query` (in state): does it contain what the query asks about or describes?",
              memory: "x".repeat(2_000),
            },
            criteria: {
              true: "The memory states facts that answer, match, or directly bear on what the query asks about or describes.",
              false: "The memory is about something else, or only shares words or a topic with the query.",
            },
          },
        },
      }),
    )
    expect(JEV_MODEL).toBe("jev-1.13.0")
  })
})

describe("parseJevRerankAnswers", () => {
  it("returns probabilities in candidate order and the served model", () => {
    expect(parseJevRerankAnswers({ model: "jev-1.13.0", answers: { c1: { noul: 0.9 }, c0: { noul: 0.1 } } }, 2)).toEqual({
      probabilities: [0.1, 0.9],
      servedModel: "jev-1.13.0",
    })
  })

  it("rejects a missing, non-numeric, or out-of-range answer instead of returning a partial ranking", () => {
    expect(() => parseJevRerankAnswers({ answers: { c0: { noul: 0.1 } } }, 2)).toThrow(/c1/)
    expect(() => parseJevRerankAnswers({ answers: { c0: { noul: "0.1" } } }, 1)).toThrow(/c0/)
    expect(() => parseJevRerankAnswers({ answers: { c0: { noul: 1.5 } } }, 1)).toThrow(/c0/)
    expect(() => parseJevRerankAnswers(null, 1)).toThrow(/c0/)
  })
})

describe("jevRequestBatches", () => {
  it("40 English memories at the cap are one request - the benchmarked shape", () => {
    expect(jevRequestBatches(Array.from({ length: 40 }, () => "a".repeat(2_000)))).toEqual([Array.from({ length: 40 }, (_, i) => i)])
  })

  it("long non-Latin memories split into requests under the budget, preserving order", () => {
    const batches = jevRequestBatches(Array.from({ length: 40 }, () => "記".repeat(2_000)))
    expect(batches.length).toBeGreaterThan(1)
    expect(batches.flat()).toEqual(Array.from({ length: 40 }, (_, i) => i))
  })

  it("estimateJevTokens counts ~4 ASCII characters per token and 1 per other character", () => {
    expect(estimateJevTokens("abcd")).toBe(1)
    expect(estimateJevTokens("記記")).toBe(2)
    expect(estimateJevTokens("")).toBe(0)
  })
})
