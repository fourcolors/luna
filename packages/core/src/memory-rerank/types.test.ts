import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import {
  applyRerank,
  FakeReranker,
  MemoryReranker,
  PassthroughReranker,
  type RerankCandidateInput,
  type RerankScore,
} from "./types.js"

// ---------------------------------------------------------------------------
// applyRerank — pure gating helper
// ---------------------------------------------------------------------------

interface TestCandidate {
  readonly id: string
  readonly text: string
}

const cand = (id: string): TestCandidate => ({ id, text: `text-${id}` })

describe("applyRerank", () => {
  it("orders scored candidates by llmScore descending", () => {
    const candidates = [cand("a"), cand("b"), cand("c")]
    const scores: RerankScore[] = [
      { id: "a", llmScore: 50 },
      { id: "b", llmScore: 90 },
      { id: "c", llmScore: 70 },
    ]
    const result = applyRerank(candidates, scores, { threshold: 0 })
    expect(result.kept.map((k) => k.candidate.id)).toEqual(["b", "c", "a"])
    expect(result.kept.map((k) => k.llmScore)).toEqual([90, 70, 50])
    expect(result.keptCount).toBe(3)
    expect(result.droppedCount).toBe(0)
  })

  it("tie-breaks equal scores by original retrieval-order index", () => {
    const candidates = [cand("a"), cand("b"), cand("c")]
    const scores: RerankScore[] = [
      { id: "a", llmScore: 80 },
      { id: "b", llmScore: 80 },
      { id: "c", llmScore: 80 },
    ]
    const result = applyRerank(candidates, scores, { threshold: 0 })
    // All tied -> original order (a, b, c) preserved.
    expect(result.kept.map((k) => k.candidate.id)).toEqual(["a", "b", "c"])
  })

  it("drops scored candidates below threshold and reports the count", () => {
    const candidates = [cand("a"), cand("b"), cand("c")]
    const scores: RerankScore[] = [
      { id: "a", llmScore: 90 },
      { id: "b", llmScore: 40 },
      { id: "c", llmScore: 74 },
    ]
    const result = applyRerank(candidates, scores, { threshold: 75 })
    expect(result.kept.map((k) => k.candidate.id)).toEqual(["a"])
    expect(result.keptCount).toBe(1)
    expect(result.droppedCount).toBe(2)
  })

  it("threshold is inclusive (score === threshold survives)", () => {
    const candidates = [cand("a")]
    const scores: RerankScore[] = [{ id: "a", llmScore: 75 }]
    const result = applyRerank(candidates, scores, { threshold: 75 })
    expect(result.kept.map((k) => k.candidate.id)).toEqual(["a"])
    expect(result.droppedCount).toBe(0)
  })

  it("empty scores: every candidate is treated as unscored and kept, in original order", () => {
    const candidates = [cand("a"), cand("b"), cand("c")]
    const result = applyRerank(candidates, [], { threshold: 75 })
    expect(result.kept.map((k) => k.candidate.id)).toEqual(["a", "b", "c"])
    expect(result.kept.every((k) => k.llmScore === undefined)).toBe(true)
    expect(result.keptCount).toBe(3)
    expect(result.droppedCount).toBe(0)
  })

  it("all-below-threshold: scored candidates are all dropped, no unscored survivors", () => {
    const candidates = [cand("a"), cand("b")]
    const scores: RerankScore[] = [
      { id: "a", llmScore: 10 },
      { id: "b", llmScore: 20 },
    ]
    const result = applyRerank(candidates, scores, { threshold: 75 })
    expect(result.kept).toEqual([])
    expect(result.keptCount).toBe(0)
    expect(result.droppedCount).toBe(2)
  })

  it("partial scores: unscored candidates are NEVER gated by threshold and land after scored-kept, in original relative order", () => {
    // b and d never come back from the reranker (partial model response).
    const candidates = [cand("a"), cand("b"), cand("c"), cand("d")]
    const scores: RerankScore[] = [
      { id: "a", llmScore: 30 }, // below threshold -> dropped
      { id: "c", llmScore: 95 }, // above threshold -> kept, ranked first
    ]
    const result = applyRerank(candidates, scores, { threshold: 75 })
    expect(result.kept.map((k) => k.candidate.id)).toEqual(["c", "b", "d"])
    expect(result.kept.map((k) => k.llmScore)).toEqual([95, undefined, undefined])
    expect(result.keptCount).toBe(3)
    // Only "a" is a counted drop — b/d are unscored, never counted as dropped.
    expect(result.droppedCount).toBe(1)
  })

  it("all unscored (reranker returned nothing) keeps every candidate, ungated, in original order", () => {
    const candidates = [cand("a"), cand("b"), cand("c")]
    const result = applyRerank(candidates, [], { threshold: 100 })
    expect(result.kept.map((k) => k.candidate.id)).toEqual(["a", "b", "c"])
    expect(result.droppedCount).toBe(0)
  })

  it("empty candidates list is a no-op", () => {
    const result = applyRerank([], [{ id: "x", llmScore: 90 }], { threshold: 0 })
    expect(result.kept).toEqual([])
    expect(result.keptCount).toBe(0)
    expect(result.droppedCount).toBe(0)
  })

  it("scores for ids not present in candidates are ignored", () => {
    const candidates = [cand("a")]
    const scores: RerankScore[] = [
      { id: "a", llmScore: 90 },
      { id: "ghost", llmScore: 99 },
    ]
    const result = applyRerank(candidates, scores, { threshold: 0 })
    expect(result.kept.map((k) => k.candidate.id)).toEqual(["a"])
    expect(result.keptCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// FakeReranker
// ---------------------------------------------------------------------------

const candidatesOf = (ids: ReadonlyArray<string>): ReadonlyArray<RerankCandidateInput> =>
  ids.map((id) => ({ id, text: `text-${id}`, retrievalScore: 0 }))

describe("FakeReranker", () => {
  it("scores only the ids present in the seeded map", async () => {
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const r = yield* MemoryReranker
        return yield* r.rerank({
          queryText: "q",
          candidates: candidatesOf(["a", "b", "c"]),
        })
      }).pipe(Effect.provide(FakeReranker.of({ a: 91, c: 12 }))),
    )
    expect(out).toEqual(
      expect.arrayContaining([
        { id: "a", llmScore: 91 },
        { id: "c", llmScore: 12 },
      ]),
    )
    expect(out.length).toBe(2)
  })

  it("returns an empty array when the seeded map matches no candidate", async () => {
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const r = yield* MemoryReranker
        return yield* r.rerank({ queryText: "q", candidates: candidatesOf(["x"]) })
      }).pipe(Effect.provide(FakeReranker.of({ a: 91 }))),
    )
    expect(out).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// PassthroughReranker
// ---------------------------------------------------------------------------

describe("PassthroughReranker", () => {
  it("assigns strictly-descending scores that reproduce retrieval order through applyRerank", async () => {
    const ids = ["first", "second", "third"]
    const scores = await Effect.runPromise(
      Effect.gen(function* () {
        const r = yield* MemoryReranker
        return yield* r.rerank({ queryText: "q", candidates: candidatesOf(ids) })
      }).pipe(Effect.provide(PassthroughReranker)),
    )
    const candidates = ids.map((id) => cand(id))
    const result = applyRerank(candidates, scores, { threshold: 0 })
    expect(result.kept.map((k) => k.candidate.id)).toEqual(ids)
  })
})
