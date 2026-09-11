/**
 * define-worker.test.ts — tests for the shared `buildWorker` catch-all that
 * wraps the brokered reasoner lanes (dream, wake, bulletin — see
 * wake-worker.ts / dream-worker.ts, both built via `defineWorkerLayer`).
 *
 * Those lanes run through a caller-typed reasoner effect whose failures
 * arrive here as OPAQUE causes (not already a `WorkerError`), so this is the
 * one place a thrown/failed budget-ceiling message for those three lanes can
 * become the typed, non-retryable `budget_exhausted` reason instead of the
 * generic `worker_failed` the ticker would otherwise retry three times
 * against an identical, unwinnable budget.
 *
 * Deterministic, no SQLite, no Clock — same shape as worker-registry.test.ts.
 */
import { describe, expect, it } from "vitest"
import { Context, Effect } from "effect"
import { buildWorker } from "./define-worker.js"
import { WorkerError, type WorkerContext, type WorkerKindSpec } from "./worker-registry.js"

const jobCtx: WorkerContext = { jobId: "j", runId: 1, attempt: 1, deadline: 0 }
const emptyCtx: Context.Context<never> = Context.empty()

/** Build a one-shot spec whose `run` always fails with `cause`. */
const specThatFails = (cause: unknown): WorkerKindSpec<never> => ({
  kind: "dream",
  defaultTimeoutMs: () => 60_000,
  run: () => Effect.fail(cause),
})

describe("buildWorker (define-worker.ts catch-all)", () => {
  it("wraps a non-WorkerError cause carrying the production budget-ceiling string as reason='budget_exhausted'", async () => {
    // This is what protects dream/wake/bulletin: their reasoner effects fail
    // through a caller-typed error channel, so a thrown SDK budget ceiling
    // arrives here as an opaque `unknown` cause, never already a WorkerError.
    // Reverting the `isBudgetCeilingCause(e)` check in define-worker.ts's
    // `buildWorker` back to an unconditional "worker_failed" would fail this.
    const cause = new Error(
      "Claude Code returned an error result: Reached maximum number of turns (15)",
    )
    const worker = buildWorker(specThatFails(cause), emptyCtx, "dream")
    const result = await Effect.runPromise(
      Effect.result(worker({}, jobCtx)),
    )
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.failure).toBeInstanceOf(WorkerError)
      expect(result.failure.reason).toBe("budget_exhausted")
      expect(result.failure.kind).toBe("dream")
      expect(result.failure.cause).toBe(cause)
    }
  })

  it("wraps an unrelated cause as reason='worker_failed' (not everything is a budget ceiling)", async () => {
    const cause = new Error("ECONNRESET: socket hang up")
    const worker = buildWorker(specThatFails(cause), emptyCtx, "wake")
    const result = await Effect.runPromise(
      Effect.result(worker({}, jobCtx)),
    )
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.failure).toBeInstanceOf(WorkerError)
      expect(result.failure.reason).toBe("worker_failed")
      expect(result.failure.kind).toBe("wake")
    }
  })

  it("passes an already-typed WorkerError failure through unchanged (no double-wrap)", async () => {
    const original = new WorkerError({
      reason: "bad_payload",
      kind: "bulletin",
      message: "already typed, should not be re-classified",
    })
    const worker = buildWorker(specThatFails(original), emptyCtx, "bulletin")
    const result = await Effect.runPromise(
      Effect.result(worker({}, jobCtx)),
    )
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.failure).toBe(original)
      expect(result.failure.reason).toBe("bad_payload")
    }
  })
})
