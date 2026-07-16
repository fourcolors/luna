/**
 * rerank-eval - LLM pointwise rerank experiment ("Exp B", SIRA stage 3).
 *
 * Measures whether an LLM reranker over the top-20 hybrid candidates improves
 * retrieval precision, and whether it produces usable score magnitude for a
 * future injection-confidence gate (today's hybrid/RRF scores don't - see
 * memory-suite.ts's negative-separation table).
 *
 * Corpus loading, the retrieval-quality metric functions (recall@k/MRR/nDCG),
 * and the latency/percentile helpers are DUPLICATED from memory-suite.ts
 * rather than imported. This is deliberate: memory-suite.ts is under active
 * concurrent edit by another agent in this session, and importing from it
 * would create a merge hazard. Consolidate the two once both land.
 *
 * Two LLM call shapes, both against `claude -p --model haiku` on the
 * Anthropic subscription (no API-key metering):
 *   batched   - one call per query, all 20 candidates scored in one prompt.
 *               Runs over the full (optionally --limit'd) corpus.
 *   pointwise - one call per (query, candidate) pair. Runs ONLY over a
 *               stratified subsample to keep call count sane (20x a batched
 *               query costs 20x the calls).
 *
 * Run via:
 *   bun packages/memory/bench/rerank-eval.ts --limit 6     (smoke test)
 *   LUNA_EMBEDDER=ollama LUNA_OLLAMA_EMBED_MODEL=nomic-embed-text \
 *     bun packages/memory/bench/rerank-eval.ts             (full run)
 *
 * Env:
 *   LUNA_BENCH_CORPUS                path to a corpus JSON file (default:
 *                                    sibling memory-suite-corpus.json)
 *   LUNA_BENCH_JSON                  if set, write full structured results here
 *   LUNA_RERANK_ENGINE               "cross-encoder" selects local llama-server
 *   LUNA_RERANK_CE_URL               llama-server base URL (default http://127.0.0.1:8181)
 *   LUNA_RERANK_CE_TIMEOUT_MS        cross-encoder request timeout (default 2000)
 *   LUNA_RERANK_CE_MAX_INPUT_CHARS    whole-candidate request split budget (default 48000)
 *   LUNA_RERANK_MODEL                claude CLI model alias (default "haiku")
 *   LUNA_RERANK_CONCURRENCY          parallel LLM calls (default 7, clamp 6-8)
 *   LUNA_RERANK_SUBSAMPLE_VOCAB      pointwise subsample vocab-mismatch count (default 12)
 *   LUNA_RERANK_SUBSAMPLE_PARAPHRASE pointwise subsample paraphrase count (default 6)
 *   LUNA_RERANK_SUBSAMPLE_NEGATIVE   pointwise subsample negative count (default 6)
 * Flags:
 *   --limit N     only process the first N queries (corpus order) - smoke test
 *   --no-cache    bypass the LLM response cache entirely (no read, no write)
 *
 * Exit codes:
 *   0  ran to completion
 *   2  Ollama unreachable (skip - daemon not running)
 *   3  corpus invalid, load error, or invalid configuration
 *   4  runtime failure (backend/embedder error mid-run)
 *   5  claude CLI unavailable or unauthenticated
 *   6  cross-encoder sidecar unreachable or calibration failed
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { spawn, spawnSync } from "node:child_process"
import { Effect, Layer, Stream } from "effect"
import {
  Clock,
  MemoryReranker,
  ObservabilityService,
  StubEmbedderLayer,
  makeOllamaEmbedderLayer,
  type MemoryRerankerApi,
} from "@luna/core"
import {
  CrossEncoderRerankerLayer,
  DEFAULT_CROSS_ENCODER_URL,
  probeCrossEncoder,
} from "@luna/adapter-sdk"
import { SqliteVectorBackend } from "../src/backends/sqlite-vector.js"
import { LunaSqliteBootstrapLive } from "../src/backends/vectorlite-bootstrap.js"
import { MemoryLayer } from "../src/layer.js"
import { MemoryRouterTag } from "../src/router.js"
import { makeRecord } from "../src/types.js"

// ---------------------------------------------------------------------------
// Corpus types + loader (duplicated from memory-suite.ts - see header comment)
// ---------------------------------------------------------------------------

type RecordKind = "project" | "preference" | "episodic" | "distractor"
type QuerySlice =
  | "verbatim"
  | "paraphrase"
  | "vocab-mismatch"
  | "temporal"
  | "negative"

interface CorpusRecord {
  readonly id: string
  readonly kind: RecordKind
  readonly text: string
}

interface CorpusQuery {
  readonly id: string
  readonly slice: QuerySlice
  readonly text: string
  readonly relevantIds: ReadonlyArray<string>
}

interface Corpus {
  readonly version: string
  readonly description: string
  readonly records: ReadonlyArray<CorpusRecord>
  readonly queries: ReadonlyArray<CorpusQuery>
}

const RECORD_KINDS = new Set<string>(["project", "preference", "episodic", "distractor"])
const QUERY_SLICES = new Set<string>([
  "verbatim",
  "paraphrase",
  "vocab-mismatch",
  "temporal",
  "negative",
])
const POSITIVE_SLICE_ORDER: ReadonlyArray<QuerySlice> = [
  "verbatim",
  "paraphrase",
  "vocab-mismatch",
  "temporal",
]

function resolveCorpusPath(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const envPath = process.env["LUNA_BENCH_CORPUS"]
  if (envPath !== undefined) return resolve(envPath)
  return resolve(here, "memory-suite-corpus.json")
}

function loadCorpus(path: string): Corpus {
  const raw = readFileSync(path, "utf8")
  const parsed = JSON.parse(raw) as {
    version?: unknown
    description?: unknown
    records?: unknown
    queries?: unknown
  }

  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error("corpus: missing or invalid `version` (expected string)")
  }
  if (!Array.isArray(parsed.records) || parsed.records.length === 0) {
    throw new Error("corpus: missing or empty `records` array")
  }
  if (!Array.isArray(parsed.queries) || parsed.queries.length === 0) {
    throw new Error("corpus: missing or empty `queries` array")
  }

  const recordIds = new Set<string>()
  const records: CorpusRecord[] = []
  parsed.records.forEach((raw, i) => {
    const rec = raw as Partial<CorpusRecord>
    if (typeof rec.id !== "string" || rec.id.length === 0) {
      throw new Error(`corpus.records[${i}]: missing or invalid \`id\``)
    }
    if (recordIds.has(rec.id)) {
      throw new Error(`corpus.records[${i}]: duplicate id "${rec.id}"`)
    }
    if (typeof rec.kind !== "string" || !RECORD_KINDS.has(rec.kind)) {
      throw new Error(`corpus.records[${i}] (${rec.id}): invalid \`kind\` "${String(rec.kind)}"`)
    }
    if (typeof rec.text !== "string" || rec.text.length === 0) {
      throw new Error(`corpus.records[${i}] (${rec.id}): missing or invalid \`text\``)
    }
    recordIds.add(rec.id)
    records.push({ id: rec.id, kind: rec.kind as RecordKind, text: rec.text })
  })

  const queryIds = new Set<string>()
  const queries: CorpusQuery[] = []
  parsed.queries.forEach((raw, i) => {
    const q = raw as Partial<CorpusQuery>
    if (typeof q.id !== "string" || q.id.length === 0) {
      throw new Error(`corpus.queries[${i}]: missing or invalid \`id\``)
    }
    if (queryIds.has(q.id)) {
      throw new Error(`corpus.queries[${i}]: duplicate id "${q.id}"`)
    }
    if (typeof q.slice !== "string" || !QUERY_SLICES.has(q.slice)) {
      throw new Error(`corpus.queries[${i}] (${q.id}): invalid \`slice\` "${String(q.slice)}"`)
    }
    if (typeof q.text !== "string" || q.text.length === 0) {
      throw new Error(`corpus.queries[${i}] (${q.id}): missing or invalid \`text\``)
    }
    if (!Array.isArray(q.relevantIds)) {
      throw new Error(`corpus.queries[${i}] (${q.id}): missing \`relevantIds\` array`)
    }
    for (const rid of q.relevantIds) {
      if (typeof rid !== "string" || !recordIds.has(rid)) {
        throw new Error(
          `corpus.queries[${i}] (${q.id}): relevantIds references unknown record "${String(rid)}"`,
        )
      }
    }
    if (q.slice !== "negative" && q.relevantIds.length === 0) {
      throw new Error(
        `corpus.queries[${i}] (${q.id}): non-negative slice "${q.slice}" needs at least one relevantId`,
      )
    }
    queryIds.add(q.id)
    queries.push({
      id: q.id,
      slice: q.slice as QuerySlice,
      text: q.text,
      relevantIds: q.relevantIds as ReadonlyArray<string>,
    })
  })

  return {
    version: parsed.version,
    description: typeof parsed.description === "string" ? parsed.description : "",
    records,
    queries,
  }
}

function buildEmbedderLayer() {
  const choice = process.env["LUNA_EMBEDDER"]?.toLowerCase()
  if (choice === "ollama") {
    const model = process.env["LUNA_OLLAMA_EMBED_MODEL"]
    const baseUrl = process.env["LUNA_OLLAMA_BASE_URL"]
    return makeOllamaEmbedderLayer({
      ...(model !== undefined ? { model } : {}),
      ...(baseUrl !== undefined ? { baseUrl } : {}),
    })
  }
  return StubEmbedderLayer
}

async function probeOllama(): Promise<boolean> {
  const baseUrl =
    process.env["LUNA_OLLAMA_BASE_URL"] ?? process.env["OLLAMA_HOST"] ?? "http://127.0.0.1:11434"
  const url = baseUrl.startsWith("http") ? baseUrl : `http://${baseUrl}`
  try {
    const res = await fetch(url.replace(/\/+$/, "") + "/", { signal: AbortSignal.timeout(1500) })
    return res.ok || res.status < 500
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Metric helpers (duplicated from memory-suite.ts - see header comment)
// ---------------------------------------------------------------------------

function relevantRanks(
  rankedIds: ReadonlyArray<string>,
  relevantIds: ReadonlySet<string>,
): number[] {
  const ranks: number[] = []
  rankedIds.forEach((id, i) => {
    if (relevantIds.has(id)) ranks.push(i + 1)
  })
  return ranks
}

function recallAtK(ranks: ReadonlyArray<number>, k: number, relevantCount: number): number {
  if (relevantCount === 0) return 0
  return ranks.filter((r) => r <= k).length / relevantCount
}

function mrrOf(ranks: ReadonlyArray<number>): number {
  if (ranks.length === 0) return 0
  return 1 / Math.min(...ranks)
}

function ndcgAt10(ranks: ReadonlyArray<number>, relevantCount: number): number {
  const dcg = ranks.filter((r) => r <= 10).reduce((acc, r) => acc + 1 / Math.log2(r + 1), 0)
  const idealCount = Math.min(relevantCount, 10)
  let idcg = 0
  for (let r = 1; r <= idealCount; r++) idcg += 1 / Math.log2(r + 1)
  return idcg > 0 ? dcg / idcg : 0
}

interface SliceMetrics {
  readonly slice: string
  readonly queries: number
  readonly recallAt1: number
  readonly recallAt5: number
  readonly recallAt10: number
  readonly mrr: number
  readonly ndcg10: number
}

interface ScoredQuery {
  readonly queryId: string
  readonly slice: QuerySlice
  readonly relevantIds: ReadonlySet<string>
  readonly rankedIds: ReadonlyArray<string>
}

function aggregateSlice(results: ReadonlyArray<ScoredQuery>, label: string): SliceMetrics {
  const n = results.length
  if (n === 0) {
    return { slice: label, queries: 0, recallAt1: 0, recallAt5: 0, recallAt10: 0, mrr: 0, ndcg10: 0 }
  }
  let sumR1 = 0
  let sumR5 = 0
  let sumR10 = 0
  let sumMrr = 0
  let sumNdcg = 0
  for (const r of results) {
    const ranks = relevantRanks(r.rankedIds, r.relevantIds)
    sumR1 += recallAtK(ranks, 1, r.relevantIds.size)
    sumR5 += recallAtK(ranks, 5, r.relevantIds.size)
    sumR10 += recallAtK(ranks, 10, r.relevantIds.size)
    sumMrr += mrrOf(ranks)
    sumNdcg += ndcgAt10(ranks, r.relevantIds.size)
  }
  return {
    slice: label,
    queries: n,
    recallAt1: sumR1 / n,
    recallAt5: sumR5 / n,
    recallAt10: sumR10 / n,
    mrr: sumMrr / n,
    ndcg10: sumNdcg / n,
  }
}

function slicesTable(results: ReadonlyArray<ScoredQuery>): {
  rows: SliceMetrics[]
  overall: SliceMetrics
  macro: SliceMetrics
} {
  const positive = results.filter((r) => r.slice !== "negative")
  const present = POSITIVE_SLICE_ORDER.filter((s) => positive.some((r) => r.slice === s))
  const rows = present.map((s) => aggregateSlice(positive.filter((r) => r.slice === s), s))
  const overall = aggregateSlice(positive, "OVERALL")
  const macro: SliceMetrics = {
    slice: "MACRO",
    queries: rows.length,
    recallAt1: rows.reduce((a, r) => a + r.recallAt1, 0) / (rows.length || 1),
    recallAt5: rows.reduce((a, r) => a + r.recallAt5, 0) / (rows.length || 1),
    recallAt10: rows.reduce((a, r) => a + r.recallAt10, 0) / (rows.length || 1),
    mrr: rows.reduce((a, r) => a + r.mrr, 0) / (rows.length || 1),
    ndcg10: rows.reduce((a, r) => a + r.ndcg10, 0) / (rows.length || 1),
  }
  return { rows, overall, macro }
}

function tabulateSlices(rows: ReadonlyArray<SliceMetrics>): string {
  const header = `| slice          | queries | recall@1 | recall@5 | recall@10 | MRR   | nDCG@10 |`
  const sep = `|:---|---:|---:|---:|---:|---:|---:|`
  const body = rows.map(
    (r) =>
      `| ${r.slice.padEnd(14)} | ${String(r.queries).padStart(7)} | ${r.recallAt1
        .toFixed(3)
        .padStart(8)} | ${r.recallAt5.toFixed(3).padStart(8)} | ${r.recallAt10
        .toFixed(3)
        .padStart(9)} | ${r.mrr.toFixed(3).padStart(5)} | ${r.ndcg10.toFixed(3).padStart(7)} |`,
  )
  return [header, sep, ...body].join("\n")
}

function percentile(sorted: ReadonlyArray<number>, p: number): number {
  if (sorted.length === 0) return NaN
  if (sorted.length === 1) return sorted[0]!
  const idx = (p / 100) * (sorted.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]!
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo)
}

function fmtMs(n: number): string {
  return Number.isNaN(n) ? "n/a" : n.toFixed(2)
}

function fmtScore(n: number): string {
  return Number.isNaN(n) ? "n/a" : n.toFixed(3)
}

interface LatencyMetrics {
  readonly label: string
  readonly mean: number
  readonly p50: number
  readonly p95: number
  readonly calls: number
}

function latencyFor(label: string, tookMsList: ReadonlyArray<number>): LatencyMetrics {
  const sorted = [...tookMsList].sort((a, b) => a - b)
  const mean = sorted.length > 0 ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0
  return { label, mean, p50: percentile(sorted, 50), p95: percentile(sorted, 95), calls: sorted.length }
}

function tabulateLatency(rows: ReadonlyArray<LatencyMetrics>): string {
  const header = `| shape                       | calls | mean (ms) | p50 (ms) | p95 (ms) |`
  const sep = `|:---|---:|---:|---:|---:|`
  const body = rows.map(
    (r) =>
      `| ${r.label.padEnd(28)} | ${String(r.calls).padStart(5)} | ${fmtMs(r.mean).padStart(9)} | ${fmtMs(
        r.p50,
      ).padStart(8)} | ${fmtMs(r.p95).padStart(8)} |`,
  )
  return [header, sep, ...body].join("\n")
}

// ---------------------------------------------------------------------------
// Retrieval phase - seed a fresh :memory: hybrid backend and pull top-20
// candidates per query, same layer wiring as memory-suite.ts.
// ---------------------------------------------------------------------------

interface Candidate {
  readonly id: string
  readonly text: string
  readonly score: number
}

interface RetrievalResult {
  readonly queryId: string
  readonly slice: QuerySlice
  readonly queryText: string
  readonly relevantIds: ReadonlySet<string>
  readonly candidates: ReadonlyArray<Candidate>
}

const TOP_K = 20
const NAMESPACE = "bench"

function textOf(content: unknown): string {
  if (content !== null && typeof content === "object" && "text" in content) {
    const t = (content as { text: unknown }).text
    if (typeof t === "string") return t
  }
  return ""
}

async function retrieveCandidates(
  corpus: Corpus,
  queries: ReadonlyArray<CorpusQuery>,
): Promise<RetrievalResult[]> {
  const embedderL = buildEmbedderLayer()
  const supportLayer = Layer.mergeAll(
    ObservabilityService.Default.pipe(Layer.provide(Clock.Default)),
    embedderL,
    Clock.Default,
    LunaSqliteBootstrapLive,
  )
  const layer = Layer.unwrapEffect(
    Effect.gen(function* () {
      const backend = yield* SqliteVectorBackend
      return MemoryLayer({ rules: [{ pattern: "*", backend }] })
    }),
  ).pipe(
    Layer.provideMerge(SqliteVectorBackend.fromPath(":memory:")),
    Layer.provideMerge(supportLayer),
  )

  const results: RetrievalResult[] = []
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const router = yield* MemoryRouterTag
        for (const rec of corpus.records) {
          yield* router.put(
            makeRecord({
              id: rec.id,
              namespace: NAMESPACE,
              kind: rec.kind,
              content: { text: rec.text },
            }),
          )
        }
        for (const q of queries) {
          const hits = yield* Stream.runCollect(
            router.search({ queryText: q.text, namespace: NAMESPACE, topK: TOP_K, mode: "hybrid" }),
          )
          const arr = Array.from(hits)
          results.push({
            queryId: q.id,
            slice: q.slice,
            queryText: q.text,
            relevantIds: new Set(q.relevantIds),
            candidates: arr.map((h) => ({ id: h.record.id, text: textOf(h.record.content), score: h.score })),
          })
        }
      }),
    ).pipe(Effect.provide(layer)),
  )
  return results
}

// ---------------------------------------------------------------------------
// claude CLI plumbing
// ---------------------------------------------------------------------------

const MODEL = process.env["LUNA_RERANK_MODEL"] ?? "haiku"
const CROSS_ENCODER_MODE = process.env["LUNA_RERANK_ENGINE"] === "cross-encoder"
const CROSS_ENCODER_URL = (
  process.env["LUNA_RERANK_CE_URL"]?.trim() || DEFAULT_CROSS_ENCODER_URL
).replace(/\/+$/, "")

/** Validates LUNA_RERANK_CONCURRENCY explicitly rather than letting a bad
 * value (NaN from a non-numeric string) silently fall through Math.min/max
 * into mapLimit's Array.from({length: NaN}), which produces zero workers
 * and hangs the run instead of failing loudly. */
