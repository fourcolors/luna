/**
 * WorkerRegistry tests — deterministic, no SQLite, no Clock dependencies.
 */
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import {
  WorkerRegistry,
  WorkerError,
  makeWorkerRegistry,
  type Worker,
} from "./worker-registry.js"

const idCtx = { jobId: "j", runId: 1, attempt: 1, deadline: 0 }

describe("WorkerRegistry", () => {
  it("dispatch on unknown kind fails with WorkerError({reason:'unknown_kind'})", async () => {
    const prog = Effect.gen(function* () {
      const reg = yield* WorkerRegistry
      const result = yield* Effect.either(
        reg.dispatch("nope", {}, idCtx),
      )
      expect(result._tag).toBe("Left")
      if (result._tag === "Left") {
        expect(result.left.reason).toBe("unknown_kind")
        expect(result.left.kind).toBe("nope")
      }
    })
    await Effect.runPromise(prog.pipe(Effect.provide(WorkerRegistry.Default)))
  })

  it("register + dispatch round-trips the payload through the worker", async () => {
    const echo: Worker = (payload, ctx) =>
      Effect.succeed({
        outputText: JSON.stringify({ payload, jobId: ctx.jobId }),
      })
    const prog = Effect.gen(function* () {
      const reg = yield* WorkerRegistry
      yield* reg.register("echo", echo)
      const out = yield* reg.dispatch(
        "echo",
        { hello: "world" },
        { jobId: "abc", runId: 7, attempt: 1, deadline: 0 },
      )
      expect(out.outputText).toBe(
        JSON.stringify({ payload: { hello: "world" }, jobId: "abc" }),
      )
    })
    await Effect.runPromise(prog.pipe(Effect.provide(WorkerRegistry.Default)))
  })

  it("register returns the previous worker on replacement (for swap-tests)", async () => {
    const v1: Worker = () => Effect.succeed({ outputText: "v1" })
    const v2: Worker = () => Effect.succeed({ outputText: "v2" })
    const prog = Effect.gen(function* () {
      const reg = yield* WorkerRegistry
      const before1 = yield* reg.register("swap", v1)
      expect(before1).toBeNull()
      const before2 = yield* reg.register("swap", v2)
      expect(before2).toBe(v1)
      const out = yield* reg.dispatch("swap", {}, idCtx)
      expect(out.outputText).toBe("v2")
    })
    await Effect.runPromise(prog.pipe(Effect.provide(WorkerRegistry.Default)))
  })

  it("listKinds returns a sorted snapshot of registered kinds", async () => {
    const noop: Worker = () => Effect.succeed({ outputText: null })
    const prog = Effect.gen(function* () {
      const reg = yield* WorkerRegistry
      yield* reg.register("workflow", noop)
      yield* reg.register("prompt", noop)
      yield* reg.register("shell", noop)
      const kinds = yield* reg.listKinds
      expect([...kinds]).toEqual(["prompt", "shell", "workflow"])
    })
    await Effect.runPromise(prog.pipe(Effect.provide(WorkerRegistry.Default)))
  })

  it("makeWorkerRegistry(initial) seeds the registry at construction time", async () => {
    const stubWorker: Worker = (payload) =>
      Effect.succeed({ outputText: `got:${JSON.stringify(payload)}` })
    const stack = makeWorkerRegistry({ prompt: stubWorker })
    const prog = Effect.gen(function* () {
      const reg = yield* WorkerRegistry
      const kinds = yield* reg.listKinds
      expect([...kinds]).toEqual(["prompt"])
      const out = yield* reg.dispatch("prompt", { x: 1 }, idCtx)
      expect(out.outputText).toBe('got:{"x":1}')
    })
    await Effect.runPromise(prog.pipe(Effect.provide(stack)))
  })

  it("a worker's own typed failure surfaces as WorkerError on dispatch", async () => {
    const failing: Worker = () =>
      Effect.fail(
        new WorkerError({

          reason: "bad_payload",
          message: "missing field",
        }),
      )
    const prog = Effect.gen(function* () {
      const reg = yield* WorkerRegistry
      yield* reg.register("badp", failing)
      const result = yield* Effect.either(reg.dispatch("badp", {}, idCtx))
      expect(result._tag).toBe("Left")
      if (result._tag === "Left") {
        expect(result.left.reason).toBe("bad_payload")
        expect(result.left.message).toBe("missing field")
      }
    })
    await Effect.runPromise(prog.pipe(Effect.provide(WorkerRegistry.Default)))
  })

  it("makeWorkerRegistry's seeded workers are still mutable post-build via register()", async () => {
    const a: Worker = () => Effect.succeed({ outputText: "a" })
    const b: Worker = () => Effect.succeed({ outputText: "b" })
    const stack = makeWorkerRegistry({ prompt: a })
    const prog = Effect.gen(function* () {
      const reg = yield* WorkerRegistry
      const before = yield* reg.register("prompt", b)
      expect(before).toBe(a)
      const out = yield* reg.dispatch("prompt", {}, idCtx)
      expect(out.outputText).toBe("b")
    })
    await Effect.runPromise(prog.pipe(Effect.provide(stack)))
  })
})
