/**
 * memory-suite - cross-mode retrieval quality bench.
 *
 * Seeds a fresh sqlite-vector backend with the corpus records, then runs
 * every query against all three search modes ("bm25", "vec", "hybrid") and
 * reports recall@1/5/10, MRR, and nDCG@10 per slice, plus latency and
 * negative-query score separation. Unlike paraphrase-recall.ts (single mode,
 * single "does this beat a threshold" question), this is a comparison
 * harness across modes and query difficulty slices - report-only by default.
 *
 * NOT a vitest. Run via:
 *   bun packages/memory/bench/memory-suite.ts --sample        (stub embedder, tiny fixture)
 *   LUNA_TEST_OLLAMA=1 LUNA_EMBEDDER=ollama LUNA_OLLAMA_EMBED_MODEL=nomic-embed-text \
 *     bun packages/memory/bench/memory-suite.ts
 *
 * When LUNA_EMBEDDER=ollama, LUNA_OLLAMA_EMBED_MODEL is required - the
 * Ollama embedder has no built-in default model.
 *
 * Env:
 *   LUNA_BENCH_CORPUS            path to a corpus JSON file (default: sibling
 *                                memory-suite-corpus.json)
 *   LUNA_BENCH_JSON              if set, write full structured results here
 *   LUNA_BENCH_ENFORCE           "1" to gate on hybrid recall@5 (default "0", report-only)
 *   LUNA_BENCH_RECALL_THRESHOLD  hybrid OVERALL recall@5 floor when enforcing (default 0.85)
 *   LUNA_BENCH_ENRICHMENT        path to an enrichment sidecar (see enrich-corpus.ts);
 *                                overrides --enriched's default path when set
 *   --sample                     use the bundled memory-suite-corpus.sample.json fixture
 *   --enriched                   merge the sibling memory-suite-corpus.enrichment.json
 *                                sidecar into each record before put() (Experiment A).
 *                                Embedding input is unaffected either way - only the
 *                                lexical (bm25/hybrid-terms) index gains the phrases.
 *
 * Exit codes:
 *   0  ran to completion (report-only, or enforce passed)
 *   1  LUNA_BENCH_ENFORCE=1 and hybrid OVERALL recall@5 < threshold
 *   2  Ollama unreachable (skip - daemon not running)
 *   3  corpus invalid, load error, or invalid configuration
 *   4  runtime failure (backend/embedder error mid-run)
 */
import { readFileSync, writeFileSync } from "node:fs"
import { basename, resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect, Layer, Stream } from "effect"
import {
  Clock,
  ObservabilityService,
  StubEmbedderLayer,
  makeOllamaEmbedderLayer,
} from "@luna/core"
import { SqliteVectorBackend } from "../src/backends/sqlite-vector.js"
import { LunaSqliteBootstrapLive } from "../src/backends/vectorlite-bootstrap.js"
import { MemoryLayer } from "../src/layer.js"
import { MemoryRouterTag } from "../src/router.js"
import { makeRecord } from "../src/types.js"

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

const RECORD_KINDS = new Set<string>([
  "project",
  "preference",
  "episodic",
  "distractor",
])
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

const MODES = ["bm25", "vec", "hybrid", "hybrid-terms"] as const
type Mode = (typeof MODES)[number]

const TOP_K = 10
const NAMESPACE = "bench"
const RECALL_THRESHOLD = Number(
  process.env["LUNA_BENCH_RECALL_THRESHOLD"] ?? "0.85",
)
const ENFORCE = process.env["LUNA_BENCH_ENFORCE"] === "1"

async function probeOllama(): Promise<boolean> {
  const baseUrl =
    process.env["LUNA_OLLAMA_BASE_URL"] ??
    process.env["OLLAMA_HOST"] ??
    "http://127.0.0.1:11434"
  const url = baseUrl.startsWith("http") ? baseUrl : `http://${baseUrl}`
  try {
    const res = await fetch(url.replace(/\/+$/, "") + "/", {
      signal: AbortSignal.timeout(1500),
    })
    return res.ok || res.status < 500
  } catch {
    return false
  }
}

function resolveCorpusPath(sample: boolean): string {
  const here = dirname(fileURLToPath(import.meta.url))
  if (sample) return resolve(here, "memory-suite-corpus.sample.json")
  const envPath = process.env["LUNA_BENCH_CORPUS"]
  if (envPath !== undefined) return resolve(envPath)
  return resolve(here, "memory-suite-corpus.json")
}

