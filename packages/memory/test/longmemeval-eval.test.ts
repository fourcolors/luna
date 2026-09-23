/**
 * LongMemEval harness unit tests - pure functions plus a fake router.
 * No network, no Ollama. Live path is run.ts + RESULTS.md.
 */
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import type { MemoryRecord, MemoryRouter } from "@luna/memory"
import { probAnyDrawn, randomRetrievalBaseline, signTestP } from "../src/adapters/longmemeval-eval/baselines.js"
import {
  flattenTurns,
  isAbstentionId,
  seededShuffle,
  selectSubset,
  SPLIT_URLS,
} from "../src/adapters/longmemeval-eval/dataset.js"
import { ingestInstance, namespaceFor } from "../src/adapters/longmemeval-eval/ingest.js"
import { resolveOllamaBaseUrl } from "../src/adapters/eval-common/ollama.js"
import {
  ALWAYS_ABSTAIN_PREDICTION,
  aggregateByType,
  containsGold,
  isLmeAbstained,
  scoreQA,
} from "../src/adapters/longmemeval-eval/scoring.js"
import type { LmeInstance } from "../src/adapters/longmemeval-eval/types.js"

// Regenerate ONLY on a deliberate selection change; it invalidates RESULTS.md.
const PINNED_SEED42_PICK = ["q31", "q07", "q22", "q35", "q01"]

function sample(over: Partial<LmeInstance> = {}): LmeInstance {
  return {
    question_id: "q-1",
    question_type: "single-session-user",
    question: "What is my dog's name?",
    answer: "Buddy",
    question_date: "2023/05/08",
    haystack_session_ids: ["sess-b", "sess-a"],
    haystack_dates: ["2023/05/01", "2023/04/01"],
    haystack_sessions: [
      [
        { role: "user", content: "I got a dog named Buddy", has_answer: true },
        { role: "assistant", content: "Nice!" },
      ],
      [{ role: "user", content: "filler" }],
    ],
    answer_session_ids: ["sess-b"],
    ...over,
  }
}

describe("longmemeval-eval dataset helpers", () => {
  it("isAbstentionId matches official `_abs` substring rule", () => {
    expect(isAbstentionId("foo_abs")).toBe(true)
    expect(isAbstentionId("abs_foo")).toBe(false)
    expect(isAbstentionId("q-1")).toBe(false)
  })

  it("selectSubset with seed=null is first-N in file order", () => {
    const ds = [sample({ question_id: "a" }), sample({ question_id: "b" }), sample({ question_id: "c" })]
    expect(selectSubset(ds, 2, null).map((q) => q.question_id)).toEqual(["a", "b"])
    expect(selectSubset(ds, 0, null)).toEqual([])
  })

  it("seededShuffle is deterministic and changes order", () => {
    const ids = ["a", "b", "c", "d", "e", "f", "g", "h"]
    expect(seededShuffle(ids, 42)).toEqual(seededShuffle(ids, 42))
    expect(seededShuffle(ids, 42)).not.toEqual(ids)
    expect(seededShuffle(ids, 1)).not.toEqual(seededShuffle(ids, 42))
  })

  it("selectSubset picks the same ids whatever the file order (splits list questions differently)", () => {
    const ds = "abcdefghijklmnop".split("").map((id) => sample({ question_id: id }))
    const reversed = ds.slice().reverse()
    const pick = (d: ReadonlyArray<LmeInstance>) => selectSubset(d, 5, 42).map((q) => q.question_id)
    expect(pick(reversed)).toEqual(pick(ds))
  })

  it("SPLIT_URLS point at the loadable official cleaned files", () => {
    expect(SPLIT_URLS.oracle).toMatch(/\/longmemeval_oracle\.json$/)
    expect(SPLIT_URLS.s).toMatch(/\/longmemeval_s_cleaned\.json$/)
    // M is 2.7GB: past the JS max string length, so it is not offered.
    expect(Object.keys(SPLIT_URLS)).toEqual(["oracle", "s"])
  })

  it("selectSubset seed 42 is pinned (committed results depend on it)", () => {
    const ds = Array.from({ length: 40 }, (_, i) => sample({ question_id: `q${String(i).padStart(2, "0")}` }))
    expect(selectSubset(ds, 5, 42).map((q) => q.question_id)).toEqual(PINNED_SEED42_PICK)
  })

  it("flattenTurns keeps haystack order and stamps session + has_answer", () => {
    const turns = flattenTurns(sample())
    expect(turns).toHaveLength(3)
    expect(turns[0]).toMatchObject({
      questionId: "q-1",
      sessionId: "sess-b",
      sessionIdx: 0,
      sessionDate: "2023/05/01",
      role: "user",
      text: "I got a dog named Buddy",
      hasAnswer: true,
      turnIdx: 0,
    })
    expect(turns[2]).toMatchObject({ sessionId: "sess-a", text: "filler", hasAnswer: false })
  })

  it("namespaceFor scopes each question independently", () => {
    expect(namespaceFor("q-1")).toBe("longmemeval-eval:q-1")
  })
})

