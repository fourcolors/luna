/**
 * sweep - LongMemEval RETRIEVAL-config sweep (no answer model).
 *
 * Ingests each question's haystack ONCE into a fresh in-memory store, then
 * runs every search config against it, so a whole sweep costs one ingest.
 * The first config is the baseline; every other config is compared to it
 * per question (paired), which is what the plan's ship rule needs:
 * docs/superpowers/plans/2026-09-22-memory-lexical-fusion-and-query-expansion.md
 *
 * Metrics (abstention questions excluded: there is nothing to find):
 *   evidence recall@5 / @10   has_answer turns in the top 5 / 10
 *   session recall@5          answer sessions with >= 1 turn in the top 5
 *   paired @5 vs baseline     questions with more / fewer evidence hits in
 *                             the top 5, exact two-sided sign test p
 * Plus a diagnostic: for every evidence turn some config finds in its top
 * 10 but the baseline misses, its rank in pure vector search (top 50), which
 * says whether reweighting the fusion can reach it at all.
 *
 * Env (fail-closed like run.ts; exit 2 Ollama blocker, 3 dataset, 4 config,
 * 5 memory backend):
 *   LUNA_EMBEDDER=ollama                    required
 *   LUNA_LME_SEARCH_CONFIGS                 required, comma-separated labels
 *                                           (src/search-config.ts); first = baseline
 *   LUNA_LME_SPLIT                          oracle | s (default: s)
 *   LUNA_LME_QA_OFFSET / LUNA_LME_QA_LIMIT  which questions of the seeded
 *                                           order (default 0 / 60); 0/60 = tuning,
 *                                           60/200 = held-out
 *   LUNA_LME_SEED                           default 42
 *   LUNA_LME_FRESH=1                        ignore (and delete) this run's checkpoint
 *   LUNA_LME_DUMP_TOP=1                     also save each config's top-10 records (id, text,
 *                                           timestamp) and the question, date and gold answer,
 *                                           for the answer stage (bench/lme-qa-answer.ts in
 *                                           @luna/memory-tools); large, not for committing
 *
 * Checkpoint: each finished question is appended to .out/checkpoint-<id>.jsonl,
 * where <id> hashes everything that defines the run (split, questions, seed,
 * configs, embed model, Ollama version). Rerunning the same command after a
 * failure (a network hang ends a run by design) resumes from it; every
 * question is still computed exactly once. Deleted after a complete run.
 *   LUNA_OLLAMA_EMBED_MODEL, LUNA_OLLAMA_BASE_URL / OLLAMA_HOST
 */
import { Effect, Stream } from "effect"
import { MemoryRouterTag } from "../../router.js"
import { expansionFor, parseSearchConfigs, type ExpansionSidecar, type SearchConfig } from "../../search-config.js"
import { fetchOllamaVersion, probeModel, resolveOllamaBaseUrl } from "../eval-common/ollama.js"
import { makeJudges, warmUpJudges, type Judge, type JudgeName } from "../eval-common/judge.js"
import { judgeLatency, recordText, searchWithConfig, type JudgeTiming } from "../eval-common/search.js"
import { signTestP } from "./baselines.js"
import { fetchDataset, flattenTurns, isAbstentionId, selectSubset, SPLIT_URLS, type LmeSplit } from "./dataset.js"
import { describeError, hasErrorTag, loadExpansionSidecars, makeQuestionLayer } from "./harness.js"
import { ingestInstance, namespaceFor, recordId } from "./ingest.js"
import type { LmeInstance } from "./types.js"
import { createHash } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), ".out")
const DUMP_TOP = process.env["LUNA_LME_DUMP_TOP"] === "1"
const DIAG_VEC_DEPTH = 50

function fail(code: number, message: string): never {
  console.error(`[longmemeval-sweep] ${message} No results written.`)
  process.exit(code)
}

