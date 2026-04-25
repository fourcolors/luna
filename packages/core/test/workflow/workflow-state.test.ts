/**
 * WorkflowState — unit tests (Phase 12).
 *
 * Tests the in-memory persistence layer in isolation.
 * Uses Clock.Test for deterministic timestamps.
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { Clock } from "../../src/clock.js"
import { WorkflowState } from "../../src/workflow-state/index.js"

const makeLayer = (fixedMs = 1_000_000) =>
  WorkflowState.Default.pipe(Layer.provide(Clock.Test(fixedMs)))

const run = <A, E>(prog: Effect.Effect<A, E, WorkflowState>) =>
  Effect.runPromise(prog.pipe(Effect.provide(makeLayer())))

describe("WorkflowState", () => {
  it("create: returns an id and sets pending status", async () => {
    const out = await run(
      Effect.gen(function* () {
        const ws = yield* WorkflowState
        const id = yield* ws.create({ kind: "my-workflow" })
        const rec = yield* ws.get(id)
        return rec
      }),
    )
    expect(out).not.toBeNull()
    expect(out?.status).toBe("pending")
    expect(out?.kind).toBe("my-workflow")
    expect(out?.sessionId).toBeNull()
    expect(out?.checkpoint).toBe("")
    expect(typeof out?.id).toBe("string")
  })

  it("create: with sessionId", async () => {
    const out = await run(
      Effect.gen(function* () {
        const ws = yield* WorkflowState
        const id = yield* ws.create({ kind: "k", sessionId: "sess-1" })
        return yield* ws.get(id)
      }),
    )
    expect(out?.sessionId).toBe("sess-1")
  })

  it("setStatus: transitions status and optionally updates checkpoint", async () => {
    const out = await run(
      Effect.gen(function* () {
        const ws = yield* WorkflowState
        const id = yield* ws.create({ kind: "k" })
        yield* ws.setStatus(id, "running")
        const after = yield* ws.get(id)
        yield* ws.setStatus(id, "completed", '{"result":"ok"}')
        const final = yield* ws.get(id)
        return { after, final }
      }),
    )
    expect(out.after?.status).toBe("running")
    expect(out.after?.checkpoint).toBe("")
    expect(out.final?.status).toBe("completed")
    expect(out.final?.checkpoint).toBe('{"result":"ok"}')
  })

  it("writeCheckpoint: updates checkpoint without changing status", async () => {
    const out = await run(
      Effect.gen(function* () {
        const ws = yield* WorkflowState
        const id = yield* ws.create({ kind: "k" })
        yield* ws.setStatus(id, "running")
        yield* ws.writeCheckpoint(id, '{"step":1}')
        return yield* ws.get(id)
      }),
    )
    expect(out?.status).toBe("running")
    expect(out?.checkpoint).toBe('{"step":1}')
  })

  it("appendEvent + readEvents: ordered event log", async () => {
    const out = await run(
      Effect.gen(function* () {
        const ws = yield* WorkflowState
        const id = yield* ws.create({ kind: "k" })
        yield* ws.appendEvent(id, "start", { input: 42 })
        yield* ws.appendEvent(id, "step", { name: "fetch" })
        yield* ws.appendEvent(id, "completed", { result: "done" })
        return yield* ws.readEvents(id)
      }),
    )
    expect(out).toHaveLength(3)
    expect(out[0]?.kind).toBe("start")
    expect(out[0]?.seq).toBe(1)
    expect(out[1]?.seq).toBe(2)
    expect(out[2]?.seq).toBe(3)
    // payload is JSON-stringified
    expect(JSON.parse(out[0]?.payload ?? "{}")).toEqual({ input: 42 })
  })

  it("list: filters by kind", async () => {
    const out = await run(
      Effect.gen(function* () {
        const ws = yield* WorkflowState
        yield* ws.create({ kind: "typeA" })
        yield* ws.create({ kind: "typeA" })
        yield* ws.create({ kind: "typeB" })
        return yield* ws.list({ kind: "typeA" })
      }),
    )
    expect(out).toHaveLength(2)
    expect(out.every((r) => r.kind === "typeA")).toBe(true)
  })

  it("list: filters by status", async () => {
    const out = await run(
      Effect.gen(function* () {
        const ws = yield* WorkflowState
        const id1 = yield* ws.create({ kind: "k" })
        const id2 = yield* ws.create({ kind: "k" })
        yield* ws.create({ kind: "k" })
        yield* ws.setStatus(id1, "running")
        yield* ws.setStatus(id2, "completed")
        return yield* ws.list({ status: ["running", "completed"] })
      }),
    )
    expect(out).toHaveLength(2)
  })

  it("list: filters by sessionId", async () => {
    const out = await run(
      Effect.gen(function* () {
        const ws = yield* WorkflowState
        yield* ws.create({ kind: "k", sessionId: "s1" })
        yield* ws.create({ kind: "k", sessionId: "s1" })
        yield* ws.create({ kind: "k", sessionId: "s2" })
        return yield* ws.list({ sessionId: "s1" })
      }),
    )
    expect(out).toHaveLength(2)
    expect(out.every((r) => r.sessionId === "s1")).toBe(true)
  })

  it("get: returns null for unknown id", async () => {
    const out = await run(
      Effect.gen(function* () {
        const ws = yield* WorkflowState
        return yield* ws.get("does-not-exist")
      }),
    )
    expect(out).toBeNull()
  })
})
