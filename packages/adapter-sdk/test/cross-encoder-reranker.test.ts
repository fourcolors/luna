import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Effect } from "effect"
import { MemoryReranker, RerankError, type RerankCandidateInput } from "@luna/core"
import {
  CrossEncoderRerankerLayer,
  normalizeCrossEncoderScore,
  probeCrossEncoder,
} from "../src/cross-encoder-reranker.js"

const originalFetch = globalThis.fetch

const setFetch = (fetchImpl: typeof globalThis.fetch) => {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: fetchImpl,
  })
}

const restoreFetch = () => setFetch(originalFetch)

const response = (body: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  }) as Response

const healthResponse = () => response({ status: "ok" })

// The probe sends 3 candidates (relevant, irrelevant, longform batch-capacity
// check), so a well-formed probe response must score all three (strict 1:1).
const goodProbeResponse = () =>
  response({
    results: [
      { index: 0, relevance_score: 0.91 },
      { index: 1, relevance_score: 0.08 },
      { index: 2, relevance_score: 0.55 },
    ],
  })

const candidates = (ids: ReadonlyArray<string>): ReadonlyArray<RerankCandidateInput> =>
  ids.map((id) => ({ id, text: `memory ${id}`, retrievalScore: 0.5 }))

const hangingResponse = (init: RequestInit): Promise<Response> =>
  new Promise<Response>((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject((init.signal as AbortSignal).reason), {
      once: true,
    })
  })

const runRerank = (
  fetchMock: ReturnType<typeof vi.fn>,
  ids: ReadonlyArray<string> = ["a"],
  timeoutMs = 100,
) => runRerankCandidates(fetchMock, candidates(ids), timeoutMs)

const runRerankCandidates = (
  fetchMock: ReturnType<typeof vi.fn>,
  inputs: ReadonlyArray<RerankCandidateInput>,
  timeoutMs = 100,
) => {
  setFetch(fetchMock as unknown as typeof globalThis.fetch)
  return Effect.runPromiseExit(
    Effect.gen(function* () {
      const reranker = yield* MemoryReranker
      return yield* reranker.rerank({ queryText: "query", candidates: inputs })
    }).pipe(
      Effect.provide(
        CrossEncoderRerankerLayer({ url: "http://cross-encoder.test", timeoutMs }),
      ),
    ),
  )
}

const failureOf = (exit: Awaited<ReturnType<typeof runRerank>>): RerankError => {
  expect(exit._tag).toBe("Failure")
  if (exit._tag !== "Failure" || exit.cause._tag !== "Fail") {
    throw new Error("expected a typed failure")
  }
  expect(exit.cause.error).toBeInstanceOf(RerankError)
  return exit.cause.error as RerankError
}

