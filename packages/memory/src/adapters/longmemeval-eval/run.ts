/**
 * run — LongMemEval memory-benchmark smoke (thin spike).
 *
 * Pipeline: fetch official oracle JSON (cached, never vendored) → take the
 * first N questions in file order (default 15) → ingest each instance's
 * haystack turns into a fresh sqlite-vector MemoryRouter (Ollama embeddings,
 * same backend the chat-server uses) → memory_search-equivalent hybrid
 * retrieval scoped to that question's namespace → (unless --dry-run) ask a
 * local Ollama model to answer using ONLY the retrieved text → cheap F1 +
 * contains-gold scoring (NOT the official GPT-4o judge).
 *
 * Luna surface wired (same as locomo-eval):
 *   write:  MemoryRouter.put / makeRecord          (@luna/memory)
 *           identical call memory_save makes        (packages/memory-tools/src/tools.ts)
 *   read:   MemoryRouter.search({ mode: "hybrid" }) (@luna/memory/src/router.ts)
 *           identical call memory_search makes      (packages/memory-tools/src/tools.ts)
 *   store:  SqliteVectorBackend fromPath(":memory:") + LunaSqliteBootstrapLive
 *   embed:  makeOllamaEmbedderLayer                 (@luna/core)
 *
 * Env vars (all optional except LUNA_EMBEDDER=ollama):
 *   LUNA_LME_QA_LIMIT          question count (default: 15)
 *   LUNA_LME_TOPK              memory_search topK (default: 10)
 *   LUNA_LME_ANSWER_MODEL      Ollama chat model (default: llama3.2:1b)
 *   LUNA_LME_DATASET_URL       override oracle JSON URL
 *   LUNA_EMBEDDER=ollama       required (stub embeddings are meaningless)
 *   LUNA_OLLAMA_BASE_URL       default http://127.0.0.1:11434
 *   LUNA_OLLAMA_EMBED_MODEL    default Luna embedder is embeddinggemma;
 *                              this smoke documents nomic-embed-text
 *
 * Flags: --dry-run   ingest + retrieve only (no answer model)
 *
 * Exit codes: 0 success, 2 Ollama unreachable / embedder not ollama,
 * 3 dataset load error, 4 missing required env.
 */
import { Effect, Layer, Stream } from "effect"
import {
  Clock,
  ObservabilityService,
  makeOllamaEmbedderLayer,
} from "@luna/core"
import { SqliteVectorBackend } from "../../backends/sqlite-vector.js"
import { LunaSqliteBootstrapLive } from "../../backends/vectorlite-bootstrap.js"
import { MemoryLayer } from "../../layer.js"
import { MemoryRouterTag } from "../../router.js"
import {
  answerFromContextOllama,
  newCostTracker,
  type CostTracker,
} from "../locomo-eval/answer-model.js"
import { fetchDataset, flattenTurns, selectSubset } from "./dataset.js"
import { ingestInstance, namespaceFor, recordId } from "./ingest.js"
import { aggregateByType, scoreQA, type ScoredQA } from "./scoring.js"
import type { RetrievalRecord } from "./types.js"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = resolve(here, ".out")

const DRY_RUN = process.argv.includes("--dry-run")

function parseNumericEnv(key: string, defaultValue: string): number {
  const raw = process.env[key] ?? defaultValue
  const parsed = Number(raw)
  if (Number.isNaN(parsed)) {
    console.error(`[longmemeval-eval] invalid numeric env var ${key}="${raw}"`)
    process.exit(2)
  }
  return parsed
}

const QA_LIMIT = parseNumericEnv("LUNA_LME_QA_LIMIT", "15")
const TOP_K = parseNumericEnv("LUNA_LME_TOPK", "10")
// null = official file order (type-clustered). Default 42 = seeded shuffle
// so the 15-question smoke is not all temporal-reasoning. See dataset.ts.
const SEED_RAW = process.env["LUNA_LME_SEED"]
const SEED: number | null =
  SEED_RAW === "none" || SEED_RAW === "order"
    ? null
    : parseNumericEnv("LUNA_LME_SEED", "42")
const ANSWER_MODEL = process.env["LUNA_LME_ANSWER_MODEL"] ?? "llama3.2:1b"
const OLLAMA_BASE_URL =
  process.env["LUNA_OLLAMA_BASE_URL"] ?? process.env["OLLAMA_HOST"] ?? "http://127.0.0.1:11434"

