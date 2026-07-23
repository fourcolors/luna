import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { forkThreadInputSchema, makeForkThreadTools } from "../src/tools.js"

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
