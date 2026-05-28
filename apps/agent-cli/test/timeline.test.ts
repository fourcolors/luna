import { describe, expect, it } from "vitest"
import { emptyTimeline, applyUser, applyAssistantDelta, applyAssistantDone, applyToolCall, applyToolResult, type Block } from "../src/tui/timeline.js"

describe("timeline reducer", () => {
  it("appends a user block", () => {
    const t = applyUser(emptyTimeline(), "hi")
    expect(t).toEqual([{ kind: "user", text: "hi" }])
  })
  it("upserts assistant text by turnId", () => {
    let t = applyAssistantDelta(emptyTimeline(), "turn-1", "he")
    t = applyAssistantDelta(t, "turn-1", "hello")
    expect(t).toEqual([{ kind: "assistant", turnId: "turn-1", text: "hello", done: false }])
    t = applyAssistantDone(t, "turn-1", "hello")
    expect((t[0] as Extract<Block, { kind: "assistant" }>).done).toBe(true)
  })
  it("appends a running tool block, then merges its result by toolCallId", () => {
    let t = applyToolCall(emptyTimeline(), { toolCallId: "tu_1", name: "bash", input: { cmd: "ls" }, turnId: "turn-1" })
    expect(t).toEqual([{ kind: "tool", toolCallId: "tu_1", name: "bash", input: { cmd: "ls" }, status: "running" }])
    t = applyToolResult(t, { toolCallId: "tu_1", status: "ok", output: "a\nb", truncated: false })
    expect(t[0]).toEqual({ kind: "tool", toolCallId: "tu_1", name: "bash", input: { cmd: "ls" }, status: "ok", output: "a\nb", truncated: false })
  })
  it("ignores a tool-result with no matching call", () => {
    const t = applyToolResult(emptyTimeline(), { toolCallId: "nope", status: "ok", output: "x", truncated: false })
    expect(t).toEqual([])
  })
})
