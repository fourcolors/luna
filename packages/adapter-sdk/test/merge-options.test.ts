/**
 * Merge-options guard — DESIGN.md §12.2 invariant #7.
 */
import { describe, expect, it } from "vitest"
import { mergeOptions } from "../src/merge-options.js"

describe("mergeOptions", () => {
  it("passes through non-reserved caller keys", () => {
    const { merged, warnings } = mergeOptions(
      { model: "m", cwd: "/tmp", maxTurns: 5 },
      {},
    )
    expect(merged).toMatchObject({ model: "m", cwd: "/tmp", maxTurns: 5 })
    expect(warnings).toEqual([])
  })

  it("drops reserved caller keys and records warnings", () => {
    const { merged, warnings } = mergeOptions(
      {
        model: "m",
        hooks: { PreToolUse: [] },
        canUseTool: async () => ({}),
        abortController: new AbortController(),
        resume: "should-be-dropped",
        forkSession: true,
      },
      {},
    )
    expect(merged).toHaveProperty("model", "m")
    expect(merged).not.toHaveProperty("hooks")
    expect(merged).not.toHaveProperty("canUseTool")
    expect(merged).not.toHaveProperty("abortController")
    expect(merged).not.toHaveProperty("resume")
    expect(merged).not.toHaveProperty("forkSession")
    const keys = warnings.map((w) => w.key).sort()
    expect(keys).toEqual([
      "abortController",
      "canUseTool",
      "forkSession",
      "hooks",
      "resume",
    ])
  })

  it("overrides win over non-reserved caller keys", () => {
    const ac = new AbortController()
    const { merged } = mergeOptions({ maxTurns: 5 }, { maxTurns: 10, abortController: ac })
    expect((merged as { maxTurns?: number }).maxTurns).toBe(10)
    expect((merged as { abortController?: AbortController }).abortController).toBe(ac)
  })
})
