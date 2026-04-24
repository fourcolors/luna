/**
 * SkillRegistry Tier-1 tests — register/unregister/list, listSegments
 * passthrough into composeBasePrompt, and scope-cleanup via `registerScoped`.
 */
import { describe, expect, it } from "vitest"
import { Effect, Exit, Scope } from "effect"
import {
  SkillRegistry,
  registerScopedSkill as registerScoped,
  type SkillEntry,
} from "./index.js"
import { composeBasePrompt } from "../prompt/base-prompt.js"
import { ValidationError as _ValidationError } from "../errors.js"

const run = <A, E>(eff: Effect.Effect<A, E, SkillRegistry>) =>
  Effect.runPromise(eff.pipe(Effect.provide(SkillRegistry.Default)))

const skill = (name: string, segment: string): SkillEntry => ({ name, segment })

describe("SkillRegistry", () => {
  it("register + list roundtrip", async () => {
    const got = await run(
      Effect.gen(function* () {
        const reg = yield* SkillRegistry
        yield* reg.register(skill("git-ops", "You have git-ops."))
        yield* reg.register(skill("docs", "You have docs."))
        return yield* reg.list()
      }),
    )
    expect(Object.keys(got).sort()).toEqual(["docs", "git-ops"])
    expect(got["git-ops"]).toEqual({
      name: "git-ops",
      segment: "You have git-ops.",
    })
  })

  it("duplicate register → ValidationError", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const reg = yield* SkillRegistry
        yield* reg.register(skill("dup", "one"))
        yield* reg.register(skill("dup", "two"))
      }).pipe(Effect.provide(SkillRegistry.Default)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const flat = JSON.stringify(exit.cause)
      expect(flat).toContain("ValidationError")
      expect(flat).toContain("SkillRegistry")
      expect(flat).toContain("dup")
    }
  })

  it("unregister returns true/false appropriately", async () => {
    const out = await run(
      Effect.gen(function* () {
        const reg = yield* SkillRegistry
        yield* reg.register(skill("x", "x-seg"))
        const a = yield* reg.unregister("x")
        const b = yield* reg.unregister("x")
        const c = yield* reg.unregister("never-registered")
        return { a, b, c }
      }),
    )
    expect(out).toEqual({ a: true, b: false, c: false })
  })

  it("registerScoped unregisters on scope close", async () => {
    const { duringScope, afterScope } = await run(
      Effect.gen(function* () {
        const reg = yield* SkillRegistry
        const scope = yield* Scope.make()
        yield* registerScoped(skill("scoped", "scoped-seg")).pipe(
          Scope.extend(scope),
        )
        const duringScope = yield* reg.list()
        yield* Scope.close(scope, Exit.void)
        const afterScope = yield* reg.list()
        return { duringScope, afterScope }
      }),
    )
    expect(Object.keys(duringScope)).toEqual(["scoped"])
    expect(Object.keys(afterScope)).toEqual([])
  })

  it("listSegments feeds composeBasePrompt in registration order", async () => {
    const segments = await run(
      Effect.gen(function* () {
        const reg = yield* SkillRegistry
        yield* reg.register(skill("first", "You have skill-A."))
        yield* reg.register(skill("second", "You have skill-B."))
        return yield* reg.listSegments()
      }),
    )
    expect(segments).toEqual(["You have skill-A.", "You have skill-B."])

    const prompt = composeBasePrompt({
      identity: "You are Atlas.",
      skillSegments: segments,
    })
    expect(Array.isArray(prompt)).toBe(true)
    expect(prompt as string[]).toEqual([
      "You are Atlas.",
      "You have skill-A.",
      "You have skill-B.",
    ])
  })
})
