/**
 * JobInputBridge — the server-side half of job-summoned operator input
 * (widget-system.md Phase 5). A running job's `request_input` tool calls
 * `request()`, which sends a `job-input-request` frame to EVERY connected
 * client and AWAITS the first `job-input-result`. This suspends the job's
 * model turn (the tool's Promise is unresolved) until an operator answers,
 * cancels, or the timeout elapses — the same pause-resume shape as the
 * secret-request bridge, with one structural difference:
 *
 * BROADCAST, NOT THREAD-TARGETED — a job has no owning chat thread, so
 * there is no single registered client to route to. Instead the bridge
 * keeps a Set of ALL connected clients (the server registers every
 * connection's send-handle when the bridge is configured) and fans the
 * request out. FIRST ANSWER WINS: the winning sender gets a
 * `job-input-status {ok:true}` ack; later/duplicate answers get
 * `{ok:false, "already answered"}`.
 *
 * CONTAINMENT — the answer is OPERATOR INPUT, not a secret: unlike the
 * secret bridge it IS returned to the caller (the tool hands it to the
 * job's model turn — that is the whole point). But it is still never
 * logged and never echoed into any frame: the only places the answer
 * exists are the inbound `job-input-result` frame and the resolved
 * Promise. The optional `log` dep receives request lifecycle metadata
 * only (requestId/runId/outcome), never the answer text.
 *
 * ONE PENDING REQUEST PER RUN — a second `request()` for a runId that
 * already has a request in flight fails cleanly (the job's tool sees
 * `{ok:false}`); it does not queue and does not clobber the live request.
 *
 * Timers are `unref`'d so a pending request never keeps the process alive.
 */
import { randomUUID } from "node:crypto"
import type {
  JobInputRequestFrame,
  JobInputResultFrame,
  JobInputStatusFrame,
} from "./protocol.js"

export type SendJobInputFrame = (
  frame: JobInputRequestFrame | JobInputStatusFrame,
) => void

/**
 * Outcome handed to the awaiting tool. `answer` is present ONLY on
 * `ok:true` — it is the operator's reply, destined for the job's model
 * turn. Never logged by this package.
 */
export type JobInputOutcome =
  | { readonly ok: true; readonly answer: string }
  | { readonly ok: false; readonly message: string }

export interface JobInputRequest {
  readonly runId: number
  readonly jobId: string
  readonly jobName: string
  /** What the job is asking — shown above the client's input field. */
  readonly prompt: string
  /** Wall-clock the operator has to respond before the request fails. */
  readonly timeoutMs: number
}

export interface JobInputBridgeDeps {
  /** Optional non-sensitive audit logger (ids/outcomes only — NEVER the answer). */
  readonly log?: (message: string) => void
}

export interface JobInputBridge {
  /**
   * Register a connected client's send-handle (called for EVERY connection
   * when the bridge is configured, at connection setup). `connId` is a
   * stable per-connection id so teardown can remove exactly this handle.
   */
  readonly registerClient: (connId: string, send: SendJobInputFrame) => void
  /**
   * Drop a client on connection teardown. Unknown/stale connIds are a
   * no-op. When the LAST client leaves while requests are pending, the
   * pending requests resolve failed (nobody is left who saw the prompt;
   * a client connecting later never receives the frame — no replay).
   */
  readonly unregisterClient: (connId: string) => void
  /**
   * Broadcast a `job-input-request` and await the first answer. Resolves
   * `{ok:true, answer}` on the winning `job-input-result`, or `{ok:false}`
   * on cancel / timeout / no-clients / duplicate-run.
   */
  readonly request: (input: JobInputRequest) => Promise<JobInputOutcome>
  /**
   * Inbound `job-input-result` from a client. `replyTo` is THAT sender's
   * send-handle — used for the win/already-answered status ack.
   */
  readonly acceptResult: (
    frame: JobInputResultFrame,
    replyTo: SendJobInputFrame,
  ) => void
}

interface PendingRequest {
  readonly runId: number
  readonly resolve: (r: JobInputOutcome) => void
  readonly timer: ReturnType<typeof setTimeout>
}