interface EnrichmentSidecar {
  readonly file: string
  readonly model: string
  readonly generatedAt: string
  readonly phrases: Readonly<Record<string, ReadonlyArray<string>>>
}

/** `LUNA_BENCH_ENRICHMENT` wins over `--enriched`'s default sibling path;
 * neither present means enrichment stays off (report-only comparison knob,
 * not a default-on feature - see Deliverable 3 in the enrichment plan). */
function resolveEnrichmentPath(): string | null {
  const envPath = process.env["LUNA_BENCH_ENRICHMENT"]
  if (envPath !== undefined) return resolve(envPath)
  if (process.argv.includes("--enriched")) {
    const here = dirname(fileURLToPath(import.meta.url))
    return resolve(here, "memory-suite-corpus.enrichment.json")
  }
  return null
}

function loadEnrichment(path: string): EnrichmentSidecar {
  const raw = readFileSync(path, "utf8")
  const parsed = JSON.parse(raw) as {
    model?: unknown
    generatedAt?: unknown
    phrases?: unknown
  }
  if (parsed.phrases === null || typeof parsed.phrases !== "object") {
    throw new Error(`enrichment sidecar missing \`phrases\` object (${path})`)
  }
  return {
    file: basename(path),
    model: typeof parsed.model === "string" ? parsed.model : "unknown",
    generatedAt: typeof parsed.generatedAt === "string" ? parsed.generatedAt : "unknown",
    phrases: parsed.phrases as Record<string, ReadonlyArray<string>>,
  }
}

/**
 * Validates the corpus shape by hand (no schema library dependency for a
 * bench script). Throws with a message pointing at the offending index so a
 * corpus author can fix it without a debugger.
 */
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
      throw new Error(
        `corpus.records[${i}] (${rec.id}): invalid \`kind\` "${String(rec.kind)}"`,
      )
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
      throw new Error(
        `corpus.queries[${i}] (${q.id}): invalid \`slice\` "${String(q.slice)}"`,
      )
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

interface QueryResult {
  readonly queryId: string
  readonly slice: QuerySlice
  readonly relevantIds: ReadonlySet<string>
  readonly rankedIds: ReadonlyArray<string>
  readonly scores: ReadonlyArray<number>
  readonly tookMs: number
}

/** 1-indexed ranks (in emission order) of every relevant hit. */
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

/** True recall@k: fraction of the query's relevant ids found in the top k.
 * Equal to hit-rate for single-relevant queries (the common case). */
function recallAtK(
  ranks: ReadonlyArray<number>,
  k: number,
  relevantCount: number,
): number {
  if (relevantCount === 0) return 0
  return ranks.filter((r) => r <= k).length / relevantCount
}

function mrrOf(ranks: ReadonlyArray<number>): number {
  if (ranks.length === 0) return 0
  return 1 / Math.min(...ranks)
}

/** Binary-relevance nDCG@10: DCG over relevant hits in top 10, normalized by
 * the ideal DCG for min(|relevantIds|, 10) relevant hits ranked first. */