function resolveRequestedConcurrency(): number {
  const raw = process.env["LUNA_RERANK_CONCURRENCY"]
  if (raw === undefined) return 7
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 1) {
    console.error(`[rerank] invalid LUNA_RERANK_CONCURRENCY "${raw}" - must be a finite number >= 1`)
    process.exit(3)
  }
  return n
}
const CONCURRENCY = Math.max(6, Math.min(8, resolveRequestedConcurrency()))
const CLAUDE_DISALLOWED_TOOLS = "Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Task"
const CALL_TIMEOUT_MS = 45_000
const RETRY_ATTEMPTS = 2

// Run claude from a neutral cwd, not the repo, so it doesn't auto-discover
// this project's CLAUDE.md files - cuts system-prompt cache_creation tokens
// roughly in half (24k -> 17k measured) with no effect on scoring behavior.
const NEUTRAL_CWD = resolve(tmpdir(), "luna-rerank-eval-cwd")
if (!existsSync(NEUTRAL_CWD)) mkdirSync(NEUTRAL_CWD, { recursive: true })

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Spawns one `claude -p` call with the given prompt on stdin. Resolves with
 * the extracted `result` text field, or rejects on non-zero exit, timeout,
 * or an is_error result frame. */
function callClaudeOnce(prompt: string): Promise<{ text: string; tookMs: number }> {
  const t0 = performance.now()
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      "claude",
      [
        "-p",
        "--model",
        MODEL,
        "--output-format",
        "json",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--disallowedTools",
        CLAUDE_DISALLOWED_TOOLS,
      ],
      { cwd: NEUTRAL_CWD, stdio: ["pipe", "pipe", "pipe"] },
    )
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error(`claude call timed out after ${CALL_TIMEOUT_MS}ms`))
    }, CALL_TIMEOUT_MS)
    child.stdout.on("data", (d) => (stdout += String(d)))
    child.stderr.on("data", (d) => (stderr += String(d)))
    child.on("error", (e) => {
      clearTimeout(timer)
      reject(e)
    })
    // EPIPE guard: the child can exit before consuming stdin; without this
    // listener that throws an unhandled 'error' event instead of letting
    // the 'close' handler below report the real failure.
    child.stdin.on("error", () => {})
    child.on("close", (code) => {
      clearTimeout(timer)
      const tookMs = performance.now() - t0
      if (code !== 0) {
        reject(new Error(`claude exited ${code}: ${stderr.slice(0, 300)}`))
        return
      }
      try {
        const events = JSON.parse(stdout) as ReadonlyArray<Record<string, unknown>>
        const resultEvent = [...events].reverse().find((e) => e["type"] === "result")
        if (resultEvent === undefined) {
          reject(new Error("claude response had no result event"))
          return
        }
        if (resultEvent["is_error"] === true) {
          reject(new Error(`claude result error: ${String(resultEvent["result"])}`))
          return
        }
        resolvePromise({ text: String(resultEvent["result"] ?? ""), tookMs })
      } catch (e) {
        reject(new Error(`claude stdout was not valid JSON: ${e instanceof Error ? e.message : String(e)}`))
      }
    })
    child.stdin.write(prompt)
    child.stdin.end()
  })
}

