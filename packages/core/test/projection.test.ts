/**
 * projection.ts — pure derivation of ChatMessage view-models from
 * StoredMessage envelopes.
 *
 * Coverage:
 *   - extractTextPreview: string content / structured content / non-text /
 *     malformed / whitespace collapse + truncation
 *   - projectOne: user, assistant text, assistant with tool_use, dropped
 *     kinds (system/result/stream_event/hook), malformed payloads
 *   - projectChatMessages: Stream-level filter of nulls
 */
import { describe, expect, it } from "vitest"
import { Chunk, Effect, Stream } from "effect"
import {
  extractTextPreview,
  projectChatMessages,
  projectOne,
  type ChatMessage,
} from "../src/session/projection.js"
import {
  MESSAGE_ENVELOPE_VERSION,
  type MessageKind,
  type StoredMessage,
} from "../src/messages.js"

const stored = (
  id: string,
  seq: number,
  kind: MessageKind,
  payload: unknown,
): StoredMessage => ({
  id,
  sessionId: "s",
  seq,
  ts: seq * 1000,
  parentId: null,
  kind,
  schemaVersion: MESSAGE_ENVELOPE_VERSION,
  payload,
})

const userPayload = (text: string) => ({
  type: "user",
  message: { role: "user", content: text },
})

const assistantTextPayload = (text: string) => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text }] },
})

const assistantToolPayload = (text: string, toolName: string) => ({
  type: "assistant",
  message: {
    role: "assistant",
    content: [
      { type: "text", text },
      { type: "tool_use", id: "tu_1", name: toolName, input: { x: 1 } },
    ],
  },
})

describe("extractTextPreview", () => {
  it("returns string content unchanged when short", () => {
    expect(extractTextPreview(userPayload("hello world"))).toBe("hello world")
  })

  it("collapses whitespace", () => {
    expect(extractTextPreview(userPayload("a   b\n\n\tc"))).toBe("a b c")
  })

  it("truncates long content with ellipsis", () => {
    const long = "x".repeat(500)
    const out = extractTextPreview(userPayload(long))
    expect(out).not.toBeNull()
    expect(out!.length).toBeLessThanOrEqual(140)
    expect(out!.endsWith("…")).toBe(true)
  })

  it("walks structured content blocks (assistant text)", () => {
    expect(extractTextPreview(assistantTextPayload("from blocks"))).toBe(
      "from blocks",
    )
  })

  it("ignores non-text blocks (tool_use only -> null)", () => {
    const payload = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }],
      },
    }
    expect(extractTextPreview(payload)).toBeNull()
  })

  it("returns null for malformed payloads", () => {
    expect(extractTextPreview(null)).toBeNull()
    expect(extractTextPreview(42)).toBeNull()
    expect(extractTextPreview({})).toBeNull()
    expect(extractTextPreview({ message: null })).toBeNull()
    expect(extractTextPreview({ message: { content: 99 } })).toBeNull()
  })
})

describe("projectOne", () => {
  it("projects a user turn", () => {
    const out = projectOne(stored("u1", 0, "user", userPayload("hi")))
    expect(out).toEqual<ChatMessage>({
      id: "u1",
      seq: 0,
      ts: 0,
      role: "user",
      text: "hi",
      toolUses: [],
    })
  })

  it("projects an assistant text turn", () => {
    const out = projectOne(
      stored("a1", 1, "assistant", assistantTextPayload("yo")),
    )
    expect(out?.role).toBe("assistant")
    expect(out?.text).toBe("yo")
    expect(out?.toolUses).toEqual([])
  })

  it("flattens tool_use blocks alongside text", () => {
    const out = projectOne(
      stored("a2", 2, "assistant", assistantToolPayload("running", "Bash")),
    )
    expect(out?.text).toBe("running")
    expect(out?.toolUses).toHaveLength(1)
    expect(out?.toolUses[0]).toMatchObject({
      id: "tu_1",
      name: "Bash",
      input: { x: 1 },
    })
  })

  it("returns null for non-chat kinds", () => {
    expect(projectOne(stored("r1", 0, "result", { result: "ok" }))).toBeNull()
    expect(projectOne(stored("s1", 0, "system", {}))).toBeNull()
    expect(projectOne(stored("e1", 0, "stream_event", {}))).toBeNull()
    expect(projectOne(stored("h1", 0, "hook", {}))).toBeNull()
    expect(projectOne(stored("o1", 0, "other", {}))).toBeNull()
  })

  it("returns null for malformed user payload", () => {
    expect(projectOne(stored("u-bad", 0, "user", { wrong: true }))).toBeNull()
  })

  it("drops empty user turns but keeps tool-only assistant turns", () => {
    expect(projectOne(stored("u-empty", 0, "user", userPayload("")))).toBeNull()
    const toolOnly = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_x", name: "Read", input: {} }],
      },
    }
    const out = projectOne(stored("a-tool", 0, "assistant", toolOnly))
    expect(out?.text).toBe("")
    expect(out?.toolUses).toHaveLength(1)
  })
})

describe("projectChatMessages (stream)", () => {
  it("filters out null projections in order", async () => {
    const input: ReadonlyArray<StoredMessage> = [
      stored("u1", 0, "user", userPayload("first")),
      stored("s1", 1, "system", {}),
      stored("a1", 2, "assistant", assistantTextPayload("hi back")),
      stored("r1", 3, "result", { result: "ok" }),
      stored("u2", 4, "user", userPayload("second")),
    ]
    const out = await Effect.runPromise(
      Stream.runCollect(projectChatMessages(Stream.fromIterable(input))),
    )
    const arr = Array.from(Chunk.toReadonlyArray(out))
    expect(arr.map((m) => m.id)).toEqual(["u1", "a1", "u2"])
    expect(arr.map((m) => m.role)).toEqual(["user", "assistant", "user"])
  })
})
