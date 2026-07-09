/**
 * workflow-worker.test.ts — Tier-1 tests for the Phase-12b workflow worker.
 *
 * Uses real child_process for shell steps (the tests run safe `echo` /
 * `false` / `sh -c "exit N"` commands so they're hermetic + fast) and
 * SDKClient.fake for prompt sub-steps. ZERO model calls.
 */
import { describe, expect, it } from "vitest"
import { Effect, Fiber, Layer } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
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

  it(
    "prompt step exceeding timeout_ms → status='timeout' + aborts the SDK subprocess",
    async () => {
      let captured: AbortController | undefined

      // Faithful fake: it yields NOTHING on its own but ends PROMPTLY the
      // instant its AbortController fires — exactly how the real SDK behaves
      // (options.abortController → subprocess dies → iterator completes). The
      // 30s safety-net timer means a broken abort path fails as a vitest
      // deadline (red), never an infinite hang. This is the empirical proof
      // that Effect.timeout actually interrupts a wedged Stream pull AND that
      // the interrupt reaches the subprocess kill signal.
      const sdkLayer = SDKClient.fake((params) => {
        const ac = params.options?.abortController as
          | AbortController
          | undefined
        captured = ac
        async function* gen(): AsyncGenerator<SDKMessage, void> {
          await new Promise<void>((resolve) => {
            if (ac?.signal.aborted) return resolve()
            ac?.signal.addEventListener("abort", () => resolve(), {
              once: true,
            })
            setTimeout(resolve, 30_000).unref?.()
          })
          // Aborted → end the stream with no result message.
        }
        return gen() as unknown as import("../src/sdk-client.js").Query
      })

      const prog = Effect.gen(function* () {
        const sdk = yield* SDKClient
        const notes = yield* AgentNotesService
        const worker = buildWorkflowWorker(sdk, notes)
        const result = yield* Effect.either(
          worker(
            {
              steps: [
                { kind: "prompt", user_prompt: "hang forever", timeout_ms: 50 },
              ],
            },
            ctx,
          ),
        )
        // halt_on_failure defaults true → a non-success step fails the worker.
        expect(result._tag).toBe("Left")
        if (result._tag === "Left") {
          const cause = result.left.cause as {
            steps: PromptStepResult[]
            halted_at: number
          }
          expect(cause.steps[0]?.status).toBe("timeout")
          expect(cause.halted_at).toBe(0)
        }
        // The subprocess-kill signal must have fired.
        expect(captured?.signal.aborted).toBe(true)
      })
      await Effect.runPromise(
        prog.pipe(Effect.provide(Layer.mergeAll(sdkLayer, TestNotes))),
      )
    },
    10_000,
  )

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

  // job-ticker-oban-deadlines (Seam 2 boot wiring): a bare-function
  // registration here would silently regress every workflow job back to the
  // pre-slice 5-min ticker ceiling.
  it("registers with a defaultTimeoutMs wide enough for a multi-step run (Seam 1/2 boot wiring)", async () => {
    const sdkLayer = fakeClientWithText("noop")
    const exposed = WorkflowWorkerLayer().pipe(
      Layer.provideMerge(
        Layer.mergeAll(sdkLayer, makeWorkerRegistry({}), TestNotes, Clock.Default),
      ),
    )
    const prog = Effect.gen(function* () {
      const reg = yield* WorkerRegistry
      const entry = yield* reg.lookupEntry("workflow")
      expect(entry?.defaultTimeoutMs).toBeGreaterThanOrEqual(10 * 60 * 1000)
    })
    await Effect.runPromise(prog.pipe(Effect.provide(exposed)))
  })
})

// ── issue #277 Seam B: abort-wired shell steps kill the process GROUP ──────
//
// A shell step's cmd backgrounds a grandchild (`sleep 30 &`) and publishes
// its pid to a temp file - this is the process that must NOT outlive an
// interrupted/timed-out dispatch. `wait` keeps the immediate `/bin/sh` child
// alive until the grandchild exits (or is killed), mirroring a real
// long-running command (e.g. `git push`) with children of its own (`ssh`).

/** Poll `check` every `intervalMs` until it returns true, or throw once
 *  `timeoutMs` elapses. Used to observe async OS-level state (a pidfile
 *  appearing, a process dying) without a fixed sleep racing the assertion. */
