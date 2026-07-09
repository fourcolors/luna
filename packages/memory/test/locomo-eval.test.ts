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
  buildDateIndexBlock,
  classifyOllamaCloudResponse,
} from "../src/adapters/locomo-eval/answer-model.js"
import { flattenTurns } from "../src/adapters/locomo-eval/dataset.js"
import {
  buildCrosstab,
  buildJudgePrompt,
  parseJudgeVerdict,
  spearmanRankCorrelation,
  type JudgedQA,
} from "../src/adapters/locomo-eval/judge-rescore.js"
import type { LocomoQA, LocomoSample, RetrievalRecord } from "../src/adapters/locomo-eval/types.js"
import {
  buildSessionSummaries,
  decomposeQuestion,
  mergeHits,
  parseRetrievalMode,
  prioritizeBySessions,
  rankSessions,
  sessionNumFromTags,
} from "../src/adapters/locomo-eval/retrieval-modes.js"

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


describe("judge-rescore: parseJudgeVerdict", () => {
  it("parses the exact requested format", () => {
    expect(parseJudgeVerdict("VERDICT: 1")).toEqual({ verdict: 1, parseOk: true })
    expect(parseJudgeVerdict("VERDICT: 0")).toEqual({ verdict: 0, parseOk: true })
  })

  it("parses the requested format even wrapped in extra prose", () => {
    const raw = "Let me think about this.\n\nVERDICT: 1\n\nThe candidate matches the reference."
    expect(parseJudgeVerdict(raw)).toEqual({ verdict: 1, parseOk: true })
  })

  it("falls back to a bare standalone digit when the format isn't followed", () => {
    expect(parseJudgeVerdict("1").verdict).toBe(1)
    expect(parseJudgeVerdict("Answer: 0").verdict).toBe(0)
  })

  it("falls back to correct/incorrect keywords, checking 'incorrect' before the 'correct' substring it contains", () => {
    expect(parseJudgeVerdict("The candidate answer is incorrect.")).toEqual({ verdict: 0, parseOk: true })
    expect(parseJudgeVerdict("This is correct.")).toEqual({ verdict: 1, parseOk: true })
  })

  it("falls back to yes/no keywords", () => {
    expect(parseJudgeVerdict("Yes, these match.").verdict).toBe(1)
    expect(parseJudgeVerdict("No, these are different.").verdict).toBe(0)
  })

  it("flags totally unparseable responses as parseOk: false, defaulting to incorrect", () => {
    const result = parseJudgeVerdict("I cannot determine this.")
    expect(result).toEqual({ verdict: 0, parseOk: false })
  })
})

describe("judge-rescore: buildJudgePrompt", () => {
  it("includes the question, reference answer, and candidate answer", () => {
    const prompt = buildJudgePrompt("When did X happen?", "7 May 2023", "May 7 2023")
    expect(prompt).toContain("QUESTION: When did X happen?")
    expect(prompt).toContain("REFERENCE ANSWER: 7 May 2023")
    expect(prompt).toContain("CANDIDATE ANSWER: May 7 2023")
  })

  it("marks an empty candidate answer explicitly rather than leaving it blank", () => {
    const prompt = buildJudgePrompt("Q?", "gold", "")
    expect(prompt).toContain("CANDIDATE ANSWER: (empty — no answer given)")
  })
})

