/**
 * The grade stage must use LongMemEval's official judge prompts
 * (src/evaluation/evaluate_qa.py at 9e0b455f); a reworded prompt would make
 * the scores incomparable with published ones.
 */
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { anscheckPrompt, computeMetrics, GRADERS, judgeLabel, readJsonl, type QaRef } from "../bench/lme-qa-grade.js"

describe("lme-qa-grade", () => {
  it("uses the official shared template for single-session and multi-session questions", () => {
    expect(anscheckPrompt("multi-session", "Q?", "A", "R", false)).toBe(
      "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. \n\nQuestion: Q?\n\nCorrect Answer: A\n\nModel Response: R\n\nIs the model response correct? Answer yes or no only.",
    )
    expect(anscheckPrompt("single-session-user", "Q?", "A", "R", false)).toBe(anscheckPrompt("single-session-assistant", "Q?", "A", "R", false))
  })

  it("temporal questions forgive off-by-one day counts; knowledge-update accepts an updated answer; preference uses a rubric", () => {
    expect(anscheckPrompt("temporal-reasoning", "Q?", "A", "R", false)).toContain(
      "In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct. \n\nQuestion: Q?",
    )
    expect(anscheckPrompt("knowledge-update", "Q?", "A", "R", false)).toContain(
      "If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.\n\nQuestion: Q?",
    )
    expect(anscheckPrompt("single-session-preference", "Q?", "A", "R", false)).toContain("\n\nRubric: A\n\nModel Response: R\n\n")
  })

  it("abstention questions (ids ending _abs) use the unanswerable template whatever their type", () => {
    const p = anscheckPrompt("temporal-reasoning", "Q?", "why unanswerable", "R", true)
    expect(p.startsWith("I will give you an unanswerable question, an explanation, and a response from a model.")).toBe(true)
    expect(p).toContain("\n\nExplanation: why unanswerable\n\n")
    expect(p.endsWith("Does the model correctly identify the question as unanswerable? Answer yes or no only.")).toBe(true)
  })

  it("rejects an unknown question type instead of grading it with the wrong template", () => {
    expect(() => anscheckPrompt("open-domain", "Q?", "A", "R", false)).toThrow(/unknown question type/)
  })

  it("the GPT-4o grader is the paper's pinned judge", () => {
    expect(GRADERS["gpt-4o"]!.model).toBe("gpt-4o-2024-08-06")
  })

  it("judgeLabel: the official 'yes' substring rule, but an empty or cut-off reply is a failure, not a 'no'", () => {
    expect(judgeLabel("Yes.", "stop")).toBe(true)
    expect(judgeLabel("no", "stop")).toBe(false)
    expect(judgeLabel("yes, but", "length")).toBe(true)
    expect(() => judgeLabel("", "stop")).toThrow(/empty/)
    expect(() => judgeLabel("The response", "length")).toThrow(/cut off/)
  })

  it("computeMetrics: print_qa_metrics semantics over every question, flagged incomplete when any is missing", () => {
    const ref = new Map<string, QaRef>([
      ["a", { questionType: "multi-session", abstention: false }],
      ["b", { questionType: "multi-session", abstention: false }],
      ["c_abs", { questionType: "multi-session", abstention: true }],
      ["d", { questionType: "temporal-reasoning", abstention: false }],
      ...(["single-session-user", "single-session-preference", "single-session-assistant", "knowledge-update"] as const).map(
        (t) => [`x-${t}`, { questionType: t, abstention: false }] as [string, QaRef],
      ),
    ])
    const labels = { a: true, b: false, c_abs: true, d: false, "x-single-session-user": true, "x-single-session-preference": true, "x-single-session-assistant": true, "x-knowledge-update": false }
    const m = computeMetrics(labels, ref)
    expect(m.complete).toBe(true)
    expect(m.overall).toBeCloseTo(5 / 8) // abstention question included in Overall
    expect(m.perType["multi-session"]).toBeCloseTo(2 / 3) // ...and in its own type
    expect(m.taskAveraged).toBeCloseTo((2 / 3 + 0 + 1 + 1 + 1 + 0) / 6)
    expect(m.abstention).toBe(1)
    const partial = computeMetrics({ a: true }, ref)
    expect(partial.complete).toBe(false)
    expect(partial.graded).toBe(1)
    expect(partial.total).toBe(8)
  })

  it("readJsonl skips a line cut short by a crash instead of failing the resume", () => {
    const f = join(mkdtempSync(join(tmpdir(), "lme-qa-grade-")), "x.jsonl")
    writeFileSync(f, '{"question_id":"a"}\n{"question_id":"b"}\n{"question_id":"c', "utf8")
    expect(readJsonl<{ question_id: string }>(f).map((e) => e.question_id)).toEqual(["a", "b"])
  })
})
