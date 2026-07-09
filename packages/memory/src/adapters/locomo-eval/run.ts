/**
 * run — LoCoMo memory-benchmark harness entrypoint.
 *
 * Pipeline: fetch dataset (cached, never vendored) → ingest each selected
 * conversation's raw turns into a fresh sqlite-vector MemoryRouter (Ollama
 * embeddings, same backend the chat-server uses) → for each QA pair, run
 * memory_search-equivalent retrieval scoped to that conversation's
 * namespace → (unless --dry-run) ask a local Ollama model to answer using
 * ONLY the retrieved text → score against ground truth per LoCoMo's own
 * per-category methodology (scoring.ts) → aggregate + report.
 *
 * Answer backend: **Ollama by default** (`LUNA_LOCOMO_ANSWER_BACKEND`
 * unset or "ollama") — local, zero API cost, needs no key. The original
 * Anthropic path is preserved behind `LUNA_LOCOMO_ANSWER_BACKEND=anthropic`
 * for future flexibility (see answer-model.ts).
 *
 * Cost vs. time budget: with Ollama there is no per-token dollar cost to
 * cap (see pricing.ts's `ollama` rate — always $0), so the old
 * `LUNA_LOCOMO_BUDGET_USD` dollar guard has been replaced with a
 * **wall-clock time estimate + cap** (`LUNA_LOCOMO_MAX_MINUTES`, default
 * 55): the harness times the first few answer-model calls, projects total
 * runtime from the observed seconds/QA-pair, and refuses to start a run
 * that would blow past the cap. Use `LUNA_LOCOMO_SAMPLE_LIMIT` /
 * `LUNA_LOCOMO_QA_LIMIT` to run a documented subset instead of silently
 * truncating mid-run.
 *
 * Env vars (all optional except where noted):
 *   LUNA_LOCOMO_SAMPLE_LIMIT     number of conversations to run (default: all 10)
 *   LUNA_LOCOMO_QA_LIMIT         max QA pairs PER conversation (default: all)
 *   LUNA_LOCOMO_TOPK             memory_search topK (default: 10)
 *   LUNA_LOCOMO_MAX_MINUTES      wall-clock soft cap for the answer-generation
 *                                phase (default: 55). Checked after each
 *                                conversation's first few QA calls project
 *                                overall runtime; if exceeded, the run stops
 *                                cleanly (exit code 5) with all results-so-far
 *                                written to disk, same as the old budget cap.
 *   LUNA_LOCOMO_ANSWER_BACKEND   "ollama" (default) or "anthropic"
 *   LUNA_LOCOMO_ANSWER_MODEL     model id. Default for ollama: "llama3.1:8b".
 *                                REQUIRED for the anthropic backend (exact
 *                                dated Anthropic model id — the raw Messages
 *                                API needs a dated id, not a "haiku"/"sonnet"
 *                                tier alias — check
 *                                https://docs.anthropic.com/en/docs/about-claude/models)
 *   ANTHROPIC_API_KEY            REQUIRED only when LUNA_LOCOMO_ANSWER_BACKEND=anthropic
 *   LUNA_OLLAMA_BASE_URL         Ollama daemon base URL (default: http://127.0.0.1:11434)
 *   LUNA_EMBEDDER=ollama         required (same convention as bench/paraphrase-recall.ts)
 *
 * Flags:
 *   --dry-run   skip the answer-model + scoring step entirely. Ingests +
 *               retrieves only, reports retrieval evidence-hit-rate (does
 *               the top-K search actually surface the annotated evidence
 *               dialog turns?). Zero cost/time spent on answer generation.
 *
 * Exit codes: 0 success, 2 Ollama unreachable, 3 dataset load error,
 * 4 missing required env for a non-dry-run, 5 time cap would be/was exceeded.
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
import {
  answerFromContextAnthropic,
  answerFromContextOllama,
  newCostTracker,
  type CostTracker,
} from "./answer-model.js"
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
const MAX_MINUTES = Number(process.env["LUNA_LOCOMO_MAX_MINUTES"] ?? "55")
const ANSWER_BACKEND = (process.env["LUNA_LOCOMO_ANSWER_BACKEND"] ?? "ollama").toLowerCase()
const ANSWER_MODEL =
  process.env["LUNA_LOCOMO_ANSWER_MODEL"] ?? (ANSWER_BACKEND === "ollama" ? "llama3.1:8b" : undefined)
const API_KEY = process.env["ANTHROPIC_API_KEY"]
const OLLAMA_BASE_URL =
  process.env["LUNA_OLLAMA_BASE_URL"] ?? process.env["OLLAMA_HOST"] ?? "http://127.0.0.1:11434"

async function probeOllama(): Promise<boolean> {
  const baseUrl = OLLAMA_BASE_URL
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
  console.log(
    `# LoCoMo memory benchmark — ${DRY_RUN ? "DRY RUN (retrieval only)" : `full run (answer backend: ${ANSWER_BACKEND})`}`,
  )

  if (!DRY_RUN) {
    if (ANSWER_BACKEND === "anthropic") {
      if (!ANSWER_MODEL) {
        console.error(
          "[locomo-eval] LUNA_LOCOMO_ANSWER_MODEL is required for the anthropic backend (exact Anthropic model id). Use --dry-run to test retrieval only, or unset LUNA_LOCOMO_ANSWER_BACKEND to use local Ollama.",
        )
        process.exit(4)
      }
      if (!API_KEY) {
        console.error("[locomo-eval] ANTHROPIC_API_KEY is required for the anthropic backend.")
        process.exit(4)
      }
    } else if (ANSWER_BACKEND !== "ollama") {
      console.error(
        `[locomo-eval] unknown LUNA_LOCOMO_ANSWER_BACKEND "${ANSWER_BACKEND}" — expected "ollama" or "anthropic".`,
      )
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
  const totalQaPlanned = samples.reduce(
    (acc, s) => acc + (QA_LIMIT ? Math.min(QA_LIMIT, s.qa.length) : s.qa.length),
    0,
  )
  console.log(
    `# ${samples.length}/${dataset.length} conversations (${samples.map((s) => s.sample_id).join(", ")}) · ${totalQaPlanned} QA pairs planned · topK=${TOP_K} · embedder=${process.env["LUNA_EMBEDDER"] ?? "stub"}`,
  )

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
  let timeCapExceeded = false
  const answerStartedAt = Date.now()
  let qaAnswered = 0
  // Ingestion and answer-generation time are tracked SEPARATELY. Ingestion
  // is a one-time-per-conversation fixed cost (embedding N turns) that must
  // not pollute the per-QA-pair average used to project remaining runtime —
  // folding it into a single elapsed/qaAnswered ratio caused the very first
  // answer call (which lands right after a ~100-200s ingestion) to look
  // like it costs 150s+/call, wildly over-projecting total runtime and
  // aborting after a single QA pair. See obs_note ledger for the incident.
  let ingestionElapsedMs = 0
  let samplesIngested = 0
  let answerElapsedMs = 0

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const router = yield* MemoryRouterTag

        for (let sampleIdx = 0; sampleIdx < samples.length; sampleIdx++) {
          const sample = samples[sampleIdx]!
          const turns = flattenTurns(sample)
          const ingestStart = Date.now()
          const n = yield* ingestSample(router, turns)
          ingestionElapsedMs += Date.now() - ingestStart
          samplesIngested += 1
          console.log(`# ingested ${n} turns for ${sample.sample_id}`)

          const qas = QA_LIMIT ? sample.qa.slice(0, QA_LIMIT) : sample.qa
          for (const qa of qas) {
            if (timeCapExceeded) break

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

            // Wall-clock guard BEFORE spending time on this call: project
            // total runtime as (time already spent) + (avg answer-call time
            // × remaining planned QA pairs) + (avg ingestion time × samples
            // not yet ingested). The 60s/call floor before the first call
            // is the measured throughput on the reference machine (16 vCPU,
            // no GPU, llama3.1:8b) — see README.md "Time budget". This
            // replaces the old dollar-budget guard now that Ollama is free
            // — the constraint that matters here is operator wall-clock
            // time, not spend.
            const elapsedSec = (Date.now() - answerStartedAt) / 1000
            const avgAnswerSecPerQa = qaAnswered > 0 ? answerElapsedMs / 1000 / qaAnswered : 60
            const avgIngestSecPerSample =
              samplesIngested > 0 ? ingestionElapsedMs / 1000 / samplesIngested : 0
            const remainingQa = totalQaPlanned - qaAnswered
            const remainingSamples = samples.length - sampleIdx - 1
            const projectedTotalSec =
              elapsedSec + avgAnswerSecPerQa * remainingQa + avgIngestSecPerSample * remainingSamples
            if (projectedTotalSec > MAX_MINUTES * 60) {
              console.error(
                `[locomo-eval] TIME CAP — stopping before projected runtime (${(projectedTotalSec / 60).toFixed(1)}m) exceeds LUNA_LOCOMO_MAX_MINUTES=${MAX_MINUTES}m (answered ${qaAnswered}/${totalQaPlanned} so far, ${elapsedSec.toFixed(0)}s elapsed, avg ${avgAnswerSecPerQa.toFixed(1)}s/QA).`,
              )
              timeCapExceeded = true
              break
            }

            const answerCallStart = Date.now()
            const result = yield* Effect.tryPromise({
              try: () =>
                ANSWER_BACKEND === "anthropic"
                  ? answerFromContextAnthropic({
                      question: qa.question,
                      context: contextTexts,
                      apiKey: API_KEY!,
                      model: ANSWER_MODEL!,
                      tracker,
                    })
                  : answerFromContextOllama({
                      question: qa.question,
                      context: contextTexts,
                      baseUrl: OLLAMA_BASE_URL,
                      model: ANSWER_MODEL!,
                      tracker,
                    }),
              catch: (cause) => new Error(`answer-model call failed: ${String(cause)}`),
            }).pipe(
              Effect.catchAll((e) =>
                Effect.succeed({ text: "", tokensIn: 0, tokensOut: 0, costUsd: 0, error: String(e) }),
              ),
            )
            answerElapsedMs += Date.now() - answerCallStart

            qaAnswered += 1
            scored.push(scoreQA(qa, result.text))
          }
          if (timeCapExceeded) break
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
    const totalWallSec = (Date.now() - answerStartedAt) / 1000
    console.log("")
    console.log("| category | count | mean F1/score |")
    console.log("|:---|---:|---:|")
    for (const row of agg) {
      console.log(`| ${row.category} | ${row.count} | ${row.meanScore.toFixed(3)} |`)
    }
    console.log("")
    console.log(
      `# answer backend: ${ANSWER_BACKEND} (${ANSWER_MODEL}) · ${tracker.calls} calls · ${tracker.totalTokensIn} in / ${tracker.totalTokensOut} out tokens · $${tracker.totalCostUsd.toFixed(4)} · wall-clock ${(totalWallSec / 60).toFixed(1)}m`,
    )
    writeFileSync(
      resolve(OUT_DIR, `results-${stamp}.json`),
      JSON.stringify(
        {
          scored,
          aggregate: agg,
          cost: tracker,
          wallClockSec: totalWallSec,
          config: {
            SAMPLE_LIMIT,
            QA_LIMIT,
            TOP_K,
            ANSWER_BACKEND,
            ANSWER_MODEL,
            samples: samples.map((s) => s.sample_id),
          },
        },
        null,
        2,
      ),
    )
    console.log(`# wrote ${resolve(OUT_DIR, `results-${stamp}.json`)}`)
  }

  if (timeCapExceeded) process.exit(5)
}

await main()
