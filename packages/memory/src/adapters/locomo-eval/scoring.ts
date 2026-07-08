/**
 * LoCoMo QA scoring — independently implemented from the LoCoMo paper's
 * published methodology (verified by reading, NOT copying,
 * task_eval/evaluation.py in snap-research/locomo — that file is
 * AGPL-adjacent-repo-free but we still don't vendor it; we re-derived the
 * same algorithm in TypeScript). The paper uses token-overlap F1 as its
 * primary metric (plus EM/BERTScore/ROUGE-L as secondary, which we skip —
 * see README.md "Deviations from the paper's exact numbers").
 *
 * Per-category scoring (category numbers verified against the actual
 * upstream `eval_question_answering`):
 *   - category 2, 4: plain token F1(prediction, answer)
 *   - category 3 (temporal): answer truncated at the first ";" before F1
 *   - category 1 (multi-hop): both sides comma-split into sub-answers;
 *     for each ground-truth sub-answer, take the max F1 against any
 *     predicted sub-answer, then average
 *   - category 5 (adversarial): 1 if the prediction abstains (contains
 *     "no information available" or "not mentioned"), else 0 — there is
 *     no ground-truth `answer` for this category, only a distractor
 *     `adversarial_answer` the model should NOT produce
 *
 * Deviation from the paper: the paper stems tokens with a Porter stemmer
 * before computing F1. We use a lightweight suffix-stripping approximation
 * (see `lightStem`) instead of vendoring a full Porter implementation.
 * This means our F1 numbers are directionally comparable across our own
 * runs but NOT bit-for-bit comparable to the published LoCoMo leaderboard.
 */
import type { LocomoCategory, LocomoQA } from "./types.js"

const ARTICLES = /\b(a|an|the|and)\b/g
const PUNCT = /[!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~]/g

function normalizeAnswer(s: string): string {
  return s
    .replace(/,/g, "")
    .replace(ARTICLES, " ")
    .replace(PUNCT, "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .join(" ")
}

/** Cheap suffix-stripping stand-in for PorterStemmer — see module docstring. */
function lightStem(token: string): string {
  if (token.length > 4 && token.endsWith("ies")) return token.slice(0, -3) + "y"
  if (token.length > 4 && token.endsWith("es")) return token.slice(0, -2)
  if (token.length > 4 && token.endsWith("ing")) return token.slice(0, -3)
  if (token.length > 3 && token.endsWith("ed")) return token.slice(0, -2)
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) {
    return token.slice(0, -1)
  }
  return token
}

function tokenize(s: string): string[] {
  return normalizeAnswer(s)
    .split(" ")
    .filter(Boolean)
    .map(lightStem)
}

/** Token-overlap F1 between one prediction string and one ground-truth string. */
export function f1Score(prediction: string, groundTruth: string): number {
  const predTokens = tokenize(prediction)
  const gtTokens = tokenize(groundTruth)
  if (predTokens.length === 0 || gtTokens.length === 0) {
    return predTokens.length === gtTokens.length ? 1 : 0
  }
  const counts = new Map<string, number>()
  for (const t of gtTokens) counts.set(t, (counts.get(t) ?? 0) + 1)
  let numSame = 0
  const remaining = new Map(counts)
  for (const t of predTokens) {
    const left = remaining.get(t) ?? 0
    if (left > 0) {
      numSame++
      remaining.set(t, left - 1)
    }
  }
  if (numSame === 0) return 0
  const precision = numSame / predTokens.length
  const recall = numSame / gtTokens.length
  return (2 * precision * recall) / (precision + recall)
}

/** Multi-answer F1 (category 1): comma-split both sides, max-then-average. */
function multiAnswerF1(prediction: string, groundTruth: string): number {
  const preds = prediction.split(",").map((p) => p.trim()).filter(Boolean)
  const truths = groundTruth.split(",").map((g) => g.trim()).filter(Boolean)
  if (preds.length === 0 || truths.length === 0) return 0
  const perTruth = truths.map((gt) =>
    Math.max(...preds.map((p) => f1Score(p, gt))),
  )
  return perTruth.reduce((a, b) => a + b, 0) / perTruth.length
}

const ABSTAIN_PHRASES = ["no information available", "not mentioned"]

export interface ScoredQA {
  readonly question: string
  readonly category: LocomoCategory
  readonly groundTruth: string
  readonly prediction: string
  readonly score: number
}

/** Score one answered QA pair per the category rules above. */
export function scoreQA(qa: LocomoQA, prediction: string): ScoredQA {
  const category = qa.category

  if (category === 5) {
    const lower = prediction.toLowerCase()
    const abstained = ABSTAIN_PHRASES.some((p) => lower.includes(p))
    return {
      question: qa.question,
      category,
      groundTruth: "(unanswerable — expects abstention)",
      prediction,
      score: abstained ? 1 : 0,
    }
  }

  const rawAnswer = String(qa.answer ?? "")
  const groundTruth = category === 3 ? (rawAnswer.split(";")[0] ?? "").trim() : rawAnswer
  const score =
    category === 1 ? multiAnswerF1(prediction, groundTruth) : f1Score(prediction, groundTruth)

  return { question: qa.question, category, groundTruth, prediction, score }
}

export interface CategoryMetrics {
  readonly category: LocomoCategory | "OVERALL"
  readonly count: number
  readonly meanScore: number
}

export function aggregateByCategory(
  scored: ReadonlyArray<ScoredQA>,
): ReadonlyArray<CategoryMetrics> {
  const categories = Array.from(new Set(scored.map((s) => s.category))).sort()
  const perCategory = categories.map((category) => {
    const slice = scored.filter((s) => s.category === category)
    const meanScore = slice.reduce((a, b) => a + b.score, 0) / slice.length
    return { category, count: slice.length, meanScore }
  })
  const overall: CategoryMetrics = {
    category: "OVERALL",
    count: scored.length,
    meanScore: scored.reduce((a, b) => a + b.score, 0) / (scored.length || 1),
  }
  return [...perCategory, overall]
}
