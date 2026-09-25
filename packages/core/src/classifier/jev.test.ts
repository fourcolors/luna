/**
 * classifier/jev.test.ts - the Jev classifier wire contract: the request is
 * caller-shaped state + typed questions verbatim, and every answer is
 * validated against the question that produced it — a missing, malformed, or
 * out-of-set answer fails the whole call rather than biasing the decision it
 * feeds.
 */
import { describe, expect, it } from "vitest"
import { JEV_MODEL } from "../memory-rerank/jev.js"
import { jevClassifierRequest, parseJevClassifierAnswers } from "./jev.js"
import type { ClassifierQuestion } from "./types.js"

const routingQuestion: ClassifierQuestion = {
  type: "choice",
  instructions: "Which lane should handle this message?",
  criteria: { chat: "Ordinary conversation", job: "A durable job or task", ignore: "No action needed" },
}

const gateQuestion: ClassifierQuestion = {
  type: "noul",
  instructions: { task: "Does this message ask for something durable?" },
  criteria: { true: "The message asks to remember, schedule, or track something.", false: "Everything else." },
}

const scoreQuestion: ClassifierQuestion = {
  type: "score",
  instructions: "How urgent is this message?",
  criteria: ["Not urgent — can wait days", "Soon — today", "Urgent — now"],
}

describe("jevClassifierRequest", () => {
  it("wraps caller-shaped state + questions verbatim under the pinned model", () => {
    const questions = { route: routingQuestion, gate: gateQuestion }
    const req = jevClassifierRequest({ text: "remind me to water the plants" }, questions)
    expect(req.model).toBe(JEV_MODEL)
    expect(req.state).toEqual({ text: "remind me to water the plants" })
    expect(req.questions).toBe(questions)
    expect(JEV_MODEL).toBe("jev-1.13.0")
  })

  it("honors an explicit model override — the swap point as Jev versions land", () => {
    expect(jevClassifierRequest("s", {}, "jev-9.9.9").model).toBe("jev-9.9.9")
  })
})

describe("parseJevClassifierAnswers", () => {
  it("returns typed answers keyed by question id, preserving confidence/probabilities", () => {
    const questions = { route: routingQuestion, gate: gateQuestion, urgency: scoreQuestion }
    const { answers, servedModel } = parseJevClassifierAnswers(
      {
        model: JEV_MODEL,
        answers: {
          route: { type: "choice", choice: "job", confidence: 0.91, probabilities: { job: 0.91, chat: 0.06, ignore: 0.03 } },
          gate: { type: "noul", noul: 0.87 },
          urgency: { type: "score", score: 1, confidence: 0.8, legend: { "1": "Soon — today" }, probabilities: { "1": 0.8 } },
        },
      },
      questions,
    )
    expect(servedModel).toBe(JEV_MODEL)
    expect(answers["route"]).toEqual({ type: "choice", choice: "job", confidence: 0.91, probabilities: { job: 0.91, chat: 0.06, ignore: 0.03 } })
    expect(answers["gate"]).toEqual({ type: "noul", noul: 0.87 })
    expect(answers["urgency"]).toMatchObject({ type: "score", score: 1 })
  })

  it("fails when an answer is missing — a half-answered decision is worse than no decision", () => {
    expect(() =>
      parseJevClassifierAnswers({ answers: { gate: { noul: 0.5 } } }, { route: routingQuestion, gate: gateQuestion }),
    ).toThrow(/missing or malformed choice answer route/)
  })

  it("fails on a noul outside 0..1 and on non-numeric answers", () => {
    for (const noul of [1.2, -0.1, "yes", null]) {
      expect(() => parseJevClassifierAnswers({ answers: { gate: { noul } } }, { gate: gateQuestion })).toThrow(/noul answer gate/)
    }
  })

  it("fails when the choice winner is not a declared option — it would route to a destination that does not exist", () => {
    expect(() =>
      parseJevClassifierAnswers({ answers: { route: { choice: "sleep" } } }, { route: routingQuestion }),
    ).toThrow(/undeclared option "sleep"/)
  })

  it("rejects prototype-chain keys as choice winners — `in` would accept them on any criteria object", () => {
    for (const choice of ["toString", "constructor", "hasOwnProperty", "valueOf"]) {
      expect(() =>
        parseJevClassifierAnswers({ answers: { route: { choice } } }, { route: routingQuestion }),
      ).toThrow(new RegExp(`undeclared option "${choice}"`))
    }
  })

  it("fails on a score index outside the rubric's level range", () => {
    expect(() =>
      parseJevClassifierAnswers({ answers: { urgency: { score: 3 } } }, { urgency: scoreQuestion }),
    ).toThrow(/out of range/)
  })

  it("fails on malformed confidence/probabilities instead of trusting them", () => {
    expect(() =>
      parseJevClassifierAnswers({ answers: { route: { choice: "job", confidence: 2 } } }, { route: routingQuestion }),
    ).toThrow(/confidence/)
    expect(() =>
      parseJevClassifierAnswers({ answers: { route: { choice: "job", probabilities: { job: "high" } } } }, { route: routingQuestion }),
    ).toThrow(/probabilities/)
  })
})
