/**
 * question-sanitize.test.ts — the plain-English survey question.
 *
 * WHY THIS FIELD EXISTS: the survey rendered the belief's `statement` verbatim.
 * Live statements run to a median of 283 characters of third-person technical
 * prose, so the operator could not tell what he was agreeing to and agreed to
 * everything. A rubber-stamped survey is worse than none: the agreement
 * activates the belief and injects it into every system prompt.
 *
 * THE CONTRACT UNDER TEST: `sanitizeQuestion` is TOTAL. Every input returns;
 * nothing throws. A bad question degrades to `undefined` and the survey falls
 * back to `statement` — a cosmetic miss. A THROW here would fail the whole
 * chunk, which is never committed, which re-runs against the same window
 * forever. That is the shape of the outage that killed 30 nights of dreams.
 */
import { describe, expect, it } from "vitest"
import { sanitizeQuestion } from "../src/dream-reasoner.js"

const LONG = "a".repeat(121)

describe("sanitizeQuestion — accepts a real question", () => {
  it("keeps a short second-person question", () => {
    expect(sanitizeQuestion("Do you want PRs opened against master?")).toBe(
      "Do you want PRs opened against master?",
    )
  })
  it("trims surrounding whitespace", () => {
    expect(sanitizeQuestion("  Do you work late?  ")).toBe("Do you work late?")
  })
  it("accepts exactly the 120-character limit", () => {
    const at = "b".repeat(120)
    expect(sanitizeQuestion(at)).toBe(at)
  })
})

describe("sanitizeQuestion — rejects, never throws", () => {
  const rejected: ReadonlyArray<readonly [string, unknown]> = [
    ["undefined", undefined],
    ["null", null],
    ["a number", 42],
    ["an object", { q: "hi" }],
    ["an array", ["hi"]],
    ["empty string", ""],
    ["whitespace only", "   "],
    ["over the char limit", LONG],
    ["a code span", "Do you prefer `bun test` over vitest?"],
    ["a file path", "Is apps/server/src/chat-server.ts yours?"],
    ["call syntax", "Do you use runBoundedQuery() directly?"],
    ["a snake_case identifier", "Is last_dream_at meaningful to you?"],
    ["a thread id", "Did thr_abc belong to you?"],
    ["a namespace separator", "Do you own Luna::Core?"],
    ["braces", "Do you want {ops:[]} back?"],
    ["angle brackets", "Do you prefer <master> as the base?"],
  ]
  for (const [label, input] of rejected) {
    it(`${label} -> undefined (caller falls back to statement)`, () => {
      expect(() => sanitizeQuestion(input)).not.toThrow()
      expect(sanitizeQuestion(input)).toBeUndefined()
    })
  }

  it("is total: no input of any type throws", () => {
    const hostile: ReadonlyArray<unknown> = [
      Symbol("x"), 0, -1, NaN, Infinity, true, false, () => "hi",
      new Date(), /regex/, new Map(), new Set(), BigInt(1),
      Object.create(null), { toString() { throw new Error("boom") } },
    ]
    for (const h of hostile) {
      expect(() => sanitizeQuestion(h)).not.toThrow()
    }
  })

  it("over-limit text is DISCARDED, never truncated", () => {
    // Truncating would misrepresent the belief — the operator would answer a
    // question that stops mid-clause. The long-but-honest statement is better.
    expect(sanitizeQuestion(LONG)).toBeUndefined()
    expect(sanitizeQuestion("Do you " + "really ".repeat(30) + "mean it?")).toBeUndefined()
  })
})
