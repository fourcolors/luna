/**
 * judge-rescore — LLM-judge binary-accuracy re-scoring pass over an
 * EXISTING LoCoMo eval run's saved output.
 *
 * This is PURELY a re-scoring pass: no re-ingestion, no re-retrieval, no
 * re-answering. It reads `.out/results-<stamp>.json` (the per-QA
 * `{question, category, groundTruth, prediction, score}` array `run.ts`
 * already wrote for the F1 pass) and the MATCHING `.out/retrieval-<stamp>.json`
 * from the same run (per-QA evidence-coverage data — only present for QA
 * pairs that have annotated `evidence` dia_ids), and:
 *
 *   1. Asks an Ollama Cloud model (default `gpt-oss:120b`, same model as
 *      the F1 run this re-scores, for an apples-to-apples same-backbone
 *      comparison) an INDEPENDENTLY WRITTEN binary judge prompt per QA
 *      pair — see `buildJudgePrompt` below. This is our own wording based
 *      on the general, publicly-described "LLM judge: is the predicted
 *      answer the same as the gold answer" methodology; it is NOT copied
 *      from Honcho's, Hindsight's, or ByteRover's (all proprietary,
 *      unpublished) judge prompts.
 *   2. Category 5 (adversarial) is graded by the SAME deterministic
 *      abstention rule the F1 pass uses (`isAbstained` in scoring.ts,
 *      exported for exactly this reuse) instead of an LLM call — there is
 *      no ground-truth `answer` for category 5, only a distractor
 *      `adversarial_answer` a naive model might produce, so "is the
 *      prediction the same as the gold answer" doesn't apply. This keeps
 *      category 5 identical between the F1 pass and the judge pass by
 *      construction.
 *   3. Cross-references retrieval evidence coverage (was the FULL set of
 *      annotated gold evidence dia_ids present in the top-K hits for this
 *      QA pair?) against judge correctness to build a 2x2 — evidence
 *      found/missing × judge correct/incorrect — overall and per category.
 *   4. Reports overall + per-category judge accuracy, plus two sanity
 *      checks that judge-accuracy and F1 are measuring roughly the same
 *      underlying thing (they should correlate even though the absolute
 *      numbers differ, since F1 punishes correct-but-differently-phrased
 *      answers and judge-accuracy doesn't):
 *        - per-category rank agreement (does the category ordering by
 *          judge-accuracy roughly match the ordering by F1?)
 *        - mean F1 score split by judge verdict (QA pairs the judge calls
 *          correct should have a materially higher mean F1 than the ones
 *          it calls incorrect)
 *
 * Why a separate script instead of extending run.ts: this is a re-scoring
 * pass over data we ALREADY HAVE on disk — no MemoryRouter, no Effect
 * layers, no embedder, no live retrieval call. Folding it into run.ts's
 * live-pipeline loop would force a fake dependency on all that machinery
 * for a step that is purely `results.json` + `retrieval.json` in,
 * judged-accuracy-report out.
 *
 * Concurrency: light parallelism (`LUNA_LOCOMO_JUDGE_CONCURRENCY`, default
 * 8) via a simple lane-based worker pool (see `judgeAll`). Each lane's HTTP
 * call already retries 429/5xx with backoff and hard-stops on persistent
 * failure via the SAME `callOllamaCloudChat` / `classifyOllamaCloudResponse`
 * / `LocomoHardStopError` machinery `answer-model.ts` uses for the answer-
 * generation step — see that module's docstring. On top of that per-call
 * discipline, this script ALSO degrades the pool's concurrency (halving,
 * down to `LUNA_LOCOMO_JUDGE_MIN_CONCURRENCY`, default 1) after 3
 * consecutive non-hard-stop failures, since a burst of ordinary failures
 * (not severe enough to hard-stop a single call, e.g. a flaky response)
 * can still mean the service is under load. A hard stop aborts the ENTIRE
 * judge pass immediately (partial results written), same discipline as
 * `run.ts`.
 *
 * Env vars:
 *   LUNA_LOCOMO_RESULTS_FILE       path to the results-*.json to re-score
 *                                  (default: the 840-QA-pair run this PR
 *                                  reports on — see DEFAULT_RESULTS_FILE)
 *   LUNA_LOCOMO_RETRIEVAL_FILE     path to the matching retrieval-*.json
 *                                  (default: same run as the results file)
 *   OLLAMA_CLOUD_KEY               REQUIRED — Bearer token for
 *                                  https://ollama.com/api. Resolve from
 *                                  your own secret manager at run time;
 *                                  never log, print, or commit this value.
 *   LUNA_LOCOMO_JUDGE_MODEL        judge model id (default: gpt-oss:120b)
 *   LUNA_LOCOMO_JUDGE_CONCURRENCY  initial in-flight judge calls (default 8)
 *   LUNA_LOCOMO_JUDGE_MIN_CONCURRENCY  floor the adaptive pool degrades to
 *                                  (default 1)
 *
 * Output: writes `.out/judge-<stamp>.json` (overall + per-category
 * accuracy, the 2x2 crosstab, the correlation sanity checks, and every
 * per-QA judge verdict + raw judge response) and prints the same tables to
 * stdout. Exit code 6 on a hard stop (see `answer-model.ts`), matching
 * `run.ts`'s convention.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  callOllamaCloudChat,
  LocomoHardStopError,
  newCostTracker,
  type CostTracker,
} from "./answer-model.js"
import { isAbstained, type ScoredQA } from "./scoring.js"
import type { RetrievalRecord } from "./types.js"
import type { LocomoCategory } from "./types.js"

const here = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = resolve(here, ".out")

// Defaults point at the specific 840-QA-pair run this PR reports on (see
// README.md "Time budget" — ollama-cloud, gpt-oss:120b, all 10 conversations
// ingested, first 84 QA pairs/conversation, 42.3% of the full 1,986-pair
// dataset). Override both env vars together to re-score a different run —
// the results and retrieval files must come from the SAME run (matched by
// question text, see `buildRetrievalIndex`).
const DEFAULT_RESULTS_FILE = resolve(OUT_DIR, "results-2026-07-09T10-09-56-109Z.json")
const DEFAULT_RETRIEVAL_FILE = resolve(OUT_DIR, "retrieval-2026-07-09T10-09-56-109Z.json")
const RESULTS_FILE = process.env["LUNA_LOCOMO_RESULTS_FILE"] ?? DEFAULT_RESULTS_FILE
const RETRIEVAL_FILE = process.env["LUNA_LOCOMO_RETRIEVAL_FILE"] ?? DEFAULT_RETRIEVAL_FILE
const JUDGE_MODEL = process.env["LUNA_LOCOMO_JUDGE_MODEL"] ?? "gpt-oss:120b"
const INITIAL_CONCURRENCY = Number(process.env["LUNA_LOCOMO_JUDGE_CONCURRENCY"] ?? "8")
const MIN_CONCURRENCY = Number(process.env["LUNA_LOCOMO_JUDGE_MIN_CONCURRENCY"] ?? "1")
const OLLAMA_CLOUD_KEY = process.env["OLLAMA_CLOUD_KEY"]

interface ResultsFile {
  readonly scored: ReadonlyArray<ScoredQA>
  readonly aggregate: ReadonlyArray<{
    readonly category: LocomoCategory | "OVERALL"
    readonly count: number
    readonly meanScore: number
  }>
}

/**
 * Independently written binary judge prompt — general "LLM judge: is the
 * predicted answer the same as the gold answer" methodology, our own
 * wording (see module docstring for why this is not copied from any
 * vendor's proprietary judge prompt). Asks for a single machine-parseable
 * line so `parseJudgeVerdict` doesn't have to fight free-form prose, but
 * `parseJudgeVerdict` still has to be robust — models sometimes ignore the
 * format instruction and wrap the verdict in extra text anyway.
 */
