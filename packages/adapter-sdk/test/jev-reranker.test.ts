/**
 * JevRerankerLayer: the production Jev reranker must send exactly the
 * request the held-out comparison measured, score on applyRerank's 0-100
 * scale, declare the defaults that make configuring it the opt-in, and turn
 * every failure into a typed RerankError (callers degrade to retrieval order).
 */
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { JEV_MODEL, JEV_URL, MemoryReranker, jevRerankRequest, type RerankArgs } from "@luna/core"
import { JevRerankerLayer } from "../src/jev-reranker.js"

const args: RerankArgs = {
  queryText: "what is my dog called",
  candidates: [
    { id: "cat", text: "My sister's cat is Mittens.", retrievalScore: 0.9 },
    { id: "dog", text: "I adopted a dog named Biscuit.", retrievalScore: 0.8 },
  ],
}

const run = (layer: ReturnType<typeof JevRerankerLayer>, a: RerankArgs = args) =>
  Effect.runPromise(Effect.flip(Effect.flatMap(Effect.service(MemoryReranker), (r) => r.rerank(a))).pipe(Effect.provide(layer)))
const runOk = (layer: ReturnType<typeof JevRerankerLayer>, a: RerankArgs = args) =>
  Effect.runPromise(Effect.flatMap(Effect.service(MemoryReranker), (r) => r.rerank(a)).pipe(Effect.provide(layer)))
const describeOf = (layer: ReturnType<typeof JevRerankerLayer>) =>
  Effect.runPromise(Effect.service(MemoryReranker).pipe(Effect.provide(layer)))

const answering = (nouls: ReadonlyArray<number>, calls: Array<{ url: string; init: RequestInit }> = []) =>
  (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(JSON.stringify({ model: JEV_MODEL, answers: Object.fromEntries(nouls.map((n, i) => [`c${i}`, { type: "noul", noul: n }])) }))
  }) as unknown as typeof fetch

describe("JevRerankerLayer", () => {
  it("sends the shared held-out request with the pinned model and the key, and scores p x 100 in candidate order", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const scores = await runOk(JevRerankerLayer({ apiKey: "k", warmUp: false, fetch: answering([0.014, 0.923], calls) }))
    // Unrounded, so production orders exactly like the benchmark (which sorted raw probabilities).
    expect(scores[0]!.id).toBe("cat")
    expect(scores[0]!.llmScore).toBeCloseTo(1.4)
    expect(scores[1]!.llmScore).toBeCloseTo(92.3)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(JEV_URL)
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe("Bearer k")
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual(jevRerankRequest(args.queryText, args.candidates.map((c) => c.text), JEV_MODEL))
    expect(JEV_MODEL).toBe("jev-1.13.0")
  })

  it("declares itself on by default at depth 40 with threshold 0 - the measured setup (configuring the engine is the opt-in)", async () => {
    const r = await describeOf(JevRerankerLayer({ apiKey: "k", warmUp: false, fetch: answering([]) }))
    expect(r.engine).toBe("jev")
    expect(r.defaults).toEqual({ maxCandidates: 40, threshold: 0, enabled: true })
  })

  it("warms up once at layer build with a data-free request, so the first real call is not the cold one", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    await describeOf(JevRerankerLayer({ apiKey: "k", fetch: answering([0.5], calls) }))
    await new Promise((r) => setTimeout(r, 10))
    expect(calls).toHaveLength(1)
    expect(JSON.parse(String(calls[0]!.init.body)).state).toEqual({ query: "warm-up" })
    const noKey: Array<{ url: string; init: RequestInit }> = []
    await describeOf(JevRerankerLayer({ apiKey: "", fetch: answering([0.5], noKey) }))
    await new Promise((r) => setTimeout(r, 10))
    expect(noKey).toHaveLength(0)
  })

  it("splits a request whose text would exceed Jev's token budget, keeping scores in candidate order", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchEcho = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      const qs = JSON.parse(String(init.body)).questions as Record<string, { instructions: { memory: string } }>
      // score each memory by its own leading digit, so order mistakes show up
      return new Response(JSON.stringify({ answers: Object.fromEntries(Object.entries(qs).map(([k, q]) => [k, { noul: Number(q.instructions.memory[0]) / 10 }])) }))
    }) as unknown as typeof fetch
    const cjk = "記".repeat(1_999)
    const candidates = Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, text: `${i % 10}${cjk}`, retrievalScore: 0 }))
    const scores = await runOk(JevRerankerLayer({ apiKey: "k", warmUp: false, fetch: fetchEcho }), { queryText: "q", candidates })
    expect(calls.length).toBeGreaterThan(1)
    expect(scores.map((s) => s.id)).toEqual(candidates.map((c) => c.id))
    expect(scores.map((s) => Math.round(s.llmScore))).toEqual(candidates.map((_, i) => (i % 10) * 10))
  })

  it("without a key, fails with a typed error and never calls out", async () => {
    let called = false
    const err = await run(JevRerankerLayer({ apiKey: "", warmUp: false, fetch: (async () => { called = true; return new Response("{}") }) as unknown as typeof fetch }))
    expect(err).toMatchObject({ _tag: "RerankError", op: "acquire" })
    expect(err.message).toMatch(/TYPESAFE_API_KEY/)
    expect(called).toBe(false)
  })

  it("an HTTP error, a malformed answer, or a missing answer is a typed error, never a partial ranking", async () => {
    const http = (async () => new Response("overloaded", { status: 529 })) as unknown as typeof fetch
    expect(await run(JevRerankerLayer({ apiKey: "k", warmUp: false, fetch: http }))).toMatchObject({ op: "stream", message: "jev HTTP 529: overloaded" })
    const auth = (async () => new Response("invalid key sk-echoed-back", { status: 401 })) as unknown as typeof fetch
    const authErr = await run(JevRerankerLayer({ apiKey: "k", warmUp: false, fetch: auth }))
    expect(authErr.message).toBe("jev HTTP 401") // no body: it can echo request details
    expect(await run(JevRerankerLayer({ apiKey: "k", warmUp: false, fetch: answering([0.5]) }))).toMatchObject({ op: "parse" })
    expect(await run(JevRerankerLayer({ apiKey: "k", warmUp: false, fetch: answering([0.5, 1.7]) }))).toMatchObject({ op: "parse" })
    const notJson = (async () => new Response("<html>")) as unknown as typeof fetch
    expect(await run(JevRerankerLayer({ apiKey: "k", warmUp: false, fetch: notJson }))).toMatchObject({ op: "parse" })
  })

  it("gives up at the caller's per-call budget with a timeout error", async () => {
    const hang = ((_url: string, init: RequestInit) =>
      new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch
    const t0 = performance.now()
    const err = await run(JevRerankerLayer({ apiKey: "k", warmUp: false, fetch: hang }), { ...args, timeoutMs: 30 })
    expect(err).toMatchObject({ op: "timeout" })
    expect(performance.now() - t0).toBeLessThan(2_000)
  })

  it("no candidates: no call", async () => {
    let called = false
    const scores = await runOk(JevRerankerLayer({ apiKey: "k", warmUp: false, fetch: (async () => { called = true; return new Response("{}") }) as unknown as typeof fetch }), { queryText: "q", candidates: [] })
    expect(scores).toEqual([])
    expect(called).toBe(false)
  })
})
