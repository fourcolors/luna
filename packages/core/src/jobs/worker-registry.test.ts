/**
 * WorkerRegistry tests — deterministic, no SQLite, no Clock dependencies.
 */
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import {
  WorkerRegistry,
  WorkerError,
  makeWorkerRegistry,
  isBudgetCeilingCause,
  type Worker,
} from "./worker-registry.js"

const idCtx = { jobId: "j", runId: 1, attempt: 1, deadline: 0 }

describe("isBudgetCeilingCause", () => {
  it("TRUE for the literal production string (thrown-route cause, issue measured 141/195 failures)", () => {
    expect(
      isBudgetCeilingCause(
        new Error(
          "Claude Code returned an error result: Reached maximum number of turns (15)",
        ),
      ),
    ).toBe(true)
  })

  it("TRUE for the frame-route subtype markers error_max_turns / error_max_budget_usd", () => {
    expect(isBudgetCeilingCause(new Error("error_max_turns"))).toBe(true)
    expect(isBudgetCeilingCause(new Error("error_max_budget_usd"))).toBe(true)
  })

  it("accepts an Error instance, a bare string, and an object carrying a message field", () => {
    expect(
      isBudgetCeilingCause(new Error("reached maximum number of turns")),
    ).toBe(true)
    expect(isBudgetCeilingCause("reached maximum number of turns")).toBe(true)
    expect(
      isBudgetCeilingCause({ message: "reached maximum number of turns" }),
    ).toBe(true)
  })

  it("FALSE for 'maxTurns' — the SDK's own option name, NOT a ceiling report (the critical negative case)", () => {
    // An earlier draft's regex also matched a bare `max(imum)?[\s_]*turns`,
    // which matches the SDK's own `maxTurns` request option — any error that
    // happens to echo the request options back (e.g. in a validation/debug
    // message) would then be misclassified as a deterministic, non-retryable
    // budget failure when it might be a perfectly retryable transient fault.
    expect(isBudgetCeilingCause(new Error("maxTurns"))).toBe(false)
    expect(
      isBudgetCeilingCause(new Error("invalid option: maxTurns must be > 0")),
    ).toBe(false)
  })

  it("FALSE for max_tokens (a different, unrelated ceiling)", () => {
    expect(isBudgetCeilingCause(new Error("max_tokens exceeded"))).toBe(false)
  })

  it("FALSE for a generic network/stream error with no budget wording", () => {
    expect(isBudgetCeilingCause(new Error("ECONNRESET: socket hang up"))).toBe(
      false,
    )
  })

  it("FALSE for null/undefined", () => {
    expect(isBudgetCeilingCause(null)).toBe(false)
    expect(isBudgetCeilingCause(undefined)).toBe(false)
  })
})

describe("WorkerRegistry", () => {
  it("dispatch on unknown kind fails with WorkerError({reason:'unknown_kind'})", async () => {
    const prog = Effect.gen(function* () {
      const reg = yield* WorkerRegistry
      const result = yield* Effect.result(
        reg.dispatch("nope", {}, idCtx),
      )
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure.reason).toBe("unknown_kind")
        expect(result.failure.kind).toBe("nope")
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
      const result = yield* Effect.result(reg.dispatch("badp", {}, idCtx))
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure.reason).toBe("bad_payload")
        expect(result.failure.message).toBe("missing field")
      }
    })
    await Effect.runPromise(prog.pipe(Effect.provide(WorkerRegistry.Default)))
  })

  it("register(kind, {run, defaultTimeoutMs}) round-trips through lookupEntry AND lookup", async () => {
    const withTimeout: Worker = () => Effect.succeed({ outputText: "timed" })
    const prog = Effect.gen(function* () {
      const reg = yield* WorkerRegistry
      yield* reg.register("dream", { run: withTimeout, defaultTimeoutMs: 900_000 })

      // lookupEntry surfaces the full entry (what the ticker reads for its
      // Seam-1 backstop deadline computation).
      const entry = yield* reg.lookupEntry("dream")
      expect(entry?.defaultTimeoutMs).toBe(900_000)
      expect(entry?.run).toBe(withTimeout)

      // lookup (back-compat) still resolves to the bare run function.
      const fn = yield* reg.lookup("dream")
      expect(fn).toBe(withTimeout)

      // dispatch still invokes .run under the hood.
      const out = yield* reg.dispatch("dream", {}, idCtx)
      expect(out.outputText).toBe("timed")
    })
    await Effect.runPromise(prog.pipe(Effect.provide(WorkerRegistry.Default)))
  })

  it("a bare-function registration has no defaultTimeoutMs on its entry (back-compat)", async () => {
    const bare: Worker = () => Effect.succeed({ outputText: "bare" })
    const prog = Effect.gen(function* () {
      const reg = yield* WorkerRegistry
      yield* reg.register("wake", bare)
      const entry = yield* reg.lookupEntry("wake")
      expect(entry?.run).toBe(bare)
      expect(entry?.defaultTimeoutMs).toBeUndefined()
    })
    await Effect.runPromise(prog.pipe(Effect.provide(WorkerRegistry.Default)))
  })

  it("register() returns the previous RUN function (not the wrapping entry) on replacement, for both bare-fn and object forms", async () => {
    const v1: Worker = () => Effect.succeed({ outputText: "v1" })
    const v2: Worker = () => Effect.succeed({ outputText: "v2" })
    const prog = Effect.gen(function* () {
      const reg = yield* WorkerRegistry
      const before1 = yield* reg.register("swap", { run: v1, defaultTimeoutMs: 1000 })
      expect(before1).toBeNull()
      const before2 = yield* reg.register("swap", v2)
      expect(before2).toBe(v1)
      // The object-form registration's defaultTimeoutMs is gone now that a
      // bare-function registration replaced it (each register() call fully
      // replaces the entry, it does not merge).
      const entry = yield* reg.lookupEntry("swap")
      expect(entry?.defaultTimeoutMs).toBeUndefined()
    })
    await Effect.runPromise(prog.pipe(Effect.provide(WorkerRegistry.Default)))
  })

  it("makeWorkerRegistry(initial) accepts the object form too and normalizes identically to WorkerRegistry.Default", async () => {
    const stubWorker: Worker = () => Effect.succeed({ outputText: "seeded" })
    const stack = makeWorkerRegistry({ dream: { run: stubWorker, defaultTimeoutMs: 900_000 } })
    const prog = Effect.gen(function* () {
      const reg = yield* WorkerRegistry
      const entry = yield* reg.lookupEntry("dream")
      expect(entry?.defaultTimeoutMs).toBe(900_000)
      const fn = yield* reg.lookup("dream")
      expect(fn).toBe(stubWorker)
    })
    await Effect.runPromise(prog.pipe(Effect.provide(stack)))
  })

  it("lookupEntry returns null for an unregistered kind", async () => {
    const prog = Effect.gen(function* () {
      const reg = yield* WorkerRegistry
      const entry = yield* reg.lookupEntry("nope")
      expect(entry).toBeNull()
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