const pollUntil = async (
  check: () => boolean,
  timeoutMs: number,
  intervalMs = 25,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  if (!check()) {
    throw new Error(`pollUntil: condition not met within ${timeoutMs}ms`)
  }
}

const isAlive = (pid: number): boolean => {
  try {
    // Signal 0 sends nothing but still throws ESRCH if the pid is gone -
    // the standard liveness probe.
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const shellCmdPublishingGrandchildPid = (pidFile: string): string =>
  `sleep 30 & echo $! > ${JSON.stringify(pidFile)}; wait`

describe("buildWorkflowWorker - shell step process-group kill (issue #277 Seam B)", () => {
  it("interrupting the dispatch mid-shell-step kills the child process GROUP, not just the immediate shell", async () => {
    const sdkLayer = fakeClientWithText("noop")
    const pidFile = path.join(
      os.tmpdir(),
      `luna-wf-worker-interrupt-${process.pid}-${Date.now()}.pid`,
    )
    try {
      const prog = Effect.gen(function* () {
        const sdk = yield* SDKClient
        const notes = yield* AgentNotesService
        const worker = buildWorkflowWorker(sdk, notes)
        const cmd = shellCmdPublishingGrandchildPid(pidFile)

        // Fork (not yield*) - we need a live Fiber to interrupt mid-flight,
        // which the existing tests never needed (they always run the
        // worker to completion).
        const fiber = yield* Effect.fork(
          worker({ steps: [{ kind: "shell", cmd }] }, ctx),
        )

        // Wait for the grandchild to actually be spawned + alive before
        // interrupting, so the test can't race ahead of the spawn.
        yield* Effect.promise(() =>
          pollUntil(() => {
            if (!fs.existsSync(pidFile)) return false
            const raw = fs.readFileSync(pidFile, "utf8").trim()
            return raw.length > 0 && isAlive(Number(raw))
          }, 3000),
        )
        const grandchildPid = Number(fs.readFileSync(pidFile, "utf8").trim())
        expect(isAlive(grandchildPid)).toBe(true)

        yield* Fiber.interrupt(fiber)

        // The group kill must reach the grandchild, not just the immediate
        // /bin/sh - proving `-pid` targets the whole process GROUP.
        yield* Effect.promise(() => pollUntil(() => !isAlive(grandchildPid), 3000))
        expect(isAlive(grandchildPid)).toBe(false)
      })
      await Effect.runPromise(
        prog.pipe(Effect.provide(Layer.mergeAll(sdkLayer, TestNotes))),
      )
    } finally {
      try { fs.unlinkSync(pidFile) } catch { /* best effort cleanup */ }
    }
  }, 10_000)

  it("the timeout path (not just interruption) also kills the process GROUP", async () => {
    const sdkLayer = fakeClientWithText("noop")
    const pidFile = path.join(
      os.tmpdir(),
      `luna-wf-worker-timeout-${process.pid}-${Date.now()}.pid`,
    )
    try {
      const prog = Effect.gen(function* () {
        const sdk = yield* SDKClient
        const notes = yield* AgentNotesService
        const worker = buildWorkflowWorker(sdk, notes)
        const cmd = shellCmdPublishingGrandchildPid(pidFile)
        const result = yield* Effect.either(
          worker({ steps: [{ kind: "shell", cmd, timeout_ms: 100 }] }, ctx),
        )
        expect(result._tag).toBe("Left")
        if (result._tag === "Left") {
          const cause = result.left.cause as { steps: ShellStepResult[] }
          expect(cause.steps[0]?.status).toBe("timeout")
        }

        // By the time the worker settles, the grandchild must already be
        // gone - the timeout kill path group-kills exactly like the abort
        // path above (both funnel through `runShellStep`'s `killGroup`).
        const grandchildPid = Number(fs.readFileSync(pidFile, "utf8").trim())
        expect(isAlive(grandchildPid)).toBe(false)
      })
      await Effect.runPromise(
        prog.pipe(Effect.provide(Layer.mergeAll(sdkLayer, TestNotes))),
      )
    } finally {
      try { fs.unlinkSync(pidFile) } catch { /* best effort cleanup */ }
    }
  }, 10_000)
})
