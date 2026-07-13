/**
 * run — LoCoMo memory-benchmark harness entrypoint.
 *
 * Pipeline: fetch dataset (cached, never vendored) → ingest each selected
 * conversation's raw turns into a fresh sqlite-vector MemoryRouter (Ollama
 * embeddings, same backend the chat-server uses) → for each QA pair, run
 * memory_search-equivalent retrieval scoped to that conversation's
 * namespace → (unless --dry-run) ask a model to answer using ONLY the
 * retrieved text → score against ground truth per LoCoMo's own per-category
 * methodology (scoring.ts) → aggregate + report.
 *
 * Answer backend (`LUNA_LOCOMO_ANSWER_BACKEND`): "ollama" (default, local,
 * zero cost, needs no key), "ollama-cloud" (Ollama's hosted cloud API,
 * `https://ollama.com/api/chat`, needs `OLLAMA_CLOUD_KEY` — much faster than
 * local CPU inference), or "anthropic" (original path, needs
 * `ANTHROPIC_API_KEY`, currently blocked in this environment). See
 * answer-model.ts for all three implementations.
 *
 * Cost vs. time budget: with Ollama (local or cloud) there is no per-token
 * dollar cost to cap (see pricing.ts's `ollama*` rate — always $0 in this
 * harness's accounting), so the old `LUNA_LOCOMO_BUDGET_USD` dollar guard
 * has been replaced with a **wall-clock time estimate + cap**
 * (`LUNA_LOCOMO_MAX_MINUTES`, default 55): the harness times the first few
 * answer-model calls, projects total runtime from the observed
 * seconds/QA-pair, and refuses to start a run that would blow past the cap.
 * Use `LUNA_LOCOMO_SAMPLE_LIMIT` / `LUNA_LOCOMO_QA_LIMIT` to run a
 * documented subset instead of silently truncating mid-run.
 *
 * Hard-stop handling (ollama-cloud only): `answerFromContextOllamaCloud`
 * retries 429/5xx/network errors with backoff, but throws
 * `LocomoHardStopError` on a HARD failure (bad auth, a quota/billing
 * signal, or persistent throttling that never clears). The main loop below
 * catches that specifically and stops the ENTIRE run immediately — not just
 * the one QA pair — writing partial results, same discipline as the
 * wall-clock cap. This prevents a broken key or exhausted quota from
 * silently burning through the rest of the dataset one failed retry-loop at
 * a time.
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
 *   LUNA_LOCOMO_ANSWER_BACKEND   "ollama" (default), "ollama-cloud", or "anthropic"
 *   LUNA_LOCOMO_ANSWER_MODEL     model id, overrides the per-backend default
 *                                below for any backend. REQUIRED for the
 *                                anthropic backend (exact dated Anthropic
 *                                model id — the raw Messages API needs a
 *                                dated id, not a "haiku"/"sonnet" tier alias
 *                                — check
 *                                https://docs.anthropic.com/en/docs/about-claude/models).
 *                                Default for ollama: "llama3.1:8b". Default
 *                                for ollama-cloud: "gpt-oss:120b" (or
 *                                LUNA_LOCOMO_CLOUD_MODEL, see below).
 *   LUNA_LOCOMO_CLOUD_MODEL      ollama-cloud model id (default "gpt-oss:120b").
 *                                Only used when LUNA_LOCOMO_ANSWER_MODEL is unset.
 *   OLLAMA_CLOUD_KEY             REQUIRED for the ollama-cloud backend — Bearer
 *                                token for https://ollama.com/api. Never log
 *                                or print this value.
 *   ANTHROPIC_API_KEY            REQUIRED only when LUNA_LOCOMO_ANSWER_BACKEND=anthropic
 *   LUNA_OLLAMA_BASE_URL         Ollama daemon base URL (default: http://127.0.0.1:11434)
 *   LUNA_EMBEDDER=ollama         required (same convention as bench/paraphrase-recall.ts)
 *   LUNA_LOCOMO_RETRIEVAL_MODE   "flat" (default, unchanged baseline), "decompose", or
 *                                "hierarchical" — see retrieval-modes.ts module docstring
 *                                for the category-1 diagnosis this is built on.
 *   LUNA_LOCOMO_HIERARCHICAL_TOP_SESSIONS   sessions prioritized in hierarchical mode (default 3)
 *   LUNA_LOCOMO_HIERARCHICAL_CANDIDATE_K    widened candidate pool hierarchical mode
 *                                           re-ranks before trimming to LUNA_LOCOMO_TOPK
 *                                           (default TOP_K*5)
 *   LUNA_LOCOMO_DATE_INDEX       "1" to inject the deterministic per-session date index
 *                                into the answer prompt (Task 3 temporal fix); default "0"
 *                                (off, baseline prompt unchanged) — see answer-model.ts.
 *   LUNA_LOCOMO_CATEGORY_FILTER  comma-separated category numbers (e.g. "1,3") — only
 *                                ANSWER those categories this run (evidence/retrieval is
 *                                still computed for all). Lets a comparison run re-score
 *                                just the categories a change affects, against the SAME
 *                                QA-pair selection as a prior full run.
 *
 * Flags:
 *   --dry-run   skip the answer-model + scoring step entirely. Ingests +
 *               retrieves only, reports retrieval evidence-hit-rate (does
 *               the top-K search actually surface the annotated evidence
 *               dialog turns?). Zero cost/time spent on answer generation.
 *
 * Exit codes: 0 success, 2 Ollama unreachable, 3 dataset load error,
 * 4 missing required env for a non-dry-run, 5 time cap would be/was
 * exceeded, 6 hard-stop from the ollama-cloud backend (see above).
 */
