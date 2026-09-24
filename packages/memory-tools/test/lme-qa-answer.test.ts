/**
 * The answer stage must show the model what the setup claims - Luna's
 * production per-turn recall, or the LongMemEval protocol's own format -
 * inside the official reading prompt, and nothing it should not see.
 */
import { describe, expect, it } from "vitest"
import { DEFAULT_RECALL_CONTEXT_OPTIONS } from "../src/turn-memory.js"
import { answerPrompt, history, parseTurn, pyJsonDumps, SETUPS, type DumpQuestion } from "../bench/lme-qa-answer.js"

const setup = (name: string) => SETUPS.find((s) => s.name === name)!

const dumpQuestion = (id: string, turns: ReadonlyArray<[date: string, text: string]>): DumpQuestion => {
  const top = turns.map(([date, text], i) => ({ id: `lme_${id}_s${i}_t0`, text: `[${date}] user: ${text}`, updatedAt: Date.UTC(2023, 4, 1 + i) }))
  return {
    questionId: id,
    questionType: "single-session-user",
    qa: { question: "What is my dog called?", questionDate: "2023/05/30 (Tue) 23:40", answer: "Biscuit" },
    perConfig: { hybrid: { top }, "hybrid:rr=jev@40": { top } },
  }
}

describe("lme-qa-answer", () => {
  it("luna setups pack with the production per-turn recall budget and neutral memory names", () => {
    const q = dumpQuestion("0862e8bf_abs", Array.from({ length: 10 }, (_, i) => ["2023/05/20 (Sat) 02:21", `memory ${i}`] as [string, string]))
    const h = history(q, setup("luna-today"))
    expect(h.startsWith("<memory_context>")).toBe(true)
    expect(h.match(/^- \[/gm)).toHaveLength(DEFAULT_RECALL_CONTEXT_OPTIONS.maxHits)
    expect(h).toContain("- [m1 · 2023-05-01]")
    expect(h).not.toContain("0862e8bf")
    expect(h).not.toContain("_abs")
  })

  it("official setups sort turns by date and use the protocol's session wrapper with Python json.dumps", () => {
    const q = dumpQuestion("q1", [["2023/06/02 (Fri) 10:00", "second"], ["2023/05/20 (Sat) 02:21", "first café"]])
    expect(history(q, setup("official-jev"))).toBe(
      '\n### Session 1:\nSession Date: 2023/05/20 (Sat) 02:21\nSession Content:\n\n{"role": "user", "content": "first caf\\u00e9"}\n' +
        '\n### Session 2:\nSession Date: 2023/06/02 (Fri) 10:00\nSession Content:\n\n{"role": "user", "content": "second"}\n',
    )
  })

  it("pyJsonDumps matches Python's defaults: ', ' / ': ' separators and \\u escapes for non-ASCII", () => {
    expect(pyJsonDumps({ role: "user", content: 'a "b"\nc – é 😀' })).toBe('{"role": "user", "content": "a \\"b\\"\\nc \\u2013 \\u00e9 \\ud83d\\ude00"}')
  })

  it("parseTurn reads ingest's record text and rejects anything else", () => {
    expect(parseTurn("[2023/05/20 (Sat) 02:21] assistant: multi\nline")).toEqual({ date: "2023/05/20 (Sat) 02:21", role: "assistant", content: "multi\nline" })
    expect(() => parseTurn("no date here")).toThrow(/not a LongMemEval turn/)
  })

  it("no setup's prompt contains the question id or the gold answer", () => {
    const q = dumpQuestion("gpt4_abc_abs", [["2023/05/20 (Sat) 02:21", "I adopted a dog."]])
    for (const s of SETUPS) {
      const p = answerPrompt(history(q, s), q.qa!.questionDate, q.qa!.question)
      expect(p).not.toContain("gpt4_abc")
      expect(p).not.toContain("_abs")
      expect(p).not.toContain("Biscuit")
    }
  })

  it("fails loudly when the dump lacks the setup's config", () => {
    const q = { ...dumpQuestion("q1", [["2023/05/20 (Sat) 02:21", "x"]]), perConfig: {} }
    expect(() => history(q, setup("luna-jev"))).toThrow(/LUNA_LME_DUMP_TOP=1/)
  })

  it("wraps the history in the official LongMemEval reading prompt with the question's date", () => {
    expect(answerPrompt("H", "2023/05/30 (Tue) 23:40", "Q?")).toBe(
      "I will give you several history chats between you and a user. Please answer the question based on the relevant chat history.\n\n\nHistory Chats:\n\nH\n\nCurrent Date: 2023/05/30 (Tue) 23:40\nQuestion: Q?\nAnswer:",
    )
  })
})
