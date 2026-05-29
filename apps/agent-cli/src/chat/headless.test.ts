/**
 * headless.test.ts — frame roundtrip + verdict assembly tests for D3 survey
 * (Task 4, TDD).
 *
 * Tests the pure data contract:
 *   1. survey-request frame → emits "survey" event with PendingSurvey payload
 *   2. sendSurveyResponse stamps issuedAt onto every verdict's `at` (D-LOCK-5)
 *   3. dismiss = client-side no-op (nothing sent — Execution Correction #1)
 *   4. buildSurveyVerdicts pure function assembles correct SurveyVerdict[]
 *
 * No terminal, no real WebSocket required.
 */
import { describe, expect, it } from "vitest"
import { LunaHeadlessSession } from "./headless.js"
import { buildSurveyVerdicts, type SurveyAnswers } from "./headless.js"
import type { SurveyRequestFrame } from "@luna/ui-ws"

// A minimal fake LunaWsClient: records sends, lets us push frames directly.
const fakeClient = () => {
  const sent: unknown[] = []
  return {
    sent,
    send: (f: unknown) => {
      sent.push(f)
    },
    nextFrame: () => new Promise<never>(() => {}),
    close: () => Promise.resolve(),
  }
}

const makeSession = (client: ReturnType<typeof fakeClient>): LunaHeadlessSession =>
  new LunaHeadlessSession({
    client: client as never,
    profileName: "test",
    model: "m",
    saveLastThread: () => {},
    clearLastThread: () => {},
  })

describe("survey frame roundtrip (D3 Task 4)", () => {
  it("a survey-request frame emits the 'survey' event with the PendingSurvey payload", () => {
    const client = fakeClient()
    const session = makeSession(client)

    const got: Array<{ issuedAt: number; items: ReadonlyArray<{ kind: string }> }> = []
    session.on("survey", (p) => got.push(p))

    const frame: SurveyRequestFrame = {
      type: "survey-request",
      surveyId: "survey-1000",
      issuedAt: 1000,
      items: [
        { id: "sq-1000", kind: "task_quality", prompt: "How aligned?", ref: "task_quality" },
        { id: "bv-x-1000", kind: "belief_validation", prompt: "You prefer terse", ref: "x", beliefId: "x" },
      ],
    }

    // handleFrame is private; exercise it through the casting pattern used in the plan.
    ;(session as unknown as { handleFrame: (f: unknown) => void }).handleFrame(frame)

    expect(got).toHaveLength(1)
    expect(got[0]?.issuedAt).toBe(1000)
    expect(got[0]?.items).toHaveLength(2)
    expect(got[0]?.items[0]?.kind).toBe("task_quality")
    expect(got[0]?.items[1]?.kind).toBe("belief_validation")
  })

  it("sendSurveyResponse stamps issuedAt onto every verdict's `at` (D-LOCK-5)", () => {
    const client = fakeClient()
    const session = makeSession(client)

    session.sendSurveyResponse("survey-1000", 1000, [
      { itemId: "sq-1000", kind: "task_quality", ref: "task_quality", score: 1, via: "survey" },
      { itemId: "bv-x-1000", kind: "belief_validation", ref: "x", beliefId: "x", verdict: "confirmed", via: "survey" },
    ])

    const frame = client.sent[0] as {
      type: string
      surveyId: string
      issuedAt: number
      verdicts: Array<{ at?: number }>
    }
    expect(frame.type).toBe("survey-response")
    expect(frame.surveyId).toBe("survey-1000")
    expect(frame.issuedAt).toBe(1000)
    // D-LOCK-5: every verdict's at is pinned to issuedAt
    expect(frame.verdicts.every((v) => v.at === 1000)).toBe(true)
  })

  it("dismiss is a client-side no-op — nothing is sent (Execution Correction #1)", () => {
    const client = fakeClient()
    const session = makeSession(client)

    // Calling dismiss should NOT send any frame — the survey re-surfaces on next connection.
    session.dismissSurvey()

    expect(client.sent).toHaveLength(0)
  })
})

