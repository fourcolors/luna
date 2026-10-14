import { Context, Effect, Layer } from "effect"
import { defineToolPackage } from "@luna/tools"
import type {
  AnyZodRawShape,
  McpSdkServerConfigWithInstance,
  SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk"
import { ForkProposalStore, type ForkProposalStoreApi } from "./store.js"
import { makeForkThreadTools } from "./tools.js"
import { AGENT_CREATED_TAG, FORK_CHILD_TAG } from "./types.js"

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

export class ThreadToolsService extends Context.Service<ThreadToolsService, ThreadToolsConfig>()("luna/ThreadToolsService") {}

export const THREAD_TOOLS_SYSTEM_PROMPT_ADDENDUM =
  "You have a thread-tools MCP server (`thread_tools`) with the tool " +
  "`mcp__thread_tools__fork_thread(title, summary, seed)`. Use this fully-qualified " +
  "name exactly. When the operator pivots to a GENUINELY UNRELATED topic mid-chat " +
  "(high confidence only — not same-task tangents), call fork_thread to PROPOSE " +
  "peeling that topic into a sibling thread. An inline marker appears; the operator " +
  "clicks to enter. Provide a short title, one-line summary, and a self-contained " +
  "`seed` restating their pivoted ask for the new thread. Propose sparingly; a " +
  "missed fork is far cheaper than a wrong one. Do not call fork_thread from a " +
  "thread that was itself created by a fork. " +
  "The same server also has `mcp__thread_tools__create_thread(title, seed)`: it " +
  "creates a new chat IMMEDIATELY, sends `seed` as its first message, and switches " +
  "the operator's window to it. Use it when the operator asks you to make a new " +
  "chat, or approves one. The new chat does not see this conversation, so the seed " +
  "must restate everything it needs."

/** create_thread budget: at most this many new chats per thread per window. */
export const CREATE_THREAD_MAX_PER_WINDOW = 3
export const CREATE_THREAD_WINDOW_MS = 10 * 60 * 1000

/**
 * Tags that mark a chat nobody started by hand. create_thread is refused in
 * these, so an injected or mistaken agent cannot spawn chats recursively.
 */
const NO_CREATE_TAGS: ReadonlyArray<string> = [FORK_CHILD_TAG, AGENT_CREATED_TAG, "channel"]

/** Shared across every session binding: thread id -> recent create timestamps. */
export type CreateBudget = Map<string, number[]>

export const checkCreateAllowed = (
  budget: CreateBudget,
  threadId: string,
  tags: ReadonlyArray<string>,
  now: number,
): string | null => {
  if (tags.some((t) => NO_CREATE_TAGS.includes(t))) {
    return "create_thread is only available in a chat the operator started (not in forked, agent-created, or channel chats)"
  }
  const recent = (budget.get(threadId) ?? []).filter((t) => now - t < CREATE_THREAD_WINDOW_MS)
  if (recent.length >= CREATE_THREAD_MAX_PER_WINDOW) {
    budget.set(threadId, recent)
    return `create_thread budget reached: at most ${CREATE_THREAD_MAX_PER_WINDOW} new chats per chat every ${CREATE_THREAD_WINDOW_MS / 60000} minutes`
  }
  budget.set(threadId, [...recent, now])
  return null
}

const createConfig = (
  store: ForkProposalStoreApi,
  budget: CreateBudget,
): ThreadToolsSessionConfig => {
  const sessionCell: {
    value: string | null
    isForkChild: boolean
    tags: ReadonlyArray<string>
  } = { value: null, isForkChild: false, tags: [] }

  const currentThreadId = () => sessionCell.value
  const isForkChildThread = () => sessionCell.isForkChild

  const bindSession = (
    sessionId: string,
    meta?: { readonly tags?: ReadonlyArray<string> },
  ) => {
    sessionCell.value = sessionId
    sessionCell.isForkChild =
      meta?.tags?.includes(FORK_CHILD_TAG) === true
    sessionCell.tags = meta?.tags ?? []
  }
  const clearSession = (sessionId: string) => {
    if (sessionCell.value === sessionId) {
      sessionCell.value = null
      sessionCell.isForkChild = false
      sessionCell.tags = []
    }
  }

  const tools = makeForkThreadTools(
    store,
    currentThreadId,
    isForkChildThread,
    () => Date.now(),
    (threadId, now) => checkCreateAllowed(budget, threadId, sessionCell.tags, now),
  ) as unknown as ReadonlyArray<SdkMcpToolDefinition<AnyZodRawShape>>
  const config = defineToolPackage({
    name: "thread_tools",
    tools,
    addendum: THREAD_TOOLS_SYSTEM_PROMPT_ADDENDUM,
  })

  return { ...config, serverName: "thread_tools", bindSession, clearSession }
}

/**
 * Provides ThreadToolsService + in-memory ForkProposalStore.
 * Accept/create-thread happens in chat-server (needs ChatService).
 */
export const ThreadToolsLayer: Layer.Layer<
  ThreadToolsService | ForkProposalStore
> = Layer.effect(
  ThreadToolsService,
  Effect.gen(function* () {
    const store = yield* ForkProposalStore
    const budget: CreateBudget = new Map()
    return {
      ...createConfig(store, budget),
      createSessionBinding: () => createConfig(store, budget),
      store,
    }
  }),
).pipe(Layer.provideMerge(ForkProposalStore.Memory))
