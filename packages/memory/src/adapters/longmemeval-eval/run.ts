/**
 * run - LongMemEval memory-benchmark smoke (thin spike).
 *
 * Pipeline: fetch official oracle JSON (cached, never vendored) → pick N
 * questions via a seeded shuffle (default 15, seed 42; the file is
 * type-clustered) → per question, ingest its haystack turns into a FRESH
 * in-memory sqlite-vector MemoryRouter (Ollama embeddings, same backend the
 * chat-server uses) → memory_search-equivalent retrieval scoped to that
 * question's namespace → (unless --dry-run) ask a local Ollama model to
 * answer using ONLY the retrieved text → cheap F1 + contains-gold scoring
 * (NOT the official GPT-4o judge).
 *
 * Every measured number is printed beside its chance baseline: random topK
 * retrieval for the recall metrics, and an always-abstain reader for QA.
 * On the oracle split those baselines are high, and a number that does not
 * beat its baseline is not evidence of anything.
 *
 * Luna surface wired (same as locomo-eval):
 *   write:  MemoryRouter.put / makeRecord          (@luna/memory)
 *           identical call memory_save makes        (packages/memory-tools/src/tools.ts)
 *   read:   MemoryRouter.search({ mode })           (@luna/memory/src/router.ts)
 *           identical call memory_search makes      (packages/memory-tools/src/tools.ts)
 *   store:  SqliteVectorBackend fromPath(":memory:") + LunaSqliteBootstrapLive
 *   embed:  makeOllamaEmbedderLayer                 (@luna/core)
 *
 * Env vars (all optional except LUNA_EMBEDDER=ollama):
 *   LUNA_EMBEDDER=ollama       required (stub embeddings are meaningless)
 *   LUNA_LME_QA_LIMIT          question count (default: 15)
 *   LUNA_LME_SEED              shuffle seed (default: 42; `order` = file order)
 *   LUNA_LME_TOPK              memory_search topK (default: 10)
 *   LUNA_LME_SEARCH_MODE       vec | hybrid | bm25 | hybrid-terms (default:
 *                              hybrid, what memory_search uses; note hybrid's
 *                              BM25 leg is exact-phrase, see RESULTS.md)
 *   LUNA_LME_ANSWER_MODEL      Ollama chat model (default: llama3.2:1b)
 *   LUNA_LME_DATASET_URL       override oracle JSON URL
 *   LUNA_OLLAMA_EMBED_MODEL    embed model (default: embeddinggemma, Luna's default)
 *   LUNA_OLLAMA_BASE_URL       Ollama URL for embed AND answer; falls back to
 *                              OLLAMA_HOST, then http://127.0.0.1:11434
 *
 * Flags: --dry-run   ingest + retrieve only (no answer model)
 *
 * Exit codes - every non-zero exit writes NO results file:
 *   0 success
 *   2 Ollama blocker: daemon unreachable, a model not pulled, LUNA_EMBEDDER
 *     not ollama, or an answer / embed call failing mid-run
 *   3 dataset load error
 *   4 invalid configuration (bad numeric env / search mode / Ollama URL)
 *   5 memory backend failure (ingest or search). NB: locomo-eval uses 5 for
 *     its time cap; the two harnesses' codes are independent.
 */
import { Effect, Layer, Stream } from "effect"
import { Clock, ObservabilityService, makeOllamaEmbedderLayer } from "@luna/core"
import { SqliteVectorBackend } from "../../backends/sqlite-vector.js"
import { LunaSqliteBootstrapLive } from "../../backends/vectorlite-bootstrap.js"
import { MemoryLayer } from "../../layer.js"
import { MemoryRouterTag } from "../../router.js"
import {
  answerFromContextOllama,
  newCostTracker,
  type CostTracker,
} from "../locomo-eval/answer-model.js"
import { randomRetrievalBaseline } from "./baselines.js"
import {
  fetchDataset,
  flattenTurns,
  isAbstentionId,
  selectSubset,
  type LoadedDataset,
} from "./dataset.js"
import { ingestInstance, namespaceFor, recordId } from "./ingest.js"
import { probeModel, resolveOllamaBaseUrl } from "./ollama.js"
import {
  ALWAYS_ABSTAIN_PREDICTION,
  aggregateByType,
  scoreQA,
  type ScoredQA,
  type TypeMetrics,
} from "./scoring.js"
import type { LmeInstance, RetrievalRecord } from "./types.js"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = resolve(here, ".out")

