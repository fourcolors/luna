/**
 * LongMemEval harness unit tests — pure functions only.
 * No network, no Ollama. Live path is run.ts + RESULTS.md.
 */
import { describe, expect, it } from "vitest"
import {
  flattenTurns,
  isAbstentionId,
  seededShuffle,
  selectSubset,
} from "../src/adapters/longmemeval-eval/dataset.js"
import { namespaceFor } from "../src/adapters/longmemeval-eval/ingest.js"
import {
  aggregateByType,
  containsGold,
  isLmeAbstained,
  scoreQA,
} from "../src/adapters/longmemeval-eval/scoring.js"
import type { LmeInstance } from "../src/adapters/longmemeval-eval/types.js"

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

  it("flattenTurns keeps haystack order and stamps session + has_answer", () => {
    const turns = flattenTurns(sample())
    expect(turns).toHaveLength(3)
    expect(turns[0]).toMatchObject({
      questionId: "q-1",
      sessionId: "sess-b",
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

describe("longmemeval-eval scoring", () => {
  it("containsGold: exact and token-containment", () => {
    expect(containsGold("The dog is Buddy", "Buddy")).toBe(true)
    expect(containsGold("buddy the beagle", "Buddy")).toBe(true)
    expect(containsGold("I have a cat", "Buddy")).toBe(false)
  })

  it("non-abstention: F1 + contains-gold against the gold answer", () => {
    const scored = scoreQA(sample(), "Buddy")
    expect(scored.f1).toBe(1)
    expect(scored.containsGold).toBe(1)
    expect(scored.abstention).toBe(false)
  })

  it("abstention IDs score 1 only when the model abstains", () => {
    const inst = sample({ question_id: "q_abs", answer: "there is no such event" })
    expect(scoreQA(inst, "No information available.").containsGold).toBe(1)
    expect(scoreQA(inst, "Buddy").containsGold).toBe(0)
    expect(isLmeAbstained("This is unanswerable from the excerpts.")).toBe(true)
  })

  it("aggregateByType includes OVERALL and per-type means", () => {
    const rows = aggregateByType([
      scoreQA(sample({ question_id: "a", question_type: "multi-session" }), "Buddy"),
      scoreQA(sample({ question_id: "b", question_type: "multi-session" }), "wrong"),
      scoreQA(sample({ question_id: "c", question_type: "knowledge-update" }), "Buddy"),
    ])
    const overall = rows.find((r) => r.questionType === "OVERALL")
    expect(overall?.count).toBe(3)
    expect(rows.find((r) => r.questionType === "multi-session")?.count).toBe(2)
  })
})