/** Strips markdown code fences and pulls the first balanced {...} object. */
function extractJsonObject(text: string): unknown | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fenced ? fenced[1]! : text
  const braceMatch = body.match(/\{[\s\S]*\}/)
  const candidate = braceMatch ? braceMatch[0] : body.trim()
  try {
    return JSON.parse(candidate)
  } catch {
    return null
  }
}

async function callWithRetry(prompt: string): Promise<{ text: string; tookMs: number } | null> {
  let lastErr: unknown = null
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      return await callClaudeOnce(prompt)
    } catch (e) {
      lastErr = e
      if (attempt < RETRY_ATTEMPTS) {
        await sleep(250 + Math.random() * 500 * attempt)
      }
    }
  }
  console.error(`[rerank] call failed after ${RETRY_ATTEMPTS} attempts: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`)
  return null
}

async function mapLimit<T, R>(items: ReadonlyArray<T>, limit: number, fn: (item: T, idx: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let idx = 0
  async function worker(): Promise<void> {
    while (idx < items.length) {
      const i = idx++
      results[i] = await fn(items[i]!, i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return results
}

async function preflightClaude(): Promise<void> {
  const which = spawnSync("claude", ["--version"], { stdio: ["ignore", "pipe", "pipe"] })
  if (which.error || which.status !== 0) {
    console.error(`[rerank] claude CLI not found on PATH or failed \`claude --version\`.`)
    process.exit(5)
  }
  const probe = await callWithRetry('Reply with exactly this JSON and nothing else: {"ok": true}')
  if (probe === null) {
    console.error(`[rerank] claude CLI is unreachable or unauthenticated - run \`claude /login\` and retry.`)
    process.exit(5)
  }
  const parsed = extractJsonObject(probe.text) as { ok?: unknown } | null
  if (parsed === null || parsed.ok !== true) {
    console.error(`[rerank] claude CLI preflight returned an unexpected response: ${probe.text.slice(0, 200)}`)
    process.exit(5)
  }
}

// ---------------------------------------------------------------------------
// Rerank rubric (adapted from SIRA's relevance_v04.txt pointwise scorer)
// ---------------------------------------------------------------------------

// Bump this whenever RUBRIC, pointwisePrompt, or batchedPrompt's wording
// changes - it's part of the cache key, so a bump naturally invalidates
// stale cached scores instead of silently reusing scores for a different
// prompt. The cache file is gitignored, so old entries just re-miss.
const PROMPT_VERSION = "1"

const RUBRIC = `- 61-100: the candidate memory contains what the query asks about
- 41-60: the candidate memory is topically related but does not directly answer
- 0-40: the candidate memory is unrelated to the query`

function pointwisePrompt(query: string, candidateText: string): string {
  return `You are scoring how relevant a candidate memory is to a search query. Reason briefly, then score.

Query: ${query}

Candidate memory: ${candidateText}

Score 0-100:
${RUBRIC}

Output ONLY strict JSON, no markdown fences, no prose: {"score": <integer 0-100>}`
}

function batchedPrompt(query: string, candidates: ReadonlyArray<Candidate>): string {
  const numbered = candidates.map((c, i) => `${i + 1}. ${c.text}`).join("\n")
  return `You are scoring how relevant each candidate memory is to a search query. Reason briefly, then score every candidate.

Query: ${query}

Candidates:
${numbered}

For each candidate, score 0-100:
${RUBRIC}

Output ONLY strict JSON, no markdown fences, no prose, with one key per candidate number 1 through ${candidates.length}:
{"scores": {"1": <int>, "2": <int>, ...}}`
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

type Cache = Record<string, unknown>

/** Content-hashed cache key: model | shape | prompt version | query text |
 * joined candidate texts. Keying on text (not ids) plus PROMPT_VERSION
 * means a corpus edit or a rubric/prompt wording change naturally misses
 * the cache instead of silently reusing a score for different content. */
function cacheKey(
  shape: "batched" | "pointwise",
  queryText: string,
  candidateTexts: ReadonlyArray<string>,
): string {
  const engineKey = CROSS_ENCODER_MODE ? `cross-encoder|${CROSS_ENCODER_URL}` : MODEL
  const raw = `${engineKey}|${shape}|${PROMPT_VERSION}|${queryText}|${candidateTexts.join("\u0000")}`
  return createHash("sha256").update(raw).digest("hex").slice(0, 24)
}

function loadCache(path: string): Cache {
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Cache
  } catch {
    console.error(`[rerank] cache file at ${path} was unreadable - starting fresh`)
    return {}
  }
}

/** Atomic write: temp file in the same dir + rename, so a crash mid-write
 * can never leave a truncated/corrupt cache on disk. */
function flushCacheAtomic(cache: Cache, path: string): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, JSON.stringify(cache, null, 2))
  renameSync(tmp, path)
}

// A 15+ minute run losing every completed LLM call to a crash defeats the
// point of caching. Flush to disk every N successful cache writes (not every
// call - most calls are cache hits and write nothing) so a rerun after a
// crash only redoes the last partial batch, not the whole run.
const CACHE_FLUSH_INTERVAL = 20
let cacheWritesSinceFlush = 0

function persistCacheIncremental(cache: Cache, path: string): void {
  cacheWritesSinceFlush++
  if (cacheWritesSinceFlush < CACHE_FLUSH_INTERVAL) return
  cacheWritesSinceFlush = 0
  flushCacheAtomic(cache, path)
}

// ---------------------------------------------------------------------------
// Rerank execution
// ---------------------------------------------------------------------------

interface RerankOutcome {
  readonly queryId: string
  readonly slice: QuerySlice
  readonly relevantIds: ReadonlySet<string>
  /** Ranked ids after rerank, or the original hybrid order on fallback. */
  readonly rankedIds: ReadonlyArray<string>
  /** Top-1 LLM score, null when this query fell back to hybrid order. */
  readonly top1LlmScore: number | null
  readonly fell_back: boolean
}

interface CallStats {
  latenciesMs: number[]
  cacheHits: number
  cacheMisses: number
  failedQueries: number
  totalQueries: number
}

function freshStats(): CallStats {
  return { latenciesMs: [], cacheHits: 0, cacheMisses: 0, failedQueries: 0, totalQueries: 0 }
}

async function runBatchedShape(
  retrievals: ReadonlyArray<RetrievalResult>,
  cache: Cache,
  useCache: boolean,
  cachePath: string,
): Promise<{ outcomes: RerankOutcome[]; stats: CallStats }> {
  const stats = freshStats()
  stats.totalQueries = retrievals.length
  const outcomes = await mapLimit(retrievals, CONCURRENCY, async (r) => {
    const hybridOrder = r.candidates.map((c) => c.id)
    const key = cacheKey(
      "batched",
      r.queryText,
      r.candidates.map((c) => c.text),
    )
    let scores: Record<string, number> | null = null

    if (useCache && key in cache) {
      scores = cache[key] as Record<string, number>
      stats.cacheHits++
    } else {
      stats.cacheMisses++
      const resp = await callWithRetry(batchedPrompt(r.queryText, r.candidates))
      if (resp !== null) {
        stats.latenciesMs.push(resp.tookMs)
        const parsed = extractJsonObject(resp.text) as { scores?: Record<string, unknown> } | null
        if (parsed !== null && parsed.scores !== undefined) {
          const validated: Record<string, number> = {}
          let ok = true
          for (let i = 1; i <= r.candidates.length; i++) {
            const v = parsed.scores[String(i)]
            if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100) {
              ok = false
              break
            }
            validated[String(i)] = v
          }
          if (ok) {
            scores = validated
            if (useCache) {
              cache[key] = validated
              persistCacheIncremental(cache, cachePath)
            }
          }
        }
      }
    }

    if (scores === null) {
      stats.failedQueries++
      return {
        queryId: r.queryId,
        slice: r.slice,
        relevantIds: r.relevantIds,
        rankedIds: hybridOrder,
        top1LlmScore: null,
        fell_back: true,
      } satisfies RerankOutcome
    }

    const withScores = r.candidates.map((c, i) => ({ id: c.id, score: scores![String(i + 1)]!, origRank: i }))
    withScores.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.origRank - b.origRank))
    return {
      queryId: r.queryId,
      slice: r.slice,
      relevantIds: r.relevantIds,
      rankedIds: withScores.map((c) => c.id),
      top1LlmScore: withScores[0]?.score ?? null,
      fell_back: false,
    } satisfies RerankOutcome
  })
  return { outcomes, stats }
}

