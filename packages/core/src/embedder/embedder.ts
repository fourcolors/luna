/**
 * EmbedderService — pluggable text-embedding boundary.
 *
 * Lives in @luna/core (NOT @luna/memory) because embedding is a generic
 * capability — vector backends consume it from environment, the same way
 * cost-accounting consumes ObservabilityService and account-broker consumes
 * SecretProvider.
 *
 * Phase 25 ships two Layers:
 *   - StubLayer    — deterministic seeded vector, no I/O. Tests + dev.
 *   - OllamaLayer  — HTTP to local ollama daemon (default model embeddinggemma).
 *                    Probe-on-init: Layer construction fails
 *                    with a clean EmbedderError if the daemon is unreachable.
 *
 * Future (deferred): Anthropic / OpenAI / fastembed-onnx Layers. Add only
 * when a real cost case appears.
 */
import { Effect, Layer } from "effect"
import { EmbedderError } from "../errors.js"

export interface EmbedderApi {
  /** Provider tag — e.g. "stub", "ollama", "anthropic". For telemetry/logs. */
  readonly provider: string
  /** Model identifier within the provider. */
  readonly model: string
  /** Output vector dimension. Constant per Layer instance. */
  readonly dimension: number
  /** Stable vector-input formatter version used for stored memory vectors. */
  readonly embeddingFormat: string
  /** Embed one text into a Float32Array of length `dimension`. */
  readonly embed: (
    text: string,
  ) => Effect.Effect<Float32Array, EmbedderError>
}

export class EmbedderService extends Effect.Tag("luna/EmbedderService")<
  EmbedderService,
  EmbedderApi
>() {}

// ─────────────────────────────────────────────────────────────────────────────
// StubLayer — deterministic, collision-resistant, zero I/O.
//
// Goal: distinct inputs MUST produce distinct, reasonably-distributed vectors,
// AND inputs that share more tokens MUST score higher under cosine. We use a
// bag-of-tokens hash sketch: each token contributes a +1 at one of `dimension`
// slots chosen by FNV-1a hash. Then L2-normalize. This gives ranking that
// monotonically tracks token overlap — sufficient for the BDD scenarios.
// ─────────────────────────────────────────────────────────────────────────────

const FNV_OFFSET = 2166136261 >>> 0
const FNV_PRIME = 16777619

function fnv1a(s: string): number {
  let h = FNV_OFFSET
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, FNV_PRIME) >>> 0
  }
  return h
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? []
}

export interface StubEmbedderOptions {
  readonly dimension?: number
}

const STUB_DEFAULT_DIM = 64
export const DEFAULT_MEMORY_EMBEDDING_FORMAT = "memory-note-v1"

export function makeStubEmbedder(opts?: StubEmbedderOptions): EmbedderApi {
  const dimension = opts?.dimension ?? STUB_DEFAULT_DIM
  return {
    provider: "stub",
    model: "stub",
    dimension,
    embeddingFormat: DEFAULT_MEMORY_EMBEDDING_FORMAT,
    embed: (text) =>
      Effect.sync(() => {
        const v = new Float32Array(dimension)
        const tokens = tokenize(text)
        if (tokens.length === 0) {
          // Empty text → unit vector at slot 0 (still normalized; avoids NaN).
          v[0] = 1
          return v
        }
        for (const tok of tokens) {
          const slot = fnv1a(tok) % dimension
          v[slot] = (v[slot] ?? 0) + 1
        }
        // L2-normalize so cosine == dot product.
        let mag = 0
        for (let i = 0; i < dimension; i++) {
          const x = v[i] ?? 0
          mag += x * x
        }
        const norm = Math.sqrt(mag) || 1
        for (let i = 0; i < dimension; i++) v[i] = (v[i] ?? 0) / norm
        return v
      }),
  }
}

export const StubEmbedderLayer: Layer.Layer<EmbedderService> = Layer.succeed(
  EmbedderService,
  makeStubEmbedder(),
)

export const makeStubEmbedderLayer = (
  opts?: StubEmbedderOptions,
): Layer.Layer<EmbedderService> =>
  Layer.succeed(EmbedderService, makeStubEmbedder(opts))

// ─────────────────────────────────────────────────────────────────────────────
// OllamaLayer — HTTP to localhost:11434 (default).
//
// Layer.effect probes the daemon at construction; if unreachable, fails with
// EmbedderError("init"). Tests are gated on LUNA_TEST_OLLAMA=1.
// ─────────────────────────────────────────────────────────────────────────────

export interface OllamaEmbedderOptions {
  /** Model name. Default: "embeddinggemma". */
  readonly model?: string
  /** Base URL. Default: "http://127.0.0.1:11434". */
  readonly baseUrl?: string
  /** Override dimension if you know it. Otherwise probed via a 1-token call. */
  readonly dimension?: number
  /** Probe timeout in ms. Default: 3000. */
  readonly probeTimeoutMs?: number
}

