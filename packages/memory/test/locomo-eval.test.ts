/**
 * LoCoMo harness unit tests — pure functions only (scoring + turn
 * flattening). No network, no Ollama, no Anthropic calls: those paths are
 * covered by the `--dry-run` smoke test documented in
 * `src/adapters/locomo-eval/README.md`, which needs live services and is
 * intentionally NOT part of the hermetic test suite.
 */
import { describe, expect, it } from "vitest"
import { aggregateByCategory, f1Score, scoreQA } from "../src/adapters/locomo-eval/scoring.js"
import {
  backoffDelayMs,
  classifyOllamaCloudResponse,
} from "../src/adapters/locomo-eval/answer-model.js"
import { flattenTurns } from "../src/adapters/locomo-eval/dataset.js"
import type { LocomoQA, LocomoSample } from "../src/adapters/locomo-eval/types.js"

describe("locomo-eval scoring", () => {
  it("f1Score: identical strings score 1", () => {
    expect(f1Score("7 May 2023", "7 May 2023")).toBe(1)
  })

  it("f1Score: disjoint strings score 0", () => {
    expect(f1Score("banana", "spreadsheet")).toBe(0)
  })

  it("f1Score: partial token overlap scores between 0 and 1", () => {
    const score = f1Score("mental health awareness", "mental health")
    expect(score).toBeGreaterThan(0)
    expect(score).toBeLessThan(1)
  })

  it("category 2/4: plain F1 against the answer", () => {
    const qa: LocomoQA = {
      question: "What did the charity race raise awareness for?",
      answer: "mental health",
      category: 4,
    }
    const scored = scoreQA(qa, "mental health")
    expect(scored.score).toBe(1)
  })

  it("category 3: ground truth truncated at first semicolon before scoring", () => {
    const qa: LocomoQA = {
      question: "When did it happen?",
      answer: "7 May 2023; before the support group",
      category: 3,
    }
    const scored = scoreQA(qa, "7 May 2023")
    expect(scored.groundTruth).toBe("7 May 2023")
    expect(scored.score).toBe(1)
  })

  it("category 1: multi-answer comma-split, max-then-average", () => {
    const qa: LocomoQA = {
      question: "What fields would Caroline pursue?",
      answer: "Psychology, counseling certification",
      category: 1,
    }
    const scored = scoreQA(qa, "Psychology, counseling certification")
    expect(scored.score).toBeCloseTo(1, 5)
  })

  it("category 5 (adversarial): abstaining scores 1", () => {
    const qa: LocomoQA = {
      question: "What did Caroline realize after her charity race?",
      category: 5,
      adversarial_answer: "self-care is important",
    }
    expect(scoreQA(qa, "No information available.").score).toBe(1)
    expect(scoreQA(qa, "Not mentioned in the notes.").score).toBe(1)
  })

  it("category 5 (adversarial): producing the distractor scores 0", () => {
    const qa: LocomoQA = {
      question: "What did Caroline realize after her charity race?",
      category: 5,
      adversarial_answer: "self-care is important",
    }
    expect(scoreQA(qa, "That self-care is important.").score).toBe(0)
  })

  it("aggregateByCategory: computes per-category and OVERALL means", () => {
    const scored = [
      scoreQA({ question: "q1", answer: "a", category: 2 }, "a"),
      scoreQA({ question: "q2", answer: "b", category: 2 }, "wrong"),
      scoreQA({ question: "q3", category: 5, adversarial_answer: "x" }, "No information available."),
    ]
    const agg = aggregateByCategory(scored)
    const overall = agg.find((r) => r.category === "OVERALL")
    const cat2 = agg.find((r) => r.category === 2)
    const cat5 = agg.find((r) => r.category === 5)
    expect(overall?.count).toBe(3)
    expect(cat2?.count).toBe(2)
    expect(cat2?.meanScore).toBeCloseTo(0.5, 5)
    expect(cat5?.meanScore).toBe(1)
  })
})

