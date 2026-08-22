import { TestClock } from "effect/testing"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Effect, Fiber, ManagedRuntime } from "effect"
import {
  EmbedderService,
  makeOllamaEmbedderLayer,
} from "../../src/embedder/index.js"
import { EmbedderError } from "../../src/errors.js"

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

// ─────────────────────────────────────────────────────────────────────────────
// Boot-probe hardening: bounded retry + non-fatal degrade.
//
// Root cause (jax-box, 2026-07-07): during a deploy, Ollama can return a
// 200 with an empty/truncated body for ~60s while otherwise healthy. That
// is longer than any in-boot retry budget can absorb, so the only robust
// fix is to stop letting an exhausted probe be fatal to boot when the
// vector dimension is already known.
// ─────────────────────────────────────────────────────────────────────────────

// A 200 whose body read fails, mirroring `Unexpected end of JSON input`.
const emptyBodyOk = () =>
  ({
    ok: true,
    status: 200,
    json: () => Promise.reject(new SyntaxError("Unexpected end of JSON input")),
    text: () => Promise.resolve(""),
  }) as Response

// Every probe attempt tries /api/embed first, regardless of whether it then
// falls back to /api/embeddings on 404/405 — so counting only /api/embed
// calls gives a true attempt count even when some attempts are two fetches.
const probeAttemptCount = (mockFetch: ReturnType<typeof vi.fn>): number =>
  mockFetch.mock.calls.filter(
    (call) => typeof call[0] === "string" && call[0].endsWith("/api/embed"),
  ).length