const DRY_RUN = process.argv.includes("--dry-run")

const SEARCH_MODES = ["vec", "hybrid", "bm25", "hybrid-terms"] as const
type SearchMode = (typeof SEARCH_MODES)[number]

function configError(message: string): never {
  console.error(`[longmemeval-eval] invalid config: ${message}`)
  process.exit(4)
}

function blocked(message: string): never {
  console.error(`[longmemeval-eval] BLOCKED: ${message} No results written.`)
  process.exit(2)
}

function parseIntEnv(key: string, defaultValue: number, min: number): number {
  const raw = process.env[key]?.trim()
  if (raw === undefined || raw === "") return defaultValue
  // Plain decimal digits only: Number() would also accept "1e1" and "0x10".
  const parsed = /^\d+$/.test(raw) ? Number(raw) : Number.NaN
  if (!Number.isSafeInteger(parsed) || parsed < min) {
    configError(`${key}="${raw}" must be an integer >= ${min}`)
  }
  return parsed
}

const QA_LIMIT = parseIntEnv("LUNA_LME_QA_LIMIT", 15, 1)
const TOP_K = parseIntEnv("LUNA_LME_TOPK", 10, 1)
// null = official file order (type-clustered). Default 42 = seeded shuffle
// so the 15-question smoke is not all temporal-reasoning. See dataset.ts.
const SEED_RAW = process.env["LUNA_LME_SEED"]
const SEED: number | null =
  SEED_RAW === "none" || SEED_RAW === "order" ? null : parseIntEnv("LUNA_LME_SEED", 42, 0)
const SEARCH_MODE_RAW = process.env["LUNA_LME_SEARCH_MODE"] ?? "hybrid"
if (!(SEARCH_MODES as ReadonlyArray<string>).includes(SEARCH_MODE_RAW)) {
  configError(`LUNA_LME_SEARCH_MODE="${SEARCH_MODE_RAW}" must be one of ${SEARCH_MODES.join(", ")}`)
}
const SEARCH_MODE = SEARCH_MODE_RAW as SearchMode
const ANSWER_MODEL = process.env["LUNA_LME_ANSWER_MODEL"] ?? "llama3.2:1b"
const EMBED_MODEL = process.env["LUNA_OLLAMA_EMBED_MODEL"] ?? "embeddinggemma"
const OLLAMA_BASE_URL = (() => {
  try {
    return resolveOllamaBaseUrl(process.env)
  } catch (e) {
    return configError(`LUNA_OLLAMA_BASE_URL / OLLAMA_HOST: ${e instanceof Error ? e.message : String(e)}`)
  }
})()

class AnswerModelError extends Error {
  constructor(questionId: string, cause: unknown) {
    super(`answer call failed for ${questionId}: ${String(cause)}`)
  }
}

/** Does `e` (or anything on its `cause` chain) carry this Effect error tag? */
function hasErrorTag(e: unknown, tag: string, depth = 0): boolean {
  if (depth > 8 || e === null || typeof e !== "object") return false
  if ((e as { _tag?: unknown })._tag === tag) return true
  return hasErrorTag((e as { cause?: unknown }).cause, tag, depth + 1)
}

function describeError(e: unknown, depth = 0): string {
  if (depth > 8 || e === null || e === undefined) return ""
  const tag = typeof e === "object" && "_tag" in e ? String((e as { _tag: unknown })._tag) : ""
  const message = e instanceof Error ? e.message : String(e)
  const self = tag && (message === "" || message === tag) ? tag : tag ? `${tag}: ${message}` : message
  const cause = typeof e === "object" ? describeError((e as { cause?: unknown }).cause, depth + 1) : ""
  return `${self}${cause ? ` <- ${cause}` : ""}`
}