describe("CrossEncoderRerankerLayer", () => {
  beforeEach(() => {
    delete process.env["LUNA_RERANK_CE_URL"]
    delete process.env["LUNA_RERANK_CE_TIMEOUT_MS"]
    delete process.env["LUNA_RERANK_CE_MAX_INPUT_CHARS"]
  })

  afterEach(() => {
    delete process.env["LUNA_RERANK_CE_URL"]
    delete process.env["LUNA_RERANK_CE_TIMEOUT_MS"]
    delete process.env["LUNA_RERANK_CE_MAX_INPUT_CHARS"]
    restoreFetch()
    vi.restoreAllMocks()
  })

  it("maps indexed results to ids and normalizes Qwen3 probabilities", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(goodProbeResponse())
      .mockResolvedValueOnce(
        response({
          results: [
            { index: 2, relevance_score: 0.504 },
            { index: 0, relevance_score: 1.4 },
            { index: 1, relevance_score: -0.2 },
          ],
        }),
      )
    const exit = await runRerank(fetchMock, ["a", "b", "c"])
    expect(exit).toMatchObject({
      _tag: "Success",
      value: [
        { id: "c", llmScore: 50 },
        { id: "a", llmScore: 100 },
        { id: "b", llmScore: 0 },
      ],
    })
    expect(normalizeCrossEncoderScore(0.995)).toBe(100)
    const actualRequest = JSON.parse(fetchMock.mock.calls[2]![1]!.body as string)
    expect(actualRequest).toEqual({
      model: "cross-encoder",
      query: "query",
      documents: ["memory a", "memory b", "memory c"],
      top_n: 3,
    })
  })

  it("maps connection failures to acquire", async () => {
    const error = failureOf(await runRerank(vi.fn().mockRejectedValue(new TypeError("fetch failed"))))
    expect(error.op).toBe("acquire")
  })

  it("maps an exceeded request ceiling to timeout", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(goodProbeResponse())
      .mockImplementationOnce((_url: string, init: RequestInit) => hangingResponse(init))
    const error = failureOf(await runRerank(fetchMock, ["a"], 5))
    expect(error.op).toBe("timeout")
  })

  it("maps malformed JSON and a missing results field to parse", async () => {
    const malformed = {
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError("bad JSON")),
    } as Response
    const malformedError = failureOf(
      await runRerank(
        vi
          .fn()
          .mockResolvedValueOnce(healthResponse())
          .mockResolvedValueOnce(goodProbeResponse())
          .mockResolvedValueOnce(malformed),
      ),
    )
    expect(malformedError.op).toBe("parse")

    const shapeError = failureOf(
      await runRerank(
        vi
          .fn()
          .mockResolvedValueOnce(healthResponse())
          .mockResolvedValueOnce(goodProbeResponse())
          .mockResolvedValueOnce(response({ nope: [] })),
      ),
    )
    expect(shapeError.op).toBe("parse")
  })

  it("maps non-2xx responses to parse", async () => {
    const error = failureOf(
      await runRerank(
        vi
          .fn()
          .mockResolvedValueOnce(healthResponse())
          .mockResolvedValueOnce(goodProbeResponse())
          .mockResolvedValueOnce(response({}, 503)),
      ),
    )
    expect(error.op).toBe("parse")
  })

  it("maps zero results for a non-empty request to empty", async () => {
    const error = failureOf(
      await runRerank(
        vi
          .fn()
          .mockResolvedValueOnce(healthResponse())
          .mockResolvedValueOnce(goodProbeResponse())
          .mockResolvedValueOnce(response({ results: [] })),
      ),
    )
    expect(error.op).toBe("empty")
  })

  it("probes a good model and rejects the broken-GGUF near-zero collapse", async () => {
    const goodFetch = vi.fn((url: string) =>
      Promise.resolve(url.endsWith("/health") ? healthResponse() : goodProbeResponse()),
    )
    setFetch(goodFetch as unknown as typeof globalThis.fetch)
    await expect(Effect.runPromise(probeCrossEncoder("http://cross-encoder.test"))).resolves.toEqual({
      relevantRawScore: 0.91,
      irrelevantRawScore: 0.08,
    })

    const brokenFetch = vi.fn((url: string) =>
      Promise.resolve(
        url.endsWith("/health")
          ? healthResponse()
          : response({
              results: [
                { index: 0, relevance_score: 4.5e-23 },
                { index: 1, relevance_score: 4.5e-23 },
                { index: 2, relevance_score: 4.5e-23 },
              ],
            }),
      ),
    )
    setFetch(brokenFetch as unknown as typeof globalThis.fetch)
    const exit = await Effect.runPromiseExit(probeCrossEncoder("http://cross-encoder.test"))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(RerankError)
      expect((exit.cause.error as RerankError).message).toContain("broken-GGUF")
    }
  })

  it("runs the probe lazily once after success", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(goodProbeResponse())
      .mockResolvedValueOnce(response({ results: [{ index: 0, relevance_score: 0.7 }] }))
      .mockResolvedValueOnce(response({ results: [{ index: 0, relevance_score: 0.8 }] }))
    setFetch(fetchMock as unknown as typeof globalThis.fetch)
    const values = await Effect.runPromise(
      Effect.gen(function* () {
        const reranker = yield* MemoryReranker
        const first = yield* reranker.rerank({ queryText: "q", candidates: candidates(["a"]) })
        const second = yield* reranker.rerank({ queryText: "q", candidates: candidates(["a"]) })
        return { first, second }
      }).pipe(
        Effect.provide(
          CrossEncoderRerankerLayer({ url: "http://cross-encoder.test", timeoutMs: 100 }),
        ),
      ),
    )
    expect(values).toEqual({
      first: [{ id: "a", llmScore: 70 }],
      second: [{ id: "a", llmScore: 80 }],
    })
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it("retries a failed probe on the next rerank call", async () => {
    const broken = response({
      results: [
        { index: 0, relevance_score: 4.5e-23 },
        { index: 1, relevance_score: 4.5e-23 },
      ],
    })
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(broken)
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(goodProbeResponse())
      .mockResolvedValueOnce(response({ results: [{ index: 0, relevance_score: 0.77 }] }))
    setFetch(fetchMock as unknown as typeof globalThis.fetch)
    const values = await Effect.runPromise(
      Effect.gen(function* () {
        const reranker = yield* MemoryReranker
        const first = yield* Effect.exit(
          reranker.rerank({ queryText: "q", candidates: candidates(["a"]) }),
        )
        const second = yield* reranker.rerank({ queryText: "q", candidates: candidates(["a"]) })
        return { first, second }
      }).pipe(
        Effect.provide(
          CrossEncoderRerankerLayer({ url: "http://cross-encoder.test", timeoutMs: 100 }),
        ),
      ),
    )
    expect(values.first._tag).toBe("Failure")
    expect(values.second).toEqual([{ id: "a", llmScore: 77 }])
    expect(fetchMock).toHaveBeenCalledTimes(5)
  })

  it("keeps an under-budget rerank in one application request", async () => {
    process.env["LUNA_RERANK_CE_MAX_INPUT_CHARS"] = "1000"
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(goodProbeResponse())
      .mockResolvedValueOnce(
        response({
          results: [
            { index: 0, relevance_score: 0.7 },
            { index: 1, relevance_score: 0.6 },
          ],
        }),
      )

    const exit = await runRerank(fetchMock, ["a", "b"])
    expect(exit).toMatchObject({
      _tag: "Success",
      value: [
        { id: "a", llmScore: 70 },
        { id: "b", llmScore: 60 },
      ],
    })
    const applicationCalls = fetchMock.mock.calls.filter((call) => {
      const body = call[1]?.body
      return typeof body === "string" && JSON.parse(body).query === "query"
    })
    expect(applicationCalls).toHaveLength(1)
  })

  it("splits over-budget candidates and merges every id with its score", async () => {
    process.env["LUNA_RERANK_CE_MAX_INPUT_CHARS"] = "100"
    const inputs = ["a", "b", "c"].map((id) => ({
      id,
      text: id.repeat(60),
      retrievalScore: 0.5,
    }))
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(goodProbeResponse())
      .mockResolvedValueOnce(response({ results: [{ index: 0, relevance_score: 0.11 }] }))
      .mockResolvedValueOnce(response({ results: [{ index: 0, relevance_score: 0.22 }] }))
      .mockResolvedValueOnce(response({ results: [{ index: 0, relevance_score: 0.33 }] }))

    const exit = await runRerankCandidates(fetchMock, inputs)
    expect(exit).toMatchObject({
      _tag: "Success",
      value: [
        { id: "a", llmScore: 11 },
        { id: "b", llmScore: 22 },
        { id: "c", llmScore: 33 },
      ],
    })
    const applicationBodies = fetchMock.mock.calls
      .map((call) => call[1]?.body)
      .filter((body): body is string => typeof body === "string")
      .map((body) => JSON.parse(body))
      .filter((body) => body.query === "query")
    expect(applicationBodies.map((body) => body.documents)).toEqual([
      ["a".repeat(60)],
      ["b".repeat(60)],
      ["c".repeat(60)],
    ])
  })

  it("sends a candidate larger than the budget alone instead of dropping it", async () => {
    process.env["LUNA_RERANK_CE_MAX_INPUT_CHARS"] = "100"
    const hugeText = "x".repeat(150)
    const inputs = [
      { id: "huge", text: hugeText, retrievalScore: 0.5 },
      { id: "small", text: "small", retrievalScore: 0.4 },
    ]
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(goodProbeResponse())
      .mockResolvedValueOnce(response({ results: [{ index: 0, relevance_score: 0.44 }] }))
      .mockResolvedValueOnce(response({ results: [{ index: 0, relevance_score: 0.55 }] }))

    const exit = await runRerankCandidates(fetchMock, inputs)
    expect(exit).toMatchObject({
      _tag: "Success",
      value: [
        { id: "huge", llmScore: 44 },
        { id: "small", llmScore: 55 },
      ],
    })
    const sentDocuments = fetchMock.mock.calls
      .map((call) => call[1]?.body)
      .filter((body): body is string => typeof body === "string")
      .map((body) => JSON.parse(body))
      .filter((body) => body.query === "query")
      .map((body) => body.documents)
    expect(sentDocuments).toEqual([[hugeText], ["small"]])
  })

  it("fails fast when health is unreachable without retrying", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("connection refused"))
    setFetch(fetchMock as unknown as typeof globalThis.fetch)

    const exit = await Effect.runPromiseExit(probeCrossEncoder("http://cross-encoder.test"))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toMatchObject({ op: "acquire" })
      expect((exit.cause.error as RerankError).message).toContain("health")
    }
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("retries one timed-out calibration then reports a reachable busy server", async () => {
    process.env["LUNA_RERANK_CE_TIMEOUT_MS"] = "5"
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(healthResponse())
      .mockImplementation((_url: string, init: RequestInit) => hangingResponse(init))
    setFetch(fetchMock as unknown as typeof globalThis.fetch)

    const exit = await Effect.runPromiseExit(probeCrossEncoder("http://cross-encoder.test"))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toMatchObject({ op: "timeout" })
      expect((exit.cause.error as RerankError).message).toContain(
        "reachable but not responding to reranking requests",
      )
      expect((exit.cause.error as RerankError).message).not.toContain("broken-GGUF")
    }
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it("recovers when the calibration retry succeeds", async () => {
    process.env["LUNA_RERANK_CE_TIMEOUT_MS"] = "5"
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(healthResponse())
      .mockImplementationOnce((_url: string, init: RequestInit) => hangingResponse(init))
      .mockResolvedValueOnce(goodProbeResponse())
    setFetch(fetchMock as unknown as typeof globalThis.fetch)

    await expect(Effect.runPromise(probeCrossEncoder("http://cross-encoder.test"))).resolves.toEqual({
      relevantRawScore: 0.91,
      irrelevantRawScore: 0.08,
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  // --- hardening added after the adversarial review ---

  it("rejects a partial response (fewer results than candidates) instead of leaving candidates unscored", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(goodProbeResponse())
      // 3 candidates, only 2 scored - would otherwise leave candidate c
      // "unscored" and bypass the injection gate.
      .mockResolvedValueOnce(response({ results: [{ index: 0, relevance_score: 0.9 }, { index: 1, relevance_score: 0.8 }] }))
    const error = failureOf(await runRerank(fetchMock, ["a", "b", "c"]))
    expect(error.op).toBe("parse")
    expect(error.message).toMatch(/1:1|results for/i)
  })

  it("rejects a response with a duplicated document index", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(goodProbeResponse())
      .mockResolvedValueOnce(response({ results: [{ index: 0, relevance_score: 0.9 }, { index: 0, relevance_score: 0.8 }] }))
    const error = failureOf(await runRerank(fetchMock, ["a", "b"]))
    expect(error.op).toBe("parse")
    expect(error.message).toMatch(/repeated document index/i)
  })

  it("calibration surfaces a batch-size hint when the long probe doc 500s (batch-512 server)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(healthResponse())
      // server 500s on the ~600-token longform probe doc (n_ubatch too small)
      .mockResolvedValueOnce(response({ error: "input too large" }, 500))
    setFetch(fetchMock as unknown as typeof globalThis.fetch)
    const exit = await Effect.runPromiseExit(probeCrossEncoder("http://cross-encoder.test"))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
      expect((exit.cause.error as RerankError).message).toMatch(/batch|n_ubatch|500/i)
    }
  })

  it("calibration rejects a logit-scale server (raw scores outside [0,1]) so the gate can't degenerate to sign", async () => {
    // relevant > irrelevant AND relevant*100 clamps to 100 (>50), so the old
    // checks would PASS; the scale check must catch that these are logits.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(response({ results: [{ index: 0, relevance_score: 8.2 }, { index: 1, relevance_score: -3.1 }, { index: 2, relevance_score: 2.0 }] }))
    setFetch(fetchMock as unknown as typeof globalThis.fetch)
    const exit = await Effect.runPromiseExit(probeCrossEncoder("http://cross-encoder.test"))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
      expect((exit.cause.error as RerankError).op).toBe("parse")
      expect((exit.cause.error as RerankError).message).toMatch(/logit|out-of-\[0,1\]/i)
    }
  })
})