export function buildJudgePrompt(question: string, groundTruth: string, prediction: string): string {
  return [
    "You are grading the output of a question-answering system. You will be given a QUESTION, a REFERENCE ANSWER that is known to be correct, and a CANDIDATE ANSWER produced by the system being graded.",
    "Decide whether the CANDIDATE ANSWER conveys the same factual content as the REFERENCE ANSWER, even if the wording, phrasing, level of detail, units, or date format differs. Example: \"May 7 2023\" and \"7th of May, 2023\" are THE SAME. Example: \"about a week ago\" and \"last month\" are NOT the same — different facts.",
    "If the CANDIDATE ANSWER is empty, says it has no information, or states something that contradicts the REFERENCE ANSWER, it is INCORRECT.",
    "Respond with EXACTLY one line, nothing else, in the form: VERDICT: <1 or 0>",
    "Use 1 if the candidate is correct, 0 if it is incorrect.",
    "",
    `QUESTION: ${question}`,
    `REFERENCE ANSWER: ${groundTruth}`,
    `CANDIDATE ANSWER: ${prediction.trim().length > 0 ? prediction : "(empty — no answer given)"}`,
  ].join("\n")
}

export interface JudgeVerdict {
  readonly verdict: 0 | 1
  readonly parseOk: boolean
}