interface CrossEncoderBatchedRun {
  readonly outcomes: RerankOutcome[]
  readonly stats: CallStats
  readonly scoresByQuery: ReadonlyMap<string, ReadonlyMap<string, number>>
}

// The claude-CLI CONCURRENCY (6-8) is wrong for the cross-encoder engine.
// The bench DEFAULTS TO SEQUENTIAL (1) for two measured reasons:
//   1. Reliability: a timed-out client abandons its HTTP request but the
//      sidecar keeps processing the orphaned task, so concurrent callers
//      against a 1-slot server cascade into a growing queue and time out
//      (measured: CONCURRENCY~7 wedged into repeated 13-30s timeouts; even
//      2 produced occasional 2000ms-timeout fallbacks that silently drop
//      queries from the quality tables).
//   2. Bit-exactness: at concurrency > 1 the request COMPLETION order varies
//      run-to-run, and llama-server reuses each slot's KV cache by prompt
//      prefix, so the reuse pattern differs between runs and yields +/-1
//      point noise. Sequential fixes the order and the engine is bit-exact.
// 230 queries at ~0.9s each is ~3.5 min - fine for a measurement harness.
// Set LUNA_RERANK_CE_CONCURRENCY=N to trade determinism/reliability for
// throughput when benchmarking latency under load.
const CROSS_ENCODER_CONCURRENCY = (() => {
  const raw = process.env["LUNA_RERANK_CE_CONCURRENCY"]?.trim()
  const n = raw ? Number(raw) : 1
  return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : 1
})()

