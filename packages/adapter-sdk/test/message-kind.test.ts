/**
 * message-kind.ts pure helpers — subagent-spawn / tool_result id extraction
 * used by the adapter's subagent-aware inactivity watchdog.
 */
import { describe, expect, it } from "vitest"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { sdkAgentSpawnIds, sdkToolResultIds } from "../src/message-kind.js"

const assistantWith = (
  blocks: ReadonlyArray<Record<string, unknown>>,
): SDKMessage =>
  ({
    type: "assistant",
    session_id: "s",
    uuid: "a1",
    parent_tool_use_id: null,
    message: { role: "assistant", content: blocks },
  }) as unknown as SDKMessage

const userWith = (
  blocks: ReadonlyArray<Record<string, unknown>>,
): SDKMessage =>
  ({
    type: "user",
    session_id: "s",
    uuid: "u1",
    parent_tool_use_id: null,
    message: { role: "user", content: blocks },
  }) as unknown as SDKMessage

describe("sdkAgentSpawnIds", () => {
  it("extracts Agent tool_use ids (canonical wire name)", () => {
    const m = assistantWith([
      { type: "tool_use", id: "tu_a", name: "Agent", input: {} },
      { type: "text", text: "spawning" },
    ])
    expect(sdkAgentSpawnIds(m)).toEqual(["tu_a"])
  })

  it("matches the Task alias defensively", () => {
    const m = assistantWith([
      { type: "tool_use", id: "tu_t", name: "Task", input: {} },
    ])
    expect(sdkAgentSpawnIds(m)).toEqual(["tu_t"])
  })

  it("ignores other tools and non-assistant messages", () => {
    expect(
      sdkAgentSpawnIds(
        assistantWith([{ type: "tool_use", id: "tu_x", name: "Read", input: {} }]),
      ),
    ).toEqual([])
    expect(
      sdkAgentSpawnIds(
        userWith([{ type: "tool_use", id: "tu_y", name: "Agent", input: {} }]),
      ),
    ).toEqual([])
    expect(
      sdkAgentSpawnIds({ type: "result" } as unknown as SDKMessage),
    ).toEqual([])
  })

  it("collects multiple spawns from one message (parallel fan-out)", () => {
    const m = assistantWith([
      { type: "tool_use", id: "tu_1", name: "Agent", input: {} },
      { type: "tool_use", id: "tu_2", name: "Agent", input: {} },
    ])
    expect(sdkAgentSpawnIds(m)).toEqual(["tu_1", "tu_2"])
  })

  it("skips malformed blocks (missing id / name)", () => {
    const m = assistantWith([
      { type: "tool_use", name: "Agent", input: {} },
      { type: "tool_use", id: 42, name: "Agent", input: {} },
    ])
    expect(sdkAgentSpawnIds(m)).toEqual([])
  })
})

describe("sdkToolResultIds", () => {
  it("extracts tool_use_ids from user tool_result blocks", () => {
    const m = userWith([
      { type: "tool_result", tool_use_id: "tu_a", content: "done" },
      { type: "text", text: "seed" },
      { type: "tool_result", tool_use_id: "tu_b", is_error: true },
    ])
    expect(sdkToolResultIds(m)).toEqual(["tu_a", "tu_b"])
  })

  it("returns [] for non-user messages and malformed blocks", () => {
    expect(
      sdkToolResultIds(
        assistantWith([{ type: "tool_result", tool_use_id: "tu_z" }]),
      ),
    ).toEqual([])
    expect(sdkToolResultIds(userWith([{ type: "tool_result" }]))).toEqual([])
  })
})