async function probeOllama(): Promise<boolean> {
  const url = OLLAMA_BASE_URL.startsWith("http") ? OLLAMA_BASE_URL : `http://${OLLAMA_BASE_URL}`
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
  const model = process.env["LUNA_OLLAMA_EMBED_MODEL"]
  const baseUrl = process.env["LUNA_OLLAMA_BASE_URL"]
  return makeOllamaEmbedderLayer({
    ...(model !== undefined ? { model } : {}),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
  })
}

function textFromRecord(content: unknown): string {
  return content !== null && typeof content === "object" && "text" in content
    ? String((content as { text: unknown }).text)
    : ""
}

async function main(): Promise<void> {
  console.log(
    `# LongMemEval memory smoke — ${DRY_RUN ? "DRY RUN (retrieval only)" : `full run (answer: ollama/${ANSWER_MODEL})`}`,
  )

  if (process.env["LUNA_EMBEDDER"]?.toLowerCase() !== "ollama") {
    console.error(
      "[longmemeval-eval] BLOCKED: LUNA_EMBEDDER=ollama is required. Stub embeddings produce meaningless scores. Do not invent numbers.",
    )
    process.exit(2)
  }

  const reachable = await probeOllama()
  if (!reachable) {
    console.error(
      `[longmemeval-eval] BLOCKED: Ollama unreachable at ${OLLAMA_BASE_URL}. Start a local daemon (embed + chat). No paid API fallback — refusing to burn keys.`,
    )
    process.exit(2)
  }

  let dataset
  try {
    dataset = await fetchDataset()
  } catch (e) {
    console.error(`[longmemeval-eval] dataset load failed: ${String(e)}`)
    process.exit(3)
    return
  }

  const subset = selectSubset(dataset, QA_LIMIT, SEED)
  const questionIds = subset.map((q) => q.question_id)
  const typeCounts = subset.reduce<Record<string, number>>((acc, q) => {
    acc[q.question_type] = (acc[q.question_type] ?? 0) + 1
    return acc
  }, {})
  console.log(
    `# official split: longmemeval_oracle.json (${dataset.length} total) · subset: first ${subset.length} after seeded shuffle (seed=${SEED === null ? "file-order" : SEED})`,
  )
  console.log(`# question_ids: ${questionIds.join(", ")}`)
  console.log(
    `# type mix: ${Object.entries(typeCounts)
      .map(([t, n]) => `${t}=${n}`)
      .join(", ")}`,
  )
  console.log(`# topK=${TOP_K} · embedder=${process.env["LUNA_OLLAMA_EMBED_MODEL"] ?? "embeddinggemma"}`)

  const supportLayer = Layer.mergeAll(
    ObservabilityService.Default.pipe(Layer.provide(Clock.Default)),
    buildEmbedderLayer(),
    Clock.Default,
    LunaSqliteBootstrapLive,
  )
  const layer = Layer.unwrap(
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
  const startedAt = Date.now()
  let ingestedTurns = 0

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const router = yield* MemoryRouterTag

        for (const instance of subset) {
          const turns = flattenTurns(instance)
          const n = yield* ingestInstance(router, turns)
          ingestedTurns += n
          console.log(`# ingested ${n} turns for ${instance.question_id} (${instance.question_type})`)

          const hits = yield* Stream.runCollect(
            router.search({
              queryText: instance.question,
              topK: TOP_K,
              namespace: namespaceFor(instance.question_id),
              mode: "hybrid",
            }),
          ).pipe(Effect.map((h) => Array.from(h)))

          const retrievedIds = new Set(hits.map((h) => h.record.id))
          const evidenceTurns = turns.filter((t) => t.hasAnswer)
          const evidenceHit = evidenceTurns.filter((t) => retrievedIds.has(recordId(t))).length
          const retrievedSessions = new Set(
            hits.flatMap((h) =>
              h.record.tags.filter((t) => t.startsWith("session:")).map((t) => t.slice("session:".length)),
            ),
          )
          const answerSessionHit = instance.answer_session_ids.filter((id) =>
            retrievedSessions.has(id),
          ).length
          retrieval.push({
            questionId: instance.question_id,
            question: instance.question,
            questionType: instance.question_type,
            evidenceCount: evidenceTurns.length,
            evidenceHit,
            answerSessionCount: instance.answer_session_ids.length,
            answerSessionHit,
          })

          if (DRY_RUN) continue

          const contextTexts = hits.map((h) => textFromRecord(h.record.content))
          const result = yield* Effect.tryPromise({
            try: () =>
              answerFromContextOllama({
                question: `${instance.question} (asked on ${instance.question_date})`,
                context: contextTexts,
                baseUrl: OLLAMA_BASE_URL,
                model: ANSWER_MODEL,
                tracker,
              }),
            catch: (cause) => cause,
          }).pipe(
            Effect.catch((cause) => {
              console.error(`[longmemeval-eval] answer-model call failed: ${String(cause)}`)
              return Effect.succeed({ text: "", tokensIn: 0, tokensOut: 0, costUsd: 0 })
            }),
          )
          scored.push(scoreQA(instance, result.text))
        }
      }),
    ).pipe(Effect.provide(layer)),
  )

  mkdirSync(OUT_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const wallClockSec = (Date.now() - startedAt) / 1000

  if (retrieval.length > 0) {
    const totalEvidence = retrieval.reduce((a, b) => a + b.evidenceCount, 0)
    const totalHit = retrieval.reduce((a, b) => a + b.evidenceHit, 0)
    const sessTotal = retrieval.reduce((a, b) => a + b.answerSessionCount, 0)
    const sessHit = retrieval.reduce((a, b) => a + b.answerSessionHit, 0)
    const fullHit = retrieval.filter((r) => r.evidenceCount > 0 && r.evidenceHit === r.evidenceCount).length
    console.log("")
    console.log(
      `# turn-level evidence coverage: ${totalHit}/${totalEvidence} has_answer turns in top-${TOP_K} (${
        totalEvidence > 0 ? ((totalHit / totalEvidence) * 100).toFixed(1) : "n/a"
      }%)`,
    )
    console.log(
      `# session-level evidence coverage: ${sessHit}/${sessTotal} answer_session_ids in top-${TOP_K} (${
        sessTotal > 0 ? ((sessHit / sessTotal) * 100).toFixed(1) : "n/a"
      }%)`,
    )
    console.log(
      `# QA pairs with ALL evidence turns retrieved: ${fullHit}/${retrieval.filter((r) => r.evidenceCount > 0).length}`,
    )
    writeFileSync(resolve(OUT_DIR, `retrieval-${stamp}.json`), JSON.stringify(retrieval, null, 2))
  }

  const payload = {
    blocked: false as const,
    officialSplit: "longmemeval_oracle.json",
    subsetRule:
      SEED === null
        ? `first ${subset.length} questions in official file order (type-clustered)`
        : `seeded Fisher–Yates (seed=${SEED}) then first ${subset.length} (no cherry-pick)`,
    seed: SEED,
    questionIds,
    ingestedTurns,
    scored,
    retrieval,
    aggregate: DRY_RUN ? [] : aggregateByType(scored),
    cost: tracker,
    wallClockSec,
    config: {
      QA_LIMIT,
      SEED,
      TOP_K,
      ANSWER_MODEL,
      DRY_RUN,
      embedModel: process.env["LUNA_OLLAMA_EMBED_MODEL"] ?? "embeddinggemma",
      ollamaBaseUrl: OLLAMA_BASE_URL,
    },
    scoringNote:
      "Cheap F1 + contains-gold only. Official LongMemEval metric is a GPT-4o yes/no judge — not run (no paid keys).",
  }

  if (!DRY_RUN) {
    const agg = payload.aggregate
    console.log("")
    console.log("| question_type | count | mean F1 | contains-gold |")
    console.log("|:---|---:|---:|---:|")
    for (const row of agg) {
      console.log(
        `| ${row.questionType} | ${row.count} | ${row.meanF1.toFixed(3)} | ${row.meanContainsGold.toFixed(3)} |`,
      )
    }
    console.log("")
    console.log(
      `# answer: ollama/${ANSWER_MODEL} · ${tracker.calls} calls · ${tracker.totalTokensIn} in / ${tracker.totalTokensOut} out · $${tracker.totalCostUsd.toFixed(4)} · wall-clock ${(wallClockSec / 60).toFixed(1)}m`,
    )
  }

  const outPath = resolve(OUT_DIR, `results-${stamp}.json`)
  writeFileSync(outPath, JSON.stringify(payload, null, 2))
  console.log(`# wrote ${outPath}`)
}

await main()
