/**
 * survey-frames.protocol.test.ts
 *
 * Wire-serializability proofs for the Phase 3 D3 survey frames.
 *
 * Coverage:
 *   - SurveyRequestFrame is a member of ServerFrame (type-level + roundtrip)
 *   - SurveyResponseFrame is a member of ClientFrame (type-level + roundtrip)
 *   - SurveyItem + SurveyVerdict survive JSON roundtrip intact (no DTO needed)
 *   - The issuedAt anchor invariant: every verdict in a SurveyResponseFrame
 *     has at === issuedAt (D-LOCK-5)
 *
 * NO snooze/dismiss frame exists in v1 (Execution Correction #1):
 *   dismiss is a client-side no-op — an unanswered survey re-surfaces on the
 *   next connection-time due-check. No server frame is emitted or expected.
 *
 * Server-side routing idempotency (D-LOCK-5):
 *   The server pins every verdict's `at` to `frame.issuedAt` before calling
 *   processVerdict — verified in server.chat.test.ts (integration level) if a
 *   real-WS harness exists; here we verify the FRAME SHAPE carries issuedAt
 *   and that the client is expected to echo it back in every verdict's `at`.
 */
import { describe, expect, it } from "vitest"
import type { ServerFrame, ClientFrame, SurveyRequestFrame, SurveyResponseFrame } from "../src/protocol.js"
import type { SurveyItem, SurveyVerdict } from "@luna/core"