function intEnv(key: string, def: number, min: number): number {
  const raw = process.env[key]?.trim()
  if (raw === undefined || raw === "") return def
  const n = /^\d+$/.test(raw) ? Number(raw) : Number.NaN
  if (!Number.isSafeInteger(n) || n < min) fail(4, `invalid config: ${key}="${raw}" must be an integer >= ${min}`)
  return n
}

const CONFIGS: ReadonlyArray<SearchConfig> = (() => {
  try {
    return parseSearchConfigs(process.env["LUNA_LME_SEARCH_CONFIGS"] ?? "")
  } catch (e) {
    return fail(4, `invalid config: LUNA_LME_SEARCH_CONFIGS: ${e instanceof Error ? e.message : String(e)}`)
  }
})()
const SPLIT_RAW = process.env["LUNA_LME_SPLIT"]?.trim() || "s"
if (!Object.hasOwn(SPLIT_URLS, SPLIT_RAW)) fail(4, `invalid config: LUNA_LME_SPLIT="${SPLIT_RAW}"`)
const SPLIT = SPLIT_RAW as LmeSplit
const OFFSET = intEnv("LUNA_LME_QA_OFFSET", 0, 0)
const LIMIT = intEnv("LUNA_LME_QA_LIMIT", 60, 1)
const SEED = intEnv("LUNA_LME_SEED", 42, 0)
const EMBED_MODEL = process.env["LUNA_OLLAMA_EMBED_MODEL"] ?? "embeddinggemma"
const OLLAMA_BASE_URL = (() => {
  try {
    return resolveOllamaBaseUrl(process.env)
  } catch (e) {
    return fail(4, `invalid config: ${e instanceof Error ? e.message : String(e)}`)
  }
})()

/** Per question, per config: evidence / session hits at 5 and 10. */
interface ConfigHits {
  readonly ev5: number
  readonly ev10: number
  readonly sess5: number
  readonly top10: ReadonlyArray<string>
  /** The rr= judge call's timing and attempts; absent without rr=. */
  readonly judge?: JudgeTiming
  /** LUNA_LME_DUMP_TOP=1 only: the top-10 records in rank order. */
  readonly top?: ReadonlyArray<{ readonly id: string; readonly text: string; readonly updatedAt: number; readonly score: number }>
}

interface QuestionResult {
  readonly questionId: string
  readonly questionType: string
  readonly abstention: boolean
  readonly haystackTurns: number
  readonly evidenceCount: number
  readonly answerSessionCount: number
  readonly perConfig: Readonly<Record<string, ConfigHits>>
  /** Rank (1-based) of each evidence turn in pure vec search, null when beyond DIAG_VEC_DEPTH. */
  readonly evidenceVecRank: Readonly<Record<string, number | null>>
  /** Each judge's served model id(s) as of this question (a resumed run can span model updates). */
  readonly servedModels?: Readonly<Record<string, string>>
  /** LUNA_LME_DUMP_TOP=1 only: what the answer stage needs. */
  readonly qa?: { readonly question: string; readonly questionDate: string; readonly answer: string }
}

