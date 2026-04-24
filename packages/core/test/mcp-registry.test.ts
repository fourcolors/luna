/**
 * MCPRegistry Tier-1 tests — register/unregister/list/toMcpServersField
 * and scope-cleanup via `registerScoped`.
 */
import { describe, expect, it } from "vitest"
import { Effect, Exit, Scope } from "effect"
import {
  MCPRegistry,
  registerScoped,
  type McpServerConfigLike,
} from "../src/mcp-registry/index.js"
import { ValidationError } from "../src/errors.js"

const run = <A, E>(eff: Effect.Effect<A, E, MCPRegistry>) =>
  Effect.runPromise(eff.pipe(Effect.provide(MCPRegistry.Default)))

const stdio = (cmd: string): McpServerConfigLike => ({
  type: "stdio",
  command: cmd,
})

describe("MCPRegistry", () => {
  it("register + list roundtrip", async () => {
    const got = await run(
      Effect.gen(function* () {
        const reg = yield* MCPRegistry
        yield* reg.register("a", stdio("cmd-a"))
        yield* reg.register("b", stdio("cmd-b"))
        return yield* reg.list()
      }),
    )
    expect(Object.keys(got).sort()).toEqual(["a", "b"])
    expect((got["a"] as { command: string }).command).toBe("cmd-a")
  })

  it("duplicate register → ValidationError", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const reg = yield* MCPRegistry
        yield* reg.register("dup", stdio("one"))
        yield* reg.register("dup", stdio("two"))
      }).pipe(Effect.provide(MCPRegistry.Default)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const err = exit.cause
      // Check that the tagged error surfaces
      const flat = JSON.stringify(err)
      expect(flat).toContain("ValidationError")
      expect(flat).toContain("dup")
    }
  })

  it("unregister returns true/false appropriately", async () => {
    const out = await run(
      Effect.gen(function* () {
        const reg = yield* MCPRegistry
        yield* reg.register("x", stdio("c"))
        const a = yield* reg.unregister("x")
        const b = yield* reg.unregister("x")
        const c = yield* reg.unregister("never-registered")
        return { a, b, c }
      }),
    )
    expect(out).toEqual({ a: true, b: false, c: false })
  })

  it("toMcpServersField returns a plain Record suitable for Options.mcpServers", async () => {
    const out = await run(
      Effect.gen(function* () {
        const reg = yield* MCPRegistry
        yield* reg.register("s1", stdio("c1"))
        yield* reg.register("s2", { type: "http", url: "https://x" })
        return yield* reg.toMcpServersField()
      }),
    )
    // Must be a plain object (Object.prototype parent), not a Map.
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect(out["s1"]).toMatchObject({ type: "stdio", command: "c1" })
    expect(out["s2"]).toMatchObject({ type: "http", url: "https://x" })
  })

  it("registerScoped unregisters on scope close", async () => {
    const run2 = <A, E>(eff: Effect.Effect<A, E, MCPRegistry>) =>
      Effect.runPromise(eff.pipe(Effect.provide(MCPRegistry.Default)))

    const { duringScope, afterScope } = await run2(
      Effect.gen(function* () {
        const reg = yield* MCPRegistry
        const scope = yield* Scope.make()
        yield* registerScoped("scoped", stdio("inside")).pipe(
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
})
