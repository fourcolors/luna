import { describe, expect, it } from "vitest"
import type { MessageKind, StoredMessage } from "../messages.js"
import { MESSAGE_ENVELOPE_VERSION } from "../messages.js"
import type { SessionSummary } from "../session/types.js"
import {
  DEFAULT_DISTILL_OPTIONS,
  distillMessage,
  distillSession,
  estimateTokens,
  type DistillOptions,
} from "./distill.js"

// ── test helpers ─────────────────────────────────────────────────────────

let autoSeq = 0

const message = (fields: {
  readonly kind: MessageKind
  readonly payload: unknown
  readonly seq?: number
  readonly ts?: number
  readonly id?: string
  readonly sessionId?: string
  readonly parentId?: string | null
}): StoredMessage => {
  autoSeq += 1
  return {
    id: fields.id ?? `msg-${autoSeq}`,
    sessionId: fields.sessionId ?? "session-1",
    seq: fields.seq ?? autoSeq,
    ts: fields.ts ?? autoSeq,
    parentId: fields.parentId ?? null,
    kind: fields.kind,
    schemaVersion: MESSAGE_ENVELOPE_VERSION,
    payload: fields.payload,
  }
}

const summary = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  id: over.id ?? "session-1",
  parentId: over.parentId ?? null,
  title: over.title ?? null,
  tags: over.tags ?? [],
  createdAt: over.createdAt ?? 0,
  endedAt: over.endedAt ?? null,
  model: over.model ?? "claude-test-model",
  status: over.status ?? "closed",
  lastMessageAt: over.lastMessageAt ?? null,
  lastMessagePreview: over.lastMessagePreview ?? null,
})

const textPayload = (role: "user" | "assistant", content: string) => ({
  message: { role, content },
})

const blocksPayload = (
  role: "user" | "assistant",
  content: ReadonlyArray<Record<string, unknown>>,
) => ({ message: { role, content } })

const win = (watermark: number, now: number) => ({ watermark, now })

// ── S1: distillMessage ───────────────────────────────────────────────────