describe("buildSurveyVerdicts — pure verdict assembly (D-LOCK-4/5)", () => {
  const TASK_ITEM = { id: "sq-5000", kind: "task_quality" as const, prompt: "How aligned?", ref: "task_quality" }
  const BELIEF_A = { id: "bv-a-5000", kind: "belief_validation" as const, prompt: "You like terse", ref: "beliefA", beliefId: "beliefA" }
  const BELIEF_B = { id: "bv-b-5000", kind: "belief_validation" as const, prompt: "You like details", ref: "beliefB", beliefId: "beliefB" }

  const ISSUED_AT = 5000

  it("task_quality score 4 maps to (4-1)/4 = 0.75 (D-LOCK-4)", () => {
    const answers: SurveyAnswers = {
      likert: 4,
      beliefAnswers: {},
    }
    const verdicts = buildSurveyVerdicts([TASK_ITEM, BELIEF_A], answers, ISSUED_AT)
    const tq = verdicts.find((v) => v.kind === "task_quality")
    expect(tq).toBeDefined()
    expect(tq?.score).toBe(0.75)
    expect(tq?.at).toBe(ISSUED_AT)
    expect(tq?.via).toBe("survey")
    expect(tq?.ref).toBe("task_quality")
  })

  it("task_quality score 1 maps to 0.0, score 5 maps to 1.0 (clean endpoints)", () => {
    const v1 = buildSurveyVerdicts([TASK_ITEM], { likert: 1, beliefAnswers: {} }, ISSUED_AT)
    expect(v1[0]?.score).toBe(0.0)

    const v5 = buildSurveyVerdicts([TASK_ITEM], { likert: 5, beliefAnswers: {} }, ISSUED_AT)
    expect(v5[0]?.score).toBe(1.0)
  })

  it("belief_validation: confirmed/corrected/rejected mapped correctly, at=issuedAt, via='survey'", () => {
    const answers: SurveyAnswers = {
      likert: 3,
      beliefAnswers: {
        beliefA: "confirmed",
        beliefB: "rejected",
      },
    }
    const verdicts = buildSurveyVerdicts([TASK_ITEM, BELIEF_A, BELIEF_B], answers, ISSUED_AT)
    const bvA = verdicts.find((v) => v.beliefId === "beliefA")
    const bvB = verdicts.find((v) => v.beliefId === "beliefB")

    expect(bvA?.kind).toBe("belief_validation")
    expect(bvA?.verdict).toBe("confirmed")
    expect(bvA?.at).toBe(ISSUED_AT)
    expect(bvA?.via).toBe("survey")

    expect(bvB?.verdict).toBe("rejected")
    expect(bvB?.at).toBe(ISSUED_AT)
  })

  it("unanswered belief items are omitted from verdicts", () => {
    const answers: SurveyAnswers = {
      likert: 3,
      beliefAnswers: {}, // no belief answers
    }
    const verdicts = buildSurveyVerdicts([TASK_ITEM, BELIEF_A, BELIEF_B], answers, ISSUED_AT)
    // Only task_quality verdict emitted
    expect(verdicts).toHaveLength(1)
    expect(verdicts[0]?.kind).toBe("task_quality")
  })

  it("null likert: task_quality item is omitted from verdicts (mandatory but not answered)", () => {
    const answers: SurveyAnswers = {
      likert: null,
      beliefAnswers: { beliefA: "confirmed" },
    }
    const verdicts = buildSurveyVerdicts([TASK_ITEM, BELIEF_A], answers, ISSUED_AT)
    const tq = verdicts.find((v) => v.kind === "task_quality")
    expect(tq).toBeUndefined()
    // The belief verdict is still included
    expect(verdicts.find((v) => v.kind === "belief_validation")).toBeDefined()
  })
})
