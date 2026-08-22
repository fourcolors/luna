/**
 * AgentRegistry Tier-1 tests — register/unregister/list, fresh-record
 * `toAgentsField`, and scope-cleanup via `registerScoped`. The registry
 * stores opaque AgentDefinition-shaped values (§4 / §12.2 #6); these
 * tests do not exercise spawn behavior (that lives in adapter-sdk and
 * is Phase 11 territory).
 */
import { describe, expect, it } from "vitest"
import { Effect, Exit, Scope } from "effect"
import {
  AgentRegistry,
  registerScopedAgent as registerScoped,
  type AgentDefinitionLike,
} from "./index.js"

const run = <A, E>(eff: Effect.Effect<A, E, AgentRegistry>) =>
  Effect.runPromise(eff.pipe(Effect.provide(AgentRegistry.Default)))

const def = (description: string): AgentDefinitionLike => ({
  description,
  prompt: "you are a test agent",
  tools: [],
})

describe("AgentRegistry", () => {
  it("register + list roundtrip; unregister removes", async () => {
    const out = await run(
      Effect.gen(function* () {
        const reg = yield* AgentRegistry
        yield* reg.register("a", def("alpha"))
        yield* reg.register("b", def("beta"))
        const after = yield* reg.list()
        const removed = yield* reg.unregister("a")
        const final = yield* reg.list()
        return { after, removed, final }
      }),
    )
    expect(Object.keys(out.after).sort()).toEqual(["a", "b"])
    expect((out.after["a"] as { description: string }).description).toBe("alpha")
    expect(out.removed).toBe(true)
    expect(Object.keys(out.final)).toEqual(["b"])
  })

  it("duplicate register → ValidationError with module=AgentRegistry", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const reg = yield* AgentRegistry
        yield* reg.register("dup", def("first"))
        yield* reg.register("dup", def("second"))
      }).pipe(Effect.provide(AgentRegistry.Default)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const flat = JSON.stringify(exit.cause)
      expect(flat).toContain("ValidationError")
      expect(flat).toContain("AgentRegistry")
      expect(flat).toContain("dup")
    }
  })

  it("unregister of unknown name returns false", async () => {
    const result = await run(
      Effect.gen(function* () {
        const reg = yield* AgentRegistry
        return yield* reg.unregister("never-registered")
      }),
    )
    expect(result).toBe(false)
  })

  it("toAgentsField returns a fresh mutable record each call", async () => {
    const { first, second } = await run(
      Effect.gen(function* () {
        const reg = yield* AgentRegistry
        yield* reg.register("x", def("x-desc"))
        const first = yield* reg.toAgentsField()
        // Mutate the returned record — should not leak into next call.
        first["mutated"] = def("should-not-leak")
        delete first["x"]
        const second = yield* reg.toAgentsField()
        return { first, second }
      }),
    )
    expect(Object.keys(first).sort()).toEqual(["mutated"])
    expect(Object.keys(second)).toEqual(["x"])
    expect("mutated" in second).toBe(false)
  })

  it("registerScoped unregisters on scope close", async () => {
    const { duringScope, afterScope } = await run(
      Effect.gen(function* () {
        const reg = yield* AgentRegistry
        const scope = yield* Scope.make()
        yield* registerScoped("scoped", def("scoped-desc")).pipe(
          Scope.provide(scope),
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
})
