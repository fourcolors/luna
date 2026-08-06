/**
 * release-workflow.integration.test.ts — Phase 12b P8.
 *
 * The unit tests in workflow-worker.test.ts exercise `buildWorkflowWorker`
 * in isolation (by invoking the worker function directly). The smoke
 * (apps/server/scripts/smoke/workflow-worker-boot.smoke.ts) proves the
 * Layer composes and the WorkerRegistry sees the "workflow" kind.
 *
 * THIS file fills the middle gap: a real end-to-end dispatch path test
 * that proves a workflow row INSERTed into JobsStore is picked up by the
 * JobTicker, dispatched via WorkerRegistry to WorkflowWorker, executed
 * step-by-step, and recorded in `job_runs` with the right shape.
 *
 * Models a "release workflow" — the canonical multi-step use case from
 * issue #47: shell preflight → shell verify → prompt summarise. ZERO real
 * model calls (SDKClient.fake) and no real DB (JobsStore.Memory). Shell
 * steps use safe `echo` / `exit` so the test is hermetic.
 *
 * Scenarios:
 *   (1) Happy path: 3-step workflow (shell + shell + prompt) → job_runs
 *       row status='success' + steps_json contains 3 success records +
 *       outputText populated.
 *   (2) halt_on_failure: middle shell step exits non-zero → workflow
 *       halts → job_runs status='failed' + steps_json shows 1 success,
 *       1 failed, third step not run.
 *   (3) Idempotency: a second drain of the same store does NOT re-fire
 *       the row that was just claimed.
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer, Duration } from "effect"
import {
  AgentNotesService,
  Clock,
  JobTicker,
  JobTickerLayer,
  JobsStoreService,
  makeWorkerRegistry,
} from "@luna/core"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { SDKClient } from "../src/sdk-client.js"
import { WorkflowWorkerLayer } from "../src/workflow-worker.js"
import { makeFakeQuery } from "./fake-sdk.js"

/** Build a fake SDK that returns a single canned text result. */
const fakeClientWithText = (text: string): Layer.Layer<SDKClient> =>
  SDKClient.fake(() => {
    const result = {
      type: "result",
      subtype: "success",
      session_id: "s",
      uuid: "u",
      is_error: false,
      duration_ms: 5,
      duration_api_ms: 3,
      num_turns: 1,
      result: text,
    } as unknown as SDKMessage
    return makeFakeQuery({ messages: [result] }).query
  })

/**
 * Build the full integration stack: ticker + memory store + registry
 * populated with the real WorkflowWorker (closed over a fake SDK +
 * memory notes store).
 */
const buildReleaseStack = (sdkReply: string) => {
  const sdkL = fakeClientWithText(sdkReply)
  const notesL = AgentNotesService.Memory.pipe(Layer.provide(Clock.Default))
  const storeL = JobsStoreService.Memory.pipe(Layer.provide(Clock.Default))

  // WorkflowWorkerLayer registers "workflow" into the registry as a
  // side-effect of its build. The registry it consumes is the SAME one
  // the ticker reads — composed inside one provideMerge so the Layer
  // memoization keeps both views pointing at the same Ref.
  const workersL = WorkflowWorkerLayer().pipe(
    Layer.provideMerge(
      Layer.mergeAll(sdkL, makeWorkerRegistry({}), notesL),
    ),
  )

  // job-ticker-producer-executor-276 (critic amendment 5): `autoStart`
  // defaults to true, and `Effect.repeat(loop, Schedule.fixed)` runs the loop
  // body once EAGERLY at fork - so a background producer drain would race
  // this file's explicit `ticker.drain` calls on the shared store. That
  // latent race got easier to trip once the producer started forking real
  // dispatches (the auto-loop could claim the armed job before an explicit
  // drain runs). autoStart:false keeps only the explicit drains live, same
  // as job-ticker.test.ts's buildStack.
  return JobTickerLayer({ tickInterval: Duration.seconds(60), autoStart: false }).pipe(
    Layer.provideMerge(Layer.mergeAll(storeL, workersL, Clock.Default)),
  )
}

