/**
 * feedback-frames.protocol.test.ts — wire-serializability proofs for the
 * point-at-the-UI feedback frames (same style as skill-frames.protocol.test.ts:
 * plain TS unions, JSON roundtrips, type-level union membership).
 *
 * Pins: (1) FeedbackSubmitFrame ∈ ClientFrame, FeedbackAckFrame ∈ ServerFrame;
 * (2) the ack mirrors capability-execute-result exactly ({requestId, ok,
 * message?} — message OPTIONAL); (3) capabilities.feedback is additive/optional
 * so an old-server hello without it still typechecks and roundtrips.
 */
import { describe, expect, it } from "vitest"
import type {
  ClientFrame,
  ServerFrame,
  FeedbackSubmitFrame,
  FeedbackAckFrame,
} from "../src/protocol.js"

describe("feedback wire frames (plain TS unions, NO Effect Schema)", () => {
  describe("FeedbackSubmitFrame (client→server)", () => {
    it("is a member of ClientFrame and roundtrips intact", () => {
      const f: ClientFrame = {
        type: "feedback-submit",
        requestId: "fb-1",
        threadId: "thr-9",
        note: "the send button is too small",
        target: {
          selector: "body > div:nth-of-type(2) > button:nth-of-type(1)",
          tag: "button",
          id: "send-btn",
          classes: ["send-btn"],
          text: "Send",
          rect: { x: 10, y: 20, w: 30, h: 24 },
          context: { anchor: { tag: "form", id: "chat-form", dataAttrs: {} } },
        },
        page: "chat.html",
        appVersion: "0.0.56",
        appearance: "tide/dark/wash",
        clientTs: 1783918800000,
      }
      const rt = JSON.parse(JSON.stringify(f)) as ClientFrame
      expect(rt).toEqual(f)
      expect(rt.type).toBe("feedback-submit")
      if (rt.type === "feedback-submit") {
        expect(rt.target.selector.length).toBeGreaterThan(0)
        expect(rt.note).toContain("too small")
        expect(rt.clientTs).toBe(1783918800000)
      }
    })

    it("minimal frame: only requestId + note + target.selector + page + clientTs are required", () => {
      const f: FeedbackSubmitFrame = {
        type: "feedback-submit",
        requestId: "fb-2",
        note: "x",
        target: { selector: "#thing" },
        page: "chat.html",
        clientTs: 1,
      }
      const rt = JSON.parse(JSON.stringify(f)) as FeedbackSubmitFrame
      expect(rt).toEqual(f)
      // screenshot is additive/optional — an old-client frame without it
      // still typechecks and roundtrips (backward compat).
      expect(rt.screenshot).toBeUndefined()
      // @ts-expect-error — target.selector is required
      const _illegal: FeedbackSubmitFrame = {
        type: "feedback-submit",
        requestId: "fb-3",
        note: "x",
        target: {},
        page: "chat.html",
        clientTs: 1,
      }
      void _illegal
    })

    it("screenshot is an OPTIONAL base64 PNG (no data: prefix) and roundtrips intact", () => {
      const f: FeedbackSubmitFrame = {
        type: "feedback-submit",
        requestId: "fb-4",
        note: "the icon looks wrong",
        target: { selector: "#thing" },
        page: "chat.html",
        clientTs: 1,
        screenshot: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
      }
      const rt = JSON.parse(JSON.stringify(f)) as FeedbackSubmitFrame
      expect(rt.screenshot).toBe(f.screenshot)
      expect(rt.screenshot?.startsWith("data:")).toBe(false)
    })
  })

  describe("FeedbackAckFrame (server→client)", () => {
    it("ok ack roundtrips; failure carries an OPTIONAL message (mirrors capability-execute-result)", () => {
      const ok: ServerFrame = { type: "feedback-ack", requestId: "fb-1", ok: true }
      const fail: FeedbackAckFrame = {
        type: "feedback-ack",
        requestId: "fb-1",
        ok: false,
        message: "malformed feedback-submit frame",
      }
      expect(JSON.parse(JSON.stringify(ok))).toEqual(ok)
      const rtFail = JSON.parse(JSON.stringify(fail)) as FeedbackAckFrame
      expect(rtFail.ok).toBe(false)
      expect(rtFail.message).toContain("malformed")
      // message is optional — an ok ack with no message is valid.
      expect(Object.keys(ok as object).sort()).toEqual(["ok", "requestId", "type"])
    })
  })

  describe("hello capability", () => {
    it("capabilities.feedback is additive/optional — old-server hello (without it) still typechecks", () => {
      const oldHello: ServerFrame = {
        type: "hello",
        protocolVersion: 2,
        kinds: [],
        capabilities: {
          chat: true,
          streamingDeltas: true,
          localShell: false,
          setup: false,
          turnComplete: true,
          // no `feedback` key — pre-feature server
        },
      }
      const newHello: ServerFrame = {
        type: "hello",
        protocolVersion: 2,
        kinds: [],
        capabilities: {
          chat: true,
          streamingDeltas: true,
          localShell: false,
          setup: false,
          turnComplete: true,
          feedback: true,
        },
      }
      for (const f of [oldHello, newHello]) {
        expect(JSON.parse(JSON.stringify(f))).toEqual(f)
      }
      if (newHello.type === "hello") expect(newHello.capabilities.feedback).toBe(true)
      if (oldHello.type === "hello") expect(oldHello.capabilities.feedback).toBeUndefined()
    })
  })
})