async function runCrossEncoderBatchedShape(
  retrievals: ReadonlyArray<RetrievalResult>,
  cache: Cache,
  useCache: boolean,
  cachePath: string,
  reranker: MemoryRerankerApi,
  // Concurrency is a parameter (not the module const) so the determinism
  // check can force sequential scoring. At concurrency > 1 the request
  // COMPLETION order varies run-to-run, and llama-server reuses each slot's
  // KV cache by prompt-prefix similarity, so the reuse pattern (recompute vs
  // reuse) differs between passes and produces +/-1 point KV-reuse noise.
  // Sequential scoring fixes the order, making the reuse pattern identical
  // and the engine bit-exact.
  concurrency: number = CROSS_ENCODER_CONCURRENCY,
): Promise<CrossEncoderBatchedRun> {
  const stats = freshStats()
  stats.totalQueries = retrievals.length
  const scoresByQuery = new Map<string, ReadonlyMap<string, number>>()
  const outcomes = await mapLimit(retrievals, concurrency, async (r) => {
    const hybridOrder = r.candidates.map((candidate) => candidate.id)
    const key = cacheKey(
      "batched",
      r.queryText,
      r.candidates.map((candidate) => candidate.text),
    )
    let indexedScores: Record<string, number> | null = null

    if (useCache && key in cache) {
      indexedScores = cache[key] as Record<string, number>
      stats.cacheHits++
    } else {
      stats.cacheMisses++
      const t0 = performance.now()
      try {
        const scores = await Effect.runPromise(
          reranker.rerank({
            queryText: r.queryText,
            candidates: r.candidates.map((candidate) => ({
              id: candidate.id,
              text: candidate.text,
              retrievalScore: candidate.score,
            })),
          }),
        )
        stats.latenciesMs.push(performance.now() - t0)
        const scoreById = new Map(scores.map((score) => [score.id, score.llmScore]))
        if (r.candidates.every((candidate) => scoreById.has(candidate.id))) {
          indexedScores = Object.fromEntries(
            r.candidates.map((candidate, index) => [String(index + 1), scoreById.get(candidate.id)!]),
          )
          if (useCache) {
            cache[key] = indexedScores
            persistCacheIncremental(cache, cachePath)
          }
        }
      } catch (error) {
        console.error(
          `[rerank] cross-encoder call failed for ${r.queryId}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }

    if (indexedScores === null) {
      stats.failedQueries++
      return {
        queryId: r.queryId,
        slice: r.slice,
        relevantIds: r.relevantIds,
        rankedIds: hybridOrder,
        top1LlmScore: null,
        fell_back: true,
      } satisfies RerankOutcome
    }

    const withScores = r.candidates.map((candidate, index) => ({
      id: candidate.id,
      score: indexedScores![String(index + 1)]!,
      origRank: index,
    }))
    if (withScores.some(({ score }) => typeof score !== "number" || !Number.isFinite(score))) {
      stats.failedQueries++
      return {
        queryId: r.queryId,
        slice: r.slice,
        relevantIds: r.relevantIds,
        rankedIds: hybridOrder,
        top1LlmScore: null,
        fell_back: true,
      } satisfies RerankOutcome
    }
    scoresByQuery.set(r.queryId, new Map(withScores.map(({ id, score }) => [id, score])))
    withScores.sort((a, b) =>
      b.score !== a.score ? b.score - a.score : a.origRank - b.origRank,
    )
    return {
      queryId: r.queryId,
      slice: r.slice,
      relevantIds: r.relevantIds,
      rankedIds: withScores.map((candidate) => candidate.id),
      top1LlmScore: withScores[0]?.score ?? null,
      fell_back: false,
    } satisfies RerankOutcome
  })
  return { outcomes, stats, scoresByQuery }
}

function assertDeterministic(
  retrievals: ReadonlyArray<RetrievalResult>,
  first: CrossEncoderBatchedRun,
  second: CrossEncoderBatchedRun,
): void {
  // Every delta, not just a sample: at 230 queries x 20 candidates a raw
  // per-line dump of every mismatch is thousands of lines and buries the
  // one signal that matters - whether deltas are 1-point floating-point
  // batching noise (see cross-encoder-reranker.ts's DEFAULT_CROSS_ENCODER_TIMEOUT_MS
  // comment on server-side queueing; --parallel > 1 reorders the matmul
  // reduction across concurrently-batched requests, which is a real,
  // non-buggy source of sub-integer score drift) or an actual regression
  // (deltas of several points, which floating-point reordering does not
  // produce). The histogram makes that distinction visible at a glance; a
  // few example lines from the WORST bucket keep it debuggable without
  // reprinting every occurrence.
  const unscored: string[] = []
  const deltaCounts = new Map<number, number>()
  const deltaExamples = new Map<number, string[]>()
  let identical = 0
  for (const retrieval of retrievals) {
    for (const candidate of retrieval.candidates) {
      const firstScore = first.scoresByQuery.get(retrieval.queryId)?.get(candidate.id)
      const secondScore = second.scoresByQuery.get(retrieval.queryId)?.get(candidate.id)
      if (firstScore === undefined || secondScore === undefined) {
        unscored.push(`${retrieval.queryId}/${candidate.id}`)
      } else if (firstScore === secondScore) {
        identical++
      } else {
        const delta = Math.abs(firstScore - secondScore)
        deltaCounts.set(delta, (deltaCounts.get(delta) ?? 0) + 1)
        const examples = deltaExamples.get(delta) ?? []
        if (examples.length < 3) {
          examples.push(`${retrieval.queryId}/${candidate.id}: ${firstScore} != ${secondScore}`)
        }
        deltaExamples.set(delta, examples)
      }
    }
  }
  if (
    first.stats.failedQueries > 0 ||
    second.stats.failedQueries > 0 ||
    unscored.length > 0
  ) {
    const totalQueries = retrievals.length
    console.error(
      `[rerank] determinism: INVALID - ${first.stats.failedQueries}/${totalQueries} queries fell back to hybrid order in pass 1, ${second.stats.failedQueries}/${totalQueries} in pass 2 - fix the underlying rerank failures before this check is meaningful`,
    )
    if (unscored.length > 0) {
      console.error(
        `[rerank] determinism: ${unscored.length} candidate comparisons were unscored because one or both passes lacked a score`,
      )
    }
    process.exit(6)
  }
  if (deltaCounts.size > 0) {
    console.error(`[rerank] determinism: FAIL`)
    const totalMismatches = Array.from(deltaCounts.values()).reduce((a, b) => a + b, 0)
    console.error(
      `[rerank] determinism: ${totalMismatches} of ${identical + totalMismatches} scored comparisons differed between passes - delta histogram (|pass1 - pass2| -> count):`,
    )
    Array.from(deltaCounts.keys())
      .sort((a, b) => a - b)
      .forEach((delta) => {
        console.error(`[rerank]   delta=${delta}: ${deltaCounts.get(delta)} occurrences`)
        deltaExamples.get(delta)!.forEach((example) => console.error(`[rerank]     e.g. ${example}`))
      })
    process.exit(4)
  }
  console.log(`determinism: PASS (${identical}/${identical} identical)`)
  console.log(``)
}

async function runPointwiseShape(
  retrievals: ReadonlyArray<RetrievalResult>,
  cache: Cache,
  useCache: boolean,
  cachePath: string,
): Promise<{ outcomes: RerankOutcome[]; stats: CallStats }> {
  const stats = freshStats()
  stats.totalQueries = retrievals.length
  // Flatten to one unit of work per (query, candidate) pair so the
  // concurrency limiter parallelizes across all pointwise calls, not just
  // across queries - this shape is 20x the call volume of batched.
  const outcomes = await mapLimit(retrievals, 1, async (r) => {
    const hybridOrder = r.candidates.map((c) => c.id)
    const perCandidate = await mapLimit(r.candidates, CONCURRENCY, async (c) => {
      const key = cacheKey("pointwise", r.queryText, [c.text])
      if (useCache && key in cache) {
        stats.cacheHits++
        return { id: c.id, score: cache[key] as number, failed: false }
      }
      stats.cacheMisses++
      const resp = await callWithRetry(pointwisePrompt(r.queryText, c.text))
      if (resp === null) return { id: c.id, score: null, failed: true }
      stats.latenciesMs.push(resp.tookMs)
      const parsed = extractJsonObject(resp.text) as { score?: unknown } | null
      const v = parsed?.score
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100) {
        return { id: c.id, score: null, failed: true }
      }
      if (useCache) {
        cache[key] = v
        persistCacheIncremental(cache, cachePath)
      }
      return { id: c.id, score: v, failed: false }
    })

    const anyFailed = perCandidate.some((p) => p.failed)
    if (anyFailed) {
      stats.failedQueries++
      return {
        queryId: r.queryId,
        slice: r.slice,
        relevantIds: r.relevantIds,
        rankedIds: hybridOrder,
        top1LlmScore: null,
        fell_back: true,
      } satisfies RerankOutcome
    }

    const withScores = perCandidate.map((p, i) => ({ id: p.id, score: p.score as number, origRank: i }))
    withScores.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.origRank - b.origRank))
    return {
      queryId: r.queryId,
      slice: r.slice,
      relevantIds: r.relevantIds,
      rankedIds: withScores.map((c) => c.id),
      top1LlmScore: withScores[0]?.score ?? null,
      fell_back: false,
    } satisfies RerankOutcome
  })
  return { outcomes, stats }
}

// ---------------------------------------------------------------------------
// Separation + injection threshold
// ---------------------------------------------------------------------------

interface SeparationRow {
  readonly label: string
  readonly negMedian: number
  readonly negP90: number
  readonly posMedian: number
  readonly posP90: number
}

function separationRow(
  label: string,
  results: ReadonlyArray<{ slice: QuerySlice; score: number | null }>,
): SeparationRow {
  const neg = results.filter((r) => r.slice === "negative" && r.score !== null).map((r) => r.score as number).sort((a, b) => a - b)
  const pos = results.filter((r) => r.slice !== "negative" && r.score !== null).map((r) => r.score as number).sort((a, b) => a - b)
  return {
    label,
    negMedian: percentile(neg, 50),
    negP90: percentile(neg, 90),
    posMedian: percentile(pos, 50),
    posP90: percentile(pos, 90),
  }
}

function tabulateSeparation(rows: ReadonlyArray<SeparationRow>): string {
  const header = `| stage                | neg median | neg p90 | pos median | pos p90 |`
  const sep = `|:---|---:|---:|---:|---:|`
  const body = rows.map(
    (r) =>
      `| ${r.label.padEnd(21)} | ${fmtScore(r.negMedian).padStart(10)} | ${fmtScore(r.negP90).padStart(7)} | ${fmtScore(
        r.posMedian,
      ).padStart(10)} | ${fmtScore(r.posP90).padStart(7)} |`,
  )
  return [header, sep, ...body].join("\n")
}

interface InjectionThreshold {
  readonly threshold: number
  readonly keepPositiveFrac: number
  readonly rejectNegativeFrac: number
  readonly meetsGoal: boolean
}

/** Highest integer threshold T such that keeping top-1 scores >= T retains
 * >=95% of positive queries AND rejects >=80% of negative queries. Falls
 * back to the T that maximizes reject-fraction subject to the 95% keep floor
 * if no T clears both bars, so the report always has a number to discuss. */
function computeInjectionThreshold(
  positiveScores: ReadonlyArray<number>,
  negativeScores: ReadonlyArray<number>,
): InjectionThreshold | null {
  if (positiveScores.length === 0 || negativeScores.length === 0) return null
  let bestMeetingGoal: InjectionThreshold | null = null
  let bestEffort: InjectionThreshold | null = null
  for (let t = 100; t >= 0; t--) {
    const keepFrac = positiveScores.filter((s) => s >= t).length / positiveScores.length
    const rejectFrac = negativeScores.filter((s) => s < t).length / negativeScores.length
    if (keepFrac >= 0.95) {
      if (bestEffort === null || rejectFrac > bestEffort.rejectNegativeFrac) {
        bestEffort = { threshold: t, keepPositiveFrac: keepFrac, rejectNegativeFrac: rejectFrac, meetsGoal: rejectFrac >= 0.8 }
      }
      if (rejectFrac >= 0.8 && bestMeetingGoal === null) {
        bestMeetingGoal = { threshold: t, keepPositiveFrac: keepFrac, rejectNegativeFrac: rejectFrac, meetsGoal: true }
      }
    }
  }
  return bestMeetingGoal ?? bestEffort
}

interface HoldoutThreshold {
  readonly meanKeepFrac: number
  readonly meanRejectFrac: number
  readonly folds: number
}

/** 2-fold cross-validated keep/reject: fit the threshold on one half of the
 * queries (deterministic even/odd index split), evaluate on the other half,
 * both directions, and average. The in-sample threshold above is optimistic
 * by construction (fit and scored on the same queries); this is the honest
 * out-of-sample estimate of how the gate would perform on unseen queries. */
function holdoutThresholdEstimate(
  positiveScores: ReadonlyArray<number>,
  negativeScores: ReadonlyArray<number>,
): HoldoutThreshold | null {
  const split = (xs: ReadonlyArray<number>) => [
    xs.filter((_, i) => i % 2 === 0),
    xs.filter((_, i) => i % 2 === 1),
  ]
  const [posA, posB] = split(positiveScores)
  const [negA, negB] = split(negativeScores)
  const evalFold = (
    train: { pos: number[]; neg: number[] },
    test: { pos: number[]; neg: number[] },
  ) => {
    const fit = computeInjectionThreshold(train.pos, train.neg)
    if (fit === null || test.pos.length === 0 || test.neg.length === 0) return null
    return {
      keep: test.pos.filter((s) => s >= fit.threshold).length / test.pos.length,
      reject: test.neg.filter((s) => s < fit.threshold).length / test.neg.length,
    }
  }
  const folds = [
    evalFold({ pos: posA!, neg: negA! }, { pos: posB!, neg: negB! }),
    evalFold({ pos: posB!, neg: negB! }, { pos: posA!, neg: negA! }),
  ].filter((f): f is { keep: number; reject: number } => f !== null)
  if (folds.length === 0) return null
  return {
    meanKeepFrac: folds.reduce((a, f) => a + f.keep, 0) / folds.length,
    meanRejectFrac: folds.reduce((a, f) => a + f.reject, 0) / folds.length,
    folds: folds.length,
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const limitIdx = args.indexOf("--limit")
  const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : undefined
  const useCache = !args.includes("--no-cache")

  if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
    console.error(`[rerank] --limit requires a positive integer`)
    process.exit(3)
  }

  const corpusPath = resolveCorpusPath()
  let corpus: Corpus
  try {
    corpus = loadCorpus(corpusPath)
  } catch (e) {
    console.error(`[rerank] corpus load failed (${corpusPath}): ${e instanceof Error ? e.message : String(e)}`)
    process.exit(3)
  }

  const embedderChoice = process.env["LUNA_EMBEDDER"]?.toLowerCase() ?? "stub"
  if (embedderChoice === "ollama") {
    const reachable = await probeOllama()
    if (!reachable) {
      console.error(`[rerank] Ollama unreachable at http://127.0.0.1:11434/ - start the daemon or unset LUNA_EMBEDDER.`)
      process.exit(2)
    }
  }

  let crossEncoderReranker: MemoryRerankerApi | null = null
  if (CROSS_ENCODER_MODE) {
    console.log(`[rerank] preflight: checking cross-encoder at ${CROSS_ENCODER_URL}...`)
    try {
      const probe = await Effect.runPromise(probeCrossEncoder(CROSS_ENCODER_URL))
      console.log(
        `[rerank] preflight OK - engine=cross-encoder url=${CROSS_ENCODER_URL} relevant=${probe.relevantRawScore} irrelevant=${probe.irrelevantRawScore}`,
      )
      crossEncoderReranker = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* MemoryReranker
        }).pipe(Effect.provide(CrossEncoderRerankerLayer({ url: CROSS_ENCODER_URL }))),
      )
    } catch (error) {
      console.error(
        `[rerank] cross-encoder preflight failed at ${CROSS_ENCODER_URL}: ${error instanceof Error ? error.message : String(error)}`,
      )
      process.exit(6)
      return
    }
  } else {
    console.log(`[rerank] preflight: checking claude CLI...`)
    await preflightClaude()
    console.log(`[rerank] preflight OK - model=${MODEL} concurrency=${CONCURRENCY}`)
  }

  const queries = limit !== undefined ? corpus.queries.slice(0, limit) : corpus.queries
  console.log(`# rerank-eval - ${corpus.records.length} records, ${queries.length} queries · ${corpusPath}`)
  console.log(`# embedder: ${embedderChoice}${limit !== undefined ? ` · --limit ${limit}` : ""}`)
  console.log(``)

  let retrievals: RetrievalResult[]
  try {
    retrievals = await retrieveCandidates(corpus, queries)
  } catch (e) {
    console.error(`[rerank] retrieval phase failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
    process.exit(4)
    return
  }

  const cachePath = resolve(dirname(fileURLToPath(import.meta.url)), ".rerank-cache.json")
  const cache = useCache ? loadCache(cachePath) : {}

  console.log(`## batched shape (1 call/query, ${retrievals.length} calls)`)
  console.log(``)
  const batchedRun = CROSS_ENCODER_MODE
    ? await runCrossEncoderBatchedShape(
        retrievals,
        cache,
        useCache,
        cachePath,
        crossEncoderReranker!,
      )
    : await runBatchedShape(retrievals, cache, useCache, cachePath)
  const { outcomes: batchedOutcomes, stats: batchedStats } = batchedRun

  if (CROSS_ENCODER_MODE) {
    // Two FRESH sequential passes (concurrency 1, no cache) so the request
    // order is fixed and the server's KV-prefix reuse is identical between
    // them - this proves the engine itself is bit-exact, independent of the
    // quality pass's throughput concurrency. (The quality pass above may run
    // at concurrency > 1; comparing it here would surface harmless KV-reuse
    // noise, not engine nondeterminism.)
    const passA = await runCrossEncoderBatchedShape(
      retrievals,
      {},
      false,
      cachePath,
      crossEncoderReranker!,
      1,
    )
    const passB = await runCrossEncoderBatchedShape(
      retrievals,
      {},
      false,
      cachePath,
      crossEncoderReranker!,
      1,
    )
    assertDeterministic(retrievals, passA, passB)
  }

  let subsample: ReadonlyArray<RetrievalResult> = []
  let subsampleIds = new Set<string>()
  let pointwiseOutcomes: RerankOutcome[] = []
  let pointwiseStats = freshStats()
  if (CROSS_ENCODER_MODE) {
    console.log(
      `[rerank] NOTE: pointwise shape skipped - the cross-encoder scores all candidates in one production-shaped request; one-candidate calls would only imitate the claude CLI comparison.`,
    )
    console.log(``)
  } else {
    // Subsample selection for the pointwise shape, in corpus order.
    const vocabWant = Number(process.env["LUNA_RERANK_SUBSAMPLE_VOCAB"] ?? "12")
    const paraphraseWant = Number(process.env["LUNA_RERANK_SUBSAMPLE_PARAPHRASE"] ?? "6")
    const negativeWant = Number(process.env["LUNA_RERANK_SUBSAMPLE_NEGATIVE"] ?? "6")
    const bySlice = (s: QuerySlice, want: number) => retrievals.filter((r) => r.slice === s).slice(0, want)
    subsample = [
      ...bySlice("vocab-mismatch", vocabWant),
      ...bySlice("paraphrase", paraphraseWant),
      ...bySlice("negative", negativeWant),
    ]
    subsampleIds = new Set(subsample.map((r) => r.queryId))
    if (subsample.length < vocabWant + paraphraseWant + negativeWant) {
      console.log(
        `[rerank] NOTE: subsample smaller than requested (${subsample.length} of ${vocabWant + paraphraseWant + negativeWant}) - --limit likely cut into slice availability`,
      )
    }

    console.log(`## pointwise shape (1 call/candidate, ${subsample.length} queries x 20 = ${subsample.length * 20} calls)`)
    console.log(``)
    const pointwiseRun = await runPointwiseShape(subsample, cache, useCache, cachePath)
    pointwiseOutcomes = pointwiseRun.outcomes
    pointwiseStats = pointwiseRun.stats
  }

  // Final flush unconditionally (incremental flushing only fires every
  // CACHE_FLUSH_INTERVAL writes, so the last partial batch needs this).
  if (useCache) {
    flushCacheAtomic(cache, cachePath)
  }

  // ---- Table (a): hybrid vs batched-reranked, full processed corpus ----
  // Fallback queries (parse/CLI failure -> rankedIds is just hybrid order
  // relabeled) are excluded from the "reranked" rows below: including them
  // would silently blend hybrid-order results into the rerank metric and
  // make the comparison dishonest. They're reported as a separate count.
  const hybridScored: ScoredQuery[] = retrievals.map((r) => ({
    queryId: r.queryId,
    slice: r.slice,
    relevantIds: r.relevantIds,
    rankedIds: r.candidates.map((c) => c.id),
  }))
  const batchedNonFallback = batchedOutcomes.filter((o) => !o.fell_back)
  const batchedScored: ScoredQuery[] = batchedNonFallback.map((o) => ({
    queryId: o.queryId,
    slice: o.slice,
    relevantIds: o.relevantIds,
    rankedIds: o.rankedIds,
  }))
  const batchedExcluded = batchedOutcomes.length - batchedNonFallback.length
  const hybridTable = slicesTable(hybridScored)
  const batchedTable = slicesTable(batchedScored)

  console.log(`## (a) hybrid vs batched-reranked, full processed set (${retrievals.length} queries)`)
  console.log(``)
  console.log(`### hybrid (pre-rerank)`)
  console.log(``)
  console.log(tabulateSlices([...hybridTable.rows, hybridTable.overall, hybridTable.macro]))
  console.log(``)
  console.log(`### reranked (batched, ${batchedScored.length} of ${batchedOutcomes.length} queries)`)
  console.log(``)
  console.log(tabulateSlices([...batchedTable.rows, batchedTable.overall, batchedTable.macro]))
  console.log(``)
  console.log(
    `excluded ${batchedExcluded} fallback quer${batchedExcluded === 1 ? "y" : "ies"} from the reranked rows above (fell back to hybrid order on parse/CLI failure)`,
  )
  console.log(``)

  // ---- Table (b): batched vs pointwise on the subsample queries ----
  const batchedOnSubsample = batchedScored.filter((s) => subsampleIds.has(s.queryId))
  const batchedSubsampleExcluded = subsample.length - batchedOnSubsample.length
  const pointwiseNonFallback = pointwiseOutcomes.filter((o) => !o.fell_back)
  const pointwiseScored: ScoredQuery[] = pointwiseNonFallback.map((o) => ({
    queryId: o.queryId,
    slice: o.slice,
    relevantIds: o.relevantIds,
    rankedIds: o.rankedIds,
  }))
  const pointwiseExcluded = pointwiseOutcomes.length - pointwiseNonFallback.length
  const batchedSubsampleTable = slicesTable(batchedOnSubsample)
  const pointwiseTable = slicesTable(pointwiseScored)

  if (!CROSS_ENCODER_MODE) {
    console.log(`## (b) batched vs pointwise, subsample queries (${subsample.length} queries)`)
    console.log(``)
    console.log(`### batched (subsample, ${batchedOnSubsample.length} of ${subsample.length} queries)`)
    console.log(``)
    console.log(tabulateSlices([...batchedSubsampleTable.rows, batchedSubsampleTable.overall, batchedSubsampleTable.macro]))
    console.log(``)
    console.log(
      `excluded ${batchedSubsampleExcluded} fallback quer${batchedSubsampleExcluded === 1 ? "y" : "ies"} from the batched (subsample) rows above`,
    )
    console.log(``)
    console.log(`### pointwise (subsample, ${pointwiseScored.length} of ${subsample.length} queries)`)
    console.log(``)
    console.log(tabulateSlices([...pointwiseTable.rows, pointwiseTable.overall, pointwiseTable.macro]))
    console.log(``)
    console.log(
      `excluded ${pointwiseExcluded} fallback quer${pointwiseExcluded === 1 ? "y" : "ies"} from the pointwise (subsample) rows above`,
    )
    console.log(``)
  }

  // ---- Table (c): negative separation before/after + injection threshold ----
  const beforeRows = retrievals.map((r) => ({ slice: r.slice, score: r.candidates[0]?.score ?? null }))
  const afterRows = batchedOutcomes
    .filter((o) => !o.fell_back)
    .map((o) => ({ slice: o.slice, score: o.top1LlmScore }))

  console.log(`## (c) negative separation before/after (batched shape, non-fallback queries)`)
  console.log(``)
  console.log(tabulateSeparation([separationRow("hybrid (before)", beforeRows), separationRow("LLM rerank (after)", afterRows)]))
  console.log(``)

  const positiveTop1 = afterRows.filter((r) => r.slice !== "negative" && r.score !== null).map((r) => r.score as number)
  const negativeTop1 = afterRows.filter((r) => r.slice === "negative" && r.score !== null).map((r) => r.score as number)
  const threshold = computeInjectionThreshold(positiveTop1, negativeTop1)
  if (threshold === null) {
    console.log(`suggested injection threshold: n/a (insufficient positive or negative samples)`)
  } else {
    const fragileBandCount = CROSS_ENCODER_MODE
      ? Array.from(
          (batchedRun as CrossEncoderBatchedRun).scoresByQuery.values(),
          (scores) => Array.from(scores.values()),
        )
          .flat()
          .filter((score) => Math.abs(score - threshold.threshold) <= 5).length
      : null
    console.log(
      `suggested injection threshold: score >= ${threshold.threshold} (IN-SAMPLE: keeps ${(threshold.keepPositiveFrac * 100).toFixed(
        1,
      )}% of positive top-1s, rejects ${(threshold.rejectNegativeFrac * 100).toFixed(1)}% of negative top-1s - fit and scored on the same queries, so optimistic)${
        threshold.meetsGoal ? "" : " - does NOT meet the 95%/80% goal, best effort shown"
      }${fragileBandCount === null ? "" : ` - fragile band +/-5: ${fragileBandCount} scored candidates`}`,
    )
    const holdout = holdoutThresholdEstimate(positiveTop1, negativeTop1)
    if (holdout !== null) {
      console.log(
        `holdout estimate (2-fold CV): keeps ${(holdout.meanKeepFrac * 100).toFixed(1)}% / rejects ${(holdout.meanRejectFrac * 100).toFixed(1)}% on unseen queries`,
      )
    }
  }
  console.log(``)

  // ---- Table (d): LLM latency per shape ----
  console.log(`## (d) LLM call latency`)
  console.log(``)
  console.log(
    tabulateLatency(
      CROSS_ENCODER_MODE
        ? [latencyFor("cross-encoder (per query)", batchedStats.latenciesMs)]
        : [
            latencyFor("batched (per query, 1 call)", batchedStats.latenciesMs),
            latencyFor("pointwise (per call, ~20/query)", pointwiseStats.latenciesMs),
          ],
    ),
  )
  console.log(``)

  // ---- Parse-failure + cache reporting ----
  const batchedFailRate = batchedStats.totalQueries > 0 ? batchedStats.failedQueries / batchedStats.totalQueries : 0
  const pointwiseFailRate = pointwiseStats.totalQueries > 0 ? pointwiseStats.failedQueries / pointwiseStats.totalQueries : 0
  console.log(`## parse-failure + cache stats`)
  console.log(``)
  console.log(
    `batched: ${batchedStats.failedQueries}/${batchedStats.totalQueries} queries fell back to hybrid order (${(
      batchedFailRate * 100
    ).toFixed(1)}%), cache hits ${batchedStats.cacheHits} / misses ${batchedStats.cacheMisses}`,
  )
  if (!CROSS_ENCODER_MODE) {
    console.log(
      `pointwise: ${pointwiseStats.failedQueries}/${pointwiseStats.totalQueries} queries fell back to hybrid order (${(
        pointwiseFailRate * 100
      ).toFixed(1)}%), cache hits ${pointwiseStats.cacheHits} / misses ${pointwiseStats.cacheMisses}`,
    )
  }
  if (batchedFailRate > 0.05) {
    console.log(`[rerank] WARNING: batched parse-failure rate ${(batchedFailRate * 100).toFixed(1)}% exceeds 5%`)
  }
  if (!CROSS_ENCODER_MODE && pointwiseFailRate > 0.05) {
    console.log(`[rerank] WARNING: pointwise parse-failure rate ${(pointwiseFailRate * 100).toFixed(1)}% exceeds 5%`)
  }
  console.log(``)

  const jsonPath = process.env["LUNA_BENCH_JSON"]
  if (jsonPath !== undefined) {
    writeFileSync(
      jsonPath,
      JSON.stringify(
        {
          corpus: { records: corpus.records.length, queries: retrievals.length },
          embedder: embedderChoice,
          model: CROSS_ENCODER_MODE ? `cross-encoder|${CROSS_ENCODER_URL}` : MODEL,
          hybrid: hybridTable,
          batched: batchedTable,
          batchedOnSubsample: batchedSubsampleTable,
          pointwise: pointwiseTable,
          separation: { before: separationRow("hybrid", beforeRows), after: separationRow("llm", afterRows) },
          injectionThreshold: threshold,
          latency: { batched: latencyFor("batched", batchedStats.latenciesMs), pointwise: latencyFor("pointwise", pointwiseStats.latenciesMs) },
          parseFailure: { batchedRate: batchedFailRate, pointwiseRate: pointwiseFailRate },
          excludedFallback: {
            batched: batchedExcluded,
            batchedOnSubsample: batchedSubsampleExcluded,
            pointwise: pointwiseExcluded,
          },
        },
        null,
        2,
      ),
    )
    console.log(`[rerank] wrote full results to ${jsonPath}`)
  }
}

try {
  await main()
} catch (e) {
  console.error(`[rerank] runtime failure: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
  process.exit(4)
}
