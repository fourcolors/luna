// packages/core/src/suggested-actions/accept-handler.test.ts
import { describe, expect, it } from "vitest"
import { Duration, Effect, Layer, Scope } from "effect"
import { Clock } from "../clock.js"
import { JobsStoreService } from "../jobs/jobs-store.js"
import { SuggestedActionsStore } from "./suggested-actions-store.js"
import { SuggestedActions } from "./suggested-actions.js"
import { AcceptHandlerLayer, buildPromptJobSpec, executionIdFor } from "./accept-handler.js"
import type { ProposeInput, SuggestedActionRow } from "./types.js"

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

  it("does not set permission_mode (cannot grant bypass)", () => {
    const spec = buildPromptJobSpec(fakeRow({ actionType: "task" }))
    expect("permission_mode" in spec.payload).toBe(false)
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
