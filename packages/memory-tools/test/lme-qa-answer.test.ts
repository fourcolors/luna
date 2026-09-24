/**
 * The answer stage must show the model exactly what Luna's per-turn recall
 * would (packRecallContext with the production budget), inside the official
 * LongMemEval reading prompt.
 */
import { describe, expect, it } from "vitest"
import { DEFAULT_RECALL_CONTEXT_OPTIONS } from "../src/turn-memory.js"
import { answerPrompt, packedHistory, SETUPS } from "../bench/lme-qa-answer.js"

const dumpQuestion = (n: number, chars = 50) => ({
  questionId: "q1",
  questionType: "single-session-user",
  qa: { question: "What is my dog called?", questionDate: "2023/05/30 (Tue) 23:40", answer: "Biscuit" },
  perConfig: {
    hybrid: {
      top: Array.from({ length: n }, (_, i) => ({
        id: `lme_q1_s0_t${i}`,
        text: `[2023/05/20 (Sat) 02:21] user: memory ${i} ${"x".repeat(chars)}`,
        updatedAt: Date.UTC(2023, 4, 20, 2, 21),
      })),
    },
  },
})

describe("lme-qa-answer", () => {
  const today = SETUPS.find((s) => s.name === "luna-today")!

  it("luna-today packs with the production per-turn recall budget", () => {
    expect(today.packing).toBe(DEFAULT_RECALL_CONTEXT_OPTIONS)
    const packed = packedHistory(dumpQuestion(10), today)
    expect(packed.startsWith("<memory_context>")).toBe(true)
    expect(packed.match(/^- \[/gm)).toHaveLength(DEFAULT_RECALL_CONTEXT_OPTIONS.maxHits)
    expect(packed).toContain("[lme_q1_s0_t0 · 2023-05-20]") // the session's date, not the ingest date
  })

  it("the wide setup shows more of each memory than production does", () => {
    const wide = SETUPS.find((s) => s.name === "luna-jev-wide")!
    const q = { ...dumpQuestion(3, 1500), perConfig: { "hybrid:rr=jev@40": dumpQuestion(3, 1500).perConfig.hybrid } }
    expect(packedHistory(q, wide).length).toBeGreaterThan(packedHistory(dumpQuestion(3, 1500), today).length * 2)
  })

  it("fails loudly when the dump lacks the setup's config", () => {
    expect(() => packedHistory(dumpQuestion(3), SETUPS.find((s) => s.name === "luna-jev")!)).toThrow(/LUNA_LME_DUMP_TOP=1/)
  })

  it("wraps the history in the official LongMemEval reading prompt with the question's date", () => {
    expect(answerPrompt("H", "2023/05/30 (Tue) 23:40", "Q?")).toBe(
      "I will give you several history chats between you and a user. Please answer the question based on the relevant chat history.\n\n\nHistory Chats:\n\nH\n\nCurrent Date: 2023/05/30 (Tue) 23:40\nQuestion: Q?\nAnswer:",
    )
  })
})