/** A fresh in-memory store per question: no shared index, no order effects. */
function makeQuestionLayer() {
  const supportLayer = Layer.mergeAll(
    ObservabilityService.Default.pipe(Layer.provide(Clock.Default)),
    makeOllamaEmbedderLayer({ model: EMBED_MODEL, baseUrl: OLLAMA_BASE_URL }),
    Clock.Default,
    LunaSqliteBootstrapLive,
  )
  return Layer.unwrap(
    Effect.gen(function* () {
      const backend = yield* SqliteVectorBackend
      return MemoryLayer({ rules: [{ pattern: "*", backend }] })
    }),
  ).pipe(
    Layer.provideMerge(SqliteVectorBackend.fromPath(":memory:")),
    Layer.provideMerge(supportLayer),
  )
}

function textFromRecord(content: unknown): string {
  return content !== null && typeof content === "object" && "text" in content
    ? String((content as { text: unknown }).text)
    : ""
}

interface QuestionOutcome {
  readonly ingested: number
  readonly retrieval: RetrievalRecord
  readonly scored: ScoredQA | null
}

function runQuestion(instance: LmeInstance, tracker: CostTracker) {
  return Effect.gen(function* () {
    const router = yield* MemoryRouterTag
    const turns = flattenTurns(instance)
    const ingested = yield* ingestInstance(router, turns)

    const hits = yield* Stream.runCollect(
      router.search({
        queryText: instance.question,
        topK: TOP_K,
        namespace: namespaceFor(instance.question_id),
        mode: SEARCH_MODE,
      }),
    ).pipe(Effect.map((h) => Array.from(h)))

    // Map hits back to turns harness-side: records carry no session ids or
    // labels (see ingest.ts), so evidence can only be joined by record id.
    const turnById = new Map(turns.map((t) => [recordId(t), t] as const))
    const retrievedIds = new Set(hits.map((h) => h.record.id))
    const evidenceTurns = turns.filter((t) => t.hasAnswer)
    const retrievedSessions = new Set(
      hits.flatMap((h) => {
        const turn = turnById.get(h.record.id)
        return turn === undefined ? [] : [turn.sessionId]
      }),
    )
    const chance = randomRetrievalBaseline(turns, instance.answer_session_ids, TOP_K)
    const retrieval: RetrievalRecord = {
      questionId: instance.question_id,
      question: instance.question,
      questionType: instance.question_type,
      abstention: isAbstentionId(instance.question_id),
      haystackTurns: turns.length,
      hitCount: hits.length,
      evidenceCount: evidenceTurns.length,
      evidenceHit: evidenceTurns.filter((t) => retrievedIds.has(recordId(t))).length,
      answerSessionCount: instance.answer_session_ids.length,
      answerSessionHit: instance.answer_session_ids.filter((id) => retrievedSessions.has(id)).length,
      randomEvidenceHit: chance.evidenceHit,
      randomAnswerSessionHit: chance.answerSessionHit,
    }

    if (DRY_RUN) return { ingested, retrieval, scored: null } satisfies QuestionOutcome

    const result = yield* Effect.tryPromise({
      try: () =>
        answerFromContextOllama({
          question: `${instance.question} (asked on ${instance.question_date})`,
          context: hits.map((h) => textFromRecord(h.record.content)),
          baseUrl: OLLAMA_BASE_URL,
          model: ANSWER_MODEL,
          tracker,
        }),
      catch: (cause) => new AnswerModelError(instance.question_id, cause),
    })
    return { ingested, retrieval, scored: scoreQA(instance, result.text) } satisfies QuestionOutcome
  })
}

function pct(num: number, den: number): string {
  return den > 0 ? `${((num / den) * 100).toFixed(1)}%` : "n/a"
}

function fmt(x: number | null): string {
  return x === null ? "n/a" : x.toFixed(3)
}

