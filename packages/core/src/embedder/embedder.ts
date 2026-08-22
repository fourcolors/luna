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
import { Context, Effect, Result, Layer, Schedule } from "effect"
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

export class EmbedderService extends Context.Service<EmbedderService, EmbedderApi>()("luna/EmbedderService") {}

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
// Layer.effect probes the daemon at construction, retrying up to
// `maxProbeAttempts` times with jittered backoff. If every attempt fails,
// it fails with EmbedderError("init") - unless `degradeOnProbeFailure` is
// set and the dimension is already known, in which case it boots non-fatally
// and later `embed()` calls hit Ollama for real. Tests are gated on
// LUNA_TEST_OLLAMA=1.
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
  /**
   * Bounded probe retry count. Default: 3. A value of 1 reproduces the
   * original fail-fast-on-first-attempt behavior.
   */
  readonly maxProbeAttempts?: number
  /** Backoff between probe attempts in ms. Default: 200. */
  readonly probeBackoffMs?: number
  /**
   * When the probe is still failing once retries are exhausted, and the
   * dimension is already known (declared, not probed), construct the layer
   * anyway instead of failing boot. Every real `embed()` call still hits
   * Ollama for real and can still fail with EmbedderError{op:"embed"} - this
   * never fabricates vectors. Default: false (fail fast once retries are
   * exhausted); the chat-server deploy path opts in via selectEmbedderLayer.
   */
  readonly degradeOnProbeFailure?: boolean
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

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

const DEFAULT_MAX_PROBE_ATTEMPTS = 3
const DEFAULT_PROBE_BACKOFF_MS = 200