describe("locomo-eval answer-model: ollama-cloud failure classification", () => {
  it("401/403 -> hard-stop (auth), regardless of attempt count", () => {
    const a = classifyOllamaCloudResponse({ status: 401, body: "unauthorized", attempt: 1, maxAttempts: 4 })
    const b = classifyOllamaCloudResponse({ status: 403, body: "forbidden", attempt: 1, maxAttempts: 4 })
    expect(a).toEqual({ kind: "hard-stop", reason: "auth" })
    expect(b).toEqual({ kind: "hard-stop", reason: "auth" })
  })

  it("402, or a quota/billing-signal body, -> hard-stop (quota) even on a 200-adjacent status", () => {
    const a = classifyOllamaCloudResponse({ status: 402, body: "", attempt: 1, maxAttempts: 4 })
    const b = classifyOllamaCloudResponse({
      status: 429,
      body: '{"error":"insufficient_quota: spend cap reached"}',
      attempt: 1,
      maxAttempts: 4,
    })
    expect(a).toEqual({ kind: "hard-stop", reason: "quota" })
    expect(b).toEqual({ kind: "hard-stop", reason: "quota" })
  })

  it("429 retries with backoff until maxAttempts, then hard-stops (rate_limit)", () => {
    const early = classifyOllamaCloudResponse({ status: 429, body: "slow down", attempt: 1, maxAttempts: 4 })
    expect(early.kind).toBe("retry")
    if (early.kind === "retry") expect(early.delayMs).toBeGreaterThan(0)

    const last = classifyOllamaCloudResponse({ status: 429, body: "slow down", attempt: 4, maxAttempts: 4 })
    expect(last).toEqual({ kind: "hard-stop", reason: "rate_limit" })
  })

  it("5xx retries with backoff until maxAttempts, then hard-stops (server)", () => {
    const early = classifyOllamaCloudResponse({ status: 503, body: "unavailable", attempt: 2, maxAttempts: 4 })
    expect(early.kind).toBe("retry")

    const last = classifyOllamaCloudResponse({ status: 500, body: "internal error", attempt: 4, maxAttempts: 4 })
    expect(last).toEqual({ kind: "hard-stop", reason: "server" })
  })

  it("other 4xx (e.g. a malformed request) is a plain, non-systemic failure", () => {
    const result = classifyOllamaCloudResponse({ status: 400, body: "bad request", attempt: 1, maxAttempts: 4 })
    expect(result).toEqual({ kind: "fail" })
  })

  it("backoffDelayMs grows exponentially and is capped", () => {
    expect(backoffDelayMs(1)).toBe(400)
    expect(backoffDelayMs(2)).toBe(800)
    expect(backoffDelayMs(3)).toBe(1600)
    expect(backoffDelayMs(10)).toBe(4000)
  })
})

describe("locomo-eval dataset flattening", () => {
  it("flattenTurns: orders sessions numerically and attaches date/sample metadata", () => {
    const sample: LocomoSample = {
      sample_id: "conv-test",
      qa: [],
      conversation: {
        speaker_a: "Caroline",
        speaker_b: "Melanie",
        session_2_date_time: "10 May 2023",
        session_2: [{ speaker: "Melanie", dia_id: "D2:1", text: "second session" }],
        session_1_date_time: "8 May 2023",
        session_1: [
          { speaker: "Caroline", dia_id: "D1:1", text: "first turn" },
          { speaker: "Melanie", dia_id: "D1:2", text: "second turn" },
        ],
      },
    }
    const turns = flattenTurns(sample)
    expect(turns).toHaveLength(3)
    expect(turns[0]).toMatchObject({
      sampleId: "conv-test",
      sessionNum: 1,
      sessionDateTime: "8 May 2023",
      diaId: "D1:1",
    })
    expect(turns[2]).toMatchObject({ sessionNum: 2, diaId: "D2:1" })
  })

  it("flattenTurns: folds blip_caption into the ingested text for multimodal turns", () => {
    const sample: LocomoSample = {
      sample_id: "conv-test",
      qa: [],
      conversation: {
        speaker_a: "Caroline",
        speaker_b: "Melanie",
        session_1_date_time: "8 May 2023",
        session_1: [
          {
            speaker: "Caroline",
            dia_id: "D1:1",
            text: "look at this",
            blip_caption: "a photo of a mural",
          },
        ],
      },
    }
    const [turn] = flattenTurns(sample)
    expect(turn?.text).toContain("look at this")
    expect(turn?.text).toContain("a photo of a mural")
  })
})
