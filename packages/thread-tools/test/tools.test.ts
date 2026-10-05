import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { createThreadInputSchema, forkThreadInputSchema, makeForkThreadTools } from "../src/tools.js"
import { checkCreateAllowed, CREATE_THREAD_MAX_PER_WINDOW, CREATE_THREAD_WINDOW_MS } from "../src/layer.js"
import { AGENT_CREATED_TAG, FORK_CHILD_TAG } from "../src/types.js"

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

describe("create_thread gate (checkCreateAllowed)", () => {
  it("refuses forked, agent-created, and channel chats", () => {
    for (const tag of [FORK_CHILD_TAG, AGENT_CREATED_TAG, "channel"]) {
      expect(checkCreateAllowed(new Map(), "t", [tag], 0)).toMatch(/only available/)
    }
    expect(checkCreateAllowed(new Map(), "t", [], 0)).toBeNull()
  })

  it("allows at most CREATE_THREAD_MAX_PER_WINDOW per chat per window, then recovers", () => {
    const budget = new Map<string, number[]>()
    for (let i = 0; i < CREATE_THREAD_MAX_PER_WINDOW; i++) {
      expect(checkCreateAllowed(budget, "t", [], 1000 + i)).toBeNull()
    }
    expect(checkCreateAllowed(budget, "t", [], 2000)).toMatch(/budget/)
    expect(checkCreateAllowed(budget, "other", [], 2000)).toBeNull()
    expect(checkCreateAllowed(budget, "t", [], 1000 + CREATE_THREAD_WINDOW_MS + 5)).toBeNull()
  })

  it("the tool surfaces a gate refusal as an error and stages nothing", async () => {
    let calls = 0
    const tools = makeForkThreadTools(
      { propose: () => Effect.sync(() => { calls++; return { id: "x" } }) },
      () => "t",
      () => false,
      () => 1,
      () => "nope",
    )
    const r = await tools.find((t) => t.name === "create_thread")!.handler({ title: "T", seed: "s" }, {} as never)
    expect(r.isError).toBe(true)
    expect(calls).toBe(0)
  })

  it("tag strings are pinned (ui-ws UNATTENDED_THREAD_TAGS lists these same strings)", () => {
    expect(FORK_CHILD_TAG).toBe("forked-from-parent")
    expect(AGENT_CREATED_TAG).toBe("agent-created")
  })
})