function runQuestion(
  instance: LmeInstance,
  sidecars: ReadonlyMap<string, ExpansionSidecar>,
  judges: ReadonlyMap<JudgeName, Judge>,
) {
  return Effect.gen(function* () {
    const router = yield* MemoryRouterTag
    const turns = flattenTurns(instance)
    yield* ingestInstance(router, turns)
    const turnById = new Map(turns.map((t) => [recordId(t), t] as const))
    const evidence = turns.filter((t) => t.hasAnswer).map(recordId)
    const evidenceSet = new Set(evidence)
    const answerSessions = new Set(instance.answer_session_ids)
    const namespace = namespaceFor(instance.question_id)

    let judge: JudgeTiming | undefined
    const search = (config: SearchConfig) => {
      const kw = expansionFor(config, instance.question_id, sidecars)
      judge = undefined
      return searchWithConfig(
        router,
        config,
        {
          queryText: instance.question,
          topK: 10,
          namespace,
          ...(kw !== undefined ? { expansionTerms: kw } : {}),
          onJudgeCall: (t) => (judge = t),
        },
        judges,
      )
    }

    const perConfig: Record<string, ConfigHits> = {}
    for (const config of CONFIGS) {
      const hits10 = yield* search(config)
      const top10 = hits10.map((h) => h.record.id)
      const top5 = top10.slice(0, 5)
      const sessions5 = new Set(top5.flatMap((id) => turnById.get(id)?.sessionId ?? []))
      perConfig[config.label] = {
        ev5: top5.filter((id) => evidenceSet.has(id)).length,
        ev10: top10.filter((id) => evidenceSet.has(id)).length,
        sess5: [...answerSessions].filter((s) => sessions5.has(s)).length,
        top10,
        ...(judge !== undefined ? { judge } : {}),
        ...(DUMP_TOP ? { top: hits10.map((h) => ({ id: h.record.id, text: recordText(h.record), updatedAt: h.record.updatedAt, score: h.score })) } : {}),
      }
    }
    const vecDeep = Array.from(
      yield* Stream.runCollect(router.search({ queryText: instance.question, topK: DIAG_VEC_DEPTH, namespace, mode: "vec" })),
      (h) => h.record.id,
    )
    const evidenceVecRank: Record<string, number | null> = {}
    for (const id of evidence) {
      const r = vecDeep.indexOf(id)
      evidenceVecRank[id] = r < 0 ? null : r + 1
    }
    return {
      questionId: instance.question_id,
      questionType: instance.question_type,
      abstention: isAbstentionId(instance.question_id),
      haystackTurns: turns.length,
      evidenceCount: evidence.length,
      answerSessionCount: answerSessions.size,
      perConfig,
      evidenceVecRank,
      ...(DUMP_TOP ? { qa: { question: instance.question, questionDate: instance.question_date, answer: String(instance.answer) } } : {}),
    } satisfies QuestionResult
  })
}

function pct(n: number, d: number): string {
  return d > 0 ? `${((n / d) * 100).toFixed(1)}%` : "n/a"
}

