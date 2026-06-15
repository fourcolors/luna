/**
 * skill-tools tests — the tier-2 disclosure tool.
 *
 * Load-bearing assertions:
 *   - skill_load returns the body of an ENABLED skill
 *   - disabled and unknown ids ERROR (isError result at the SDK boundary) —
 *     the operator's toggle must hold against the tool side door
 *   - a toggle flips tool behavior live (same registry instance, no rebuild)
 *   - server config shape matches what ThreadToolsProvider merges
 */
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { SkillRegistry, type SkillManifest } from "@luna/core"
import { SkillToolsLayer, SkillToolsService, makeSkillTools } from "../src/index.js"

const manifest = (id: string, enabled = true): SkillManifest => ({
  id,
  name: `Skill ${id}`,
  description: `Does ${id}.`,
  whenToUse: `When ${id}.`,
  category: "other",
  tags: [],
  source: "builtin",
  body: `BODY-${id}`,
})

/** Run the SDK-shaped tool handler the way the SDK would (Promise API). */
const callTool = async (
  tool: { handler: (args: unknown, extra: unknown) => Promise<unknown> },
  args: unknown,
) =>
  (await tool.handler(args, {})) as {
    isError?: boolean
    content: Array<{ type: string; text: string }>
  }

describe("skill_load tool", () => {
  const withRegistry = <A>(
    f: (
      registry: (typeof SkillRegistry)["Service"],
    ) => Promise<A>,
  ) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const reg = yield* SkillRegistry
        yield* reg.register(manifest("readable"))
        yield* reg.register(manifest("hidden"))
        yield* reg.setEnabled("hidden", false)
        return yield* Effect.promise(() => f(reg))
      }).pipe(Effect.provide(SkillRegistry.Default)),
    )

  it("returns the body of an enabled skill", async () => {
    await withRegistry(async (reg) => {
      const [skillLoad] = makeSkillTools(reg)
      const res = await callTool(skillLoad as never, { id: "readable" })
      expect(res.isError).not.toBe(true)
      expect(res.content[0]?.text).toContain("BODY-readable")
    })
  })

  it("errors for disabled and unknown ids — no body leakage", async () => {
    await withRegistry(async (reg) => {
      const [skillLoad] = makeSkillTools(reg)
      const disabled = await callTool(skillLoad as never, { id: "hidden" })
      expect(disabled.isError).toBe(true)
      expect(JSON.stringify(disabled.content)).not.toContain("BODY-hidden")
      const unknown = await callTool(skillLoad as never, { id: "ghost" })
      expect(unknown.isError).toBe(true)
    })
  })

  it("a live toggle flips tool behavior without rebuilding the server", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const reg = yield* SkillRegistry
        yield* reg.register(manifest("flippy"))
        const [skillLoad] = makeSkillTools(reg)
        const before = yield* Effect.promise(() =>
          callTool(skillLoad as never, { id: "flippy" }),
        )
        expect(before.isError).not.toBe(true)
        yield* reg.setEnabled("flippy", false)
        const after = yield* Effect.promise(() =>
          callTool(skillLoad as never, { id: "flippy" }),
        )
        expect(after.isError).toBe(true)
      }).pipe(Effect.provide(SkillRegistry.Default)),
    )
  })
})

describe("SkillToolsLayer", () => {
  it("yields the skill_tools server config the thread provider expects", async () => {
    const config = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* SkillToolsService
      }).pipe(
        Effect.provide(SkillToolsLayer()),
        Effect.provide(SkillRegistry.layer({ seeds: [manifest("seeded")] })),
      ),
    )
    expect(config.serverName).toBe("skill_tools")
    expect(config.server).toBeDefined()
    expect(config.systemPromptAddendum).toBe("")
    const binding = config.createSessionBinding()
    expect(binding.serverName).toBe("skill_tools")
    // session binding hooks are deliberate no-ops — must not throw
    binding.bindSession("s1")
    binding.clearSession("s1")
  })
})