/**
 * Robustly parse a judge response into a binary verdict. Models sometimes
 * wrap the requested `VERDICT: <0|1>` line in extra prose ("Sure, here's my
 * assessment...\nVERDICT: 1\nThe candidate correctly..."), so this tries
 * the exact requested format first, then falls back to looser signals
 * (a standalone 0/1, or "correct"/"incorrect"/"yes"/"no" — checked in an
 * order where "incorrect" is matched before the "correct" substring it
 * contains). `parseOk: false` means none of that worked — the caller
 * treats it as INCORRECT (conservative) but flags it as unparsed so it can
 * be audited separately from a genuine judge "no".
 */
export function parseJudgeVerdict(raw: string): JudgeVerdict {
  const text = raw.trim()
  const strict = /VERDICT:\s*([01])\b/i.exec(text)
  if (strict) return { verdict: strict[1] === "1" ? 1 : 0, parseOk: true }

  const lower = text.toLowerCase()
  const bareDigit = /(?:^|[^0-9])([01])(?:[^0-9]|$)/.exec(lower)
  if (bareDigit) return { verdict: bareDigit[1] === "1" ? 1 : 0, parseOk: true }

  if (/\bincorrect\b|\bnot correct\b|\bwrong\b/.test(lower)) return { verdict: 0, parseOk: true }
  if (/\bcorrect\b/.test(lower)) return { verdict: 1, parseOk: true }
  if (/\byes\b/.test(lower)) return { verdict: 1, parseOk: true }
  if (/\bno\b/.test(lower)) return { verdict: 0, parseOk: true }

  return { verdict: 0, parseOk: false }
}

