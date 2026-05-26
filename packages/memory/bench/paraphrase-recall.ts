/**
 * paraphrase-recall — Tier 2 quality bench for F4.
 *
 * Seeds a fresh sqlite-vector backend with the facts from corpus.json, then
 * runs every paraphrase as a hybrid search and measures recall@1, recall@5,
 * and MRR per kind and overall.
 *
 * NOT a vitest. Run via:
 *   LUNA_TEST_OLLAMA=1 LUNA_EMBEDDER=ollama \
 *     bun packages/memory/bench/paraphrase-recall.ts
 *
 * Exit codes:
 *   0  overall recall@5 ≥ threshold (default 0.9)
 *   1  recall@5 below threshold (quality regression)
 *   2  Ollama unreachable (skip — daemon not running)
 *   3  corpus invalid or load error
 */
import { readFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
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

interface Fact {
  readonly id: string
  readonly kind: "project" | "preference" | "distractor"
  readonly text: string
  readonly paraphrases: ReadonlyArray<string>
}

interface Corpus {
  readonly version: string
  readonly facts: ReadonlyArray<Fact>
}

interface KindMetrics {
  readonly kind: string
  readonly queries: number
  readonly recallAt1: number
  readonly recallAt5: number
  readonly mrr: number
}

const RECALL_THRESHOLD = Number(
  process.env["LUNA_BENCH_RECALL_THRESHOLD"] ?? "0.9",
)
const TOP_K = 5
const NAMESPACE = "bench"

async function probeOllama(): Promise<boolean> {
  try {
    const res = await fetch("http://127.0.0.1:11434/", {
      signal: AbortSignal.timeout(500),
    })
    return res.ok || res.status < 500
  } catch {
    return false
  }
}

function loadCorpus(): Corpus {
  const here = dirname(fileURLToPath(import.meta.url))
  const path = resolve(here, "corpus.json")
  const raw = readFileSync(path, "utf8")
  const parsed = JSON.parse(raw) as Corpus
  if (!parsed.facts || !Array.isArray(parsed.facts)) {
    throw new Error("corpus.json: missing or invalid `facts` array")
  }
  return parsed
}

function buildEmbedderLayer() {
  const choice = process.env["LUNA_EMBEDDER"]?.toLowerCase()
  if (choice === "ollama") {
    const opts: Parameters<typeof makeOllamaEmbedderLayer>[0] = {}
    if (process.env["LUNA_OLLAMA_EMBED_MODEL"] !== undefined) {
      opts.model = process.env["LUNA_OLLAMA_EMBED_MODEL"]
    }
    if (process.env["LUNA_OLLAMA_BASE_URL"] !== undefined) {
      opts.baseUrl = process.env["LUNA_OLLAMA_BASE_URL"]
    }
    return makeOllamaEmbedderLayer(opts)
  }
  return StubEmbedderLayer
}

/**
 * For each paraphrase: find the rank (1-indexed) of the correct target id in
 * the topK results. Returns `null` if not found within topK.
 */
function rankOf(
  hits: ReadonlyArray<{ readonly record: { readonly id: string } }>,
  targetId: string,
): number | null {
  for (let i = 0; i < hits.length; i++) {
    if (hits[i]!.record.id === targetId) return i + 1
  }
  return null
}

function tabulate(perKind: ReadonlyArray<KindMetrics>, overall: KindMetrics) {
  const rows = [...perKind, overall]
  const header = `| kind | queries | recall@1 | recall@5 | MRR |`
  const sep = `|:---|---:|---:|---:|---:|`
  const body = rows.map(
    (r) =>
      `| ${r.kind.padEnd(8)} | ${String(r.queries).padStart(6)} | ${r.recallAt1
        .toFixed(3)
        .padStart(7)} | ${r.recallAt5.toFixed(3).padStart(7)} | ${r.mrr
        .toFixed(3)
        .padStart(5)} |`,
  )
  return [header, sep, ...body].join("\n")
}

async function main(): Promise<void> {
  // 1. Corpus
  let corpus: Corpus
  try {
    corpus = loadCorpus()
  } catch (e) {
    console.error(`[bench] corpus load failed: ${String(e)}`)
    process.exit(3)
  }
  const targets = corpus.facts.filter((f) => f.paraphrases.length > 0)
  const queryCount = targets.reduce((n, f) => n + f.paraphrases.length, 0)

  // 2. Ollama probe (only when LUNA_EMBEDDER=ollama)
  if (process.env["LUNA_EMBEDDER"]?.toLowerCase() === "ollama") {
    const reachable = await probeOllama()
    if (!reachable) {
      console.error(
        "[bench] Ollama unreachable at http://127.0.0.1:11434/ — start the daemon or unset LUNA_EMBEDDER.",
      )
      process.exit(2)
    }
  }

  // 3. Layer composition: real embedder + sqlite-vector + memory router +
  //    obs sink. RetrievalCall events flow through during the run.
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

  // 4. Run: seed all facts (targets + distractors), then query paraphrases.
  console.log(
    `# paraphrase-recall — ${corpus.facts.length} facts (${targets.length} targets, ${queryCount} queries) · threshold recall@5 ≥ ${RECALL_THRESHOLD}`,
  )
  console.log(`# embedder: ${process.env["LUNA_EMBEDDER"] ?? "stub"}`)
  console.log(``)

  const results = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const router = yield* MemoryRouterTag
        // Seed all facts including distractors.
        for (const fact of corpus.facts) {
          yield* router.put(
            makeRecord({
              id: fact.id,
              namespace: NAMESPACE,
              kind: fact.kind,
              content: { text: fact.text },
            }),
          )
        }
        // Query every paraphrase, compute rank of correct target.
        const ranks: Array<{ kind: string; rank: number | null }> = []
        for (const fact of targets) {
          for (const paraphrase of fact.paraphrases) {
            const hits = yield* Stream.runCollect(
              router.search({
                queryText: paraphrase,
                namespace: NAMESPACE,
                topK: TOP_K,
                mode: "hybrid",
              }),
            )
            const arr = Array.from(hits)
            ranks.push({ kind: fact.kind, rank: rankOf(arr, fact.id) })
          }
        }
        return ranks
      }),
    ).pipe(Effect.provide(layer)),
  )

  // 5. Aggregate per-kind and overall.
  const kinds = Array.from(new Set(results.map((r) => r.kind))).sort()
  const perKind: KindMetrics[] = kinds.map((kind) => {
    const slice = results.filter((r) => r.kind === kind)
    const r1 = slice.filter((r) => r.rank === 1).length / slice.length
    const r5 = slice.filter((r) => r.rank !== null).length / slice.length
    const mrr =
      slice.reduce((acc, r) => acc + (r.rank ? 1 / r.rank : 0), 0) /
      slice.length
    return { kind, queries: slice.length, recallAt1: r1, recallAt5: r5, mrr }
  })
  const overall: KindMetrics = {
    kind: "OVERALL",
    queries: results.length,
    recallAt1: results.filter((r) => r.rank === 1).length / results.length,
    recallAt5: results.filter((r) => r.rank !== null).length / results.length,
    mrr:
      results.reduce((acc, r) => acc + (r.rank ? 1 / r.rank : 0), 0) /
      results.length,
  }

  console.log(tabulate(perKind, overall))
  console.log(``)

  // 6. Exit non-zero on regression.
  if (overall.recallAt5 < RECALL_THRESHOLD) {
    console.error(
      `[bench] FAIL — overall recall@5 ${overall.recallAt5.toFixed(3)} < ${RECALL_THRESHOLD}`,
    )
    process.exit(1)
  }
  console.log(
    `[bench] PASS — overall recall@5 ${overall.recallAt5.toFixed(3)} ≥ ${RECALL_THRESHOLD}`,
  )
}

await main()