describe("distillMessage", () => {
  describe("S1a: noise-kind messages are dropped", () => {
    const noiseKinds: ReadonlyArray<MessageKind> = [
      "stream_event",
      "system",
      "result",
      "hook",
      "status",
      "other",
    ]

    it.each(noiseKinds)(
      "given a %s message, when distilled, then returns null",
      (kind) => {
        const msg = message({ kind, payload: textPayload("user", "hello") })
        expect(distillMessage(msg)).toBeNull()
      },
    )
  })

  describe("S1b: extracting text from SDK-shaped payloads", () => {
    it("given a user message with string content, when distilled, then returns the content prefixed with [user]", () => {
      const msg = message({ kind: "user", payload: textPayload("user", "hello world") })
      expect(distillMessage(msg)).toBe("[user] hello world")
    })

    it("given an assistant message with text content blocks, when distilled, then the blocks' text is included verbatim", () => {
      const msg = message({
        kind: "assistant",
        payload: blocksPayload("assistant", [
          { type: "text", text: "part one " },
          { type: "text", text: "part two" },
        ]),
      })
      expect(distillMessage(msg)).toBe("[assistant] part one part two")
    })

    it("given a content array mixing a known text block and an unknown block type, when distilled, then only the known block's text is included", () => {
      const msg = message({
        kind: "user",
        payload: blocksPayload("user", [
          { type: "thinking", text: "should not appear" },
          { type: "text", text: "visible text" },
        ]),
      })
      expect(distillMessage(msg)).toBe("[user] visible text")
    })

    it("given a content array containing only unknown block types, when distilled, then returns null", () => {
      const msg = message({
        kind: "assistant",
        payload: blocksPayload("assistant", [{ type: "thinking", text: "secret reasoning" }]),
      })
      expect(distillMessage(msg)).toBeNull()
    })

    it("given an assistant message with a tool_use block, when distilled, then renders a line containing [tool_use <name>] plus the JSON of input", () => {
      const msg = message({
        kind: "assistant",
        payload: blocksPayload("assistant", [
          { type: "tool_use", name: "search_web", input: { query: "weather" } },
        ]),
      })
      const out = distillMessage(msg)
      expect(out).toContain("[tool_use search_web]")
      expect(out).toContain(JSON.stringify({ query: "weather" }))
    })

    it("given a tool_use block whose JSON input exceeds 200 chars, when distilled, then the rendered input is truncated to 200 chars", () => {
      const bigInput = { blob: "x".repeat(400) }
      const fullJson = JSON.stringify(bigInput)
      const msg = message({
        kind: "assistant",
        payload: blocksPayload("assistant", [
          { type: "tool_use", name: "noop", input: bigInput },
        ]),
      })
      const out = distillMessage(msg)
      expect(out).toContain("[tool_use noop]")
      expect(out).toContain(fullJson.slice(0, 200))
      expect(out).not.toContain(fullJson.slice(0, 201))
    })

    it("given an assistant message with a tool_result block whose content is a plain string, when distilled, then renders a [tool_result] line with the content", () => {
      const msg = message({
        kind: "assistant",
        payload: blocksPayload("assistant", [
          { type: "tool_result", content: "the tool said hello" },
        ]),
      })
      const out = distillMessage(msg)
      expect(out).toContain("[tool_result]")
      expect(out).toContain("the tool said hello")
    })

    it("given a tool_result block whose flattened text exceeds 200 chars, when distilled, then the rendered text is truncated to 200 chars", () => {
      const longAnswer = "z".repeat(400)
      const msg = message({
        kind: "assistant",
        payload: blocksPayload("assistant", [
          { type: "tool_result", content: longAnswer },
        ]),
      })
      const out = distillMessage(msg)
      expect(out).toContain(longAnswer.slice(0, 200))
      expect(out).not.toContain(longAnswer.slice(0, 201))
    })

    it("given a tool_result block whose content is an array of text blocks, when distilled, then flattens them into the [tool_result] line", () => {
      const msg = message({
        kind: "assistant",
        payload: blocksPayload("assistant", [
          {
            type: "tool_result",
            content: [
              { type: "text", text: "part a " },
              { type: "text", text: "part b" },
            ],
          },
        ]),
      })
      const out = distillMessage(msg)
      expect(out).toContain("[tool_result]")
      expect(out).toContain("part a part b")
    })
  })

  describe("S1c: falls back to JSON.stringify for non-SDK-shaped payloads", () => {
    it("given a bare string payload (no message.content shape), when distilled, then falls back to JSON.stringify(payload)", () => {
      const msg = message({ kind: "user", payload: "hello" })
      expect(distillMessage(msg)).toBe(`[user] ${JSON.stringify("hello")}`)
    })

    it("given an object payload without a message.content shape, when distilled, then falls back to JSON.stringify(payload)", () => {
      const payload = { foo: "bar" }
      const msg = message({ kind: "assistant", payload })
      expect(distillMessage(msg)).toBe(`[assistant] ${JSON.stringify(payload)}`)
    })
  })

  describe("S1d: role-prefixed output and whitespace-only payloads", () => {
    it("given a user message whose content is only whitespace, when distilled, then returns null", () => {
      const msg = message({ kind: "user", payload: textPayload("user", "   \n\t  ") })
      expect(distillMessage(msg)).toBeNull()
    })

    it("given an assistant message with string content, when distilled, then the output is prefixed with [assistant]", () => {
      const msg = message({ kind: "assistant", payload: textPayload("assistant", "hi there") })
      expect(distillMessage(msg)).toBe("[assistant] hi there")
    })
  })

  describe("S1e: hard truncation to perMessageChars", () => {
    it("given distilled output longer than opts.perMessageChars, when distilled, then hard-truncates to perMessageChars ending with the truncation marker", () => {
      const longText = "a".repeat(2000)
      const msg = message({ kind: "user", payload: textPayload("user", longText) })
      const opts: DistillOptions = { ...DEFAULT_DISTILL_OPTIONS, perMessageChars: 50 }
      const out = distillMessage(msg, opts)
      expect(out).not.toBeNull()
      expect(out?.length).toBe(50)
      expect(out?.endsWith("… [truncated]")).toBe(true)
    })

    it("given no options argument, when a message exceeds the default perMessageChars, then truncates using DEFAULT_DISTILL_OPTIONS", () => {
      const longText = "b".repeat(2000)
      const msg = message({ kind: "assistant", payload: textPayload("assistant", longText) })
      const out = distillMessage(msg)
      expect(out).not.toBeNull()
      expect(out?.length).toBe(DEFAULT_DISTILL_OPTIONS.perMessageChars)
      expect(out?.endsWith("… [truncated]")).toBe(true)
    })

    it("given distilled output shorter than perMessageChars, when distilled, then is not truncated", () => {
      const msg = message({ kind: "user", payload: textPayload("user", "short") })
      const opts: DistillOptions = { ...DEFAULT_DISTILL_OPTIONS, perMessageChars: 50 }
      expect(distillMessage(msg, opts)).toBe("[user] short")
    })
  })
})