async function main(): Promise<void> {
  console.log(
    `# LongMemEval memory smoke - ${DRY_RUN ? "DRY RUN (retrieval only)" : `full run (answer: ollama/${ANSWER_MODEL})`}`,
  )

  if (process.env["LUNA_EMBEDDER"]?.toLowerCase() !== "ollama") {
    blocked("LUNA_EMBEDDER=ollama is required. Stub embeddings produce meaningless scores.")
  }

  // Preflight every model the run needs BEFORE doing any work, so a missing
  // model is a stop, never a file of zeros.
  const needed = DRY_RUN ? [EMBED_MODEL] : [EMBED_MODEL, ANSWER_MODEL]
  for (const model of needed) {
    const probe = await probeModel(OLLAMA_BASE_URL, model)
    if (!probe.ok) blocked(`${probe.reason}. No paid API fallback.`)
  }

  let loaded: LoadedDataset
  try {
    loaded = await fetchDataset()
  } catch (e) {
    console.error(`[longmemeval-eval] dataset load failed: ${String(e)}`)
    process.exit(3)
  }
  const dataset = loaded.instances

  const subset = selectSubset(dataset, QA_LIMIT, SEED)
  const questionIds = subset.map((q) => q.question_id)
  const typeCounts = subset.reduce<Record<string, number>>((acc, q) => {
    acc[q.question_type] = (acc[q.question_type] ?? 0) + 1
    return acc
  }, {})
  console.log(
    `# official split: ${loaded.file} (${dataset.length} total) · subset: ${
      SEED === null ? `first ${subset.length} in file order` : `first ${subset.length} after seeded shuffle (seed=${SEED})`
    }`,
  )
  console.log(`# question_ids: ${questionIds.join(", ")}`)
  console.log(
    `# type mix: ${Object.entries(typeCounts)
      .map(([t, n]) => `${t}=${n}`)
      .join(", ")}`,
  )
  console.log(`# topK=${TOP_K} · search=${SEARCH_MODE} · embedder=${EMBED_MODEL} · ollama=${OLLAMA_BASE_URL}`)

  const tracker: CostTracker = newCostTracker()
  const scored: ScoredQA[] = []
  const retrieval: RetrievalRecord[] = []
  const startedAt = Date.now()
  let ingestedTurns = 0

  for (const instance of subset) {
    let outcome: QuestionOutcome
    try {
      outcome = await Effect.runPromise(
        Effect.scoped(runQuestion(instance, tracker)).pipe(Effect.provide(makeQuestionLayer())),
      )
    } catch (e) {
      if (e instanceof AnswerModelError) blocked(e.message + ".")
      if (hasErrorTag(e, "EmbedderError")) {
        blocked(`embedder failed on ${instance.question_id}: ${describeError(e)}.`)
      }
      console.error(`[longmemeval-eval] memory backend failure on ${instance.question_id}: ${describeError(e)}`)
      console.error("[longmemeval-eval] No results written.")
      process.exit(5)
    }
    ingestedTurns += outcome.ingested
    retrieval.push(outcome.retrieval)
    if (outcome.scored !== null) scored.push(outcome.scored)
    console.log(`# ${instance.question_id} (${instance.question_type}): ${outcome.ingested} turns ingested`)
  }

  const wallClockSec = (Date.now() - startedAt) / 1000

  // Retrieval: abstention questions have no answer to find, so they are
  // excluded (the paper's rule), and every number sits next to chance.
  const answerableRetrieval = retrieval.filter((r) => !r.abstention)
  const sum = (f: (r: RetrievalRecord) => number) => answerableRetrieval.reduce((a, r) => a + f(r), 0)
  const evTotal = sum((r) => r.evidenceCount)
  const evHit = sum((r) => r.evidenceHit)
  const evRandom = sum((r) => r.randomEvidenceHit)
  const sessTotal = sum((r) => r.answerSessionCount)
  const sessHit = sum((r) => r.answerSessionHit)
  const sessRandom = sum((r) => r.randomAnswerSessionHit)
  const smallHaystacks = answerableRetrieval.filter((r) => r.haystackTurns <= TOP_K).length
  const retrievalSummary = {
    questions: answerableRetrieval.length,
    haystackTurnsMean: answerableRetrieval.length > 0 ? sum((r) => r.haystackTurns) / answerableRetrieval.length : 0,
    haystacksAtOrBelowTopK: smallHaystacks,
    evidenceTurns: { total: evTotal, hit: evHit, randomExpected: evRandom },
    answerSessions: { total: sessTotal, hit: sessHit, randomExpected: sessRandom },
  }
  console.log("")
  console.log(
    `# retrieval over ${answerableRetrieval.length} answerable questions (abstention excluded; ${smallHaystacks} haystack(s) have <= topK turns, so top-${TOP_K} returns everything)`,
  )
  console.log("| metric | measured | random top-K baseline |")
  console.log("|:---|---:|---:|")
  console.log(
    `| has_answer turns in top-${TOP_K} | ${evHit}/${evTotal} (${pct(evHit, evTotal)}) | ${evRandom.toFixed(1)}/${evTotal} (${pct(evRandom, evTotal)}) |`,
  )
  console.log(
    `| answer sessions in top-${TOP_K} | ${sessHit}/${sessTotal} (${pct(sessHit, sessTotal)}) | ${sessRandom.toFixed(1)}/${sessTotal} (${pct(sessRandom, sessTotal)}) |`,
  )

  let aggregate: ReadonlyArray<TypeMetrics> = []
  let alwaysAbstain: ReadonlyArray<TypeMetrics> = []
  if (!DRY_RUN) {
    aggregate = aggregateByType(scored)
    alwaysAbstain = aggregateByType(subset.map((q) => scoreQA(q, ALWAYS_ABSTAIN_PREDICTION)))
    const baselineFor = (row: string) => alwaysAbstain.find((r) => r.questionType === row)
    console.log("")
    console.log(`# QA - cheap metrics, NOT the GPT-4o judge. Baseline = reader that always says "${ALWAYS_ABSTAIN_PREDICTION}"`)
    console.log("| question_type | count | mean F1 | contains-gold | always-abstain F1 | always-abstain contains-gold |")
    console.log("|:---|---:|---:|---:|---:|---:|")
    for (const row of aggregate) {
      const base = baselineFor(row.questionType)
      const count = row.scoredCount === row.count ? `${row.count}` : `${row.count} (${row.scoredCount} scored)`
      console.log(
        `| ${row.questionType} | ${count} | ${fmt(row.meanF1)} | ${fmt(row.meanContainsGold)} | ${fmt(base?.meanF1 ?? null)} | ${fmt(base?.meanContainsGold ?? null)} |`,
      )
    }
    console.log("")
    console.log(
      `# answer: ollama/${ANSWER_MODEL} · ${tracker.calls} calls · ${tracker.totalTokensIn} in / ${tracker.totalTokensOut} out · $${tracker.totalCostUsd.toFixed(4)} · wall-clock ${(wallClockSec / 60).toFixed(1)}m`,
    )
  }

  const payload = {
    officialSplit: loaded.file,
    subsetRule:
      SEED === null
        ? `first ${subset.length} questions in official file order (type-clustered)`
        : `seeded Fisher–Yates (seed=${SEED}) then first ${subset.length} (no cherry-pick)`,
    seed: SEED,
    questionIds,
    ingestedTurns,
    scored,
    retrieval,
    retrievalSummary,
    aggregate,
    alwaysAbstainBaseline: alwaysAbstain,
    cost: tracker,
    wallClockSec,
    config: {
      QA_LIMIT,
      SEED,
      TOP_K,
      SEARCH_MODE,
      ANSWER_MODEL,
      DRY_RUN,
      embedModel: EMBED_MODEL,
      ollamaBaseUrl: OLLAMA_BASE_URL,
      storePerQuestion: "fresh :memory:",
    },
    scoringNote:
      "Cheap F1 + contains-gold only; abstention and answerable reported separately; preference (rubric gold) is n/a. Official LongMemEval metric is a GPT-4o yes/no judge - not run (no paid keys).",
  }

  mkdirSync(OUT_DIR, { recursive: true })
  const outPath = resolve(OUT_DIR, `results-${new Date().toISOString().replace(/[:.]/g, "-")}.json`)
  writeFileSync(outPath, JSON.stringify(payload, null, 2))
  console.log(`# wrote ${outPath}`)
}

await main()
