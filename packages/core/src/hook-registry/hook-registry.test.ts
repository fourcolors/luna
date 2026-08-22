/**
 * HookRegistry Tier-1 tests — register/unregister/list and scope-cleanup
 * via `registerScoped`. The registry stores opaque specs (§4); these
 * tests do not exercise hook execution (that lives in adapter-sdk).
 */
import { describe, expect, it } from "vitest"
import { Effect, Exit, Scope } from "effect"
import {
  HookRegistry,
  registerScopedHook as registerScoped,
  type HookSpecLike,
} from "./index.js"

const run = <A, E>(eff: Effect.Effect<A, E, HookRegistry>) =>
  Effect.runPromise(eff.pipe(Effect.provide(HookRegistry.Default)))

const spec = (event: string): HookSpecLike => ({ event, matchers: [] })

describe("HookRegistry", () => {
  it("register + list roundtrip", async () => {
    const got = await run(
      Effect.gen(function* () {
        const reg = yield* HookRegistry
        yield* reg.register("a", spec("PreToolUse"))
        yield* reg.register("b", spec("Stop"))
        return yield* reg.list()
      }),
    )
    expect(Object.keys(got).sort()).toEqual(["a", "b"])
    expect((got["a"] as { event: string }).event).toBe("PreToolUse")
  })

  it("duplicate register → ValidationError", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const reg = yield* HookRegistry
        yield* reg.register("dup", spec("PreToolUse"))
        yield* reg.register("dup", spec("Stop"))
      }).pipe(Effect.provide(HookRegistry.Default)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const flat = JSON.stringify(exit.cause)
      expect(flat).toContain("ValidationError")
      expect(flat).toContain("HookRegistry")
      expect(flat).toContain("dup")
    }
  })

  it("unregister returns true/false appropriately", async () => {
    const out = await run(
      Effect.gen(function* () {
        const reg = yield* HookRegistry
        yield* reg.register("x", spec("PreToolUse"))
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
        const reg = yield* HookRegistry
        const scope = yield* Scope.make()
        yield* registerScoped("scoped", spec("Stop")).pipe(Scope.provide(scope))
        const duringScope = yield* reg.list()
        yield* Scope.close(scope, Exit.void)
        const afterScope = yield* reg.list()
        return { duringScope, afterScope }
      }),
    )
    expect(Object.keys(duringScope)).toEqual(["scoped"])
    expect(Object.keys(afterScope)).toEqual([])
  })
})