describe("longmemeval-eval ingest", () => {
  function fakeRouter(fail = false) {
    const puts: MemoryRecord[] = []
    const router = {
      put: (rec: MemoryRecord) =>
        fail ? Effect.fail(new Error("disk full")) : Effect.sync(() => void puts.push(rec)),
    } as unknown as MemoryRouter
    return { router, puts }
  }

  it("never tags gold labels: tags are embedded into the vector input", async () => {
    // LongMemEval names evidence sessions `answer_*`, so the session id is a label too.
    const inst = sample({ haystack_session_ids: ["answer_x_1", "noans_y_2"], answer_session_ids: ["answer_x_1"] })
    const { router, puts } = fakeRouter()
    const n = await Effect.runPromise(ingestInstance(router, flattenTurns(inst)))
    expect(n).toBe(3)
    for (const rec of puts) {
      expect(rec.tags).toEqual([expect.stringMatching(/^(user|assistant)$/)])
      expect(rec.id).not.toMatch(/answer|noans/)
      expect(JSON.stringify(rec.content)).not.toMatch(/answer_x_1|noans_y_2/)
    }
    expect(puts.map((r) => r.id)).toEqual(["lme_q-1_s0_t0", "lme_q-1_s0_t1", "lme_q-1_s1_t0"])
  })

  it("fails the ingest when a put fails instead of scoring a partial haystack", async () => {
    const { router } = fakeRouter(true)
    await expect(Effect.runPromise(ingestInstance(router, flattenTurns(sample())))).rejects.toThrow()
  })
})

describe("longmemeval-eval baselines", () => {
  it("signTestP: exact two-sided sign test (ties excluded)", () => {
    expect(signTestP(13, 2)).toBeCloseTo(0.00739, 4)
    expect(signTestP(8, 2)).toBeCloseTo(0.1094, 4)
    expect(signTestP(2, 8)).toBeCloseTo(signTestP(8, 2), 12)
    expect(signTestP(5, 5)).toBe(1)
    expect(signTestP(0, 0)).toBe(1)
  })

  it("probAnyDrawn matches the closed form and its edge cases", () => {
    // 1 - C(8,2)/C(10,2) = 1 - 28/45
    expect(probAnyDrawn(10, 2, 2)).toBeCloseTo(1 - 28 / 45, 10)
    expect(probAnyDrawn(10, 1, 10)).toBe(1)
    expect(probAnyDrawn(5, 2, 10)).toBe(1)
    expect(probAnyDrawn(10, 0, 3)).toBe(0)
  })

  it("random retrieval is total recall when topK covers the haystack", () => {
    const turns = flattenTurns(sample())
    const b = randomRetrievalBaseline(turns, ["sess-b"], 10)
    expect(b.evidenceHit).toBe(1)
    expect(b.answerSessionHit).toBe(1)
  })

  it("random retrieval scales with topK / haystack size", () => {
    const turns = flattenTurns(sample())
    const b = randomRetrievalBaseline(turns, ["sess-a"], 1)
    expect(b.evidenceHit).toBeCloseTo(1 / 3, 10)
    expect(b.answerSessionHit).toBeCloseTo(1 / 3, 10)
  })
})

describe("longmemeval-eval ollama base url", () => {
  it("prefers LUNA_OLLAMA_BASE_URL, then OLLAMA_HOST, then loopback", () => {
    expect(resolveOllamaBaseUrl({})).toBe("http://127.0.0.1:11434")
    expect(resolveOllamaBaseUrl({ LUNA_OLLAMA_BASE_URL: "http://box:9999/", OLLAMA_HOST: "x" })).toBe(
      "http://box:9999",
    )
  })

  it("applies Ollama's OLLAMA_HOST rules (bare host, default port, bind-all)", () => {
    expect(resolveOllamaBaseUrl({ OLLAMA_HOST: "0.0.0.0" })).toBe("http://127.0.0.1:11434")
    expect(resolveOllamaBaseUrl({ OLLAMA_HOST: "0.0.0.0:8080" })).toBe("http://127.0.0.1:8080")
    expect(resolveOllamaBaseUrl({ OLLAMA_HOST: "gpu-box" })).toBe("http://gpu-box:11434")
    expect(resolveOllamaBaseUrl({ OLLAMA_HOST: "https://ollama.example.com" })).toBe(
      "https://ollama.example.com",
    )
  })

  it("handles quoting, IPv6, empty values, and garbage", () => {
    expect(resolveOllamaBaseUrl({ OLLAMA_HOST: "'127.0.0.1:11434'" })).toBe("http://127.0.0.1:11434")
    expect(resolveOllamaBaseUrl({ OLLAMA_HOST: "::1" })).toBe("http://[::1]:11434")
    expect(resolveOllamaBaseUrl({ OLLAMA_HOST: "[::]:9000" })).toBe("http://127.0.0.1:9000")
    expect(resolveOllamaBaseUrl({ LUNA_OLLAMA_BASE_URL: "", OLLAMA_HOST: "gpu-box" })).toBe(
      "http://gpu-box:11434",
    )
    expect(() => resolveOllamaBaseUrl({ OLLAMA_HOST: "host:99999" })).toThrow(/cannot build/)
  })
})

