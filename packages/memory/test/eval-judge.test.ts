/**
 * Relevance-judge rerank stage for the eval harnesses (adapters/eval-common).
 * fetch is stubbed by save/restore, not vi.stubGlobal: CI also runs this
 * directory under `bun test`, whose `vi` shim has no stubGlobal.
 */
import { Effect, Stream } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { crossEncoderJudge, jevJudge, makeJudges, type Judge } from "../src/adapters/eval-common/judge.js"
import { searchWithConfig } from "../src/adapters/eval-common/search.js"
import type { MemoryRouter } from "../src/router.js"
import { parseSearchConfig } from "../src/search-config.js"
import { makeRecord } from "../src/types.js"

const realFetch = globalThis.fetch
const stubFetch = (impl: (url: string, init: RequestInit) => Promise<Response>) => {
  globalThis.fetch = impl as unknown as typeof fetch
}
afterEach(() => {
  globalThis.fetch = realFetch
})

describe("rr= search-config grammar", () => {
  it("parses a judge and depth on any mode; rejects bad values", () => {
    expect(parseSearchConfig("hybrid:rr=ce@20").rerank).toEqual({ judge: "ce", depth: 20 })
    expect(parseSearchConfig("hybrid-weighted:w=0:e=0.5:kw=sonnet#0:rr=jev@10").rerank).toEqual({ judge: "jev", depth: 10 })
    expect(() => parseSearchConfig("hybrid:rr=gpt@20")).toThrow(/rr must look like/)
    expect(() => parseSearchConfig("hybrid:rr=ce@0")).toThrow(/rr must look like/)
    expect(() => parseSearchConfig("hybrid:rr=ce@101")).toThrow(/rr must look like/)
  })
})

describe("judges", () => {
  it("cross-encoder: maps scores back to candidate order; rejects partial or duplicate results", async () => {
    let body: Record<string, unknown> = {}
    stubFetch(async (_u, init) => {
      body = JSON.parse(String(init.body)) as Record<string, unknown>
      return new Response(JSON.stringify({ results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.1 }] }))
    })
    const ce = crossEncoderJudge("http://ce:8181/")
    expect(await ce.score("q", ["a", "b"])).toEqual([0.1, 0.9])
    expect(body).toMatchObject({ query: "q", documents: ["a", "b"], top_n: 2 })
    stubFetch(async () => new Response(JSON.stringify({ results: [{ index: 0, relevance_score: 0.1 }] })))
    await expect(ce.score("q", ["a", "b"])).rejects.toThrow(/partial/)
    stubFetch(async () => new Response(JSON.stringify({ results: [{ index: 0, relevance_score: 1 }, { index: 0, relevance_score: 1 }] })))
    await expect(ce.score("q", ["a", "b"])).rejects.toThrow(/duplicate/)
  })

  it("jev: one Noul per candidate over state.question; missing answers are an error", async () => {
    let req: { url: string; body: Record<string, any>; auth: string | null } | undefined
    stubFetch(async (url, init) => {
      req = { url, body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get("authorization") }
      return new Response(JSON.stringify({ answers: { c0: { type: "noul", noul: 0.2 }, c1: { type: "noul", noul: 0.8 } } }))
    })
    const jev = jevJudge("k")
    expect(await jev.score("what is my dog called", ["cat", "dog Buddy"])).toEqual([0.2, 0.8])
    expect(req?.url).toBe("https://api.typesafe.ai/v1/systemone")
    expect(req?.auth).toBe("Bearer k")
    expect(req?.body["state"]).toEqual({ question: "what is my dog called" })
    expect(Object.keys(req?.body["questions"])).toEqual(["c0", "c1"])
    expect(req?.body["questions"].c1.type).toBe("noul")
    expect(req?.body["questions"].c1.instructions.memory).toBe("dog Buddy")
    stubFetch(async () => new Response(JSON.stringify({ answers: { c0: { type: "noul", noul: 0.2 } } })))
    await expect(jev.score("q", ["a", "b"])).rejects.toThrow(/c1/)
  })

  it("makeJudges: jev without TYPESAFE_API_KEY is a config error", () => {
    expect(makeJudges(["ce"], {}).get("ce")?.name).toBe("ce")
    expect(() => makeJudges(["jev"], {})).toThrow(/TYPESAFE_API_KEY/)
  })
})

describe("searchWithConfig", () => {
  const recs = ["a", "b", "c", "d"].map((id) => makeRecord({ id, namespace: "n", kind: "note", content: { text: `text ${id}` } }))
  let lastTopK = 0
  const router = {
    search: (args: { topK?: number }) => {
      lastTopK = args.topK ?? 0
      return Stream.fromIterable(recs.map((record, i) => ({ record, score: 1 - i / 10 })))
    },
  } as unknown as MemoryRouter
  const judge = (scores: number[]): Judge => ({ name: "ce", score: async () => scores })

  it("reorders only the top <depth> by judge score, stable on ties, then appends the rest", async () => {
    const out = await Effect.runPromise(
      searchWithConfig(router, parseSearchConfig("hybrid:rr=ce@3"), { queryText: "q", topK: 4 }, new Map([["ce", judge([0.1, 0.5, 0.5])]])),
    )
    expect(out.map((h) => h.record.id)).toEqual(["b", "c", "a", "d"])
    expect(lastTopK).toBe(4)
  })

  it("fetches max(topK, depth) and returns topK", async () => {
    const out = await Effect.runPromise(
      searchWithConfig(router, parseSearchConfig("hybrid:rr=ce@4"), { queryText: "q", topK: 2 }, new Map([["ce", judge([0, 0, 0, 1])]])),
    )
    expect(lastTopK).toBe(4)
    expect(out.map((h) => h.record.id)).toEqual(["d", "a"])
  })

  it("a configured judge that is missing or throws fails the search (no silent un-reranked run)", async () => {
    await expect(
      Effect.runPromise(searchWithConfig(router, parseSearchConfig("hybrid:rr=ce@2"), { queryText: "q", topK: 2 }, new Map())),
    ).rejects.toThrow()
    const boom: Judge = { name: "ce", score: async () => { throw new Error("down") } }
    await expect(
      Effect.runPromise(searchWithConfig(router, parseSearchConfig("hybrid:rr=ce@2"), { queryText: "q", topK: 2 }, new Map([["ce", boom]]))),
    ).rejects.toThrow()
  })
})
