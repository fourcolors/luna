/**
 * workflow-worker.test.ts — Tier-1 tests for the Phase-12b workflow worker.
 *
 * Uses real child_process for shell steps (the tests run safe `echo` /
 * `false` / `sh -c "exit N"` commands so they're hermetic + fast) and
 * SDKClient.fake for prompt sub-steps. ZERO model calls.
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import {
  AgentNotesService,
  Clock,
  WorkerRegistry,
  WorkerError,
  makeWorkerRegistry,
  type WorkerContext,
} from "@luna/core"
import { SDKClient } from "../src/sdk-client.js"
import {
  WorkflowWorkerLayer,
  buildWorkflowWorker,
  parseWorkflowPayload,
  type WorkflowPayload,
  type ShellStepResult,
  type PromptStepResult,
} from "../src/workflow-worker.js"
import { makeFakeQuery } from "./fake-sdk.js"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"

const fakeClientWithText = (text: string): Layer.Layer<SDKClient> =>
  SDKClient.fake(() => {
    const result = {
      type: "result", subtype: "success", session_id: "s", uuid: "u",
      is_error: false, duration_ms: 5, duration_api_ms: 3, num_turns: 1,
      result: text,
    } as unknown as SDKMessage
    return makeFakeQuery({ messages: [result] }).query
  })

const ctx: WorkerContext = { jobId: "wf-test", runId: 1, attempt: 1, deadline: 0 }
const TestNotes = AgentNotesService.Memory.pipe(Layer.provide(Clock.Default))

describe("parseWorkflowPayload", () => {
  it("accepts a single shell step", () => {
    const r = parseWorkflowPayload({ steps: [{ kind: "shell", cmd: "echo hi" }] })
    expect(typeof r).not.toBe("string")
    expect((r as WorkflowPayload).steps.length).toBe(1)
    expect((r as WorkflowPayload).halt_on_failure).toBe(true)
  })

  it("accepts a mixed shell + prompt sequence", () => {
    const r = parseWorkflowPayload({
      steps: [
        { kind: "shell", cmd: "echo a" },
        { kind: "prompt", user_prompt: "summarise" },
      ],
      halt_on_failure: false,
    }) as WorkflowPayload
    expect(r.steps.length).toBe(2)
    expect(r.halt_on_failure).toBe(false)
  })

  it("rejects missing steps / empty steps / wrong step shape", () => {
    expect(parseWorkflowPayload({})).toMatch(/steps/)
    expect(parseWorkflowPayload({ steps: [] })).toMatch(/non-empty/)
    expect(parseWorkflowPayload({ steps: [{ kind: "shell" }] })).toMatch(/cmd/)
    expect(parseWorkflowPayload({ steps: [{ kind: "frobnicate" }] })).toMatch(/kind/)
  })

  it("rejects non-string user_prompt on prompt steps", () => {
    expect(parseWorkflowPayload({ steps: [{ kind: "prompt", user_prompt: "" }] }))
      .toMatch(/user_prompt/)
  })

  it("filters non-string entries out of allowed_tools", () => {
    const r = parseWorkflowPayload({
      steps: [{ kind: "prompt", user_prompt: "x", allowed_tools: ["good", 1, "ok"] }],
    }) as WorkflowPayload
    expect((r.steps[0] as any).allowed_tools).toEqual(["good", "ok"])
  })

  it("clamps timeout_ms to >= 1 and truncates fractions", () => {
    const r = parseWorkflowPayload({
      steps: [{ kind: "shell", cmd: "x", timeout_ms: 2.7 }],
    }) as WorkflowPayload
    expect((r.steps[0] as any).timeout_ms).toBe(2)
  })
})

describe("buildWorkflowWorker — shell steps", () => {
  it("runs a single successful shell step → outputText + steps_json contains success", async () => {
    const sdkLayer = fakeClientWithText("never invoked")
    const prog = Effect.gen(function* () {
      const sdk = yield* SDKClient
      const notes = yield* AgentNotesService
      const worker = buildWorkflowWorker(sdk, notes)
      const result = yield* worker(
        { steps: [{ kind: "shell", cmd: "echo hi" }] },
        ctx,
      )
      expect(result.outputText).toMatch(/shell exit=0/)
      const steps = JSON.parse(result.stepsJson!)
      expect(steps.steps[0].status).toBe("success")
      expect(steps.steps[0].stdout).toMatch(/hi/)
      expect(steps.halted_at).toBeNull()
    })
    await Effect.runPromise(prog.pipe(Effect.provide(Layer.mergeAll(sdkLayer, TestNotes))))
  })

  it("runs two successful shell steps in order", async () => {
    const sdkLayer = fakeClientWithText("noop")
    const prog = Effect.gen(function* () {
      const sdk = yield* SDKClient
      const notes = yield* AgentNotesService
      const worker = buildWorkflowWorker(sdk, notes)
      const result = yield* worker(
        {
          steps: [
            { kind: "shell", cmd: "echo first" },
            { kind: "shell", cmd: "echo second" },
          ],
        },
        ctx,
      )
      const steps = JSON.parse(result.stepsJson!) as {
        steps: ShellStepResult[]
      }
      expect(steps.steps.length).toBe(2)
      expect(steps.steps[0]?.stdout).toMatch(/first/)
      expect(steps.steps[1]?.stdout).toMatch(/second/)
    })
    await Effect.runPromise(prog.pipe(Effect.provide(Layer.mergeAll(sdkLayer, TestNotes))))
  })

  it("halt_on_failure=true: a non-zero shell step halts + worker fails", async () => {
    const sdkLayer = fakeClientWithText("noop")
    const prog = Effect.gen(function* () {
      const sdk = yield* SDKClient
      const notes = yield* AgentNotesService
      const worker = buildWorkflowWorker(sdk, notes)
      const result = yield* Effect.either(
        worker(
          {
            steps: [
              { kind: "shell", cmd: "echo ok" },
              { kind: "shell", cmd: "exit 7" },
              { kind: "shell", cmd: "echo SHOULD_NOT_RUN" },
            ],
          },
          ctx,
        ),
      )
      expect(result._tag).toBe("Left")
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(WorkerError)
        expect(result.left.reason).toBe("worker_failed")
        expect(result.left.message).toMatch(/halted at step 1/)
        // The cause should carry the partial step results
        const cause = result.left.cause as { steps: ShellStepResult[]; halted_at: number }
        expect(cause.steps.length).toBe(2)
        expect(cause.steps[1]?.exit_code).toBe(7)
        expect(cause.halted_at).toBe(1)
      }
    })
    await Effect.runPromise(prog.pipe(Effect.provide(Layer.mergeAll(sdkLayer, TestNotes))))
  })

  it("halt_on_failure=false: continues past failure + returns success", async () => {
    const sdkLayer = fakeClientWithText("noop")
    const prog = Effect.gen(function* () {
      const sdk = yield* SDKClient
      const notes = yield* AgentNotesService
      const worker = buildWorkflowWorker(sdk, notes)
      const result = yield* worker(
        {
          steps: [
            { kind: "shell", cmd: "echo ok" },
            { kind: "shell", cmd: "exit 9" },
            { kind: "shell", cmd: "echo finished" },
          ],
          halt_on_failure: false,
        },
        ctx,
      )
      const steps = JSON.parse(result.stepsJson!) as {
        steps: ShellStepResult[]
        halted_at: number | null
      }
      expect(steps.steps.length).toBe(3)
      expect(steps.steps[1]?.status).toBe("failed")
      expect(steps.steps[1]?.exit_code).toBe(9)
      expect(steps.steps[2]?.stdout).toMatch(/finished/)
      expect(steps.halted_at).toBeNull()
    })
    await Effect.runPromise(prog.pipe(Effect.provide(Layer.mergeAll(sdkLayer, TestNotes))))
  })

  it("step timeout: shell step that exceeds timeout_ms gets status='timeout'", async () => {
    const sdkLayer = fakeClientWithText("noop")
    const prog = Effect.gen(function* () {
      const sdk = yield* SDKClient
      const notes = yield* AgentNotesService
      const worker = buildWorkflowWorker(sdk, notes)
      const result = yield* Effect.either(
        worker(
          {
            steps: [{ kind: "shell", cmd: "sleep 5", timeout_ms: 100 }],
          },
          ctx,
        ),
      )
      expect(result._tag).toBe("Left")
      if (result._tag === "Left") {
        const cause = result.left.cause as { steps: ShellStepResult[] }
        expect(cause.steps[0]?.status).toBe("timeout")
      }
    })
    await Effect.runPromise(prog.pipe(Effect.provide(Layer.mergeAll(sdkLayer, TestNotes))))
  }, 10_000)
})

describe("buildWorkflowWorker — prompt steps", () => {
  it("runs a prompt step + returns success + output_text", async () => {
    const sdkLayer = fakeClientWithText("summary text")
    const prog = Effect.gen(function* () {
      const sdk = yield* SDKClient
      const notes = yield* AgentNotesService
      const worker = buildWorkflowWorker(sdk, notes)
      const result = yield* worker(
        { steps: [{ kind: "prompt", user_prompt: "summarise" }] },
        ctx,
      )
      const steps = JSON.parse(result.stepsJson!) as {
        steps: PromptStepResult[]
      }
      expect(steps.steps[0]?.status).toBe("success")
      expect(steps.steps[0]?.output_text).toBe("summary text")
    })
    await Effect.runPromise(prog.pipe(Effect.provide(Layer.mergeAll(sdkLayer, TestNotes))))
  })

  it("mixed sequence: shell → prompt → shell", async () => {
    const sdkLayer = fakeClientWithText("middle text")
    const prog = Effect.gen(function* () {
      const sdk = yield* SDKClient
      const notes = yield* AgentNotesService
      const worker = buildWorkflowWorker(sdk, notes)
      const result = yield* worker(
        {
          steps: [
            { kind: "shell", cmd: "echo a" },
            { kind: "prompt", user_prompt: "do thing" },
            { kind: "shell", cmd: "echo c" },
          ],
        },
        ctx,
      )
      const steps = JSON.parse(result.stepsJson!)
      expect(steps.steps.length).toBe(3)
      expect(steps.steps[0].kind).toBe("shell")
      expect(steps.steps[1].kind).toBe("prompt")
      expect(steps.steps[2].kind).toBe("shell")
    })
    await Effect.runPromise(prog.pipe(Effect.provide(Layer.mergeAll(sdkLayer, TestNotes))))
  })
})

describe("buildWorkflowWorker — payload validation", () => {
  it("bad payload → WorkerError(reason='bad_payload', kind='workflow')", async () => {
    const sdkLayer = fakeClientWithText("noop")
    const prog = Effect.gen(function* () {
      const sdk = yield* SDKClient
      const notes = yield* AgentNotesService
      const worker = buildWorkflowWorker(sdk, notes)
      const result = yield* Effect.either(
        worker({ steps: [] /* empty */ }, ctx),
      )
      expect(result._tag).toBe("Left")
      if (result._tag === "Left") {
        expect(result.left.reason).toBe("bad_payload")
        expect(result.left.kind).toBe("workflow")
      }
    })
    await Effect.runPromise(prog.pipe(Effect.provide(Layer.mergeAll(sdkLayer, TestNotes))))
  })
})

describe("WorkflowWorkerLayer", () => {
  it("registers a worker under 'workflow' that WorkerRegistry can dispatch", async () => {
    const sdkLayer = fakeClientWithText("noop")
    const exposed = WorkflowWorkerLayer().pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          sdkLayer,
          makeWorkerRegistry({}),
          TestNotes,
          Clock.Default,
        ),
      ),
    )
    const prog = Effect.gen(function* () {
      const reg = yield* WorkerRegistry
      const kinds = yield* reg.listKinds
      expect([...kinds]).toEqual(["workflow"])
      const out = yield* reg.dispatch(
        "workflow",
        { steps: [{ kind: "shell", cmd: "echo via_registry" }] },
        ctx,
      )
      const steps = JSON.parse(out.stepsJson!)
      expect(steps.steps[0].stdout).toMatch(/via_registry/)
    })
    await Effect.runPromise(prog.pipe(Effect.provide(exposed)))
  })
})