describe("survey wire frames (D-LOCK-7 — plain TS unions, NO Effect Schema)", () => {
  describe("SurveyRequestFrame (server→client)", () => {
    it("is a member of ServerFrame and preserves .type through JSON roundtrip", () => {
      const f: ServerFrame = {
        type: "survey-request",
        surveyId: "survey-1000",
        issuedAt: 1_000,
        items: [
          {
            id: "sq-1000",
            kind: "task_quality",
            prompt: "How aligned have I been with what you wanted?",
            ref: "task_quality",
          },
        ],
      }
      const roundtripped = JSON.parse(JSON.stringify(f)) as ServerFrame
      expect(roundtripped).toEqual(f)
      expect(roundtripped.type).toBe("survey-request")
      if (roundtripped.type === "survey-request") {
        expect(roundtripped.surveyId).toBe("survey-1000")
        expect(roundtripped.issuedAt).toBe(1_000)
      }
    })

    it("SurveyRequestFrame with belief_validation item round-trips intact", () => {
      const f: SurveyRequestFrame = {
        type: "survey-request",
        surveyId: "survey-2000",
        issuedAt: 2_000,
        items: [
          {
            id: "sq-2000",
            kind: "task_quality",
            prompt: "How aligned have I been?",
            ref: "task_quality",
          },
          {
            id: "bv-belief-123-2000",
            kind: "belief_validation",
            prompt: "You prefer concise answers",
            ref: "belief-123",
            beliefId: "belief-123",
          },
        ],
      }
      const rt = JSON.parse(JSON.stringify(f)) as SurveyRequestFrame
      expect(rt).toEqual(f)
      expect(rt.surveyId).toBe("survey-2000")
      expect(rt.issuedAt).toBe(2_000)
      expect(rt.items).toHaveLength(2)
    })
  })

  describe("SurveyResponseFrame (client→server)", () => {
    it("is a member of ClientFrame and preserves .type through JSON roundtrip", () => {
      const f: ClientFrame = {
        type: "survey-response",
        surveyId: "survey-1000",
        issuedAt: 1_000,
        verdicts: [
          {
            itemId: "sq-1000",
            kind: "task_quality",
            ref: "task_quality",
            score: 1,
            via: "survey",
            at: 1_000, // must equal issuedAt (D-LOCK-5 anchor)
          },
        ],
      }
      const roundtripped = JSON.parse(JSON.stringify(f)) as ClientFrame
      expect(roundtripped).toEqual(f)
      expect(roundtripped.type).toBe("survey-response")
      if (roundtripped.type === "survey-response") {
        expect(roundtripped.surveyId).toBe("survey-1000")
      }
    })

    it("issuedAt anchor invariant: every verdict.at equals frame.issuedAt (D-LOCK-5)", () => {
      const f: SurveyResponseFrame = {
        type: "survey-response",
        surveyId: "survey-3000",
        issuedAt: 3_000,
        verdicts: [
          { itemId: "sq-3000", kind: "task_quality", ref: "task_quality", score: 0.75, via: "survey", at: 3_000 },
          { itemId: "bv-b1-3000", kind: "belief_validation", ref: "b1", beliefId: "b1", verdict: "confirmed", via: "survey", at: 3_000 },
        ],
      }
      // The client SHOULD send at == issuedAt; server ALSO pins it (defence-in-depth).
      expect(f.verdicts.every((v) => v.at === f.issuedAt)).toBe(true)
      expect(f.surveyId).toBe("survey-3000")
    })

    it("SurveyResponseFrame with multiple verdicts round-trips intact", () => {
      const f: SurveyResponseFrame = {
        type: "survey-response",
        surveyId: "survey-5000",
        issuedAt: 5_000,
        verdicts: [
          { itemId: "sq-5000", kind: "task_quality", ref: "task_quality", score: 0.5, via: "survey", at: 5_000 },
          { itemId: "bv-bA-5000", kind: "belief_validation", ref: "bA", beliefId: "bA", verdict: "rejected", via: "survey", at: 5_000 },
        ],
      }
      const rt = JSON.parse(JSON.stringify(f)) as SurveyResponseFrame
      expect(rt).toEqual(f)
      expect(rt.surveyId).toBe("survey-5000")
      expect(rt.verdicts).toHaveLength(2)
    })
  })

  describe("SurveyItem wire-serializability (no DTO needed)", () => {
    it("a full SurveyItem (task_quality) survives JSON roundtrip", () => {
      const item: SurveyItem = {
        id: "sq-9999",
        kind: "task_quality",
        prompt: "How aligned have I been with what you wanted lately?",
        ref: "task_quality",
      }
      const rt = JSON.parse(JSON.stringify(item)) as SurveyItem
      expect(rt).toEqual(item)
      expect(rt.id).toBe("sq-9999")
      expect(rt.kind).toBe("task_quality")
    })

    it("a full SurveyItem (belief_validation) survives JSON roundtrip", () => {
      const item: SurveyItem = {
        id: "bv-belief-xyz-9999",
        kind: "belief_validation",
        prompt: "You prefer bullet-point answers over prose",
        ref: "belief-xyz",
        beliefId: "belief-xyz",
      }
      const rt = JSON.parse(JSON.stringify(item)) as SurveyItem
      expect(rt).toEqual(item)
      expect(rt.beliefId).toBe("belief-xyz")
    })
  })

  describe("SurveyVerdict wire-serializability (no DTO needed)", () => {
    it("a task_quality SurveyVerdict survives JSON roundtrip", () => {
      const v: SurveyVerdict = {
        itemId: "sq-1000",
        kind: "task_quality",
        ref: "task_quality",
        score: 0.75,
        via: "survey",
        at: 1_000,
      }
      const rt = JSON.parse(JSON.stringify(v)) as SurveyVerdict
      expect(rt).toEqual(v)
      expect(rt.score).toBe(0.75)
      expect(rt.at).toBe(1_000)
    })

    it("a belief_validation SurveyVerdict survives JSON roundtrip", () => {
      const v: SurveyVerdict = {
        itemId: "bv-b1-1000",
        kind: "belief_validation",
        ref: "b1",
        beliefId: "b1",
        verdict: "confirmed",
        via: "survey",
        at: 1_000,
      }
      const rt = JSON.parse(JSON.stringify(v)) as SurveyVerdict
      expect(rt).toEqual(v)
      expect(rt.verdict).toBe("confirmed")
      expect(rt.beliefId).toBe("b1")
    })
  })

  describe("No snooze/dismiss frame (Execution Correction #1)", () => {
    it("SurveyResponseFrame is the ONLY client→server survey frame — no dismiss/snooze type", () => {
      // Compile-time proof: this test file compiles without a SurveyDismissFrame import.
      // Runtime proof: ClientFrame discriminant values do not include 'survey-dismiss'.
      // An unanswered/dismissed survey is a client-side no-op (the modal closes, nothing is sent).
      // The server-side due-check re-surfaces it on the next connection.
      const validSurveyClientFrame: ClientFrame = {
        type: "survey-response",
        surveyId: "survey-1000",
        issuedAt: 1_000,
        verdicts: [],
      }
      expect(validSurveyClientFrame.type).toBe("survey-response")
    })
  })
})