describe("judge-rescore: spearmanRankCorrelation", () => {
  it("is 1 for identically ranked series", () => {
    expect(spearmanRankCorrelation([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1, 5)
  })

  it("is -1 for perfectly inverted series", () => {
    expect(spearmanRankCorrelation([1, 2, 3, 4], [40, 30, 20, 10])).toBeCloseTo(-1, 5)
  })
})

describe("judge-rescore: buildCrosstab", () => {
  const qa = (question: string, category: 1 | 2 | 3 | 4 | 5, verdict: 0 | 1): JudgedQA => ({
    question,
    category,
    f1Score: verdict,
    judgeVerdict: verdict,
    judgeParseOk: true,
    judgeCallMade: true,
    rawJudgeResponse: `VERDICT: ${verdict}`,
  })
  const retrieval = (question: string, evidenceCount: number, evidenceHit: number): RetrievalRecord => ({
    sampleId: "conv-test",
    question,
    evidenceCount,
    evidenceHit,
  })

  it("buckets evidence-found/missing x correct/incorrect, and counts QA pairs with no retrieval record separately", () => {
    const judged: JudgedQA[] = [
      qa("q1", 2, 1), // evidence found, correct
      qa("q2", 2, 0), // evidence found, incorrect
      qa("q3", 2, 1), // evidence missing (partial), correct
      qa("q4", 2, 0), // evidence missing, incorrect
      qa("q5", 3, 1), // no retrieval record at all
    ]
    const retrievalByQuestion = new Map<string, RetrievalRecord>([
      ["q1", retrieval("q1", 2, 2)],
      ["q2", retrieval("q2", 2, 2)],
      ["q3", retrieval("q3", 2, 1)], // partial coverage counts as "missing"
      ["q4", retrieval("q4", 1, 0)],
      // q5 intentionally absent — no evidence annotated for this QA pair
    ])

    const { overall, byCategory } = buildCrosstab(judged, retrievalByQuestion)

    expect(overall).toEqual({
      evidenceFoundCorrect: 1,
      evidenceFoundIncorrect: 1,
      evidenceMissingCorrect: 1,
      evidenceMissingIncorrect: 1,
      excludedNoEvidenceAnnotated: 1,
    })
    expect(byCategory[2]).toEqual({
      evidenceFoundCorrect: 1,
      evidenceFoundIncorrect: 1,
      evidenceMissingCorrect: 1,
      evidenceMissingIncorrect: 1,
      excludedNoEvidenceAnnotated: 0,
    })
    expect(byCategory[3]).toEqual({
      evidenceFoundCorrect: 0,
      evidenceFoundIncorrect: 0,
      evidenceMissingCorrect: 0,
      evidenceMissingIncorrect: 0,
      excludedNoEvidenceAnnotated: 1,
    })
  })
})

describe("answer-model: buildDateIndexBlock (Task 3 — deterministic temporal index)", () => {
  it("returns null when no date index is provided", () => {
    expect(buildDateIndexBlock(undefined)).toBeNull()
    expect(buildDateIndexBlock([])).toBeNull()
  })

  it("formats session -> date pairs as a single comma-joined line", () => {
    const block = buildDateIndexBlock([
      { sessionNum: 1, date: "8 May 2023" },
      { sessionNum: 3, date: "12 June 2023" },
    ])
    expect(block).toBe("session 1 = 8 May 2023, session 3 = 12 June 2023")
  })
})

describe("retrieval-modes: parseRetrievalMode", () => {
  it("defaults to flat for unset/unknown values", () => {
    expect(parseRetrievalMode(undefined)).toBe("flat")
    expect(parseRetrievalMode("")).toBe("flat")
    expect(parseRetrievalMode("bogus")).toBe("flat")
  })

  it("recognizes decompose and hierarchical, case-insensitively", () => {
    expect(parseRetrievalMode("decompose")).toBe("decompose")
    expect(parseRetrievalMode("HIERARCHICAL")).toBe("hierarchical")
  })
})

describe("retrieval-modes: decomposeQuestion", () => {
  it("splits a literally-conjunctive multi-hop question into sub-questions", () => {
    const parts = decomposeQuestion("What does Joanna like, and what does Nate like?")
    expect(parts.length).toBe(2)
    expect(parts[0]).toMatch(/Joanna/)
    expect(parts[1]).toMatch(/Nate/)
  })

  it("returns the question unchanged when there is nothing meaningful to split", () => {
    expect(decomposeQuestion("What has Melanie painted?")).toEqual(["What has Melanie painted?"])
  })

  it("does not split off trivial short fragments (fewer than 3 words)", () => {
    // "her family" is 2 words -- not a standalone sub-question.
    expect(decomposeQuestion("What did Melanie do with her family?")).toEqual([
      "What did Melanie do with her family?",
    ])
  })
})

describe("retrieval-modes: mergeHits", () => {
  it("dedupes by recordId keeping the max score, then sorts desc and truncates to topK", () => {
    const listA = [
      { recordId: "a", score: 0.5 },
      { recordId: "b", score: 0.9 },
    ]
    const listB = [
      { recordId: "a", score: 0.8 }, // higher score for "a" than listA
      { recordId: "c", score: 0.3 },
    ]
    const merged = mergeHits([listA, listB], 2)
    expect(merged).toEqual([
      { recordId: "b", score: 0.9 },
      { recordId: "a", score: 0.8 },
    ])
  })

  it("returns an empty array for empty input", () => {
    expect(mergeHits([], 10)).toEqual([])
  })
})

describe("retrieval-modes: buildSessionSummaries + rankSessions", () => {
  const turns = [
    { sampleId: "s", sessionNum: 1, sessionDateTime: "1 May 2023", speaker: "A", diaId: "D1:1", text: "I love hiking in the mountains every weekend." },
    { sampleId: "s", sessionNum: 1, sessionDateTime: "1 May 2023", speaker: "B", diaId: "D1:2", text: "That sounds fun, I prefer painting landscapes." },
    { sampleId: "s", sessionNum: 2, sessionDateTime: "10 June 2023", speaker: "A", diaId: "D2:1", text: "I adopted a turtle named Tilly last week." },
  ]

  it("buildSessionSummaries: one summary per session, in session-number order, carrying the date", () => {
    const summaries = buildSessionSummaries(turns)
    expect(summaries.map((s) => s.sessionNum)).toEqual([1, 2])
    expect(summaries[0]?.date).toBe("1 May 2023")
    expect(summaries[0]?.summary).toContain("hiking")
    expect(summaries[1]?.summary).toContain("turtle")
  })

  it("rankSessions: ranks the session whose summary shares more question vocabulary higher", () => {
    const summaries = buildSessionSummaries(turns)
    const ranked = rankSessions("What turtle does the person have?", summaries, 1)
    expect(ranked).toEqual([2])
  })

  it("rankSessions: returns an empty array when the question has no scorable content words", () => {
    const summaries = buildSessionSummaries(turns)
    expect(rankSessions("what is it", summaries, 3)).toEqual([])
  })
})

describe("retrieval-modes: sessionNumFromTags + prioritizeBySessions", () => {
  it("sessionNumFromTags: extracts the session:<N> tag, or null if absent", () => {
    expect(sessionNumFromTags(["conv-26", "session:3", "Melanie"])).toBe(3)
    expect(sessionNumFromTags(["conv-26", "Melanie"])).toBeNull()
  })

  it("prioritizeBySessions: reorders priority-session hits first, then fills remaining slots", () => {
    const hits = [
      { id: "a", sessionNum: 1 },
      { id: "b", sessionNum: 5 },
      { id: "c", sessionNum: 2 },
      { id: "d", sessionNum: 5 },
    ]
    const result = prioritizeBySessions(hits, new Set([5]), 3)
    expect(result.map((h) => h.id)).toEqual(["b", "d", "a"])
  })
})
