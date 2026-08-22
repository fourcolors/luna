/**
 * ChatThreadPoster — optional injection point that lets a job worker deliver a
 * finished result back INTO a chat thread (issue #124, the `chat_thread`
 * delivery sink).
 *
 * Mirrors `JobRunToolsProviderTag` / `ThreadToolsProviderTag`: the app
 * (chat-server) provides a thin implementation at boot that closes over the
 * resolved `ChatService`; the prompt worker resolves the Tag via
 * `Effect.serviceOption`, so omitting it leaves the worker's prior behaviour
 * intact — a `chat_thread` sink simply logs-and-drops when no poster is wired,
 * and no test / boot smoke needs to change.
 *
 * Why the Tag lives HERE and not in `@luna/chat-service`: adapter-sdk must NOT
 * depend on chat-service (`chat-service → adapter-sdk` is the real edge — see
 * `chat-service` importing `SDKAdapter`; the reverse import would cycle and
 * break the build). The structural binding keeps this package's surface
 * SDK-only; chat-service depends on adapter-sdk for the Tag, never the reverse.
 * This is the exact rationale documented on `JobRunToolsProviderTag`.
 */
import { Context, type Effect } from "effect"

/** One result to deliver into a thread. */
export interface ChatThreadDelivery {
  /** Luna thread id (`thr_…`) the result should surface in. */
  readonly threadId: string
  /** The finished result text — rendered as an assistant message. */
  readonly text: string
  /**
   * Where the result came from (e.g. "suggested-action", "background-job",
   * "schedule"). Persisted on the delivered message + carried on the toast so
   * the UI can mark it "from a background task" rather than a live reply.
   */
  readonly source?: string
  /**
   * Human label for what finished (e.g. the job/action title). Drives the
   * "Luna finished X" notification. Falls back to a generic label when absent.
   */
  readonly label?: string
}

export interface ChatThreadPoster {
  /**
   * Deliver one result into a thread. Best-effort: the implementation never
   * fails the worker's run (a missing/closed thread is logged-and-dropped),
   * which is why the error channel is `never`. The result text is always
   * preserved in `job_runs.output_text` regardless.
   */
  readonly post: (delivery: ChatThreadDelivery) => Effect.Effect<void, never>
}

export const ChatThreadPosterTag = Context.Service<ChatThreadPoster>(
  "luna/ChatThreadPoster",
)
