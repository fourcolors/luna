/**
 * run — LoCoMo memory-benchmark harness entrypoint.
 *
 * Pipeline: fetch dataset (cached, never vendored) → ingest each selected
 * conversation's raw turns into a fresh sqlite-vector MemoryRouter (Ollama
 * embeddings, same backend the chat-server uses) → for each QA pair, run
 * memory_search-equivalent retrieval scoped to that conversation's
 * namespace → (unless --dry-run) ask an Anthropic model to answer using
 * ONLY the retrieved text → score against ground truth per LoCoMo's own
 * per-category methodology (scoring.ts) → aggregate + report.
 *
 * Env vars (all optional except where noted):
 *   LUNA_LOCOMO_SAMPLE_LIMIT   number of conversations to run (default: all 10)
 *   LUNA_LOCOMO_QA_LIMIT       max QA pairs PER conversation (default: all)
 *   LUNA_LOCOMO_TOPK           memory_search topK (default: 10)
 *   LUNA_LOCOMO_BUDGET_USD     hard stop — abort once spend would exceed this (default: 50)
 *   LUNA_LOCOMO_ANSWER_MODEL   REQUIRED unless --dry-run — exact Anthropic model id
 *                              (the raw Messages API needs a dated id, not a
 *                              "haiku"/"sonnet" tier alias — check
 *                              https://docs.anthropic.com/en/docs/about-claude/models)
 *   ANTHROPIC_API_KEY          REQUIRED unless --dry-run
 *   LUNA_EMBEDDER=ollama       required (same convention as bench/paraphrase-recall.ts)
 *
 * Flags:
 *   --dry-run   skip the answer-model + scoring step entirely. Ingests +
 *               retrieves only, reports retrieval evidence-hit-rate (does
 *               the top-K search actually surface the annotated evidence
 *               dialog turns?). Zero API spend beyond local Ollama embeddings.
 *
 * Exit codes: 0 success, 2 Ollama unreachable, 3 dataset load error,
 * 4 missing required env for a non-dry-run, 5 budget cap would be exceeded.
 */