interface OllamaEmbedResponse {
  readonly embedding?: ReadonlyArray<number>
  readonly embeddings?: ReadonlyArray<ReadonlyArray<number>>
}

function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "")
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed
  }
  return `http://${trimmed}`
}

function normalizeVector(v: Float32Array): Float32Array {
  let mag = 0
  for (let i = 0; i < v.length; i++) {
    const x = v[i] ?? 0
    mag += x * x
  }
  const norm = Math.sqrt(mag)
  if (norm === 0 || !Number.isFinite(norm)) return v
  for (let i = 0; i < v.length; i++) v[i] = (v[i] ?? 0) / norm
  return v
}

function parseOllamaEmbedding(json: OllamaEmbedResponse): Float32Array {
  const current = json.embeddings?.[0]
  const legacy = json.embedding
  const embedding = current ?? legacy
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error("ollama returned empty embedding")
  }
  return normalizeVector(Float32Array.from(embedding))
}

async function postOllamaEmbedding(
  url: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<{ status: number; embedding: Float32Array }> {
  const init: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }
  if (signal) init.signal = signal
  const res = await fetch(url, init)
  if (!res.ok) {
    throw new Error(`ollama HTTP ${res.status}: ${await res.text()}`)
  }
  return {
    status: res.status,
    embedding: parseOllamaEmbedding((await res.json()) as OllamaEmbedResponse),
  }
}

async function ollamaEmbedHttp(
  baseUrl: string,
  model: string,
  text: string,
  signal?: AbortSignal,
): Promise<Float32Array> {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl)
  try {
    return (
      await postOllamaEmbedding(
        `${normalizedBaseUrl}/api/embed`,
        { model, input: text },
        signal,
      )
    ).embedding
  } catch (cause) {
    const message = String(cause)
    if (!message.includes("ollama HTTP 404") && !message.includes("ollama HTTP 405")) {
      throw cause
    }
  }
  return (
    await postOllamaEmbedding(
      `${normalizedBaseUrl}/api/embeddings`,
      { model, prompt: text },
      signal,
    )
  ).embedding
}

export const makeOllamaEmbedderLayer = (
  opts?: OllamaEmbedderOptions,
): Layer.Layer<EmbedderService, EmbedderError> =>
  Layer.effect(
    EmbedderService,
    Effect.gen(function* () {
      const model = opts?.model ?? "embeddinggemma"
      const baseUrl = opts?.baseUrl ?? "http://127.0.0.1:11434"
      const probeTimeoutMs = opts?.probeTimeoutMs ?? 3000

      // Probe-on-init: a real embedding call doubles as the health check
      // and tells us the dimension if the caller didn't pre-declare it.
      const probe = yield* Effect.tryPromise({
        try: async () => {
          const ctrl = new AbortController()
          const t = setTimeout(() => ctrl.abort(), probeTimeoutMs)
          try {
            return await ollamaEmbedHttp(baseUrl, model, "ping", ctrl.signal)
          } finally {
            clearTimeout(t)
          }
        },
        catch: (cause) =>
          new EmbedderError({ provider: "ollama", op: "init", cause }),
      })

      const dimension = opts?.dimension ?? probe.length

      if (opts?.dimension !== undefined && probe.length !== opts.dimension) {
        return yield* Effect.fail(
          new EmbedderError({
            provider: "ollama",
            op: "init",
            cause: new Error(
              `dimension mismatch: declared=${opts.dimension} probed=${probe.length}`,
            ),
          }),
        )
      }

      return {
        provider: "ollama",
        model,
        dimension,
        embeddingFormat: DEFAULT_MEMORY_EMBEDDING_FORMAT,
        embed: (text) =>
          Effect.tryPromise({
            try: () => ollamaEmbedHttp(baseUrl, model, text),
            catch: (cause) =>
              new EmbedderError({ provider: "ollama", op: "embed", cause }),
          }),
      } satisfies EmbedderApi
    }),
  )

// ─────────────────────────────────────────────────────────────────────────────
// Cosine similarity — exposed for backends that compute ranking in JS.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cosine similarity on already-L2-normalized vectors equals the dot product.
 * For safety we don't assume normalization here.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0
    const bi = b[i] ?? 0
    dot += ai * bi
    na += ai * ai
    nb += bi * bi
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  if (denom === 0) return 0
  return dot / denom
}

/** Pack a Float32Array into a Buffer (little-endian, native float32). */
export function float32ToBuffer(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
}

/** Unpack a Buffer/Uint8Array back to a Float32Array (zero-copy when aligned). */
export function bufferToFloat32(buf: Uint8Array): Float32Array {
  // Copy to ensure 4-byte alignment regardless of input slice offset.
  const copy = new Uint8Array(buf.byteLength)
  copy.set(buf)
  return new Float32Array(
    copy.buffer,
    copy.byteOffset,
    Math.floor(copy.byteLength / 4),
  )
}
