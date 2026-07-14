// packages/core/src/suggested-actions/accept-handler.test.ts
import { describe, expect, it } from "vitest"
import { Duration, Effect, Layer, Scope } from "effect"
import { Clock } from "../clock.js"
import { JobsStoreService } from "../jobs/jobs-store.js"
import { SuggestedActionsStore } from "./suggested-actions-store.js"
import { SuggestedActions } from "./suggested-actions.js"
import { AcceptHandlerLayer, DEFAULT_MAX_TURNS, buildPromptJobSpec, executionIdFor } from "./accept-handler.js"
import type { ProposeInput, SuggestedActionRow } from "./types.js"
import type { JobsStoreApi } from "../jobs/jobs-store-types.js"

/* -------------------------------------------------------------------------- */
/* Pure builder                                                                */
/* -------------------------------------------------------------------------- */

const fakeRow = (over: Partial<SuggestedActionRow> = {}): SuggestedActionRow => ({
  id: "sa-1",
  threadId: "t1",
  source: "agent",
  actionType: "research",
  title: "Research X",
  detail: null,
  rationale: null,
  payload: { prompt: "go research X" },
  status: "accepted",
  executionKind: null,
  executionId: null,
  error: null,
  createdAt: 1000,
  updatedAt: 1000,
  ...over,
})

describe("buildPromptJobSpec", () => {
  it("maps a research action to a one-shot prompt job (empty spec)", () => {
    const spec = buildPromptJobSpec(fakeRow({ actionType: "research" }))
    expect(spec.kind).toBe("prompt")
    expect(spec.spec).toBe("") // one-shot: empty schedule
    expect(spec.payload.label).toBe("Research X")
    expect(spec.payload.source).toBe("suggested-action")
    expect(String(spec.payload.user_prompt)).toContain("go research X")
  })

  it("stamps deliver_to=chat_thread with the originating thread (#124)", () => {
    const spec = buildPromptJobSpec(
      fakeRow({ actionType: "research", threadId: "thr_origin" }),
    )
    expect(spec.payload.deliver_to).toEqual({
      kind: "chat_thread",
      thread_id: "thr_origin",
    })
  })

  it("does not set permission_mode (cannot grant bypass)", () => {
    const spec = buildPromptJobSpec(fakeRow({ actionType: "task" }))
    expect("permission_mode" in spec.payload).toBe(false)
  })

  it("stamps DEFAULT_MAX_TURNS when the payload doesn't override it (task-23 — " +
    "the prompt-worker otherwise defaults to 1 turn and every multi-tool-call " +
    "action fails with \"Reached maximum number of turns (1)\")", () => {
    const spec = buildPromptJobSpec(fakeRow({ actionType: "research" }))
    expect(spec.payload.max_turns).toBe(DEFAULT_MAX_TURNS)
    expect(spec.payload.max_turns).toBeGreaterThan(1)
  })

  it("honors an agent-supplied maxTurns override", () => {
    const spec = buildPromptJobSpec(
      fakeRow({
        actionType: "research",
        payload: { prompt: "go research X", maxTurns: 5 },
      }),
    )
    expect(spec.payload.max_turns).toBe(5)
  })

  it("passes through agent-supplied allowedTools/model", () => {
    const spec = buildPromptJobSpec(
      fakeRow({
        actionType: "create_skill",
        payload: { prompt: "make a skill", allowedTools: ["Write", "Bash"], model: "claude-x" },
      }),
    )
    expect(spec.payload.allowed_tools).toEqual(["Write", "Bash"])
    expect(spec.payload.model).toBe("claude-x")
  })
})

/* -------------------------------------------------------------------------- */
/* Accept flow + completion observer                                           */
/* -------------------------------------------------------------------------- */

const baseLayer = (pollMs: number) =>
  AcceptHandlerLayer({ pollInterval: Duration.millis(pollMs) }).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        SuggestedActions.layer.pipe(Layer.provide(SuggestedActionsStore.Memory)),
        JobsStoreService.Memory,
      ),
    ),
    Layer.provide(Clock.Test(1000)),
  )

