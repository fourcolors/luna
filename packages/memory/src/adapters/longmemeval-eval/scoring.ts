/**
 * Cheap LongMemEval scoring - NOT the official GPT-4o judge.
 *
 * Official metric (src/evaluation/evaluate_qa.py): an LLM (gpt-4o by
 * default) answers yes/no to "does the response contain the correct
 * answer?" with a few task-specific relaxations (temporal off-by-one,
 * knowledge-update may mention the old fact, preference is a rubric,
 * abstention = model identifies the question as unanswerable).
 *
 * This smoke does not call GPT-4o / OpenAI. We report two free metrics:
 *   - token-overlap F1 (same helper as locomo-eval/scoring.ts)
 *   - contains-gold: 1 iff the normalized gold answer appears in the
 *     normalized prediction as a whole-word phrase ("12 hours" does NOT
 *     contain "2 hours"). It is strict, and only a judge fixes its limits:
 *       - an "A or B?" answer that names both options still passes;
 *       - ~11% of scorable golds carry extra prose ("7 days. 8 days
 *         (including the last day) is also acceptable.") and ~16% are 10+
 *         words, so a correct short answer can never contain them. These
 *         misses cluster in temporal-reasoning; F1 still gives partial credit.
 *
 * Abstention (`_abs`) and answerable questions are aggregated SEPARATELY.
 * The answer prompt's fallback is the exact abstain phrase, so a reader that
 * abstains on everything aces abstention; blending the two into one number
 * hides that. `single-session-preference` gold is a rubric, not an answer,
 * so both metrics are null (N/A) there.
 *
 * These numbers are internally consistent across our own runs. They are
 * NOT comparable to the published LongMemEval leaderboard (GPT-4o judge).
 */
import { f1Score, isAbstained } from "../locomo-eval/scoring.js"
import { isAbstentionId } from "./dataset.js"

/** What the answer prompt tells the reader to say when it can't answer. */
export const ALWAYS_ABSTAIN_PREDICTION = "No information available."

const EXTRA_ABSTAIN = ["unanswerable", "don't know", "do not know", "cannot answer", "can't answer"]

/** Question types whose gold `answer` is a grading rubric, not an answer. */
const RUBRIC_TYPES: ReadonlySet<string> = new Set(["single-session-preference"])

/**
 * Readers often answer in markdown, escaping `_`, `*`, etc. The escaped
 * form of a correct answer (`@jessica\_poole`) must score like the plain one.
 */
export function unescapeMarkdown(s: string): string {
  return s.replace(/\\([\\`*_{}[\]()#+\-.!|~>%'"])/g, "$1")
}

export function isLmeAbstained(prediction: string): boolean {
  if (isAbstained(prediction)) return true
  const lower = prediction.toLowerCase().replace(/[\u2018\u2019]/g, "'")
  return EXTRA_ABSTAIN.some((p) => lower.includes(p))
}

function normalize(s: string): string {
  return (
    s
      .toLowerCase()
      // Keep decimals ("5.5 weeks") intact before stripping punctuation.
      .replace(/(\d)\.(\d)/g, "$1\u0000$2")
      .replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~\u2018\u2019\u201c\u201d]/g, " ")
      .replace(/\u0000/g, ".")
      .replace(/\b(a|an|the|and)\b/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .join(" ")
  )
}

/**
 * Cheap official-proxy: does the prediction contain the gold answer as a
 * whole-word phrase? (Official judge is "contains / equivalent".)
 */
export function containsGold(prediction: string, gold: string): boolean {
  const pred = normalize(prediction)
  const g = normalize(gold)
  if (g.length === 0 || pred.length === 0) return false
  return ` ${pred} `.includes(` ${g} `)
}

export interface ScoredQA {
  readonly questionId: string
  readonly question: string
  readonly questionType: string
  readonly abstention: boolean
  readonly groundTruth: string
  readonly prediction: string
  /** null = metric does not apply (rubric-graded question type). */
  readonly f1: number | null
  readonly containsGold: number | null
}

export function scoreQA(
  instance: {
    readonly question_id: string
    readonly question: string
    readonly question_type: string
    readonly answer: string | number
  },
  prediction: string,
): ScoredQA {
  const base = {
    questionId: instance.question_id,
    question: instance.question,
    questionType: instance.question_type,
    prediction,
  }
  if (isAbstentionId(instance.question_id)) {
    const ok = isLmeAbstained(prediction) ? 1 : 0
    return {
      ...base,
      abstention: true,
      groundTruth: "(unanswerable - expects abstention)",
      f1: ok,
      containsGold: ok,
    }
  }
  const groundTruth = String(instance.answer ?? "")
  if (RUBRIC_TYPES.has(instance.question_type)) {
    return { ...base, abstention: false, groundTruth, f1: null, containsGold: null }
  }
  const plain = unescapeMarkdown(prediction)
  return {
    ...base,
    abstention: false,
    groundTruth,
    f1: f1Score(plain, groundTruth),
    containsGold: containsGold(plain, groundTruth) ? 1 : 0,
  }
}

export interface TypeMetrics {
  /** A question_type, "abstention", or "ANSWERABLE" (all non-abstention). */
  readonly questionType: string
  readonly count: number
  /** Questions a metric applies to (excludes rubric-graded ones). */
  readonly scoredCount: number
  readonly meanF1: number | null
  readonly meanContainsGold: number | null
}

function summarize(questionType: string, slice: ReadonlyArray<ScoredQA>): TypeMetrics {
  const scoredF1 = slice.flatMap((s) => (s.f1 === null ? [] : [s.f1]))
  const scoredCg = slice.flatMap((s) => (s.containsGold === null ? [] : [s.containsGold]))
  const mean = (xs: ReadonlyArray<number>) =>
    xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length
  return {
    questionType,
    count: slice.length,
    scoredCount: scoredF1.length,
    meanF1: mean(scoredF1),
    meanContainsGold: mean(scoredCg),
  }
}

/**
 * One row per question_type (answerable questions only), then an
 * "abstention" row for `_abs` IDs, then an "ANSWERABLE" overall row.
 * There is deliberately no blended overall: see the module docstring.
 */
export function aggregateByType(scored: ReadonlyArray<ScoredQA>): ReadonlyArray<TypeMetrics> {
  const answerable = scored.filter((s) => !s.abstention)
  const abstention = scored.filter((s) => s.abstention)
  const types = Array.from(new Set(answerable.map((s) => s.questionType))).sort()
  return [
    ...types.map((t) => summarize(t, answerable.filter((s) => s.questionType === t))),
    ...(abstention.length > 0 ? [summarize("abstention", abstention)] : []),
    summarize("ANSWERABLE", answerable),
  ]
}
