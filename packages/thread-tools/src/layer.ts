import { Effect, Layer } from "effect"
import { makeSdkMcpServer } from "@luna/tools"
import type {
  AnyZodRawShape,
  McpSdkServerConfigWithInstance,
  SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk"
import { ForkProposalStore, type ForkProposalStoreApi } from "./store.js"
import { makeForkThreadTools } from "./tools.js"
import { FORK_CHILD_TAG } from "./types.js"

export interface ThreadToolsSessionConfig {
  readonly serverName: "thread_tools"
  readonly server: McpSdkServerConfigWithInstance
  readonly systemPromptAddendum: string
  readonly bindSession: (sessionId: string, meta?: { readonly tags?: ReadonlyArray<string> }) => void
  readonly clearSession: (sessionId: string) => void
}

export interface ThreadToolsConfig extends ThreadToolsSessionConfig {
  readonly createSessionBinding: () => ThreadToolsSessionConfig
  readonly store: ForkProposalStoreApi
}

export class ThreadToolsService extends Effect.Tag("luna/ThreadToolsService")<
  ThreadToolsService,
  ThreadToolsConfig
>() {}

export const THREAD_TOOLS_SYSTEM_PROMPT_ADDENDUM =
  "You have a thread-tools MCP server (`thread_tools`) with the tool " +
  "`mcp__thread_tools__fork_thread(title, summary, seed)`. Use this fully-qualified " +
  "name exactly. When the operator pivots to a GENUINELY UNRELATED topic mid-chat " +
  "(high confidence only — not same-task tangents), call fork_thread to PROPOSE " +
  "peeling that topic into a sibling thread. An inline marker appears; the operator " +
  "clicks to enter. Provide a short title, one-line summary, and a self-contained " +
  "`seed` restating their pivoted ask for the new thread. Propose sparingly; a " +
  "missed fork is far cheaper than a wrong one. Do not call fork_thread from a " +
  "thread that was itself created by a fork."

const buildServer = (
  tools: ReturnType<typeof makeForkThreadTools>,
): McpSdkServerConfigWithInstance => {
  const widened = tools as unknown as ReadonlyArray<
    SdkMcpToolDefinition<AnyZodRawShape>
  >
  return makeSdkMcpServer("thread_tools", "0.1.0", widened)
}

const createConfig = (
  store: ForkProposalStoreApi,
): ThreadToolsSessionConfig => {
  const sessionCell: {
    value: string | null
    isForkChild: boolean
  } = { value: null, isForkChild: false }

  const currentThreadId = () => sessionCell.value
  const isForkChildThread = () => sessionCell.isForkChild

  const bindSession = (
    sessionId: string,
    meta?: { readonly tags?: ReadonlyArray<string> },
  ) => {
    sessionCell.value = sessionId
    sessionCell.isForkChild =
      meta?.tags?.includes(FORK_CHILD_TAG) === true
  }
  const clearSession = (sessionId: string) => {
    if (sessionCell.value === sessionId) {
      sessionCell.value = null
      sessionCell.isForkChild = false
    }
  }

  const tools = makeForkThreadTools(store, currentThreadId, isForkChildThread)
  const server = buildServer(tools)

  return {
    serverName: "thread_tools",
    server,
    systemPromptAddendum: THREAD_TOOLS_SYSTEM_PROMPT_ADDENDUM,
    bindSession,
    clearSession,
  }
}

/**
 * Provides ThreadToolsService + in-memory ForkProposalStore.
 * Accept/create-thread happens in chat-server (needs ChatService).
 */
export const ThreadToolsLayer: Layer.Layer<
  ThreadToolsService | ForkProposalStore
> = Layer.scoped(
  ThreadToolsService,
  Effect.gen(function* () {
    const store = yield* ForkProposalStore
    return {
      ...createConfig(store),
      createSessionBinding: () => createConfig(store),
      store,
    }
  }),
).pipe(Layer.provideMerge(ForkProposalStore.Memory))
