/**
 * The grade stage must use LongMemEval's official judge prompts
 * (src/evaluation/evaluate_qa.py at 9e0b455f); a reworded prompt would make
 * the scores incomparable with published ones.
 */
import { describe, expect, it } from "vitest"
import { anscheckPrompt, GRADERS } from "../bench/lme-qa-grade.js"

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
})
