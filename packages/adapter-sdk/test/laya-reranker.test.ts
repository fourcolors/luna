/**
 * LayaRerankerLayer: the production Laya reranker sends the same request the
 * held-out Jev comparison measured to the local sidecar (never TypeSafe),
 * carries no credential, scores on applyRerank's 0-100 scale, declares the
 * defaults that make configuring it the opt-in, and turns every failure into
 * a typed RerankError (callers degrade to retrieval order).
 */
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { jevRerankRequest, MemoryReranker, type RerankArgs } from "@luna/core"
import { DEFAULT_LAYA_MODEL, DEFAULT_LAYA_URL, LayaRerankerLayer } from "../src/laya-reranker.js"

const args: RerankArgs = {
  queryText: "what is my dog called",
  candidates: [
    { id: "cat", text: "My sister's cat is Mittens.", retrievalScore: 0.9 },
    { id: "dog", text: "I adopted a dog named Biscuit.", retrievalScore: 0.8 },
  ],
}

const run = (layer: ReturnType<typeof LayaRerankerLayer>, a: RerankArgs = args) =>
  Effect.runPromise(Effect.flip(Effect.flatMap(Effect.service(MemoryReranker), (r) => r.rerank(a))).pipe(Effect.provide(layer)))
const runOk = (layer: ReturnType<typeof LayaRerankerLayer>, a: RerankArgs = args) =>
  Effect.runPromise(Effect.flatMap(Effect.service(MemoryReranker), (r) => r.rerank(a)).pipe(Effect.provide(layer)))
const describeOf = (layer: ReturnType<typeof LayaRerankerLayer>) =>
  Effect.runPromise(Effect.service(MemoryReranker).pipe(Effect.provide(layer)))

const answering = (nouls: ReadonlyArray<number>, calls: Array<{ url: string; init: RequestInit }> = []) =>
  (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(JSON.stringify({ model: "laya-english", answers: Object.fromEntries(nouls.map((n, i) => [`c${i}`, { type: "noul", noul: n }])) }))
  }) as unknown as typeof fetch

describe("LayaRerankerLayer", () => {
  it("posts the shared held-out request to the local sidecar with no credential, and scores p x 100 in candidate order", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const scores = await runOk(LayaRerankerLayer({ warmUp: false, fetch: answering([0.014, 0.923], calls) }))
    expect(scores[0]!.id).toBe("cat")
    expect(scores[0]!.llmScore).toBeCloseTo(1.4)
    expect(scores[1]!.llmScore).toBeCloseTo(92.3)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`${DEFAULT_LAYA_URL}/v1/systemone`)
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBeNull()
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual(
      jevRerankRequest(args.queryText, args.candidates.map((c) => c.text), DEFAULT_LAYA_MODEL),
    )
  })

  it("honours an explicit url and LUNA_LAYA_MODEL (auto checkpoint stays the default)", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    await runOk(LayaRerankerLayer({ url: "http://127.0.0.1:9999/", model: "multilingual", warmUp: false, fetch: answering([0.5], calls) }), { ...args, candidates: [args.candidates[0]!] })
    expect(calls[0]!.url).toBe("http://127.0.0.1:9999/v1/systemone")
    expect(JSON.parse(String(calls[0]!.init.body)).model).toBe("multilingual")
  })

  it("declares itself on by default at depth 40 with threshold 0 - Jev parity (configuring the engine is the opt-in)", async () => {
    const r = await describeOf(LayaRerankerLayer({ warmUp: false, fetch: answering([]) }))
    expect(r.engine).toBe("laya")
    expect(r.defaults).toEqual({ maxCandidates: 40, threshold: 0, enabled: true })
  })

  it("warms up once at layer build with a data-free request, so a lazy checkpoint load does not land on the first real call", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    await describeOf(LayaRerankerLayer({ fetch: answering([0.5], calls) }))
    await new Promise((r) => setTimeout(r, 10))
    expect(calls).toHaveLength(1)
    expect(JSON.parse(String(calls[0]!.init.body)).state).toEqual({ query: "warm-up" })
  })

  it("splits a request whose text would exceed the per-request token budget, keeping scores in candidate order", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchEcho = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      const qs = JSON.parse(String(init.body)).questions as Record<string, { instructions: { memory: string } }>
      return new Response(JSON.stringify({ answers: Object.fromEntries(Object.entries(qs).map(([k, q]) => [k, { noul: Number(q.instructions.memory[0]) / 10 }])) }))
    }) as unknown as typeof fetch
    const cjk = "記".repeat(1_999)
    const candidates = Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, text: `${i % 10}${cjk}`, retrievalScore: 0 }))
    const scores = await runOk(LayaRerankerLayer({ warmUp: false, fetch: fetchEcho }), { queryText: "q", candidates })
    expect(calls.length).toBeGreaterThan(1)
    expect(scores.map((s) => s.id)).toEqual(candidates.map((c) => c.id))
    expect(scores.map((s) => Math.round(s.llmScore))).toEqual(candidates.map((_, i) => (i % 10) * 10))
  })

  it("an HTTP error, a malformed answer, or a missing answer is a typed error, never a partial ranking", async () => {
    const http = (async () => new Response("My private memory is Biscuit", { status: 500 })) as unknown as typeof fetch
    expect(await run(LayaRerankerLayer({ warmUp: false, fetch: http }))).toMatchObject({ op: "stream", message: "laya HTTP 500" })
    expect(await run(LayaRerankerLayer({ warmUp: false, fetch: answering([0.5]) }))).toMatchObject({ op: "parse" })
    expect(await run(LayaRerankerLayer({ warmUp: false, fetch: answering([0.5, 1.7]) }))).toMatchObject({ op: "parse" })
    const notJson = (async () => new Response("<html>")) as unknown as typeof fetch
    expect(await run(LayaRerankerLayer({ warmUp: false, fetch: notJson }))).toMatchObject({ op: "parse" })
  })

  it("an unreachable sidecar is a typed stream error naming the endpoint, not an unhandled rejection", async () => {
    const down = (async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:8182") }) as unknown as typeof fetch
    const err = await run(LayaRerankerLayer({ warmUp: false, fetch: down }))
    expect(err).toMatchObject({ op: "stream" })
    expect(err.message).toMatch(/8182/)
  })

  it("gives up at the caller's per-call budget with a timeout error", async () => {
    const hang = ((_url: string, init: RequestInit) =>
      new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch
    const t0 = performance.now()
    const err = await run(LayaRerankerLayer({ warmUp: false, fetch: hang }), { ...args, timeoutMs: 30 })
    expect(err).toMatchObject({ op: "timeout" })
    expect(performance.now() - t0).toBeLessThan(2_000)
  })

  it("no candidates: no call", async () => {
    let called = false
    const scores = await runOk(LayaRerankerLayer({ warmUp: false, fetch: (async () => { called = true; return new Response("{}") }) as unknown as typeof fetch }), { queryText: "q", candidates: [] })
    expect(scores).toEqual([])
    expect(called).toBe(false)
  })
})