describe("OllamaEmbedder boot-probe hardening", () => {
  const mockFetch = vi.fn()
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    setFetch(mockFetch as unknown as typeof globalThis.fetch)
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
  })

  afterEach(() => {
    restoreFetch()
    mockFetch.mockReset()
    errorSpy.mockRestore()
  })

  it("boots non-fatally in degraded mode through a persistent empty-body window (known dimension)", async () => {
    mockFetch.mockResolvedValue(emptyBodyOk())

    const layer = makeOllamaEmbedderLayer({
      baseUrl: "http://ollama.test:11434",
      model: "embeddinggemma",
      dimension: 768,
      degradeOnProbeFailure: true,
      probeBackoffMs: 1,
    })

    const embedder = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* EmbedderService
      }).pipe(Effect.provide(layer)),
    )

    expect(embedder.provider).toBe("ollama")
    expect(embedder.dimension).toBe(768)
    // default maxProbeAttempts=3, and every attempt failed the same way.
    expect(probeAttemptCount(mockFetch)).toBe(3)
    expect(
      errorSpy.mock.calls.some((call) =>
        String(call[0]).includes("DEGRADED MODE"),
      ),
    ).toBe(true)
  })

  it("stays fatal by default through the same persistent window even with a known dimension", async () => {
    mockFetch.mockResolvedValue(emptyBodyOk())

    const layer = makeOllamaEmbedderLayer({
      baseUrl: "http://ollama.test:11434",
      model: "embeddinggemma",
      dimension: 768,
      probeBackoffMs: 1,
      // no `degradeOnProbeFailure` — degrade is opt-in, so direct callers of
      // the shared layer keep fail-fast-on-exhausted-retries behavior.
    })

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          return yield* EmbedderService
        }).pipe(Effect.provide(layer)),
      ),
    ).rejects.toBeTruthy()
    expect(probeAttemptCount(mockFetch)).toBe(3)
  })

  it("stays fatal through the same persistent window when the dimension is unknown", async () => {
    mockFetch.mockResolvedValue(emptyBodyOk())

    const layer = makeOllamaEmbedderLayer({
      baseUrl: "http://ollama.test:11434",
      model: "embeddinggemma",
      degradeOnProbeFailure: true,
      probeBackoffMs: 1,
      // no `dimension` — degrade must refuse to engage, to avoid sizing the
      // vectorlite table from a guess.
    })

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          return yield* EmbedderService
        }).pipe(Effect.provide(layer)),
      ),
    ).rejects.toBeTruthy()
    expect(probeAttemptCount(mockFetch)).toBe(3)
  })

  it("absorbs a short transient failure and constructs normally", async () => {
    mockFetch
      .mockResolvedValueOnce(emptyBodyOk())
      .mockResolvedValueOnce(okJson({ embeddings: [[1, 0, 0]] }))

    const layer = makeOllamaEmbedderLayer({
      baseUrl: "http://ollama.test:11434",
      model: "embeddinggemma",
      probeBackoffMs: 1,
    })

    const embedder = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* EmbedderService
      }).pipe(Effect.provide(layer)),
    )

    expect(embedder.dimension).toBe(3)
    expect(probeAttemptCount(mockFetch)).toBe(2)
    expect(
      errorSpy.mock.calls.some((call) =>
        String(call[0]).includes("recovered after retry"),
      ),
    ).toBe(true)
  })

  it("genuine outage stays fatal with unknown dimension, degrades with known dimension, and never fabricates a vector", async () => {
    mockFetch.mockRejectedValue(new TypeError("fetch failed"))

    const fatalLayer = makeOllamaEmbedderLayer({
      baseUrl: "http://ollama.test:11434",
      model: "embeddinggemma",
      degradeOnProbeFailure: true,
      probeBackoffMs: 1,
    })
    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          return yield* EmbedderService
        }).pipe(Effect.provide(fatalLayer)),
      ),
    ).rejects.toBeTruthy()

    mockFetch.mockReset()
    mockFetch.mockRejectedValue(new TypeError("fetch failed"))

    const degradedLayer = makeOllamaEmbedderLayer({
      baseUrl: "http://ollama.test:11434",
      model: "embeddinggemma",
      dimension: 768,
      degradeOnProbeFailure: true,
      probeBackoffMs: 1,
    })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const embedder = yield* EmbedderService
        const outcome = yield* Effect.result(embedder.embed("hello"))
        return { embedder, outcome }
      }).pipe(Effect.provide(degradedLayer)),
    )

    expect(result.embedder.provider).toBe("ollama")
    expect(result.embedder.dimension).toBe(768)
    expect(result.outcome._tag).toBe("Left")
    if (result.outcome._tag === "Failure") {
      expect(result.outcome.failure).toBeInstanceOf(EmbedderError)
      expect(result.outcome.failure.op).toBe("embed")
    }
  })

  it("fails fast on a declared-vs-probed dimension mismatch, without retry or degrade", async () => {
    mockFetch.mockResolvedValue(okJson({ embeddings: [[1, 0, 0]] })) // length 3

    const layer = makeOllamaEmbedderLayer({
      baseUrl: "http://ollama.test:11434",
      model: "embeddinggemma",
      dimension: 999,
      degradeOnProbeFailure: true,
      probeBackoffMs: 1,
    })

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          return yield* EmbedderService
        }).pipe(Effect.provide(layer)),
      ),
    ).rejects.toBeTruthy()
    // The probe itself succeeded on the very first try — the mismatch check
    // fires immediately after, with no retry loop involved.
    expect(probeAttemptCount(mockFetch)).toBe(1)
  })

  it("degraded boot: first successful embed re-checks declared dimension (#264)", async () => {
    // Probe window fails → degraded boot with declared dim 768.
    mockFetch.mockResolvedValue(emptyBodyOk())

    const layer = makeOllamaEmbedderLayer({
      baseUrl: "http://ollama.test:11434",
      model: "embeddinggemma",
      dimension: 768,
      degradeOnProbeFailure: true,
      probeBackoffMs: 1,
    })

    const embedder = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* EmbedderService
      }).pipe(Effect.provide(layer)),
    )
    expect(embedder.dimension).toBe(768)

    // Ollama recovers but returns a different dimension than declared.
    mockFetch.mockReset()
    mockFetch.mockResolvedValue(okJson({ embeddings: [[1, 0, 0]] })) // length 3

    const first = await Effect.runPromise(Effect.result(embedder.embed("hello")))
    expect(first._tag).toBe("Left")
    if (first._tag === "Failure") {
      expect(first.failure).toBeInstanceOf(EmbedderError)
      expect(first.failure.op).toBe("embed")
      expect(String(first.failure.cause)).toMatch(/dimension mismatch after degraded boot/)
    }
    expect(
      errorSpy.mock.calls.some((call) =>
        String(call[0]).includes("FATAL dimension mismatch after degraded boot"),
      ),
    ).toBe(true)

    // Sticky: second call fails without another HTTP round-trip.
    mockFetch.mockClear()
    const second = await Effect.runPromise(Effect.result(embedder.embed("again")))
    expect(second._tag).toBe("Left")
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("degraded boot: matching dimension on first real embed is fine (#264)", async () => {
    mockFetch.mockResolvedValue(emptyBodyOk())

    const layer = makeOllamaEmbedderLayer({
      baseUrl: "http://ollama.test:11434",
      model: "embeddinggemma",
      dimension: 3,
      degradeOnProbeFailure: true,
      probeBackoffMs: 1,
    })

    const embedder = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* EmbedderService
      }).pipe(Effect.provide(layer)),
    )

    mockFetch.mockReset()
    mockFetch.mockResolvedValue(okJson({ embeddings: [[1, 0, 0]] })) // length 3

    const vec = await Effect.runPromise(embedder.embed("hello"))
    expect(vec.length).toBe(3)
  })

  it("maxProbeAttempts=1 restores today's fail-fast-on-first-attempt behavior", async () => {
    mockFetch.mockResolvedValue(emptyBodyOk())

    const layer = makeOllamaEmbedderLayer({
      baseUrl: "http://ollama.test:11434",
      model: "embeddinggemma",
      dimension: 768,
      maxProbeAttempts: 1,
      degradeOnProbeFailure: false,
      probeBackoffMs: 1,
    })

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          return yield* EmbedderService
        }).pipe(Effect.provide(layer)),
      ),
    ).rejects.toBeTruthy()
    expect(probeAttemptCount(mockFetch)).toBe(1)
  })

  it("happy path is unchanged: one fetch, zero backoff, no breadcrumbs", async () => {
    mockFetch.mockResolvedValueOnce(okJson({ embeddings: [[1, 0, 0]] }))

    const layer = makeOllamaEmbedderLayer({
      baseUrl: "http://ollama.test:11434",
      model: "embeddinggemma",
    })

    const embedder = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* EmbedderService
      }).pipe(Effect.provide(layer)),
    )

    expect(embedder.dimension).toBe(3)
    expect(probeAttemptCount(mockFetch)).toBe(1)
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it("genuinely defers each retry by the configured backoff (Effect TestClock)", async () => {
    mockFetch
      .mockResolvedValueOnce(emptyBodyOk())
      .mockResolvedValueOnce(okJson({ embeddings: [[1, 0, 0]] }))

    const layer = makeOllamaEmbedderLayer({
      baseUrl: "http://ollama.test:11434",
      model: "embeddinggemma",
      probeBackoffMs: 5000,
    })

    const runtime = ManagedRuntime.make(TestClock.layer())
    try {
      // forkDaemon, not fork: a plain Effect.fork scopes the child to this
      // runPromise call's own root fiber, which exits (and interrupts its
      // children) the instant fork itself returns the Fiber handle.
      const fiber = await runtime.runPromise(
        Effect.forkDetach(
          Effect.gen(function* () {
            return yield* EmbedderService
          }).pipe(Effect.provide(layer)),
        ),
      )

      // Let the first (failing) attempt's mocked fetch promise settle on the
      // real microtask queue before the fiber reaches the backoff sleep.
      await Promise.resolve()
      await Promise.resolve()

      const stillPending = await runtime.runPromise(Fiber.poll(fiber))
      expect(stillPending._tag).toBe("None")
      // The backoff sleep must gate the retry — no second attempt yet.
      expect(probeAttemptCount(mockFetch)).toBe(1)

      await runtime.runPromise(TestClock.adjust("10 seconds"))
      await Promise.resolve()
      await Promise.resolve()

      const embedder = await runtime.runPromise(Fiber.join(fiber))
      expect(embedder.dimension).toBe(3)
      expect(probeAttemptCount(mockFetch)).toBe(2)
    } finally {
      await runtime.dispose()
    }
  })

  it("re-arms a fresh AbortController budget on each retry attempt (JS fake timers)", async () => {
    vi.useFakeTimers()
    try {
      let firstCallSignal: AbortSignal | undefined
      mockFetch
        .mockImplementationOnce(
          (_url: string, init: RequestInit) =>
            new Promise((_resolve, reject) => {
              firstCallSignal = init.signal ?? undefined
              init.signal?.addEventListener("abort", () => {
                reject(new DOMException("aborted", "AbortError"))
              })
            }),
        )
        .mockResolvedValueOnce(okJson({ embeddings: [[1, 0, 0]] }))

      const layer = makeOllamaEmbedderLayer({
        baseUrl: "http://ollama.test:11434",
        model: "embeddinggemma",
        probeTimeoutMs: 3000,
        probeBackoffMs: 0,
      })

      const resultPromise = Effect.runPromise(
        Effect.gen(function* () {
          return yield* EmbedderService
        }).pipe(Effect.provide(layer)),
      )

      // advanceTimersByTimeAsync isn't available under bun:test's vi shim,
      // and Effect's own live Clock.sleep (used for the retry backoff) is
      // itself backed by setTimeout, so it is ALSO faked here alongside the
      // AbortController's timeout. Pump alternating timer-advances and
      // microtask flushes so any timer registered as a *consequence* of an
      // already-fired one (e.g. the backoff sleep registered only once the
      // abort rejection has propagated through the retry schedule) still
      // gets caught.
      const pump = async (rounds: number) => {
        for (let i = 0; i < rounds; i++) {
          vi.advanceTimersByTime(0)
          await Promise.resolve()
        }
      }

      // Let the fiber actually start and invoke fetch (registering the
      // AbortController's setTimeout) before advancing past it - the fetch
      // call happens on a microtask after Effect.runPromise returns, not
      // synchronously within this call frame.
      await pump(5)
      // Fire the AbortController's setTimeout for attempt 1.
      vi.advanceTimersByTime(3000)
      await pump(50)

      const embedder = await resultPromise
      expect(firstCallSignal?.aborted).toBe(true)
      expect(embedder.dimension).toBe(3)
      expect(probeAttemptCount(mockFetch)).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