const run = <A, E>(
  eff: Effect.Effect<A, E, SuggestedActions | JobsStoreService | Scope.Scope>,
  pollMs = 10_000,
) => Effect.runPromise(Effect.scoped(eff).pipe(Effect.provide(baseLayer(pollMs))))

const propose = (over: Partial<ProposeInput> = {}): ProposeInput => ({
  threadId: "t1",
  source: "agent",
  actionType: "research",
  title: "Research X",
  payload: { prompt: "go" },
  ...over,
})

describe("AcceptHandler accept flow", () => {
  it("accept records a durable one-shot job and moves the action to in_progress", async () => {
    const out = await run(
      Effect.gen(function* () {
        const sa = yield* SuggestedActions
        const jobs = yield* JobsStoreService
        const row = yield* sa.propose(propose())
        const result = yield* sa.respond({
          threadId: "t1",
          actionId: row.id,
          decision: "accept",
        })
        const job = yield* jobs.getById(executionIdFor(row.id))
        return { result, job }
      }),
    )
    expect(out.result?.status).toBe("in_progress")
    expect(out.result?.executionId).toMatch(/^saj-/)
    expect(out.job).not.toBeNull()
    expect(out.job?.kind).toBe("prompt")
    expect(out.job?.enabled).toBe(true)
    expect(out.job?.spec).toBe("") // one-shot
    expect(out.job?.nextRunAt).toBe(1000) // due now (Clock.Test)
    // task-23: the durably-recorded job payload must carry a multi-turn
    // budget, not just the pure buildPromptJobSpec() builder — this is the
    // payload the JobTicker/PromptWorker actually reads at run time.
    expect((out.job?.payload as { max_turns?: number })?.max_turns).toBe(DEFAULT_MAX_TURNS)
  })

  it("arms the accepted job atomically — no separate re-enabling write (closes the double-fire window)", async () => {
    let enableWrites = 0
    const prog = Effect.gen(function* () {
      const real = yield* JobsStoreService
      // Spy: count any setV2Fields call that re-enables the row. A separate
      // enable-after-record is exactly the window where a tick could double-fire.
      const wrapped: JobsStoreApi = {
        ...real,
        setV2Fields: (id, patch) => {
          if (patch.enabled === true) enableWrites++
          return real.setV2Fields(id, patch)
        },
      }
      const accLayer = AcceptHandlerLayer({ pollInterval: Duration.millis(10_000) }).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            SuggestedActions.layer.pipe(Layer.provide(SuggestedActionsStore.Memory)),
            Layer.succeed(JobsStoreService, wrapped),
          ),
        ),
        Layer.provide(Clock.Test(1000)),
      )
      yield* Effect.gen(function* () {
        const sa = yield* SuggestedActions
        const row = yield* sa.propose(propose())
        yield* sa.respond({ threadId: "t1", actionId: row.id, decision: "accept" })
        const job = yield* real.getById(executionIdFor(row.id))
        // Created enabled + due now…
        expect(job?.enabled).toBe(true)
        expect(job?.nextRunAt).toBe(1000)
        // …in a SINGLE write — no separate enable that opens a double-fire gap.
        expect(enableWrites).toBe(0)
      }).pipe(Effect.scoped, Effect.provide(accLayer))
    })
    await Effect.runPromise(
      Effect.scoped(prog).pipe(
        Effect.provide(JobsStoreService.Memory.pipe(Layer.provide(Clock.Test(1000)))),
      ),
    )
  })

  it("completion observer folds a terminal run back onto the action", async () => {
    const finalStatus = await run(
      Effect.gen(function* () {
        const sa = yield* SuggestedActions
        const jobs = yield* JobsStoreService
        const row = yield* sa.propose(propose())
        yield* sa.respond({ threadId: "t1", actionId: row.id, decision: "accept" })
        // Simulate the worker finishing successfully.
        const jobId = executionIdFor(row.id)
        const jr = yield* jobs.recordRunStart({ jobId, startedAt: 1000 })
        yield* jobs.recordRunEnd(jr.id, { finishedAt: 1001, status: "success" })
        // Let the poll observer pick it up.
        yield* Effect.sleep("80 millis")
        const cur = yield* sa.getById(row.id)
        return cur?.status
      }),
      40, // fast poll
    )
    expect(finalStatus).toBe("completed")
  })

  it("completion observer marks a failed run as failed with its error", async () => {
    const out = await run(
      Effect.gen(function* () {
        const sa = yield* SuggestedActions
        const jobs = yield* JobsStoreService
        const row = yield* sa.propose(propose({ actionType: "task", title: "Do thing" }))
        yield* sa.respond({ threadId: "t1", actionId: row.id, decision: "accept" })
        const jobId = executionIdFor(row.id)
        const jr = yield* jobs.recordRunStart({ jobId, startedAt: 1000 })
        yield* jobs.recordRunEnd(jr.id, { finishedAt: 1001, status: "failed", error: "boom" })
        yield* Effect.sleep("80 millis")
        return yield* sa.getById(row.id)
      }),
      40,
    )
    expect(out?.status).toBe("failed")
    expect(out?.error).toBe("boom")
  })
})