function ndcgAt10(ranks: ReadonlyArray<number>, relevantCount: number): number {
  const dcg = ranks
    .filter((r) => r <= 10)
    .reduce((acc, r) => acc + 1 / Math.log2(r + 1), 0)
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

function aggregateSlice(
  results: ReadonlyArray<QueryResult>,
  label: string,
): SliceMetrics {
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

function tabulateSlices(rows: ReadonlyArray<SliceMetrics>): string {
  const header = `| slice          | queries | recall@1 | recall@5 | recall@10 | MRR   | nDCG@10 |`
  const sep = `|:---|---:|---:|---:|---:|---:|---:|`
  const body = rows.map(
    (r) =>
      `| ${r.slice.padEnd(14)} | ${String(r.queries).padStart(7)} | ${r.recallAt1
        .toFixed(3)
        .padStart(8)} | ${r.recallAt5.toFixed(3).padStart(8)} | ${r.recallAt10
        .toFixed(3)
        .padStart(9)} | ${r.mrr.toFixed(3).padStart(5)} | ${r.ndcg10
        .toFixed(3)
        .padStart(7)} |`,
  )
  return [header, sep, ...body].join("\n")
}

/** Linear-interpolation percentile over a pre-sorted ascending array. */
function percentile(sorted: ReadonlyArray<number>, p: number): number {
  if (sorted.length === 0) return NaN
  if (sorted.length === 1) return sorted[0]!
  const idx = (p / 100) * (sorted.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]!
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo)
}

interface LatencyMetrics {
  readonly mode: Mode
  readonly mean: number
  readonly p50: number
  readonly p95: number
}

function latencyFor(mode: Mode, tookMsList: ReadonlyArray<number>): LatencyMetrics {
  const sorted = [...tookMsList].sort((a, b) => a - b)
  const mean = sorted.length > 0 ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0
  return { mode, mean, p50: percentile(sorted, 50), p95: percentile(sorted, 95) }
}

function fmtMs(n: number): string {
  return Number.isNaN(n) ? "n/a" : n.toFixed(2)
}

function tabulateLatency(rows: ReadonlyArray<LatencyMetrics>): string {
  const header = `| mode         | mean (ms) | p50 (ms) | p95 (ms) |`
  const sep = `|:---|---:|---:|---:|`
  const body = rows.map(
    (r) =>
      `| ${r.mode.padEnd(12)} | ${fmtMs(r.mean).padStart(9)} | ${fmtMs(r.p50).padStart(8)} | ${fmtMs(r.p95).padStart(8)} |`,
  )
  return [header, sep, ...body].join("\n")
}

interface SeparationMetrics {
  readonly mode: Mode
  readonly negMedian: number
  readonly negP90: number
  readonly posMedian: number
  readonly posP90: number
}

function fmtScore(n: number): string {
  return Number.isNaN(n) ? "n/a" : n.toFixed(3)
}

function separationFor(
  mode: Mode,
  results: ReadonlyArray<QueryResult>,
): SeparationMetrics {
  const top1 = (r: QueryResult) => r.scores[0] ?? 0
  const negSorted = results
    .filter((r) => r.slice === "negative")
    .map(top1)
    .sort((a, b) => a - b)
  const posSorted = results
    .filter((r) => r.slice !== "negative")
    .map(top1)
    .sort((a, b) => a - b)
  return {
    mode,
    negMedian: percentile(negSorted, 50),
    negP90: percentile(negSorted, 90),
    posMedian: percentile(posSorted, 50),
    posP90: percentile(posSorted, 90),
  }
}

function tabulateSeparation(rows: ReadonlyArray<SeparationMetrics>): string {
  const header = `| mode         | neg median | neg p90 | pos median | pos p90 |`
  const sep = `|:---|---:|---:|---:|---:|`
  const body = rows.map(
    (r) =>
      `| ${r.mode.padEnd(12)} | ${fmtScore(r.negMedian).padStart(10)} | ${fmtScore(r.negP90).padStart(7)} | ${fmtScore(r.posMedian).padStart(10)} | ${fmtScore(r.posP90).padStart(7)} |`,
  )
  return [header, sep, ...body].join("\n")
}

async function main(): Promise<void> {
  const sample = process.argv.includes("--sample")
  const corpusPath = resolveCorpusPath(sample)

  // A malformed threshold would make `recall < NaN` always false and the
  // enforce gate silently pass; refuse to run misconfigured instead.
  if (ENFORCE && !Number.isFinite(RECALL_THRESHOLD)) {
    console.error(
      `[bench] invalid LUNA_BENCH_RECALL_THRESHOLD ${JSON.stringify(process.env["LUNA_BENCH_RECALL_THRESHOLD"])} - must be a finite number`,
    )
    process.exit(3)
  }

  let corpus: Corpus
  try {
    corpus = loadCorpus(corpusPath)
  } catch (e) {
    console.error(
      `[bench] corpus load failed (${corpusPath}): ${e instanceof Error ? e.message : String(e)}`,
    )
    process.exit(3)
  }

  const enrichmentPath = resolveEnrichmentPath()
  let enrichment: EnrichmentSidecar | null = null
  if (enrichmentPath !== null) {
    try {
      enrichment = loadEnrichment(enrichmentPath)
    } catch (e) {
      console.error(
        `[bench] enrichment sidecar load failed (${enrichmentPath}): ${e instanceof Error ? e.message : String(e)} - run enrich-corpus.ts first, or unset LUNA_BENCH_ENRICHMENT/--enriched`,
      )
      process.exit(3)
    }
  }
  const enrichedCount =
    enrichment !== null
      ? corpus.records.filter((r) => (enrichment!.phrases[r.id]?.length ?? 0) > 0).length
      : 0

  const embedderChoice = process.env["LUNA_EMBEDDER"]?.toLowerCase() ?? "stub"
  if (embedderChoice === "ollama") {
    const reachable = await probeOllama()
    if (!reachable) {
      console.error(
        "[bench] Ollama unreachable at http://127.0.0.1:11434/ - start the daemon or unset LUNA_EMBEDDER.",
      )
      process.exit(2)
    }
  }

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

  console.log(
    `# memory-suite - ${corpus.records.length} records, ${corpus.queries.length} queries · ${corpusPath}`,
  )
  console.log(`# embedder: ${embedderChoice}`)
  if (enrichment !== null) {
    console.log(
      `# enrichment: ${enrichment.file} (${enrichment.model}, ${enrichedCount} records enriched)`,
    )
  }
  if (embedderChoice === "stub") {
    console.log(
      `# NOTE: stub embedder in use - stub vectors are a deterministic bag-of-tokens hash sketch, so vec/hybrid approximate unweighted bag-of-words cosine (a lexical sanity baseline, NOT semantic retrieval). Use LUNA_EMBEDDER=ollama for real numbers. bm25 numbers are real lexical results either way.`,
    )
  }
  console.log(``)

  const allResults: Record<Mode, QueryResult[]> = {
    bm25: [],
    vec: [],
    hybrid: [],
    "hybrid-terms": [],
  }

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const router = yield* MemoryRouterTag
        for (const rec of corpus.records) {
          const phrases = enrichment?.phrases[rec.id]
          const content: Record<string, unknown> = { text: rec.text }
          // Lexical-index-only: enrichment phrases never reach the embedder
          // (see put() in sqlite-vector.ts) - only the bm25/hybrid-terms
          // index gains them. Vec numbers must be identical either way.
          if (phrases !== undefined && phrases.length > 0) {
            content["enrichmentPhrases"] = phrases
          }
          yield* router.put(
            makeRecord({
              id: rec.id,
              namespace: NAMESPACE,
              kind: rec.kind,
              content,
            }),
          )
        }
        // Untimed warmup pass: absorbs JIT, cold FTS/HNSW caches, and
        // first-call embedder setup so no mode pays first-run cost in the
        // timed pass (running one mode's block first previously inflated
        // its latency ~2x - an execution-order artifact, not a real cost).
        for (const q of corpus.queries.slice(0, 25)) {
          for (const mode of MODES) {
            yield* Stream.runCollect(
              router.search({
                queryText: q.text,
                namespace: NAMESPACE,
                topK: TOP_K,
                mode,
              }),
            )
          }
        }
        // Timed pass, mode-interleaved per query so drift (GC, machine
        // load) spreads evenly across modes instead of biasing one block.
        for (const q of corpus.queries) {
          for (const mode of MODES) {
            const t0 = performance.now()
            const hits = yield* Stream.runCollect(
              router.search({
                queryText: q.text,
                namespace: NAMESPACE,
                topK: TOP_K,
                mode,
              }),
            )
            const tookMs = performance.now() - t0
            const arr = Array.from(hits)
            allResults[mode].push({
              queryId: q.id,
              slice: q.slice,
              relevantIds: new Set(q.relevantIds),
              rankedIds: arr.map((h) => h.record.id),
              scores: arr.map((h) => h.score),
              tookMs,
            })
          }
        }
      }),
    ).pipe(Effect.provide(layer)),
  )

  const jsonOut: Record<string, unknown> = {
    // basename only: absolute paths are machine-specific noise in a
    // committed baseline file.
    corpus: { file: basename(corpusPath), records: corpus.records.length, queries: corpus.queries.length },
    embedder: embedderChoice,
    enrichment:
      enrichment !== null
        ? {
            file: enrichment.file,
            model: enrichment.model,
            coverage: enrichedCount / corpus.records.length,
          }
        : null,
    modes: {} as Record<string, unknown>,
  }
  const jsonModes = jsonOut["modes"] as Record<string, unknown>

  let hybridOverallRecall5: number | null = null

  for (const mode of MODES) {
    const results = allResults[mode]
    const positiveResults = results.filter((r) => r.slice !== "negative")
    const presentSlices = POSITIVE_SLICE_ORDER.filter((s) =>
      positiveResults.some((r) => r.slice === s),
    )
    const sliceRows = presentSlices.map((s) =>
      aggregateSlice(
        positiveResults.filter((r) => r.slice === s),
        s,
      ),
    )
    const overallRow = aggregateSlice(positiveResults, "OVERALL")
    // OVERALL is a micro-average (every positive query weighted equally),
    // so it inherits the corpus's slice proportions. MACRO is the unweighted
    // mean of the slice rows and is insensitive to those proportions.
    const macroRow: SliceMetrics = {
      slice: "MACRO",
      queries: sliceRows.length,
      recallAt1: sliceRows.reduce((a, r) => a + r.recallAt1, 0) / sliceRows.length,
      recallAt5: sliceRows.reduce((a, r) => a + r.recallAt5, 0) / sliceRows.length,
      recallAt10: sliceRows.reduce((a, r) => a + r.recallAt10, 0) / sliceRows.length,
      mrr: sliceRows.reduce((a, r) => a + r.mrr, 0) / sliceRows.length,
      ndcg10: sliceRows.reduce((a, r) => a + r.ndcg10, 0) / sliceRows.length,
    }

    console.log(`## mode: ${mode}`)
    console.log(``)
    console.log(tabulateSlices([...sliceRows, overallRow, macroRow]))
    console.log(
      `(OVERALL = micro-average over positive queries, weighted by slice sizes; MACRO = unweighted mean of slice rows; MACRO "queries" column = slice count)`,
    )
    console.log(``)

    if (mode === "hybrid") hybridOverallRecall5 = overallRow.recallAt5

    jsonModes[mode] = {
      bySlice: Object.fromEntries(sliceRows.map((r) => [r.slice, r])),
      overall: overallRow,
      macro: macroRow,
    }
  }

  console.log(`## latency`)
  console.log(``)
  const latencyRows = MODES.map((mode) => latencyFor(mode, allResults[mode].map((r) => r.tookMs)))
  console.log(tabulateLatency(latencyRows))
  console.log(``)
  jsonOut["latency"] = Object.fromEntries(latencyRows.map((r) => [r.mode, r]))

  console.log(
    `## score separation (no injection threshold exists today - negative-query hits WOULD be injected)`,
  )
  console.log(``)
  // bm25 is omitted: its score is purely rank-derived (top-1 is always
  // 0.500 whenever anything matches), so it carries no match magnitude and
  // can never separate negatives from positives. hybrid RRF scores are also
  // rank-derived but vary with cross-arm agreement, so they stay (read them
  // as fusion agreement, not match confidence).
  const sepRows = MODES.filter((m) => m !== "bm25").map((mode) =>
    separationFor(mode, allResults[mode]),
  )
  console.log(tabulateSeparation(sepRows))
  console.log(
    `(bm25 omitted: rank-derived scores carry no match magnitude. hybrid/hybrid-terms RRF scores measure cross-arm agreement, not match confidence.)`,
  )
  console.log(``)
  jsonOut["negativeSeparation"] = Object.fromEntries(sepRows.map((r) => [r.mode, r]))

  const jsonPath = process.env["LUNA_BENCH_JSON"]
  if (jsonPath !== undefined) {
    writeFileSync(jsonPath, JSON.stringify(jsonOut, null, 2))
    console.log(`[bench] wrote full results to ${jsonPath}`)
  }

  if (!ENFORCE) {
    console.log(`[bench] report-only (LUNA_BENCH_ENFORCE=0) - no pass/fail gate applied`)
    return
  }

  if (hybridOverallRecall5 === null || hybridOverallRecall5 < RECALL_THRESHOLD) {
    console.error(
      `[bench] FAIL - hybrid OVERALL recall@5 ${(hybridOverallRecall5 ?? 0).toFixed(3)} < ${RECALL_THRESHOLD}`,
    )
    process.exit(1)
  }
  console.log(
    `[bench] PASS - hybrid OVERALL recall@5 ${hybridOverallRecall5.toFixed(3)} ≥ ${RECALL_THRESHOLD}`,
  )
}

// Exit 4 keeps runtime failures (backend/embedder errors) distinct from the
// quality gate's exit 1, so CI can't mistake an infra outage for a recall
// regression.
try {
  await main()
} catch (e) {
  console.error(`[bench] runtime failure: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
  process.exit(4)
}