async function main(): Promise<void> {
  if (process.env["LUNA_EMBEDDER"]?.toLowerCase() !== "ollama") fail(2, "BLOCKED: LUNA_EMBEDDER=ollama is required.")
  const probe = await probeModel(OLLAMA_BASE_URL, EMBED_MODEL)
  if (!probe.ok) fail(2, `BLOCKED: ${probe.reason}.`)
  const ollamaVersion = await fetchOllamaVersion(OLLAMA_BASE_URL)

  let sidecars: ReadonlyMap<string, ExpansionSidecar>
  try {
    sidecars = loadExpansionSidecars(CONFIGS)
  } catch (e) {
    fail(4, `invalid config: expansion keywords: ${e instanceof Error ? e.message : String(e)}`)
  }

  let judges: ReadonlyMap<JudgeName, Judge>
  try {
    judges = makeJudges(CONFIGS.flatMap((c) => (c.rerank !== undefined ? [c.rerank.judge] : [])), process.env)
  } catch (e) {
    fail(4, `invalid config: ${e instanceof Error ? e.message : String(e)}`)
  }

  let instances: ReadonlyArray<LmeInstance>
  let file: string
  try {
    const loaded = await fetchDataset(SPLIT_URLS[SPLIT])
    instances = loaded.instances
    file = loaded.file
  } catch (e) {
    fail(3, `dataset load failed: ${String(e)}.`)
  }
  const subset = selectSubset(instances, OFFSET + LIMIT, SEED).slice(OFFSET)
  // Every config naming keywords must have them for every question up front.
  for (const q of subset) {
    for (const c of CONFIGS) {
      try {
        expansionFor(c, q.question_id, sidecars)
      } catch (e) {
        fail(4, `invalid config: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  console.log(`# LongMemEval retrieval sweep - ${file}, questions ${OFFSET + 1}-${OFFSET + subset.length} (seed ${SEED}), embed ${EMBED_MODEL}, ollama ${ollamaVersion}`)
  console.log(`# baseline: ${CONFIGS[0]!.label}`)
  try {
    await warmUpJudges(judges)
  } catch (e) {
    fail(2, `BLOCKED: judge warm-up failed: ${describeError(e)}.`)
  }
  const runId = createHash("sha256")
    .update(JSON.stringify({ split: SPLIT, file, offset: OFFSET, limit: LIMIT, seed: SEED, embedModel: EMBED_MODEL, ollamaVersion, configs: CONFIGS.map((c) => c.label), ...(DUMP_TOP ? { dumpTop: true } : {}) }))
    .digest("hex")
    .slice(0, 16)
  mkdirSync(OUT_DIR, { recursive: true })
  const checkpoint = resolve(OUT_DIR, `checkpoint-${runId}.jsonl`)
  if (process.env["LUNA_LME_FRESH"] === "1") rmSync(checkpoint, { force: true })
  const done = new Map<string, QuestionResult>()
  if (existsSync(checkpoint)) {
    for (const line of readFileSync(checkpoint, "utf8").split("\n")) {
      if (line.trim() === "") continue
      const r = JSON.parse(line) as QuestionResult
      done.set(r.questionId, r)
    }
    console.log(`# resuming from ${checkpoint}: ${done.size}/${subset.length} questions already done`)
  }
  const resumedQuestions = subset.filter((q) => done.has(q.question_id)).length
  const startedAt = Date.now()
  const results: QuestionResult[] = []
  for (const [i, instance] of subset.entries()) {
    const prior = done.get(instance.question_id)
    if (prior !== undefined) {
      results.push(prior)
      continue
    }
    try {
      const r = await Effect.runPromise(
        Effect.scoped(runQuestion(instance, sidecars, judges)).pipe(Effect.provide(makeQuestionLayer(EMBED_MODEL, OLLAMA_BASE_URL))),
      )
      const withModels: QuestionResult = {
        ...r,
        servedModels: Object.fromEntries([...judges].map(([name, j]) => [name, j.describe()["servedModel"] ?? j.describe()["url"] ?? ""])),
      }
      results.push(withModels)
      appendFileSync(checkpoint, JSON.stringify(withModels) + "\n")
    } catch (e) {
      if (hasErrorTag(e, "EmbedderError")) fail(2, `BLOCKED: embedder failed on ${instance.question_id}: ${describeError(e)}.`)
      if (hasErrorTag(e, "JudgeError")) fail(2, `BLOCKED: rerank judge failed on ${instance.question_id}: ${describeError(e)}.`)
      fail(5, `memory backend failure on ${instance.question_id}: ${describeError(e)}.`)
    }
    if ((i + 1) % 10 === 0) console.log(`# ${i + 1}/${subset.length} questions`)
  }
  const judgeSettings = Object.fromEntries([...judges].map(([name, j]) => [name, j.describe()]))
  for (const j of judges.values()) j.close?.()

  const scored = results.filter((r) => !r.abstention && r.evidenceCount > 0)
  const evTotal = scored.reduce((a, r) => a + r.evidenceCount, 0)
  const sessTotal = scored.reduce((a, r) => a + r.answerSessionCount, 0)
  const base = CONFIGS[0]!.label
  const summary = CONFIGS.map((c) => {
    const hits = (f: (h: ConfigHits) => number) => scored.reduce((a, r) => a + f(r.perConfig[c.label]!), 0)
    let wins = 0
    let losses = 0
    for (const r of scored) {
      const d = r.perConfig[c.label]!.ev5 - r.perConfig[base]!.ev5
      if (d > 0) wins++
      else if (d < 0) losses++
    }
    return {
      label: c.label,
      ev5: hits((h) => h.ev5),
      ev10: hits((h) => h.ev10),
      sess5: hits((h) => h.sess5),
      wins,
      losses,
      p: signTestP(wins, losses),
      // Over every question (abstentions included): each one made a judge call.
      judgeLatency: judgeLatency(results.flatMap((r) => r.perConfig[c.label]!.judge ?? [])),
    }
  })

  console.log("")
  console.log(`# ${scored.length} answerable questions, ${evTotal} evidence turns, ${sessTotal} answer sessions`)
  console.log("| config | evidence@5 | evidence@10 | sessions@5 | vs baseline @5 (more / fewer) | sign p |")
  console.log("|:---|---:|---:|---:|---:|---:|")
  for (const s of summary) {
    console.log(
      `| ${s.label} | ${s.ev5}/${evTotal} (${pct(s.ev5, evTotal)}) | ${s.ev10}/${evTotal} (${pct(s.ev10, evTotal)}) | ${s.sess5}/${sessTotal} (${pct(s.sess5, sessTotal)}) | ${s.label === base ? "-" : `${s.wins} / ${s.losses}`} | ${s.label === base ? "-" : s.p.toFixed(4)} |`,
    )
  }

  const timed = summary.filter((s) => s.judgeLatency !== undefined)
  if (timed.length > 0) {
    console.log("")
    console.log("| config | judge calls | p50 ms | p95 ms | max ms | over 2.5 s | waited (max ms) | retried |")
    console.log("|:---|---:|---:|---:|---:|---:|---:|---:|")
    for (const s of timed) {
      const l = s.judgeLatency!
      console.log(
        `| ${s.label} | ${l.calls} | ${l.p50.toFixed(0)} | ${l.p95.toFixed(0)} | ${l.max.toFixed(0)} | ${l.over2500} | ${l.waited} (${l.maxWaitMs.toFixed(0)}) | ${l.retried} |`,
      )
    }
  }

  // Diagnostic: where do evidence turns the baseline misses (top 10) but
  // another config finds sit in pure vector search?
  const rankBuckets = { "1-10": 0, "11-50": 0, ">50": 0 }
  for (const r of scored) {
    const baseTop = new Set(r.perConfig[base]!.top10)
    const foundByOthers = new Set(CONFIGS.slice(1).flatMap((c) => r.perConfig[c.label]!.top10))
    for (const [id, rank] of Object.entries(r.evidenceVecRank)) {
      if (baseTop.has(id) || !foundByOthers.has(id)) continue
      if (rank === null) rankBuckets[">50"]++
      else if (rank <= 10) rankBuckets["1-10"]++
      else rankBuckets["11-50"]++
    }
  }
  console.log(`# evidence found by a non-baseline config but missed by the baseline, by pure-vector rank: ${JSON.stringify(rankBuckets)}`)

  const servedModelsSeen: Record<string, string[]> = {}
  for (const r of results) {
    for (const [name, m] of Object.entries(r.servedModels ?? {})) {
      for (const one of m.split(",")) if (one !== "" && !(servedModelsSeen[name] ??= []).includes(one)) servedModelsSeen[name]!.push(one)
    }
  }
  const out = resolve(OUT_DIR, `sweep-${new Date().toISOString().replace(/[:.]/g, "-")}.json`)
  writeFileSync(
    out,
    JSON.stringify(
      {
        config: { split: SPLIT, file, offset: OFFSET, limit: LIMIT, seed: SEED, embedModel: EMBED_MODEL, ollamaVersion, configs: CONFIGS.map((c) => c.label), judges: judgeSettings, servedModelsSeen },
        runId,
        resumedQuestions,
        wallClockSec: (Date.now() - startedAt) / 1000,
        summary,
        rankBuckets,
        questions: results,
      },
      null,
      2,
    ),
  )
  console.log(`# wrote ${out}`)
  rmSync(checkpoint, { force: true })
}

await main()