import { Effect, Layer, Stream } from "effect"
import {
  Clock,
  ObservabilityService,
  StubEmbedderLayer,
  makeOllamaEmbedderLayer,
} from "@luna/core"
import { SqliteVectorBackend } from "../../backends/sqlite-vector.js"
import { LunaSqliteBootstrapLive } from "../../backends/vectorlite-bootstrap.js"
import { MemoryLayer } from "../../layer.js"
import { MemoryRouterTag } from "../../router.js"
import { fetchDataset, flattenTurns } from "./dataset.js"
import { ingestSample, namespaceFor } from "./ingest.js"
import { answerFromContext, newCostTracker, type CostTracker } from "./answer-model.js"
import { aggregateByCategory, scoreQA, type ScoredQA } from "./scoring.js"
import type { LocomoSample } from "./types.js"
import { writeFileSync, mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = resolve(here, ".out")

const DRY_RUN = process.argv.includes("--dry-run")
const SAMPLE_LIMIT = Number(process.env["LUNA_LOCOMO_SAMPLE_LIMIT"] ?? "10")
const QA_LIMIT = process.env["LUNA_LOCOMO_QA_LIMIT"]
  ? Number(process.env["LUNA_LOCOMO_QA_LIMIT"])
  : undefined
const TOP_K = Number(process.env["LUNA_LOCOMO_TOPK"] ?? "10")
const BUDGET_USD = Number(process.env["LUNA_LOCOMO_BUDGET_USD"] ?? "50")
const ANSWER_MODEL = process.env["LUNA_LOCOMO_ANSWER_MODEL"]
const API_KEY = process.env["ANTHROPIC_API_KEY"]

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

interface RetrievalRecord {
  readonly sampleId: string
  readonly question: string
  readonly evidenceCount: number
  readonly evidenceHit: number
}

function diaIdFromRecordId(recordId: string): string {
  // "locomo-eval_<sampleId>_<diaId>" — diaId itself may contain ":" (e.g. D3:7).
  const parts = recordId.split("_")
  return parts.slice(2).join("_")
}

async function main(): Promise<void> {
  console.log(`# LoCoMo memory benchmark — ${DRY_RUN ? "DRY RUN (retrieval only)" : "full run"}`)

  if (!DRY_RUN) {
    if (!ANSWER_MODEL) {
      console.error(
        "[locomo-eval] LUNA_LOCOMO_ANSWER_MODEL is required for a non-dry-run (exact Anthropic model id). Use --dry-run to test retrieval only.",
      )
      process.exit(4)
    }
    if (!API_KEY) {
      console.error("[locomo-eval] ANTHROPIC_API_KEY is required for a non-dry-run.")
      process.exit(4)
    }
  }

  if (process.env["LUNA_EMBEDDER"]?.toLowerCase() === "ollama") {
    const reachable = await probeOllama()
    if (!reachable) {
      console.error("[locomo-eval] Ollama unreachable — start the daemon or unset LUNA_EMBEDDER.")
      process.exit(2)
    }
  }

  let dataset: ReadonlyArray<LocomoSample>
  try {
    dataset = await fetchDataset()
  } catch (e) {
    console.error(`[locomo-eval] dataset load failed: ${String(e)}`)
    process.exit(3)
    return
  }

  const samples = dataset.slice(0, SAMPLE_LIMIT)
  console.log(`# ${samples.length}/${dataset.length} conversations · topK=${TOP_K} · embedder=${process.env["LUNA_EMBEDDER"] ?? "stub"}`)

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

  const tracker: CostTracker = newCostTracker()
  const scored: ScoredQA[] = []
  const retrieval: RetrievalRecord[] = []
  let budgetExceeded = false

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const router = yield* MemoryRouterTag

        for (const sample of samples) {
          const turns = flattenTurns(sample)
          const n = yield* ingestSample(router, turns)
          console.log(`# ingested ${n} turns for ${sample.sample_id}`)

          const qas = QA_LIMIT ? sample.qa.slice(0, QA_LIMIT) : sample.qa
          for (const qa of qas) {
            if (budgetExceeded) break

            const hits = yield* Stream.runCollect(
              router.search({
                queryText: qa.question,
                topK: TOP_K,
                namespace: namespaceFor(sample.sample_id),
                mode: "hybrid",
              }),
            )
            const arr = Array.from(hits)
            const contextTexts = arr.map((h) => {
              const c = h.record.content
              return c !== null && typeof c === "object" && "text" in c
                ? String((c as { text: unknown }).text)
                : ""
            })

            if (qa.evidence && qa.evidence.length > 0) {
              const retrievedDiaIds = new Set(arr.map((h) => diaIdFromRecordId(h.record.id)))
              const hit = qa.evidence.filter((e) => retrievedDiaIds.has(e)).length
              retrieval.push({
                sampleId: sample.sample_id,
                question: qa.question,
                evidenceCount: qa.evidence.length,
                evidenceHit: hit,
              })
            }

            if (DRY_RUN) continue

            // Budget guard BEFORE spending — estimate is conservative (assumes
            // this call costs no more than the running average so far, or a
            // small fixed floor before the first call).
            const projected =
              tracker.calls > 0
                ? tracker.totalCostUsd + tracker.totalCostUsd / tracker.calls
                : tracker.totalCostUsd + 0.001
            if (projected > BUDGET_USD) {
              console.error(
                `[locomo-eval] BUDGET CAP — stopping before exceeding $${BUDGET_USD} (spent so far: $${tracker.totalCostUsd.toFixed(4)})`,
              )
              budgetExceeded = true
              break
            }

            const result = yield* Effect.tryPromise({
              try: () =>
                answerFromContext({
                  question: qa.question,
                  context: contextTexts,
                  apiKey: API_KEY!,
                  model: ANSWER_MODEL!,
                  tracker,
                }),
              catch: (cause) => new Error(`answer-model call failed: ${String(cause)}`),
            }).pipe(Effect.catchAll((e) => Effect.succeed({ text: "", tokensIn: 0, tokensOut: 0, costUsd: 0, error: String(e) })))

            scored.push(scoreQA(qa, result.text))
          }
          if (budgetExceeded) break
        }
      }),
    ).pipe(Effect.provide(layer)),
  )

  mkdirSync(OUT_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")

  if (retrieval.length > 0) {
    const totalEvidence = retrieval.reduce((a, b) => a + b.evidenceCount, 0)
    const totalHit = retrieval.reduce((a, b) => a + b.evidenceHit, 0)
    const fullHitCount = retrieval.filter((r) => r.evidenceHit === r.evidenceCount).length
    console.log("")
    console.log(
      `# retrieval evidence coverage: ${totalHit}/${totalEvidence} evidence dia_ids present in top-${TOP_K} hits (${((totalHit / totalEvidence) * 100).toFixed(1)}%)`,
    )
    console.log(
      `# QA pairs with ALL evidence retrieved: ${fullHitCount}/${retrieval.length} (${((fullHitCount / retrieval.length) * 100).toFixed(1)}%)`,
    )
    writeFileSync(resolve(OUT_DIR, `retrieval-${stamp}.json`), JSON.stringify(retrieval, null, 2))
  }

  if (!DRY_RUN) {
    const agg = aggregateByCategory(scored)
    console.log("")
    console.log("| category | count | mean F1/score |")
    console.log("|:---|---:|---:|")
    for (const row of agg) {
      console.log(`| ${row.category} | ${row.count} | ${row.meanScore.toFixed(3)} |`)
    }
    console.log("")
    console.log(
      `# spend: ${tracker.calls} calls · ${tracker.totalTokensIn} in / ${tracker.totalTokensOut} out tokens · $${tracker.totalCostUsd.toFixed(4)}`,
    )
    writeFileSync(
      resolve(OUT_DIR, `results-${stamp}.json`),
      JSON.stringify({ scored, aggregate: agg, cost: tracker, config: { SAMPLE_LIMIT, QA_LIMIT, TOP_K, ANSWER_MODEL } }, null, 2),
    )
    console.log(`# wrote ${resolve(OUT_DIR, `results-${stamp}.json`)}`)
  }

  if (budgetExceeded) process.exit(5)
}

await main()
