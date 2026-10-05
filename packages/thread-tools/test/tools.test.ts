import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { createThreadInputSchema, forkThreadInputSchema, makeForkThreadTools } from "../src/tools.js"

describe("fork_thread input bounds", () => {
  it("accepts a valid proposal", () => {
    const r = forkThreadInputSchema.safeParse({
      title: "Billing",
      summary: "July invoice question",
      seed: "Can we review the July invoice?",
    })
    expect(r.success).toBe(true)
  })

  it("rejects empty / over-long fields", () => {
    expect(
      forkThreadInputSchema.safeParse({
        title: "",
        summary: "s",
        seed: "seed",
      }).success,
    ).toBe(false)
    expect(
      forkThreadInputSchema.safeParse({
        title: "x".repeat(121),
        summary: "s",
        seed: "seed",
      }).success,
    ).toBe(false)
    expect(
      forkThreadInputSchema.safeParse({
        title: "t",
        summary: "s",
        seed: "x".repeat(8001),
      }).success,
    ).toBe(false)
  })
})

describe("makeForkThreadTools handler", () => {
  it("stages a proposal when a thread is bound", async () => {
    const proposed: Array<unknown> = []
    const tools = makeForkThreadTools(
      {
        propose: (input) =>
          Effect.sync(() => {
            proposed.push(input)
            return { id: "fork_test" }
          }),
      },
      () => "thr_1",
      () => false,
      () => 99,
    )
    const tool = tools[0]
    const result = await tool.handler(
      {
        title: "Topic",
        summary: "About X",
        seed: "Let's discuss X.",
      },
      {} as never,
    )
    expect(result.isError).toBeFalsy()
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? ""
    expect(text).toContain("fork_test")
    expect(proposed).toHaveLength(1)
  })

  it("fails when unbound or fork-child", async () => {
    const unbound = makeForkThreadTools(
      { propose: () => Effect.succeed({ id: "x" }) },
      () => null,
      () => false,
    )
    const r1 = await unbound[0].handler(
      { title: "T", summary: "S", seed: "seed" },
      {} as never,
    )
    expect(r1.isError).toBe(true)

    const child = makeForkThreadTools(
      { propose: () => Effect.succeed({ id: "x" }) },
      () => "thr_1",
      () => true,
    )
    const r2 = await child[0].handler(
      { title: "T", summary: "S", seed: "seed" },
      {} as never,
    )
    expect(r2.isError).toBe(true)
    expect((r2.content as Array<{ text: string }>)[0]?.text).toMatch(
      /fork-loop guard/i,
    )
  })
})

describe("create_thread", () => {
  const find = (tools: ReturnType<typeof makeForkThreadTools>) =>
    tools.find((t) => t.name === "create_thread")!

  it("stages a mode \"create\" proposal so the server accepts it at once", async () => {
    const proposed: Array<Record<string, unknown>> = []
    const tools = makeForkThreadTools(
      {
        propose: (input) =>
          Effect.sync(() => {
            proposed.push(input as never)
            return { id: "fork_new" }
          }),
      },
      () => "thr_main",
      () => false,
      () => 7,
    )
    const r = await find(tools).handler(
      { title: "Clef vs Jev", seed: "Compare the two." },
      {} as never,
    )
    expect(r.isError).toBeFalsy()
    expect(proposed).toEqual([
      {
        parentThreadId: "thr_main",
        title: "Clef vs Jev",
        summary: "Clef vs Jev",
        seed: "Compare the two.",
        nowMs: 7,
        mode: "create",
      },
    ])
  })

  it("works from a fork child (no fork-loop guard), but not when unbound", async () => {
    const fromChild = makeForkThreadTools(
      { propose: () => Effect.succeed({ id: "x" }) },
      () => "thr_child",
      () => true,
    )
    const ok = await find(fromChild).handler({ title: "T", seed: "s" }, {} as never)
    expect(ok.isError).toBeFalsy()

    const unbound = makeForkThreadTools(
      { propose: () => Effect.succeed({ id: "x" }) },
      () => null,
      () => false,
    )
    const bad = await find(unbound).handler({ title: "T", seed: "s" }, {} as never)
    expect(bad.isError).toBe(true)
  })

  it("enforces the same title and seed bounds as fork_thread", () => {
    expect(createThreadInputSchema.safeParse({ title: "", seed: "s" }).success).toBe(false)
    expect(createThreadInputSchema.safeParse({ title: "t", seed: "x".repeat(8001) }).success).toBe(false)
    expect(createThreadInputSchema.safeParse({ title: "t", seed: "s" }).success).toBe(true)
  })
})