// ── S2: distillSession ───────────────────────────────────────────────────

describe("distillSession", () => {
  describe("S2f: message-granularity windowing (watermark, now]", () => {
    it("given a message before the watermark, when distilled, then it is excluded from the excerpt and window count", () => {
      const msgs = [
        message({ seq: 1, ts: 5, kind: "user", payload: textPayload("user", "too old") }),
        message({ seq: 2, ts: 15, kind: "user", payload: textPayload("user", "in window") }),
      ]
      const out = distillSession(summary(), msgs, win(10, 100))
      expect(out.excerpt).toBe("[user] in window")
      expect(out.windowMessageCount).toBe(1)
    })

    it("given a message exactly at the watermark, when distilled, then it is excluded (strictly greater than watermark)", () => {
      const msgs = [
        message({ seq: 1, ts: 10, kind: "user", payload: textPayload("user", "at watermark") }),
      ]
      const out = distillSession(summary(), msgs, win(10, 100))
      expect(out.windowMessageCount).toBe(0)
      expect(out.excerpt).toBe("")
    })

    it("given a message exactly at now, when distilled, then it is included (ts <= now is inclusive)", () => {
      const msgs = [
        message({ seq: 1, ts: 100, kind: "user", payload: textPayload("user", "at now") }),
      ]
      const out = distillSession(summary(), msgs, win(10, 100))
      expect(out.windowMessageCount).toBe(1)
      expect(out.excerpt).toBe("[user] at now")
    })

    it("given a message after now, when distilled, then it is excluded", () => {
      const msgs = [
        message({ seq: 1, ts: 101, kind: "user", payload: textPayload("user", "future") }),
      ]
      const out = distillSession(summary(), msgs, win(10, 100))
      expect(out.windowMessageCount).toBe(0)
      expect(out.excerpt).toBe("")
    })
  })

  describe("S2g: noise-kind messages inside the window are dropped from the excerpt but still counted", () => {
    it("given a noise-kind message inside the window alongside a user message, when distilled, then the excerpt omits the noise message but windowMessageCount includes it", () => {
      const msgs = [
        message({ seq: 1, ts: 20, kind: "system", payload: { anything: true } }),
        message({ seq: 2, ts: 21, kind: "user", payload: textPayload("user", "hello") }),
      ]
      const out = distillSession(summary(), msgs, win(10, 100))
      expect(out.windowMessageCount).toBe(2)
      expect(out.excerpt).toBe("[user] hello")
    })
  })

  describe("S2h: excerpt joins distilled lines with newlines in ascending seq order", () => {
    it("given multiple in-window messages out of seq order, when distilled, then the excerpt is ordered by ascending seq", () => {
      const msgs = [
        message({ seq: 2, ts: 21, kind: "assistant", payload: textPayload("assistant", "second") }),
        message({ seq: 1, ts: 20, kind: "user", payload: textPayload("user", "first") }),
      ]
      const out = distillSession(summary(), msgs, win(10, 100))
      expect(out.excerpt).toBe("[user] first\n[assistant] second")
    })

    it("given seq and ts that disagree, when distilled, then ordering follows seq (not ts)", () => {
      // Regression lock (audit finding): every other test moves seq and ts
      // together, so a ts-based sort would pass them all. Here they diverge.
      const msgs = [
        message({ seq: 2, ts: 20, kind: "assistant", payload: textPayload("assistant", "second") }),
        message({ seq: 1, ts: 21, kind: "user", payload: textPayload("user", "first") }),
      ]
      const out = distillSession(summary(), msgs, win(10, 100))
      expect(out.excerpt).toBe("[user] first\n[assistant] second")
    })
  })

  describe("S2i: overflow drops oldest lines first, prefixed with a count marker", () => {
    it("given an excerpt exceeding perSessionChars, when distilled, then drops the oldest lines and prepends a '[… N earlier messages truncated]' marker, keeping the excerpt at or under budget", () => {
      const lineContent = (ch: string) => ch.repeat(93) // "[user] " (7 chars) + 93 = 100-char line
      const msgs = ["A", "B", "C", "D", "E"].map((ch, i) =>
        message({
          seq: i + 1,
          ts: 11 + i,
          kind: "user",
          payload: textPayload("user", lineContent(ch)),
        }),
      )
      const opts: DistillOptions = { ...DEFAULT_DISTILL_OPTIONS, perSessionChars: 335 }
      const out = distillSession(summary(), msgs, win(10, 100), opts)

      // Unbounded excerpt would be 5*100 + 4 = 504 chars, forcing truncation.
      // Keeping the newest 3 lines (300 + 2 separators = 302) plus the
      // marker (32 chars) plus its trailing newline (1) = 335, which fits;
      // keeping 4 lines would not (403 + 32 + 1 = 436 > 335).
      const expectedKept = ["C", "D", "E"].map((ch) => `[user] ${lineContent(ch)}`).join("\n")
      expect(out.excerpt).toBe(`[… 2 earlier messages truncated]\n${expectedKept}`)
      expect(out.excerpt.length).toBeLessThanOrEqual(335)
    })

    it("given an excerpt within perSessionChars, when distilled, then no truncation marker is added", () => {
      const msgs = [
        message({ seq: 1, ts: 11, kind: "user", payload: textPayload("user", "short one") }),
        message({ seq: 2, ts: 12, kind: "assistant", payload: textPayload("assistant", "short two") }),
      ]
      const out = distillSession(summary(), msgs, win(10, 100))
      expect(out.excerpt).toBe("[user] short one\n[assistant] short two")
      expect(out.excerpt).not.toContain("truncated")
    })
  })

  describe("S2j: messageCount and windowMessageCount", () => {
    it("given a mix of in-window, out-of-window, and noise-kind messages, when distilled, then messageCount is the total and windowMessageCount is only the in-window count", () => {
      const msgs = [
        message({ seq: 1, ts: 5, kind: "user", payload: textPayload("user", "old") }), // before watermark
        message({ seq: 2, ts: 20, kind: "user", payload: textPayload("user", "in1") }), // in window
        message({ seq: 3, ts: 30, kind: "system", payload: { x: 1 } }), // in window, noise kind
        message({ seq: 4, ts: 200, kind: "user", payload: textPayload("user", "future") }), // after now
      ]
      const out = distillSession(summary(), msgs, win(10, 100))
      expect(out.messageCount).toBe(4)
      expect(out.windowMessageCount).toBe(2)
    })
  })

  describe("summary pass-through", () => {
    it("given a session summary, when distilled, then it is returned unchanged on the result", () => {
      const s = summary({ id: "session-42", title: "My Session" })
      const out = distillSession(s, [], win(10, 100))
      expect(out.summary).toEqual(s)
    })
  })
})

// ── S2k / estimateTokens ─────────────────────────────────────────────────

describe("estimateTokens", () => {
  it("given an empty string, when estimated, then returns 0", () => {
    expect(estimateTokens("")).toBe(0)
  })

  it("given a 9-character string, when estimated, then returns 3 (ceil(9/4))", () => {
    expect(estimateTokens("123456789")).toBe(3)
  })
})
