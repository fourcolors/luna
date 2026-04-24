/**
 * Message tagged-union narrowing — ensure the helpers and tagged shape
 * are stable for downstream services (SessionStore, HookRegistry, TeamBroker).
 */
import { describe, expect, it } from "vitest"
import {
  isAssistantMessage,
  isPartialAssistantMessage,
  isResultMessage,
  isSystemMessage,
  isUserMessage,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKResultMessage,
  type SDKSystemMessage,
  type SDKUserMessage,
  type StoredMessage,
} from "../src/messages.js"

const user: SDKUserMessage = {
  type: "user",
  session_id: "s1",
  message: { role: "user", content: "hello" },
}

const assistant: SDKAssistantMessage = {
  type: "assistant",
  session_id: "s1",
  message: {
    id: "m1",
    role: "assistant",
    model: "claude-sonnet-4-5",
    content: [{ type: "text", text: "hi" }],
  },
}

const system: SDKSystemMessage = {
  type: "system",
  subtype: "init",
  session_id: "s1",
}

const result: SDKResultMessage = {
  type: "result",
  subtype: "success",
  session_id: "s1",
  is_error: false,
  duration_ms: 10,
  duration_api_ms: 5,
  num_turns: 1,
}

describe("SDKMessage narrowing", () => {
  it("user guard matches only user messages", () => {
    expect(isUserMessage(user)).toBe(true)
    expect(isUserMessage(assistant)).toBe(false)
  })

  it("assistant guard matches only assistant messages", () => {
    expect(isAssistantMessage(assistant)).toBe(true)
    expect(isAssistantMessage(user)).toBe(false)
  })

  it("system/result/partial guards are disjoint", () => {
    expect(isSystemMessage(system)).toBe(true)
    expect(isResultMessage(result)).toBe(true)
    expect(isPartialAssistantMessage(system)).toBe(false)
  })

  it("exhaustive switch over SDKMessage compiles", () => {
    const kinds: SDKMessage[] = [user, assistant, system, result]
    const tags = kinds.map((m) => m.type).sort()
    expect(tags).toEqual(["assistant", "result", "system", "user"])
  })

  it("StoredMessage carries monotonic seq", () => {
    const stored: StoredMessage = {
      id: "m1",
      sessionId: "s1",
      seq: 0,
      ts: 1,
      parentId: null,
      kind: "user",
      payload: user,
    }
    expect(stored.seq).toBe(0)
    expect(stored.kind).toBe("user")
  })
})