describe("release workflow integration (P8)", () => {
  it("(1) happy path: shell + shell + prompt → job_runs success + 3 steps recorded", async () => {
    const stack = buildReleaseStack(
      "Release notes: bumped scheduler to v2; included PRs #51 #53 #55 #57.",
    )

    const prog = Effect.gen(function* () {
      const store = yield* JobsStoreService
      const ticker = yield* JobTicker

      // Seed a release-shaped workflow row.
      yield* store.record({
        id: "release-test-1",
        kind: "workflow",
        spec: "0 9 * * *",
        payload: {
          label: "release-test",
          steps: [
            { kind: "shell", cmd: "echo 'preflight: checking branches'" },
            { kind: "shell", cmd: "echo 'verify: tests passing'" },
            {
              kind: "prompt",
              user_prompt: "Summarise the release in one sentence.",
            },
          ],
          halt_on_failure: true,
        },
      })
      yield* store.setV2Fields("release-test-1", {
        schedule: "0 9 * * *",
        nextRunAt: 0, // overdue → ticker claims immediately
      })

      const summary = yield* ticker.drain
      expect(summary.considered).toBe(1)
      expect(summary.claimed).toBe(1)
      expect(summary.forked).toBe(1)
      // issue #276: drain returns as soon as the dispatch is FORKED - await
      // the executor before reading job_runs.
      yield* ticker.awaitIdle

      const runs = yield* store.listRuns("release-test-1")
      expect(runs.length).toBe(1)
      const run = runs[0]!
      expect(run.status).toBe("success")
      expect(run.outputText).toBeTruthy()
      expect(run.stepsJson).toBeTruthy()

      const stepsParsed = JSON.parse(run.stepsJson!) as {
        steps: ReadonlyArray<{ status: string; stdout?: string }>
        halted_at: number | null
      }
      expect(stepsParsed.steps.length).toBe(3)
      expect(stepsParsed.steps[0]?.status).toBe("success")
      expect(stepsParsed.steps[1]?.status).toBe("success")
      expect(stepsParsed.steps[2]?.status).toBe("success")
      expect(stepsParsed.halted_at).toBeNull()
      // Shell stdout flows through the per-step record.
      expect(stepsParsed.steps[0]?.stdout).toMatch(/preflight/)
      expect(stepsParsed.steps[1]?.stdout).toMatch(/verify/)
    })

    await Effect.runPromise(prog.pipe(Effect.provide(stack)))
  })

  it("(2) halt_on_failure=true: middle shell step fails → workflow halts + job_runs failed", async () => {
    const stack = buildReleaseStack("never reached")

    const prog = Effect.gen(function* () {
      const store = yield* JobsStoreService
      const ticker = yield* JobTicker

      yield* store.record({
        id: "release-test-2",
        kind: "workflow",
        spec: "0 9 * * *",
        payload: {
          label: "release-halt",
          steps: [
            { kind: "shell", cmd: "echo 'preflight ok'" },
            // sh -c "exit 1" — non-zero → halt with halt_on_failure=true.
            { kind: "shell", cmd: "sh -c 'exit 1'" },
            {
              kind: "prompt",
              user_prompt: "Should never be invoked.",
            },
          ],
          halt_on_failure: true,
        },
      })
      yield* store.setV2Fields("release-test-2", {
        schedule: "0 9 * * *",
        nextRunAt: 0,
      })

      const summary = yield* ticker.drain
      expect(summary.considered).toBe(1)
      expect(summary.claimed).toBe(1)
      expect(summary.forked).toBe(1)
      // Worker raised a WorkerError - visible in job_runs once the executor
      // closes it (issue #276: `drain` no longer knows the outcome itself).
      yield* ticker.awaitIdle

      const runs = yield* store.listRuns("release-test-2")
      expect(runs.length).toBe(1)
      const run = runs[0]!
      expect(run.status).toBe("failed")
      expect(run.error).toBeTruthy()
      expect(run.stepsJson).toBeTruthy()

      const stepsParsed = JSON.parse(run.stepsJson!) as {
        steps: ReadonlyArray<{ status: string }>
        halted_at: number | null
      }
      // Step 1 ran + succeeded, step 2 ran + failed, step 3 not present.
      expect(stepsParsed.steps.length).toBe(2)
      expect(stepsParsed.steps[0]?.status).toBe("success")
      expect(stepsParsed.steps[1]?.status).toBe("failed")
      expect(stepsParsed.halted_at).toBe(1)
    })

    await Effect.runPromise(prog.pipe(Effect.provide(stack)))
  })

  it("(3) a second drain does not re-fire the same row (atomic claim advanced next_run_at)", async () => {
    const stack = buildReleaseStack("noop")

    const prog = Effect.gen(function* () {
      const store = yield* JobsStoreService
      const ticker = yield* JobTicker

      yield* store.record({
        id: "release-test-3",
        kind: "workflow",
        spec: "0 9 * * *",
        payload: {
          label: "release-idempotent",
          steps: [{ kind: "shell", cmd: "echo once" }],
          halt_on_failure: true,
        },
      })
      yield* store.setV2Fields("release-test-3", {
        schedule: "0 9 * * *",
        nextRunAt: 0,
      })

      const first = yield* ticker.drain
      expect(first.claimed).toBe(1)
      expect(first.forked).toBe(1)

      // issue #276: `claimAndStartRun` advances next_run_at SYNCHRONOUSLY in
      // the producer (before the fork), so the second drain's `considered:0`
      // doesn't need `awaitIdle` - but the run row itself is only written
      // once the executor closes it, so await before reading `listRuns`.
      const second = yield* ticker.drain
      // The first drain advanced next_run_at past `now`, so listDue
      // returns nothing on the second pass — no double-fire.
      expect(second.considered).toBe(0)
      expect(second.claimed).toBe(0)

      yield* ticker.awaitIdle
      const runs = yield* store.listRuns("release-test-3")
      expect(runs.length).toBe(1)
    })

    await Effect.runPromise(prog.pipe(Effect.provide(stack)))
  })
})
