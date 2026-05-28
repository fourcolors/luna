import { describe, expect, it } from "vitest"
import type { ServerFrame } from "../src/protocol.js"
import type { ChatFrame } from "@luna/chat-service"

describe("tool frames are wire-compatible", () => {
  it("a ChatToolCall is assignable to ServerFrame (passthrough forwarding)", () => {
    const f: ChatFrame = {
      type: "tool-call", threadId: "t", turnId: "u", toolCallId: "tu_1",
      name: "bash", input: { cmd: "ls" },
    }
    const wire: ServerFrame = f as ServerFrame
    expect(wire.type).toBe("tool-call")
  })
  it("a ChatToolResult is assignable to ServerFrame", () => {
    const f: ChatFrame = {
      type: "tool-result", threadId: "t", toolCallId: "tu_1",
      status: "ok", output: "done", truncated: false,
    }
    const wire: ServerFrame = f as ServerFrame
    expect(wire.type).toBe("tool-result")
  })
})