export interface JudgedQA {
  readonly question: string
  readonly category: LocomoCategory
  readonly f1Score: number
  readonly judgeVerdict: 0 | 1
  readonly judgeParseOk: boolean
  readonly judgeCallMade: boolean
  readonly rawJudgeResponse: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Lane-based adaptive-concurrency worker pool. Spawns `opts.initial` lanes;
 * each lane pulls the next unclaimed item and runs `worker` on it. A lane
 * whose index is >= the CURRENT limit idles (polls every 300ms) instead of
 * pulling work — this is how the pool "shrinks" without killing in-flight
 * requests when `worker` reports repeated failures (see `judgeAll`'s
 * `onFailure` callback, which lowers `state.limit`). A hard stop
 * (`state.hardStop` set) makes every lane stop pulling new work immediately.
 */
async function runAdaptivePool<T>(
  items: ReadonlyArray<T>,
  worker: (item: T, index: number) => Promise<void>,
  opts: {
    readonly initial: number
    readonly min: number
    readonly onFailure: () => number // returns the (possibly reduced) new limit
  },
): Promise<void> {
  const state = { limit: Math.max(opts.min, opts.initial), hardStop: false }
  let cursor = 0

  async function lane(laneIdx: number): Promise<void> {
    for (;;) {
      if (state.hardStop) return
      if (laneIdx >= state.limit) {
        await sleep(300)
        continue
      }
      const idx = cursor++
      if (idx >= items.length) return
      try {
        await worker(items[idx]!, idx)
      } catch (e) {
        if (e instanceof LocomoHardStopError) {
          state.hardStop = true
          throw e
        }
        state.limit = opts.onFailure()
      }
    }
  }

  const laneCount = Math.max(opts.min, opts.initial)
  const settled = await Promise.allSettled(
    Array.from({ length: laneCount }, (_, i) => lane(i)),
  )
  const hardStopRejection = settled.find(
    (s): s is PromiseRejectedResult => s.status === "rejected" && s.reason instanceof LocomoHardStopError,
  )
  if (hardStopRejection) throw hardStopRejection.reason
}

async function judgeAll(
  scored: ReadonlyArray<ScoredQA>,
  opts: { readonly apiKey: string; readonly model: string; readonly tracker: CostTracker },
): Promise<{ readonly judged: ReadonlyArray<JudgedQA>; readonly hardStop: { reason: string; message: string } | null }> {
  const judged: Array<JudgedQA | undefined> = new Array(scored.length)
  let consecutiveFailures = 0
  let hardStop: { reason: string; message: string } | null = null

  const onFailure = (): number => {
    consecutiveFailures++
    // no-op placeholder for the current limit; real reduction happens below
    return consecutiveFailures >= 3 ? -1 : -1
  }
  void onFailure

  let currentLimit = Math.max(MIN_CONCURRENCY, INITIAL_CONCURRENCY)

  try {
    await runAdaptivePool(
      scored,
      async (qa, idx) => {
        if (qa.category === 5) {
          judged[idx] = {
            question: qa.question,
            category: qa.category,
            f1Score: qa.score,
            judgeVerdict: isAbstained(qa.prediction) ? 1 : 0,
            judgeParseOk: true,
            judgeCallMade: false,
            rawJudgeResponse: "(category 5 — deterministic abstention rule, no LLM judge call)",
          }
          consecutiveFailures = 0
          return
        }

        const prompt = buildJudgePrompt(qa.question, qa.groundTruth, qa.prediction)
        const { text, tokensIn, tokensOut } = await callOllamaCloudChat({
          prompt,
          apiKey: opts.apiKey,
          model: opts.model,
        })
        opts.tracker.totalTokensIn += tokensIn
        opts.tracker.totalTokensOut += tokensOut
        opts.tracker.calls += 1

        const parsed = parseJudgeVerdict(text)
        judged[idx] = {
          question: qa.question,
          category: qa.category,
          f1Score: qa.score,
          judgeVerdict: parsed.verdict,
          judgeParseOk: parsed.parseOk,
          judgeCallMade: true,
          rawJudgeResponse: text,
        }
        consecutiveFailures = 0
      },
      {
        initial: currentLimit,
        min: MIN_CONCURRENCY,
        onFailure: () => {
          consecutiveFailures++
          if (consecutiveFailures >= 3 && currentLimit > MIN_CONCURRENCY) {
            const next = Math.max(MIN_CONCURRENCY, Math.floor(currentLimit / 2))
            console.error(
              `[judge-rescore] ${consecutiveFailures} consecutive failures — reducing concurrency ${currentLimit} -> ${next}`,
            )
            currentLimit = next
            consecutiveFailures = 0
          }
          return currentLimit
        },
      },
    )
  } catch (e) {
    if (e instanceof LocomoHardStopError) {
      hardStop = { reason: e.reason, message: e.message }
      console.error(`[judge-rescore] HARD STOP (${e.reason}): ${e.message}`)
    } else {
      throw e
    }
  }

  return { judged: judged.filter((j): j is JudgedQA => j !== undefined), hardStop }
}

// Not `readonly` — `buildCrosstab` accumulates these in place while
// scanning the judged list; the function's return type is what callers
// treat as the stable, read-only-in-spirit contract.
export interface CrosstabCell {
  evidenceFoundCorrect: number
  evidenceFoundIncorrect: number
  evidenceMissingCorrect: number
  evidenceMissingIncorrect: number
  excludedNoEvidenceAnnotated: number
}

function emptyCell(): CrosstabCell {
  return {
    evidenceFoundCorrect: 0,
    evidenceFoundIncorrect: 0,
    evidenceMissingCorrect: 0,
    evidenceMissingIncorrect: 0,
    excludedNoEvidenceAnnotated: 0,
  }
}

/**
 * Builds the retrieval-vs-judge 2x2 crosstab (evidence found/missing ×
 * judge correct/incorrect), overall and per category. "Evidence found"
 * means ALL annotated gold evidence dia_ids for that QA pair were present
 * in the top-K retrieved hits (`evidenceHit === evidenceCount`) — partial
 * coverage counts as "missing" here, since partial evidence may still be
 * insufficient to answer correctly. QA pairs with no retrieval record at
 * all (LoCoMo didn't annotate `evidence` for them — see README.md; a
 * handful of category-3 pairs in this dataset) are excluded from the
 * found/missing split and counted separately.
 */
export function buildCrosstab(
  judged: ReadonlyArray<JudgedQA>,
  retrievalByQuestion: ReadonlyMap<string, RetrievalRecord>,
): { readonly overall: CrosstabCell; readonly byCategory: Record<number, CrosstabCell> } {
  const overall = emptyCell()
  const byCategory: Record<number, CrosstabCell> = {}

  for (const j of judged) {
    const cell = (byCategory[j.category] ??= emptyCell())
    const retrieval = retrievalByQuestion.get(j.question)
    const correct = j.judgeVerdict === 1

    if (!retrieval || retrieval.evidenceCount === 0) {
      overall.excludedNoEvidenceAnnotated++
      cell.excludedNoEvidenceAnnotated++
      continue
    }
    const evidenceFound = retrieval.evidenceHit === retrieval.evidenceCount
    if (evidenceFound && correct) {
      overall.evidenceFoundCorrect++
      cell.evidenceFoundCorrect++
    } else if (evidenceFound && !correct) {
      overall.evidenceFoundIncorrect++
      cell.evidenceFoundIncorrect++
    } else if (!evidenceFound && correct) {
      overall.evidenceMissingCorrect++
      cell.evidenceMissingCorrect++
    } else {
      overall.evidenceMissingIncorrect++
      cell.evidenceMissingIncorrect++
    }
  }

  return { overall, byCategory }
}

function accuracyByCategory(
  judged: ReadonlyArray<JudgedQA>,
): ReadonlyArray<{ category: LocomoCategory | "OVERALL"; count: number; accuracy: number }> {
  const categories = Array.from(new Set(judged.map((j) => j.category))).sort()
  const perCategory = categories.map((category) => {
    const slice = judged.filter((j) => j.category === category)
    const accuracy = slice.reduce((a, b) => a + b.judgeVerdict, 0) / slice.length
    return { category, count: slice.length, accuracy }
  })
  const overall = {
    category: "OVERALL" as const,
    count: judged.length,
    accuracy: judged.reduce((a, b) => a + b.judgeVerdict, 0) / (judged.length || 1),
  }
  return [...perCategory, overall]
}

/** Spearman rank correlation between two equal-length numeric arrays. */
export function spearmanRankCorrelation(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  if (a.length !== b.length || a.length < 2) return NaN
  const rank = (xs: ReadonlyArray<number>): number[] => {
    const idx = xs.map((_, i) => i).sort((i, j) => xs[i]! - xs[j]!)
    const ranks = new Array<number>(xs.length)
    idx.forEach((originalIdx, sortedPos) => {
      ranks[originalIdx] = sortedPos + 1
    })
    return ranks
  }
  const ra = rank(a)
  const rb = rank(b)
  const n = a.length
  const dSquaredSum = ra.reduce((acc, r, i) => acc + (r - rb[i]!) ** 2, 0)
  return 1 - (6 * dSquaredSum) / (n * (n * n - 1))
}

async function main(): Promise<void> {
  console.log(`# LoCoMo judge-rescore — re-scoring ${RESULTS_FILE}`)

  if (!OLLAMA_CLOUD_KEY) {
    console.error(
      "[judge-rescore] OLLAMA_CLOUD_KEY is required (Bearer token for https://ollama.com/api).",
    )
    process.exit(4)
  }

  let resultsFile: ResultsFile
  let retrievalRecords: ReadonlyArray<RetrievalRecord>
  try {
    resultsFile = JSON.parse(readFileSync(RESULTS_FILE, "utf8")) as ResultsFile
    retrievalRecords = JSON.parse(readFileSync(RETRIEVAL_FILE, "utf8")) as ReadonlyArray<RetrievalRecord>
  } catch (e) {
    console.error(`[judge-rescore] failed to load results/retrieval files: ${String(e)}`)
    process.exit(3)
    return
  }

  const scored = resultsFile.scored
  const retrievalByQuestion = new Map(retrievalRecords.map((r) => [r.question, r]))
  console.log(
    `# ${scored.length} QA pairs to judge (model ${JUDGE_MODEL}) · ${retrievalRecords.length} have retrieval-evidence records · initial concurrency ${INITIAL_CONCURRENCY}`,
  )

  const tracker = newCostTracker()
  const startedAt = Date.now()
  const { judged, hardStop } = await judgeAll(scored, {
    apiKey: OLLAMA_CLOUD_KEY,
    model: JUDGE_MODEL,
    tracker,
  })
  const wallSec = (Date.now() - startedAt) / 1000

  const acc = accuracyByCategory(judged)
  const crosstab = buildCrosstab(judged, retrievalByQuestion)

  console.log("")
  console.log("| category | count | judge accuracy | F1 (from results file) |")
  console.log("|:---|---:|---:|---:|")
  const f1ByCategory = new Map(
    resultsFile.aggregate.map((a) => [String(a.category), a.meanScore]),
  )
  for (const row of acc) {
    const f1 = f1ByCategory.get(String(row.category))
    console.log(
      `| ${row.category} | ${row.count} | ${row.accuracy.toFixed(3)} | ${f1 !== undefined ? f1.toFixed(3) : "n/a"} |`,
    )
  }

  const parseFailures = judged.filter((j) => !j.judgeParseOk).length
  console.log("")
  console.log(
    `# judge calls: ${tracker.calls} · parse failures: ${parseFailures} · wall-clock ${(wallSec / 60).toFixed(1)}m`,
  )

  // Correlation sanity check #1: per-category rank agreement.
  const perCategoryRows = acc.filter((r) => r.category !== "OVERALL")
  const f1Series = perCategoryRows.map((r) => f1ByCategory.get(String(r.category)) ?? 0)
  const judgeSeries = perCategoryRows.map((r) => r.accuracy)
  const rankCorrelation = spearmanRankCorrelation(f1Series, judgeSeries)
  console.log(
    `# per-category rank correlation (F1 vs judge accuracy): Spearman rho = ${rankCorrelation.toFixed(3)} ${
      rankCorrelation > 0.5 ? "(tracks — same rough ranking)" : "(WEAK/DIVERGENT — investigate before trusting this run)"
    }`,
  )

  // Correlation sanity check #2: mean F1 split by judge verdict.
  const llmJudged = judged.filter((j) => j.judgeCallMade)
  const meanF1WhenCorrect =
    llmJudged.filter((j) => j.judgeVerdict === 1).reduce((a, b) => a + b.f1Score, 0) /
    (llmJudged.filter((j) => j.judgeVerdict === 1).length || 1)
  const meanF1WhenIncorrect =
    llmJudged.filter((j) => j.judgeVerdict === 0).reduce((a, b) => a + b.f1Score, 0) /
    (llmJudged.filter((j) => j.judgeVerdict === 0).length || 1)
  console.log(
    `# mean F1 when judge says correct: ${meanF1WhenCorrect.toFixed(3)} · when judge says incorrect: ${meanF1WhenIncorrect.toFixed(3)} ${
      meanF1WhenCorrect > meanF1WhenIncorrect
        ? "(consistent — judge-correct answers score meaningfully higher F1)"
        : "(WEAK/INVERTED — investigate before trusting this run)"
    }`,
  )

  console.log("")
  console.log("## Retrieval-vs-judge 2x2 (overall)")
  console.log(JSON.stringify(crosstab.overall, null, 2))
  console.log("")
  console.log("## Retrieval-vs-judge 2x2 (by category)")
  for (const [cat, cell] of Object.entries(crosstab.byCategory).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    console.log(`category ${cat}:`, JSON.stringify(cell))
  }

  mkdirSync(OUT_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const outPath = resolve(OUT_DIR, `judge-${stamp}.json`)
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        sourceResultsFile: RESULTS_FILE,
        sourceRetrievalFile: RETRIEVAL_FILE,
        judgeModel: JUDGE_MODEL,
        accuracyByCategory: acc,
        parseFailures,
        crosstab,
        correlationCheck: {
          perCategoryRankSpearman: rankCorrelation,
          meanF1WhenJudgeCorrect: meanF1WhenCorrect,
          meanF1WhenJudgeIncorrect: meanF1WhenIncorrect,
        },
        cost: tracker,
        wallClockSec: wallSec,
        hardStopped: hardStop,
        judged,
      },
      null,
      2,
    ),
  )
  console.log("")
  console.log(`# wrote ${outPath}`)

  if (hardStop) process.exit(6)
}

// Only run the pipeline when this file is executed directly (`bun
// .../judge-rescore.ts`), NOT when its pure functions (`buildJudgePrompt`,
// `parseJudgeVerdict`, `buildCrosstab`, `spearmanRankCorrelation`) are
// imported by the unit test suite — mirrors the guard pattern needed
// because, unlike `run.ts` (never imported elsewhere), this module IS
// imported by `test/locomo-eval.test.ts` for its pure functions.
const isDirectRun = (() => {
  try {
    return import.meta.url === new URL(process.argv[1] ?? "", "file:").href
  } catch {
    return false
  }
})()
if (isDirectRun) {
  await main()
}
