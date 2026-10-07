import { Effect } from "effect"
import { z } from "zod"
import { defineTool, ToolError } from "@luna/tools"
import { ForkProposalStore } from "./store.js"
import { FORK_CHILD_TAG, type ForkProposalMode } from "./types.js"

const forkThreadShape = {
  title: z
    .string()
    .min(1)
    .max(120)
    .describe(
      "Short title for the new sibling thread and the inline marker heading.",
    ),
  summary: z
    .string()
    .min(1)
    .max(240)
    .describe(
      "One-line summary shown on the marker (what this forked topic is about).",
    ),
  seed: z
    .string()
    .min(1)
    .max(8000)
    .describe(
      "Self-contained opening message for the new thread. Must stand alone " +
        "without relying on the parent transcript (though the new session " +
        "inherits parent context via resume-fork). Restate the operator's " +
        "pivoted ask clearly.",
    ),
}

/** Exported so bounds are unit-testable without the MCP SDK. */
export const forkThreadInputSchema = z.object(forkThreadShape)

const createThreadShape = {
  title: forkThreadShape.title.describe(
    "Short title for the new chat, shown in the operator's Chats list.",
  ),
  seed: forkThreadShape.seed.describe(
    "Self-contained opening message for the new chat. The new chat does NOT " +
      "see this conversation, so restate everything it needs: the ask, links, " +
      "names, constraints, and what a good answer looks like.",
  ),
}

/** Exported so bounds are unit-testable without the MCP SDK. */
export const createThreadInputSchema = z.object(createThreadShape)

/**
 * `makeForkThreadTools(store, currentThreadId, isForkChildThread, nowMs?, createGate?)`
 * returns `[fork_thread, create_thread]`.
 *
 * - `fork_thread` stages a marker and creates nothing until the operator
 *   clicks it. `isForkChildThread()` is the fork-loop guard: a thread created
 *   by an accepted fork must not propose another fork on early turns.
 * - `create_thread` stages a `mode: "create"` proposal that the server accepts
 *   at once. `createGate` refuses it in unattended threads and enforces the
 *   per-thread creation budget.
 */
export const makeForkThreadTools = (
  store: {
    readonly propose: (input: {
      readonly parentThreadId: string
      readonly title: string
      readonly summary: string
      readonly seed: string
      readonly nowMs: number
      readonly mode?: ForkProposalMode
    }) => Effect.Effect<{ readonly id: string }>
  },
  currentThreadId: () => string | null,
  isForkChildThread: () => boolean,
  nowMs: () => number = () => Date.now(),
  /**
   * create_thread gate: returns null to allow, or the refusal reason. The
   * layer refuses unattended threads (fork children, agent-created chats,
   * channel threads) and enforces a per-thread creation budget.
   */
  createGate: (threadId: string, nowMs: number) => string | null = () => null,
) => {
  const forkThread = defineTool({
    name: "fork_thread",
    description:
      "Propose peeling an UNRELATED topic pivot into its own sibling chat " +
      "thread. Use ONLY at high confidence that the operator has switched to " +
      "a genuinely different subject (not a same-task tangent like 'now write " +
      "the test'). Stages an inline marker the operator can click to open the " +
      "new thread — does NOT create the thread until they accept. Prefer " +
      "staying silent over a wrong fork. Never call this from a thread that " +
      "was itself just forked.",
    inputSchema: forkThreadShape,
    alwaysLoad: true,
    searchHint:
      "Propose forking an off-topic pivot into a sibling chat thread (click-to-enter marker).",
    handler: (args) =>
      Effect.gen(function* () {
        const threadId = currentThreadId()
        if (!threadId) {
          return yield* Effect.fail(
            new ToolError({
              tool: "fork_thread",
              op: "propose",
              cause: "no chat session is bound",
            }),
          )
        }
        if (isForkChildThread()) {
          return yield* Effect.fail(
            new ToolError({
              tool: "fork_thread",
              op: "propose",
              cause:
                "fork-loop guard: this thread was created by a fork; do not re-fork on its first turns",
            }),
          )
        }

        const row = yield* store.propose({
          parentThreadId: threadId,
          title: args.title,
          summary: args.summary,
          seed: args.seed,
          nowMs: nowMs(),
        })

        return {
          ok: true,
          markerId: row.id,
          message:
            "Fork proposed. The operator will see an inline marker; the sibling " +
            "thread is created only if they click Continue.",
        }
      }),
  })

  const createThread = defineTool({
    name: "create_thread",
    description:
      "Create a NEW chat for the operator right now and open it in their Luna " +
      "window. Unlike fork_thread there is no marker to click: the chat is " +
      "created, seeded with your opening message, and the operator's window " +
      "switches to it. Use when the operator asks for a new chat, or when a " +
      "task clearly deserves its own chat and the operator has said to go " +
      "ahead. The new chat starts fresh (it does not inherit this " +
      "conversation), so the seed must stand alone. Do not call it to answer " +
      "something you can answer here. It is refused inside forked, " +
      "agent-created, and channel chats, and limited to a few per chat " +
      "in a short window.",
    inputSchema: createThreadShape,
    alwaysLoad: true,
    searchHint:
      "Create a new chat thread immediately and open it in the operator's window.",
    handler: (args) =>
      Effect.gen(function* () {
        const threadId = currentThreadId()
        if (!threadId) {
          return yield* Effect.fail(
            new ToolError({
              tool: "create_thread",
              op: "create",
              cause: "no chat session is bound",
            }),
          )
        }
        const refusal = createGate(threadId, nowMs())
        if (refusal !== null) {
          return yield* Effect.fail(
            new ToolError({ tool: "create_thread", op: "create", cause: refusal }),
          )
        }
        const row = yield* store.propose({
          parentThreadId: threadId,
          title: args.title,
          summary: args.title,
          seed: args.seed,
          nowMs: nowMs(),
          mode: "create",
        })
        return {
          ok: true,
          requestId: row.id,
          message:
            "New chat requested. The server creates it, sends your seed as its " +
            "first message, and the operator's window switches to it.",
        }
      }),
  })

  return [forkThread, createThread] as const
}

/** Re-export tag for chat-server createThread tags. */
export { FORK_CHILD_TAG, ForkProposalStore }