describe("longmemeval-eval scoring", () => {
  it("containsGold: whole-word phrase match", () => {
    expect(containsGold("The dog is Buddy", "Buddy")).toBe(true)
    expect(containsGold("buddy the beagle", "Buddy")).toBe(true)
    expect(containsGold("I have a cat", "Buddy")).toBe(false)
    expect(containsGold("It took about 5.5 weeks.", "5.5 weeks")).toBe(true)
  })

  it("containsGold: no substring or token-bag false positives", () => {
    expect(containsGold("12 hours", "2 hours")).toBe(false)
    expect(containsGold("19 months", "9 months")).toBe(false)
    expect(containsGold("13 pieces", "3")).toBe(false)
    expect(containsGold("in 2023", "3")).toBe(false)
    expect(containsGold("Tomorrow", "Tom")).toBe(false)
    expect(containsGold("5 weeks and 5 days", "5.5 weeks")).toBe(false)
  })

  it("non-abstention: F1 + contains-gold against the gold answer", () => {
    const scored = scoreQA(sample(), "Buddy")
    expect(scored.f1).toBe(1)
    expect(scored.containsGold).toBe(1)
    expect(scored.abstention).toBe(false)
  })

  it("integer gold answers score like strings", () => {
    const scored = scoreQA(sample({ answer: 3 }), "You have 3 pieces.")
    expect(scored.groundTruth).toBe("3")
    expect(scored.containsGold).toBe(1)
  })

  it("escaped punctuation and backslashes never break a match", () => {
    expect(scoreQA(sample({ answer: "50%" }), "About 50\\%.").containsGold).toBe(1)
    expect(scoreQA(sample({ answer: "Sarah's dog" }), "Sarah\\'s dog").containsGold).toBe(1)
    expect(containsGold("path a\\b", "a b")).toBe(true)
  })

  it("markdown-escaped predictions score like plain ones", () => {
    const inst = sample({ answer: "@jessica_poole_jewellery" })
    const scored = scoreQA(inst, "@jessica\\_poole\\_jewellery")
    expect(scored.prediction).toBe("@jessica\\_poole\\_jewellery")
    expect(scored.f1).toBe(1)
    expect(scored.containsGold).toBe(1)
  })

  it("preference questions are n/a: gold is a rubric, not an answer", () => {
    const scored = scoreQA(
      sample({ question_type: "single-session-preference", answer: "The user would prefer..." }),
      "Try yoga.",
    )
    expect(scored.f1).toBeNull()
    expect(scored.containsGold).toBeNull()
  })

  it("abstention IDs score 1 only when the model abstains", () => {
    const inst = sample({ question_id: "q_abs", answer: "there is no such event" })
    expect(scoreQA(inst, ALWAYS_ABSTAIN_PREDICTION).containsGold).toBe(1)
    expect(scoreQA(inst, "Buddy").containsGold).toBe(0)
    expect(isLmeAbstained("This is unanswerable from the excerpts.")).toBe(true)
    expect(isLmeAbstained("I don\u2019t know.")).toBe(true)
  })

  it("aggregateByType keeps abstention out of per-type and ANSWERABLE rows", () => {
    const rows = aggregateByType([
      scoreQA(sample({ question_id: "a", question_type: "multi-session" }), "Buddy"),
      scoreQA(sample({ question_id: "b", question_type: "multi-session" }), "wrong"),
      scoreQA(sample({ question_id: "c_abs", question_type: "multi-session" }), ALWAYS_ABSTAIN_PREDICTION),
      scoreQA(sample({ question_id: "d", question_type: "single-session-preference" }), "x"),
    ])
    expect(rows.map((r) => r.questionType)).toEqual([
      "multi-session",
      "single-session-preference",
      "abstention",
      "ANSWERABLE",
    ])
    expect(rows.find((r) => r.questionType === "multi-session")).toMatchObject({ count: 2, meanF1: 0.5 })
    expect(rows.find((r) => r.questionType === "single-session-preference")).toMatchObject({
      count: 1,
      scoredCount: 0,
      meanF1: null,
    })
    expect(rows.find((r) => r.questionType === "abstention")).toMatchObject({ count: 1, meanContainsGold: 1 })
    expect(rows.find((r) => r.questionType === "ANSWERABLE")).toMatchObject({ count: 3, scoredCount: 2, meanF1: 0.5 })
  })

  it("an always-abstain reader earns nothing on answerable questions", () => {
    const rows = aggregateByType([
      scoreQA(sample({ question_id: "a" }), ALWAYS_ABSTAIN_PREDICTION),
      scoreQA(sample({ question_id: "b_abs" }), ALWAYS_ABSTAIN_PREDICTION),
    ])
    expect(rows.find((r) => r.questionType === "ANSWERABLE")?.meanContainsGold).toBe(0)
    expect(rows.find((r) => r.questionType === "abstention")?.meanContainsGold).toBe(1)
  })
})
