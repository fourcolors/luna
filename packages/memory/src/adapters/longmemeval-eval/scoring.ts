/**
 * Cheap LongMemEval scoring — NOT the official GPT-4o judge.
 *
 * Official metric (src/evaluation/evaluate_qa.py): an LLM (gpt-4o by
 * default) answers yes/no to "does the response contain the correct
 * answer?" with a few task-specific relaxations (temporal off-by-one,
 * knowledge-update may mention the old fact, preference is a rubric,
 * abstention = model identifies the question as unanswerable).
 *
 * This smoke does not call GPT-4o / OpenAI. We report two free metrics:
 *   - token-overlap F1 (same helper as locomo-eval/scoring.ts)
 *   - contains-gold: 1 if the normalized gold string (or all gold tokens)
 *     appear in the prediction; abstention IDs score 1 iff the model
 *     abstains ("no information available" / "not mentioned" /
 *     "unanswerable" / "don't know")
 *
 * These numbers are internally consistent across our own runs. They are
 * NOT comparable to the published LongMemEval leaderboard (GPT-4o judge).
 */
import { f1Score, isAbstained } from "../locomo-eval/scoring.js"
import { isAbstentionId } from "./dataset.js"

const EXTRA_ABSTAIN = ["unanswerable", "don't know", "do not know", "cannot answer", "can't answer"]

export function isLmeAbstained(prediction: string): boolean {
  if (isAbstained(prediction)) return true
  const lower = prediction.toLowerCase()
  return EXTRA_ABSTAIN.some((p) => lower.includes(p))
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~]/g, " ")
    .replace(/\b(a|an|the|and)\b/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ")
}

/**
 * Cheap official-proxy: does the prediction contain the gold answer?
 * (Official judge is "contains / equivalent"; we only check containment.)
 */
export function containsGold(prediction: string, gold: string): boolean {
  const pred = normalize(prediction)
  const g = normalize(gold)
  if (g.length === 0 || pred.length === 0) return false
  if (pred.includes(g)) return true
  const goldTokens = g.split(" ").filter(Boolean)
  const predTokens = new Set(pred.split(" ").filter(Boolean))
  return goldTokens.length > 0 && goldTokens.every((t) => predTokens.has(t))
}

export interface ScoredQA {
  readonly questionId: string
  readonly question: string
  readonly questionType: string
  readonly abstention: boolean
  readonly groundTruth: string
  readonly prediction: string
  readonly f1: number
  readonly containsGold: number
}

export function scoreQA(
  instance: {
    readonly question_id: string
    readonly question: string
    readonly question_type: string
    readonly answer: string
  },
  prediction: string,
): ScoredQA {
  const abstention = isAbstentionId(instance.question_id)
  if (abstention) {
    const ok = isLmeAbstained(prediction)
    return {
      questionId: instance.question_id,
      question: instance.question,
      questionType: instance.question_type,
      abstention: true,
      groundTruth: "(unanswerable — expects abstention)",
      prediction,
      f1: ok ? 1 : 0,
      containsGold: ok ? 1 : 0,
    }
  }
  const groundTruth = String(instance.answer ?? "")
  return {
    questionId: instance.question_id,
    question: instance.question,
    questionType: instance.question_type,
    abstention: false,
    groundTruth,
    prediction,
    f1: f1Score(prediction, groundTruth),
    containsGold: containsGold(prediction, groundTruth) ? 1 : 0,
  }
}

export interface TypeMetrics {
  readonly questionType: string
  readonly count: number
  readonly meanF1: number
  readonly meanContainsGold: number
}

export function aggregateByType(scored: ReadonlyArray<ScoredQA>): ReadonlyArray<TypeMetrics> {
  const types = Array.from(new Set(scored.map((s) => s.questionType))).sort()
  const perType = types.map((questionType) => {
    const slice = scored.filter((s) => s.questionType === questionType)
    return {
      questionType,
      count: slice.length,
      meanF1: slice.reduce((a, b) => a + b.f1, 0) / slice.length,
      meanContainsGold: slice.reduce((a, b) => a + b.containsGold, 0) / slice.length,
    }
  })
  const overall: TypeMetrics = {
    questionType: "OVERALL",
    count: scored.length,
    meanF1: scored.reduce((a, b) => a + b.f1, 0) / (scored.length || 1),
    meanContainsGold: scored.reduce((a, b) => a + b.containsGold, 0) / (scored.length || 1),
  }
  return [...perType, overall]
}
