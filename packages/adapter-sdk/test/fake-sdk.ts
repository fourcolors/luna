/**
 * In-memory fake of the SDK's Query interface for Tier-1 tests.
 *
 * The real SDK requires an OAuth token + subprocess. Our Tier-1 tests
 * substitute this fake via `SDKClient.fake(...)` — every code path in the
 * adapter is exercised without touching the network.
 */
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk"

export interface FakeQueryOptions {
  readonly messages: ReadonlyArray<SDKMessage>
  /** ms between yielded messages. Default 0. */
  readonly gapMs?: number
  /** Throw after yielding N messages (simulate subprocess failure). */
  readonly throwAfter?: number
}

export interface FakeQueryInstance {
  readonly query: Query
  readonly interrupts: { count: number }
  readonly modeChanges: Array<string>
}

/**
 * Build a fake `Query`. It implements AsyncGenerator + the control methods
 * the adapter cares about. Anything not tested is a no-op.
 */
export const makeFakeQuery = (opts: FakeQueryOptions): FakeQueryInstance => {
  const state = { interrupts: { count: 0 }, modeChanges: [] as string[] }

  async function* gen(): AsyncGenerator<SDKMessage, void> {
    let n = 0
    for (const m of opts.messages) {
      if (opts.gapMs) await new Promise((r) => setTimeout(r, opts.gapMs))
      yield m
      n++
      if (opts.throwAfter !== undefined && n >= opts.throwAfter) {
        throw new Error("fake-sdk: simulated failure")
      }
    }
  }

  const iterator = gen()
  const q: Query = Object.assign(iterator, {
    interrupt: async () => {
      state.interrupts.count++
    },
    setPermissionMode: async (mode: string) => {
      state.modeChanges.push(mode)
    },
    setModel: async (_m?: string) => {},
    applyFlagSettings: async (_s: unknown) => {},
    setMaxThinkingTokens: async (_n: number) => {},
    supplyToolPermissionResponse: async () => {},
    mcpServerStatus: async () => ({}),
  } as Partial<Query>) as Query

  return { query: q, ...state }
}

export const makeAssistantMessage = (
  sessionId: string,
  text: string,
  uuid: string,
): SDKMessage =>
  ({
    type: "assistant",
    session_id: sessionId,
    uuid,
    parent_tool_use_id: null,
    message: {
      id: uuid,
      role: "assistant",
      model: "claude-test",
      content: [{ type: "text", text }],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  }) as unknown as SDKMessage

export const makeResultMessage = (
  sessionId: string,
  uuid: string,
): SDKMessage =>
  ({
    type: "result",
    subtype: "success",
    session_id: sessionId,
    uuid,
    is_error: false,
    duration_ms: 10,
    duration_api_ms: 5,
    num_turns: 1,
    result: "ok",
  }) as unknown as SDKMessage
