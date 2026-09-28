/**
 * classifier/jev.ts - the one definition of a Jev classifier request: a
 * `state` plus typed questions (Noul / Choice / Score) answered by
 * api.typesafe.ai/v1/systemone. Shared by adapter-sdk's JevClassifierLayer
 * and any test double so the wire shape cannot drift.
 *
 * The wire contract (docs.typesafe.ai): every question is evaluated against
 * the same `state` in parallel and comes back as a typed answer —
 *   noul   -> { type:"noul",   noul: <p(yes) 0..1> }
 *   choice -> { type:"choice", choice: <optionId>, confidence, probabilities }
 *   score  -> { type:"score",  score: <level index>, confidence, legend, probabilities }
 *
 * Unlike the memory reranker (which fixes one Noul task per candidate), the
 * classifier is caller-shaped: questions arrive already in wire form from
 * ClassifierApi.ask, so the request builder only wraps them. parseAnswers
 * enforces completeness — a missing or malformed answer fails the whole
 * call rather than letting a half-answered decision through.
 */

import { JEV_MODEL } from "../memory-rerank/jev.js"
import type {
  ClassifierAnswers,
  ClassifierContent,
  ClassifierQuestion,
} from "./types.js"

export { JEV_MODEL }

/** Rough token count: ~4 characters per token for ASCII, ~1 per character
 *  otherwise (CJK). Deliberately high. Mirrors estimateJevTokens. */
export function estimateClassifierTokens(text: string): number {
  let ascii = 0
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) < 128) ascii++
  return Math.ceil(ascii / 4) + (text.length - ascii)
}

const contentTokens = (c: ClassifierContent): number =>
  typeof c === "string" ? estimateClassifierTokens(c) : estimateClassifierTokens(JSON.stringify(c))

const criteriaTokens = (criteria: ClassifierQuestion["criteria"]): number => {
  if (criteria === undefined) return 0
  if (Array.isArray(criteria)) {
    return (criteria as ReadonlyArray<ClassifierContent>).reduce(
      (acc, c) => acc + contentTokens(c),
      0,
    )
  }
  return contentTokens(criteria as ClassifierContent)
}

/** Rough per-request token cost (state + each question's instructions +
 *  criteria + the ~70-token envelope Jev sees per question). For logging,
 *  not splitting — a classifier call is a handful of questions, not 40
 *  capped memories. */
export function estimateClassifierRequestTokens(
  state: ClassifierContent,
  questions: Readonly<Record<string, ClassifierQuestion>>,
): number {
  let total = contentTokens(state)
  for (const q of Object.values(questions)) {
    total += 70 + contentTokens(q.instructions) + criteriaTokens(q.criteria)
  }
  return total
}

/** The request body judging `questions` against `state`. Questions pass
 *  through verbatim — ClassifierApi callers already speak wire shape. */
export function jevClassifierRequest(
  state: ClassifierContent,
  questions: Readonly<Record<string, ClassifierQuestion>>,
  model: string = JEV_MODEL,
) {
  return { model, state, questions }
}

const finiteInUnit = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1

const finiteNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v)

const numberMap = (v: unknown): v is Record<string, number> =>
  typeof v === "object" && v !== null && !Array.isArray(v) &&
  Object.values(v as Record<string, unknown>).every(finiteNumber)

const stringMap = (v: unknown): v is Record<string, string> =>
  typeof v === "object" && v !== null && !Array.isArray(v) &&
  Object.values(v as Record<string, unknown>).every((x) => typeof x === "string")

const optionalFields = (a: Record<string, unknown>) => ({
  ...(a["confidence"] !== undefined ? { confidence: a["confidence"] as number } : {}),
  ...(a["probabilities"] !== undefined ? { probabilities: a["probabilities"] as Record<string, number> } : {}),
})

const checkConfidenceAndProbabilities = (id: string, a: Record<string, unknown>): void => {
  if (a["confidence"] !== undefined && !finiteInUnit(a["confidence"])) {
    throw new Error(`jev: malformed confidence on answer ${id}`)
  }
  if (a["probabilities"] !== undefined && !numberMap(a["probabilities"])) {
    throw new Error(`jev: malformed probabilities on answer ${id}`)
  }
}

/** Parse + validate ONE answer against the question that produced it.
 *  Throws on missing/malformed answers: a classifier that silently drops a
 *  question would bias the decision it feeds. */
function parseAnswer(
  id: string,
  question: ClassifierQuestion,
  raw: unknown,
): ClassifierAnswers[string] {
  const a = (raw ?? {}) as Record<string, unknown>
  switch (question.type) {
    case "noul": {
      if (!finiteInUnit(a["noul"])) throw new Error(`jev: missing or malformed noul answer ${id}`)
      return { type: "noul", noul: a["noul"] }
    }
    case "choice": {
      if (typeof a["choice"] !== "string" || a["choice"].length === 0) {
        throw new Error(`jev: missing or malformed choice answer ${id}`)
      }
      // The winner must be one of the declared option ids — an out-of-set
      // label would route to a destination that doesn't exist. Own-property
      // check, not `in`: `in` walks the prototype chain, so "toString" /
      // "constructor" would pass on ANY criteria object.
      if (!Object.hasOwn(question.criteria, a["choice"])) {
        throw new Error(`jev: choice answer ${id} picked an undeclared option "${a["choice"]}"`)
      }
      checkConfidenceAndProbabilities(id, a)
      return {
        type: "choice",
        choice: a["choice"],
        ...optionalFields(a),
      }
    }
    case "score": {
      if (!finiteNumber(a["score"]) || !Number.isInteger(a["score"])) {
        throw new Error(`jev: missing or malformed score answer ${id}`)
      }
      const idx = a["score"]
      if (idx < 0 || idx >= question.criteria.length) {
        throw new Error(`jev: score answer ${id} out of range (${a["score"]} vs ${question.criteria.length} levels)`)
      }
      checkConfidenceAndProbabilities(id, a)
      if (a["legend"] !== undefined && !stringMap(a["legend"])) {
        throw new Error(`jev: malformed legend on answer ${id}`)
      }
      return {
        type: "score",
        score: a["score"],
        ...optionalFields(a),
        ...(a["legend"] !== undefined ? { legend: a["legend"] as Record<string, string> } : {}),
      }
    }
  }
}

/** Every answer keyed by its question id. Throws when any answer is missing
 *  or fails its type check. */
export function parseJevClassifierAnswers(
  json: unknown,
  questions: Readonly<Record<string, ClassifierQuestion>>,
): { readonly answers: ClassifierAnswers; readonly servedModel?: string } {
  const body = (json ?? {}) as { model?: unknown; answers?: Record<string, unknown> }
  const out: Record<string, ClassifierAnswers[string]> = {}
  for (const [id, q] of Object.entries(questions)) {
    out[id] = parseAnswer(id, q, body.answers?.[id])
  }
  return typeof body.model === "string"
    ? { answers: out, servedModel: body.model }
    : { answers: out }
}