export const makeOllamaEmbedderLayer = (
  opts?: OllamaEmbedderOptions,
): Layer.Layer<EmbedderService, EmbedderError> =>
  Layer.effect(
    EmbedderService,
    Effect.gen(function* () {
      const model = opts?.model ?? "embeddinggemma"
      const baseUrl = opts?.baseUrl ?? "http://127.0.0.1:11434"
      const probeTimeoutMs = opts?.probeTimeoutMs ?? 3000
      const maxProbeAttempts = Math.max(
        1,
        opts?.maxProbeAttempts ?? DEFAULT_MAX_PROBE_ATTEMPTS,
      )
      const probeBackoffMs = opts?.probeBackoffMs ?? DEFAULT_PROBE_BACKOFF_MS
      const degradeOnProbeFailure = opts?.degradeOnProbeFailure ?? false
      const knownDimension = opts?.dimension

      /**
       * Build the EmbedderApi.
       *
       * When `degraded` is true we skipped the boot-time declared-vs-probed
       * dimension check (probe failed). On the first *successful* real embed
       * we re-check vector length vs the declared dimension so a wrong
       * LUNA_OLLAMA_EMBED_DIMENSION surfaces as a loud EmbedderError instead
       * of a wall of per-write sqlite-vector failures (issue #264).
       */
      const makeApi = (
        dimension: number,
        degraded: boolean = false,
      ): EmbedderApi => {
        // Sticky mismatch after first successful embed in degraded mode —
        // once we know the declared dim is wrong, do not keep calling Ollama
        // only to re-discover the same config error.
        let stickyMismatch: EmbedderError | null = null
        let mismatchChecked = !degraded

        return {
          provider: "ollama",
          model,
          dimension,
          embeddingFormat: DEFAULT_MEMORY_EMBEDDING_FORMAT,
          embed: (text) =>
            Effect.gen(function* () {
              if (stickyMismatch !== null) {
                return yield* Effect.fail(stickyMismatch)
              }
              const vec = yield* Effect.tryPromise({
                try: () => ollamaEmbedHttp(baseUrl, model, text),
                catch: (cause) =>
                  new EmbedderError({
                    provider: "ollama",
                    op: "embed",
                    cause,
                  }),
              })
              if (!mismatchChecked) {
                mismatchChecked = true
                if (vec.length !== dimension) {
                  const cause = new Error(
                    `dimension mismatch after degraded boot: declared=${dimension} got=${vec.length}`,
                  )
                  stickyMismatch = new EmbedderError({
                    provider: "ollama",
                    op: "embed",
                    cause,
                  })
                  console.error(
                    `[embedder] FATAL dimension mismatch after degraded boot: ` +
                      `declared=${dimension} got=${vec.length} ` +
                      `provider=ollama baseUrl=${baseUrl} model=${model} — ` +
                      `fix LUNA_OLLAMA_EMBED_DIMENSION (or the model) and restart`,
                  )
                  return yield* Effect.fail(stickyMismatch)
                }
              }
              return vec
            }),
        }
      }

      // Probe-on-init: a real embedding call doubles as the health check
      // and tells us the dimension if the caller didn't pre-declare it.
      // The AbortController/timeout live inside this thunk so a retry
      // re-arms a fresh signal and budget rather than reusing an aborted one.
      let attempts = 0
      const singleProbe = Effect.tryPromise({
        try: async () => {
          attempts += 1
          const ctrl = new AbortController()
          const t = setTimeout(() => ctrl.abort(), probeTimeoutMs)
          try {
            return await ollamaEmbedHttp(baseUrl, model, "ping", ctrl.signal)
          } finally {
            clearTimeout(t)
          }
        },
        catch: (cause): unknown => cause,
      })

      // Bounded retry - Schedule.recurs is a hard cap, never Schedule.union,
      // so a persistently-flaky link can't eat the boot readiness budget.
      const retrySchedule = Schedule.recurs(maxProbeAttempts - 1).pipe(
        Schedule.intersect(Schedule.spaced(probeBackoffMs)),
        Schedule.jittered,
        Schedule.tapInput((cause: unknown) =>
          Effect.sync(() => {
            if (attempts < maxProbeAttempts) {
              console.error(
                `[embedder] ollama probe attempt ${attempts}/${maxProbeAttempts} failed, retrying: ` +
                  `provider=ollama baseUrl=${baseUrl} model=${model} attempts=${attempts} cause=${errorMessage(cause)}`,
              )
            }
          }),
        ),
      )

      const probeOutcome = yield* singleProbe.pipe(
        Effect.retry(retrySchedule),
        Effect.result,
      )

      if (Result.isFailure(probeOutcome)) {
        const cause = probeOutcome.failure
        if (degradeOnProbeFailure && knownDimension !== undefined) {
          console.error(
            `[embedder] DEGRADED MODE: ollama probe failed after ${attempts} attempts, ` +
              `booting anyway with declared dimension - real embed() calls still hit ollama and self-heal: ` +
              `provider=ollama baseUrl=${baseUrl} model=${model} attempts=${attempts} cause=${errorMessage(cause)}`,
          )
          // Degraded: first successful embed() re-checks declared vs actual dim (#264).
          return makeApi(knownDimension, true)
        }
        return yield* Effect.fail(
          new EmbedderError({ provider: "ollama", op: "init", cause }),
        )
      }

      const probe = probeOutcome.success

      // Deterministic config-error check - never retried, never degraded.
      // A declared dimension that doesn't match what the model actually
      // returns is a config mistake, not a transient condition, and must
      // fail loud on the very first successful probe.
      if (knownDimension !== undefined && probe.length !== knownDimension) {
        return yield* Effect.fail(
          new EmbedderError({
            provider: "ollama",
            op: "init",
            cause: new Error(
              `dimension mismatch: declared=${knownDimension} probed=${probe.length}`,
            ),
          }),
        )
      }

      if (attempts > 1) {
        console.error(
          `[embedder] ollama probe recovered after retry: ` +
            `provider=ollama baseUrl=${baseUrl} model=${model} attempts=${attempts}`,
        )
      }

      return makeApi(knownDimension ?? probe.length, false)
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