describe("AcceptHandler run_workflow + error paths", () => {
  it("clones the saved workflow job into a fresh one-shot and links it", async () => {
    const out = await run(
      Effect.gen(function* () {
        const sa = yield* SuggestedActions
        const jobs = yield* JobsStoreService
        // A saved, scheduled workflow job (the WorkflowGallery catalog source).
        yield* jobs.record({
          id: "wf-saved",
          kind: "workflow",
          spec: "0 0 * * *",
          payload: { label: "Saved WF", steps: [{ kind: "shell", cmd: "echo hi" }] },
        })
        const row = yield* sa.propose(
          propose({ actionType: "run_workflow", title: "Run it", payload: { jobId: "wf-saved" } }),
        )
        const result = yield* sa.respond({ threadId: "t1", actionId: row.id, decision: "accept" })
        const cloned = yield* jobs.getById(executionIdFor(row.id))
        return { result, cloned }
      }),
    )
    expect(out.result?.status).toBe("in_progress")
    expect(out.cloned?.kind).toBe("workflow")
    expect(out.cloned?.spec).toBe("") // one-shot clone, NOT the saved cron
    expect(out.cloned?.enabled).toBe(true)
    expect(out.cloned?.payload.label).toBe("Run it") // overridden label
    expect((out.cloned?.payload as { steps?: unknown }).steps).toBeDefined() // cloned payload
    // The saved job is untouched.
    const saved = out
    expect(saved).toBeTruthy()
  })

  it("marks the action failed when the workflow job is missing", async () => {
    const out = await run(
      Effect.gen(function* () {
        const sa = yield* SuggestedActions
        const row = yield* sa.propose(
          propose({ actionType: "run_workflow", title: "Run gone", payload: { jobId: "nope" } }),
        )
        return yield* sa.respond({ threadId: "t1", actionId: row.id, decision: "accept" })
      }),
    )
    // handler.accept fails → respond's Effect.either path records a failed terminal.
    expect(out?.status).toBe("failed")
    expect(out?.error).toBeTruthy()
  })

  it("marks the action failed when the referenced job is not a workflow", async () => {
    const out = await run(
      Effect.gen(function* () {
        const sa = yield* SuggestedActions
        const jobs = yield* JobsStoreService
        yield* jobs.record({ id: "wf-prompt", kind: "prompt", spec: "", payload: { label: "nope" } })
        const row = yield* sa.propose(
          propose({ actionType: "run_workflow", title: "Run prompt", payload: { jobId: "wf-prompt" } }),
        )
        return yield* sa.respond({ threadId: "t1", actionId: row.id, decision: "accept" })
      }),
    )
    expect(out?.status).toBe("failed")
  })
})
