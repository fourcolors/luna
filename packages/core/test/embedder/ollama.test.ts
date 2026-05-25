import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Effect } from "effect"
import {
  EmbedderService,
  makeOllamaEmbedderLayer,
} from "../../src/embedder/index.js"

const originalFetch = globalThis.fetch

const setFetch = (fetchImpl: typeof globalThis.fetch) => {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: fetchImpl,
  })
}

const restoreFetch = () => {
  if (originalFetch === undefined) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete (globalThis as { fetch?: typeof globalThis.fetch }).fetch
  } else {
    setFetch(originalFetch)
  }
}

const okJson = (body: unknown) =>
  ({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  }) as Response

const notFound = () =>
  ({
    ok: false,
    status: 404,
    json: () => Promise.resolve({ error: "not found" }),
    text: () => Promise.resolve("not found"),
  }) as Response

describe("OllamaEmbedder", () => {
  const mockFetch = vi.fn()

  beforeEach(() => {
    setFetch(mockFetch as unknown as typeof globalThis.fetch)
  })

  afterEach(() => {
    restoreFetch()
    mockFetch.mockReset()
  })

  it("uses Ollama's current /api/embed response shape", async () => {
    mockFetch
      .mockResolvedValueOnce(okJson({ embeddings: [[1, 0, 0]] }))
      .mockResolvedValueOnce(okJson({ embeddings: [[0, 1, 0]] }))

    const layer = makeOllamaEmbedderLayer({
      baseUrl: "http://ollama.test:11434",
      model: "embeddinggemma",
    })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const embedder = yield* EmbedderService
        const embedded = yield* embedder.embed("hello")
        return {
          provider: embedder.provider,
          dimension: embedder.dimension,
          embedded: Array.from(embedded),
        }
      }).pipe(Effect.provide(layer)),
    )

    expect(result).toEqual({
      provider: "ollama",
      dimension: 3,
      embedded: [0, 1, 0],
    })
    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      "http://ollama.test:11434/api/embed",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ model: "embeddinggemma", input: "ping" }),
      }),
    )
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      "http://ollama.test:11434/api/embed",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ model: "embeddinggemma", input: "hello" }),
      }),
    )
  })

  it("falls back to legacy /api/embeddings when /api/embed is unavailable", async () => {
    mockFetch
      .mockResolvedValueOnce(notFound())
      .mockResolvedValueOnce(okJson({ embedding: [1, 0] }))

    const layer = makeOllamaEmbedderLayer({
      baseUrl: "http://127.0.0.1:11434",
      model: "nomic-embed-text",
    })

    const dimension = await Effect.runPromise(
      Effect.gen(function* () {
        const embedder = yield* EmbedderService
        return embedder.dimension
      }).pipe(Effect.provide(layer)),
    )

    expect(dimension).toBe(2)
    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:11434/api/embed",
      expect.objectContaining({
        body: JSON.stringify({ model: "nomic-embed-text", input: "ping" }),
      }),
    )
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:11434/api/embeddings",
      expect.objectContaining({
        body: JSON.stringify({ model: "nomic-embed-text", prompt: "ping" }),
      }),
    )
  })

  it("normalizes host-style base URLs", async () => {
    mockFetch.mockResolvedValueOnce(okJson({ embeddings: [[1, 0, 0, 0]] }))

    const layer = makeOllamaEmbedderLayer({
      baseUrl: "10.77.0.1:11434/",
      model: "qwen3-embedding:0.6b",
    })

    const dimension = await Effect.runPromise(
      Effect.gen(function* () {
        const embedder = yield* EmbedderService
        return embedder.dimension
      }).pipe(Effect.provide(layer)),
    )

    expect(dimension).toBe(4)
    expect(mockFetch).toHaveBeenCalledWith(
      "http://10.77.0.1:11434/api/embed",
      expect.any(Object),
    )
  })
})