export const createJobInputBridge = (
  deps: JobInputBridgeDeps = {},
): JobInputBridge => {
  const clients = new Map<string, SendJobInputFrame>()
  const pending = new Map<string, PendingRequest>()

  const broadcast = (
    frame: JobInputRequestFrame | JobInputStatusFrame,
  ): void => {
    for (const send of clients.values()) {
      try {
        send(frame)
      } catch {
        // A dying socket must not poison the fan-out to healthy clients.
      }
    }
  }

  const settle = (requestId: string, outcome: JobInputOutcome): void => {
    const entry = pending.get(requestId)
    if (entry === undefined) return
    clearTimeout(entry.timer)
    pending.delete(requestId)
    entry.resolve(outcome)
  }

  const registerClient = (connId: string, send: SendJobInputFrame): void => {
    clients.set(connId, send)
  }

  const unregisterClient = (connId: string): void => {
    if (!clients.delete(connId)) return
    if (clients.size > 0) return
    // Last client gone: nobody who saw the prompt can answer any more, and
    // a future connection never receives the frame (no replay). Fail the
    // pending requests now instead of holding the job until timeout.
    for (const requestId of [...pending.keys()]) {
      deps.log?.(
        `[job-input] ${requestId} cancelled (last client disconnected)`,
      )
      settle(requestId, {
        ok: false,
        message: "No connected client is left to answer.",
      })
    }
  }

  const request = (input: JobInputRequest): Promise<JobInputOutcome> => {
    if (clients.size === 0) {
      return Promise.resolve({
        ok: false,
        message:
          "No connected Luna client to ask. Open the Moon (or web UI) and re-run the job.",
      })
    }
    for (const p of pending.values()) {
      if (p.runId === input.runId) {
        return Promise.resolve({
          ok: false,
          message: `An input request is already pending for run ${input.runId}.`,
        })
      }
    }

    const requestId = `jin_${randomUUID()}`
    deps.log?.(
      `[job-input] ${requestId} requesting input for run=${input.runId} job=${input.jobId} (timeout ${input.timeoutMs}ms)`,
    )
    return new Promise<JobInputOutcome>((resolve) => {
      const timer = setTimeout(() => {
        deps.log?.(`[job-input] ${requestId} timed out`)
        settle(requestId, {
          ok: false,
          message: "Timed out waiting for the operator to answer.",
        })
        // Tell every client the prompt expired so their panels dismiss.
        broadcast({
          type: "job-input-status",
          requestId,
          ok: false,
          message: "Timed out waiting for input.",
        })
      }, input.timeoutMs)
      if (typeof timer.unref === "function") timer.unref()

      pending.set(requestId, { runId: input.runId, resolve, timer })

      broadcast({
        type: "job-input-request",
        requestId,
        runId: input.runId,
        jobId: input.jobId,
        jobName: input.jobName,
        prompt: input.prompt,
        timeoutMs: input.timeoutMs,
      })
    })
  }

  const acceptResult = (
    frame: JobInputResultFrame,
    replyTo: SendJobInputFrame,
  ): void => {
    const entry = pending.get(frame.requestId)
    if (entry === undefined) {
      // Late or duplicate answer — the request already settled (first
      // answer won, it timed out, or it never existed). Ack the sender so
      // its UI can settle; the answer value is dropped unread.
      try {
        replyTo({
          type: "job-input-status",
          requestId: frame.requestId,
          ok: false,
          message: "Already answered (or expired).",
        })
      } catch {
        // Best-effort ack.
      }
      return
    }

    if (
      frame.cancelled === true ||
      typeof frame.answer !== "string" ||
      frame.answer.length === 0
    ) {
      deps.log?.(`[job-input] ${frame.requestId} cancelled by operator`)
      settle(frame.requestId, {
        ok: false,
        message: "The operator cancelled the input request.",
      })
      try {
        replyTo({
          type: "job-input-status",
          requestId: frame.requestId,
          ok: true,
          message: "Cancelled.",
        })
      } catch {
        // Best-effort ack.
      }
      return
    }

    // Winning answer. The value goes ONLY into the resolved Promise (the
    // awaiting tool) — never into a log line or an outbound frame.
    deps.log?.(`[job-input] ${frame.requestId} answered`)
    settle(frame.requestId, { ok: true, answer: frame.answer })
    try {
      replyTo({
        type: "job-input-status",
        requestId: frame.requestId,
        ok: true,
        message: "Answer delivered to the job.",
      })
    } catch {
      // Best-effort ack — the job already has its answer.
    }
  }

  return {
    registerClient,
    unregisterClient,
    request,
    acceptResult,
  }
}