import { Effect, Layer, Stream } from "effect"
import {
  Clock,
  ObservabilityService,
  StubEmbedderLayer,
  makeOllamaEmbedderLayer,
} from "@luna/core"
import type { MemoryRecord } from "@luna/memory"
import { SqliteVectorBackend } from "../../backends/sqlite-vector.js"
import { LunaSqliteBootstrapLive } from "../../backends/vectorlite-bootstrap.js"
import { MemoryLayer } from "../../layer.js"
import { MemoryRouterTag } from "../../router.js"
import { fetchDataset, flattenTurns } from "./dataset.js"
import { ingestSample, namespaceFor } from "./ingest.js"
import {
  answerFromContextAnthropic,
  answerFromContextOllama,
  answerFromContextOllamaCloud,
  LocomoHardStopError,
  newCostTracker,
  type CostTracker,
  type SessionDateEntry,
} from "./answer-model.js"
import { aggregateByCategory, scoreQA, type ScoredQA } from "./scoring.js"
import type { LocomoSample, RetrievalRecord } from "./types.js"
import {
  buildSessionSummaries,
  decomposeQuestion,
  mergeHits,
  parseRetrievalMode,
  prioritizeBySessions,
  rankSessions,
  sessionNumFromTags,
} from "./retrieval-modes.js"
import { writeFileSync, mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = resolve(here, ".out")

const DRY_RUN = process.argv.includes("--dry-run")
/** Parse and validate a numeric env var — throws if NaN to prevent silent guard failures. */
function parseNumericEnv(key: string, defaultValue: string): number {
  const raw = process.env[key] ?? defaultValue
  const parsed = Number(raw)
  if (Number.isNaN(parsed)) {
    console.error(`[locomo-eval] invalid numeric env var ${key}="${raw}" (not a number)`)
    process.exit(2)
  }
  return parsed
}

const SAMPLE_LIMIT = parseNumericEnv("LUNA_LOCOMO_SAMPLE_LIMIT", "10")
const QA_LIMIT = process.env["LUNA_LOCOMO_QA_LIMIT"]
  ? parseNumericEnv("LUNA_LOCOMO_QA_LIMIT", process.env["LUNA_LOCOMO_QA_LIMIT"]!)
  : undefined
const TOP_K = parseNumericEnv("LUNA_LOCOMO_TOPK", "10")
// Retrieval strategy — see retrieval-modes.ts module docstring for the
// diagnosis this is built on (topK/result-count budget is the dominant
// category-1 failure mode; decompose/hierarchical are two independent,
// additional strategies for the same "many evidence sub-topics share one
// budget" mechanism). Default "flat" preserves today's behavior exactly —
// nothing changes unless this env var is set.
const RETRIEVAL_MODE = parseRetrievalMode(process.env["LUNA_LOCOMO_RETRIEVAL_MODE"])
const HIERARCHICAL_TOP_SESSIONS = parseNumericEnv("LUNA_LOCOMO_HIERARCHICAL_TOP_SESSIONS", "3")
// Widened candidate pool hierarchical mode pulls from before re-ranking by
// session priority and trimming to TOP_K — must be >= TOP_K to have room to
// widen at all.
const HIERARCHICAL_CANDIDATE_K = Math.max(
  TOP_K,
  parseNumericEnv("LUNA_LOCOMO_HIERARCHICAL_CANDIDATE_K", String(TOP_K * 5)),
)
// Task 3 — deterministic per-session date index injected into the answer
// prompt (see answer-model.ts's buildDateIndexBlock). Default OFF so the
// baseline prompt is unchanged unless this is explicitly opted into for a
// measurement run — same "env-gated, don't regress baseline" discipline as
// RETRIEVAL_MODE above.
const DATE_INDEX_ENABLED = (process.env["LUNA_LOCOMO_DATE_INDEX"] ?? "0") === "1"
// Restrict which QA categories get ANSWERED this run (evidence/retrieval is
// still computed for every QA pair regardless). Lets a comparison run
// re-score only the categories a change actually affects (e.g. "1,3" for
// the category-1/category-3 fixes in this PR) against the SAME QA-pair
// selection (SAMPLE_LIMIT/QA_LIMIT) as a prior full run, without spending
// time re-answering unaffected categories 2/4/5. Unset (default): every
// category in the QA_LIMIT-sliced set is answered, same as before this
// flag existed.
const CATEGORY_FILTER_RAW = process.env["LUNA_LOCOMO_CATEGORY_FILTER"]
const CATEGORY_FILTER: ReadonlySet<number> | undefined = CATEGORY_FILTER_RAW
  ? new Set(CATEGORY_FILTER_RAW.split(",").map((s) => { const n = Number(s.trim()); if (Number.isNaN(n)) throw new Error(`Invalid category: ${s}`); return n; }))
  : undefined
const MAX_MINUTES = parseNumericEnv("LUNA_LOCOMO_MAX_MINUTES", "55")
const ANSWER_BACKEND = (process.env["LUNA_LOCOMO_ANSWER_BACKEND"] ?? "ollama").toLowerCase()
const DEFAULT_MODEL_BY_BACKEND: Record<string, string | undefined> = {
  ollama: "llama3.1:8b",
  "ollama-cloud": process.env["LUNA_LOCOMO_CLOUD_MODEL"] ?? "gpt-oss:120b",
  anthropic: undefined,
}
// Fallback seconds/QA-pair used ONLY before the first real answer-model call
// has completed (so the wall-clock guard has something to project from).
// This is backend-specific: local `ollama` (CPU-only llama3.1:8b) really is
// ~60s/QA on the reference machine (see README.md "Time budget"), but
// `ollama-cloud` (gpt-oss:120b, hosted) is roughly 14x faster in practice
// (~4.2s/QA measured on a real-context sizing sample — see PR body). Reusing
// the 60s local fallback here made the guard fire before the FIRST
// ollama-cloud answer call ever completed, wildly over-projecting total
// runtime from a number that was never true for this backend. 10s is a
// generous (2x) upper bound over the measured ~4.2s, not a tight guess.
const FALLBACK_SEC_PER_QA_BY_BACKEND: Record<string, number> = {
  ollama: 60,
  "ollama-cloud": 10,
  anthropic: 5,
}
// Don't enforce the wall-clock projection cap until at least this many REAL
// answer calls have completed. The pre-first-call fallback above is a rough
// guess; multiplying it across hundreds of remaining QA pairs before ANY
// real measurement exists made the guard fire before the first call ever
// finished on a large-subset ollama-cloud run (a wrong 60s/QA guess ×
// hundreds of remaining pairs blew past even a generous cap in one shot —
// see obs_note ledger for the incident). A handful of real calls gives an
// honest average to project from instead.
const TIME_CAP_WARMUP_QA = 5
const ANSWER_MODEL = process.env["LUNA_LOCOMO_ANSWER_MODEL"] ?? DEFAULT_MODEL_BY_BACKEND[ANSWER_BACKEND]
const API_KEY = process.env["ANTHROPIC_API_KEY"]
const OLLAMA_CLOUD_KEY = process.env["OLLAMA_CLOUD_KEY"]
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
          "[locomo-eval] LUNA_LOCOMO_ANSWER_MODEL is required for the anthropic backend. Use --dry-run to test retrieval only, or unset LUNA_LOCOMO_ANSWER_BACKEND to use local Ollama.",
        )
        process.exit(4)
      }
      if (!API_KEY) {
        console.error("[locomo-eval] ANTHROPIC_API_KEY is required for the anthropic backend.")
        process.exit(4)
      }
    } else if (ANSWER_BACKEND === "ollama-cloud") {
      if (!OLLAMA_CLOUD_KEY) {
        console.error(
          "[locomo-eval] OLLAMA_CLOUD_KEY is required for the ollama-cloud backend (Bearer token for https://ollama.com/api).",
        )
        process.exit(4)
      }
    } else if (ANSWER_BACKEND !== "ollama") {
      console.error(
        `[locomo-eval] unknown LUNA_LOCOMO_ANSWER_BACKEND "${ANSWER_BACKEND}" — expected "ollama", "ollama-cloud", or "anthropic".`,
      )
      process.exit(4)
    }
  }

  // Require ollama embedder — stub produces meaningless results
  if (process.env["LUNA_EMBEDDER"]?.toLowerCase() !== "ollama") {
    console.error('[locomo-eval] LUNA_EMBEDDER=ollama is required (stub embedder produces meaningless results)')
    process.exit(2)
  }

  const reachable = await probeOllama()
  if (!reachable) {
    console.error("[locomo-eval] Ollama unreachable — start the daemon first.")
    process.exit(2)
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
  const totalQaPlanned = samples.reduce((acc, s) => {
    const sliced = QA_LIMIT ? s.qa.slice(0, QA_LIMIT) : s.qa
    const filtered = CATEGORY_FILTER ? sliced.filter((qa) => CATEGORY_FILTER.has(qa.category)) : sliced
    return acc + filtered.length
  }, 0)
  console.log(
    `# ${samples.length}/${dataset.length} conversations (${samples.map((s) => s.sample_id).join(", ")}) · ${totalQaPlanned} QA pairs planned · topK=${TOP_K} · mode=${RETRIEVAL_MODE} · dateIndex=${DATE_INDEX_ENABLED} · categoryFilter=${CATEGORY_FILTER ? Array.from(CATEGORY_FILTER).join(",") : "none"} · embedder=${process.env["LUNA_EMBEDDER"] ?? "stub"}`,
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
  const hardStop: { current: { reason: string; message: string } | null } = { current: null }
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

          // Per-sample session -> date index (Task 3, cheap/deterministic —
          // reused for every QA pair in this sample) and, only in
          // "hierarchical" mode, the per-session lexical summaries
          // rankSessions() scores against each question.
          const sessionDates: ReadonlyArray<SessionDateEntry> = Array.from(
            new Map(turns.map((t) => [t.sessionNum, t.sessionDateTime])).entries(),
          )
            .sort((a, b) => a[0] - b[0])
            .map(([sessionNum, date]) => ({ sessionNum, date }))
          const sessionSummaries = RETRIEVAL_MODE === "hierarchical" ? buildSessionSummaries(turns) : []

          const runSearch = (queryText: string, topK: number) =>
            Stream.runCollect(
              router.search({
                queryText,
                topK,
                namespace: namespaceFor(sample.sample_id),
                mode: "hybrid",
              }),
            ).pipe(Effect.map((hits) => Array.from(hits)))

          const qas = QA_LIMIT ? sample.qa.slice(0, QA_LIMIT) : sample.qa
          for (const qa of qas) {
            if (timeCapExceeded || hardStop.current) break
            if (CATEGORY_FILTER && !CATEGORY_FILTER.has(qa.category)) continue

            // Retrieval strategy — see retrieval-modes.ts. "flat" (default)
            // is byte-for-byte the same single router.search() call this
            // harness has always made; "decompose"/"hierarchical" are
            // opt-in via LUNA_LOCOMO_RETRIEVAL_MODE.
            let arr: ReadonlyArray<{ readonly record: MemoryRecord; readonly score: number }>
            if (RETRIEVAL_MODE === "decompose") {
              const subQueries = decomposeQuestion(qa.question)
              if (subQueries.length <= 1) {
                arr = yield* runSearch(qa.question, TOP_K)
              } else {
                const hitLists = []
                for (const sq of subQueries) {
                  const hits = yield* runSearch(sq, TOP_K)
                  hitLists.push(hits.map((h) => ({ ...h, recordId: h.record.id })))
                }
                arr = mergeHits(hitLists, TOP_K)
              }
            } else if (RETRIEVAL_MODE === "hierarchical") {
              const wide = yield* runSearch(qa.question, HIERARCHICAL_CANDIDATE_K)
              const tagged = wide.map((h) => ({ ...h, sessionNum: sessionNumFromTags(h.record.tags) }))
              const prioritySessions = new Set(rankSessions(qa.question, sessionSummaries, HIERARCHICAL_TOP_SESSIONS))
              arr = prioritizeBySessions(tagged, prioritySessions, TOP_K)
            } else {
              arr = yield* runSearch(qa.question, TOP_K)
            }
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
            // Use total elapsed time per QA (retrieval + answer + overhead),
            // not just answer-model time, so projection accounts for all per-QA costs
            const avgAnswerSecPerQa =
              qaAnswered > 0
                ? elapsedSec / qaAnswered
                : (FALLBACK_SEC_PER_QA_BY_BACKEND[ANSWER_BACKEND] ?? 60)
            const avgIngestSecPerSample =
              samplesIngested > 0 ? ingestionElapsedMs / 1000 / samplesIngested : 0
            const remainingQa = totalQaPlanned - qaAnswered
            const remainingSamples = samples.length - sampleIdx - 1
            const projectedTotalSec =
              elapsedSec + avgAnswerSecPerQa * remainingQa + avgIngestSecPerSample * remainingSamples
            if (qaAnswered >= TIME_CAP_WARMUP_QA && projectedTotalSec > MAX_MINUTES * 60) {
              console.error(
                `[locomo-eval] TIME CAP — stopping before projected runtime (${(projectedTotalSec / 60).toFixed(1)}m) exceeds LUNA_LOCOMO_MAX_MINUTES=${MAX_MINUTES}m (answered ${qaAnswered}/${totalQaPlanned} so far, ${elapsedSec.toFixed(0)}s elapsed, avg ${avgAnswerSecPerQa.toFixed(1)}s/QA).`,
              )
              timeCapExceeded = true
              break
            }

            const answerCallStart = Date.now()
            const result = yield* Effect.tryPromise({
              try: (): Promise<AnswerCallResult> => {
                const dateIndexArg = DATE_INDEX_ENABLED ? { dateIndex: sessionDates } : {}
                if (ANSWER_BACKEND === "anthropic") {
                  return answerFromContextAnthropic({
                    question: qa.question,
                    context: contextTexts,
                    apiKey: API_KEY!,
                    model: ANSWER_MODEL!,
                    tracker,
                    ...dateIndexArg,
                  })
                }
                if (ANSWER_BACKEND === "ollama-cloud") {
                  return answerFromContextOllamaCloud({
                    question: qa.question,
                    context: contextTexts,
                    apiKey: OLLAMA_CLOUD_KEY!,
                    model: ANSWER_MODEL!,
                    tracker,
                    ...dateIndexArg,
                  })
                }
                return answerFromContextOllama({
                  question: qa.question,
                  context: contextTexts,
                  baseUrl: OLLAMA_BASE_URL,
                  model: ANSWER_MODEL!,
                  tracker,
                  ...dateIndexArg,
                })
              },
              catch: (cause) => cause,
            }).pipe(
              Effect.catchAll((cause) => {
                if (cause instanceof LocomoHardStopError) {
                  hardStop.current = { reason: cause.reason, message: cause.message }
                  console.error(`[locomo-eval] HARD STOP (${cause.reason}): ${cause.message}`)
                } else {
                  console.error(`[locomo-eval] answer-model call failed: ${String(cause)}`)
                }
                return Effect.succeed({
                  text: "",
                  tokensIn: 0,
                  tokensOut: 0,
                  costUsd: 0,
                })
              }),
            )
            answerElapsedMs += Date.now() - answerCallStart

            if (hardStop.current) break

            qaAnswered += 1
            scored.push(scoreQA(qa, result.text))
          }
          if (timeCapExceeded || hardStop.current) break
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
    console.log(
      `# timing split: ingestion ${(ingestionElapsedMs / 1000).toFixed(1)}s across ${samplesIngested} conversation(s) (avg ${(samplesIngested > 0 ? ingestionElapsedMs / 1000 / samplesIngested : 0).toFixed(1)}s/conversation) · answering ${(answerElapsedMs / 1000).toFixed(1)}s across ${qaAnswered} QA pair(s) (avg ${(qaAnswered > 0 ? answerElapsedMs / 1000 / qaAnswered : 0).toFixed(2)}s/QA-pair)`,
    )
    if (hardStop.current) {
      console.error(
        `[locomo-eval] run stopped early due to a HARD STOP (${hardStop.current.reason}) — ${qaAnswered}/${totalQaPlanned} QA pairs answered before stopping. Partial results written below.`,
      )
    }
    writeFileSync(
      resolve(OUT_DIR, `results-${stamp}.json`),
      JSON.stringify(
        {
          scored,
          aggregate: agg,
          cost: tracker,
          wallClockSec: totalWallSec,
          hardStopped: hardStop.current,
          timeCapExceeded,
          config: {
            SAMPLE_LIMIT,
            QA_LIMIT,
            TOP_K,
            ANSWER_BACKEND,
            ANSWER_MODEL,
            RETRIEVAL_MODE,
            DATE_INDEX_ENABLED,
            CATEGORY_FILTER: CATEGORY_FILTER ? Array.from(CATEGORY_FILTER) : null,
            samples: samples.map((s) => s.sample_id),
          },
        },
        null,
        2,
      ),
    )
    console.log(`# wrote ${resolve(OUT_DIR, `results-${stamp}.json`)}`)
  }

  if (hardStop.current) process.exit(6)
  if (timeCapExceeded) process.exit(5)
}

interface AnswerCallResult {
  readonly text: string
  readonly tokensIn: number
  readonly tokensOut: number
  readonly costUsd: number
}

await main()
