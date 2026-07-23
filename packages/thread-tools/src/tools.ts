import { Effect } from "effect"
import { z } from "zod"
import { defineTool, ToolError } from "@luna/tools"
import { ForkProposalStore } from "./store.js"
import { FORK_CHILD_TAG } from "./types.js"

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

/**
 * `makeForkThreadTools(store, currentThreadId, isForkChildThread)` —
 * propose-mode only: stages a marker; does NOT create the sibling yet.
 * The operator clicks the marker to accept.
 *
 * `isForkChildThread()` implements the fork-loop guard: a thread created by
 * an accepted fork must not propose another fork on early turns.
 */
export const makeForkThreadTools = (
  store: {
    readonly propose: (input: {
      readonly parentThreadId: string
      readonly title: string
      readonly summary: string
      readonly seed: string
      readonly nowMs: number
    }) => Effect.Effect<{ readonly id: string }>
  },
  currentThreadId: () => string | null,
  isForkChildThread: () => boolean,
  nowMs: () => number = () => Date.now(),
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

  return [forkThread] as const
}

/** Re-export tag for chat-server createThread tags. */
export { FORK_CHILD_TAG, ForkProposalStore }
