/**
 * defineTool / makeSdkMcpServer Tier-1 tests.
 *
 * Per the phase brief, zod is NOT a direct dep of this package - it's a
 * transitive peer via @anthropic-ai/claude-agent-sdk. The SDK's runtime
 * `tool()` treats the inputSchema opaquely (it's only inspected at JSON
 * schema conversion time when the MCP server actually starts serving
 * requests), so we exercise the builder with an empty raw shape for
 * unit-level verification.
 */
import { describe, expect, it } from "vitest"
import { Effect, Ref } from "effect"
import {
  abortSignalFromToolExtra,
  defineTool,
  makeSdkMcpServer,
} from "../src/builder.js"
import { ToolError } from "../src/errors.js"

// `AnyZodRawShape` is structurally `{[k]: ZodType}` — empty satisfies it.
// We cast to the SDK type with `as never` to avoid a direct zod import.
const emptyShape = {} as never

describe("defineTool", () => {
  it("produces an SdkMcpToolDefinition with name/description/schema/handler", () => {
    const def = defineTool({
      name: "echo",
      description: "echo the input",
      inputSchema: emptyShape,
      handler: () => Effect.succeed("ok"),
    })
    expect(def.name).toBe("echo")
    expect(def.description).toBe("echo the input")
    expect(def.inputSchema).toBeDefined()
    expect(typeof def.handler).toBe("function")
  })

  it("handler returns a text CallToolResult on success", async () => {
    const def = defineTool({
      name: "echo",
      description: "d",
      inputSchema: emptyShape,
      handler: () => Effect.succeed({ got: "hi" }),
    })
    const result = await def.handler({}, undefined)
    expect(Array.isArray(result.content)).toBe(true)
    expect(result.isError).toBeFalsy()
    const first = result.content?.[0]
    expect(first?.type).toBe("text")
    expect((first as { text: string }).text).toContain('"got":"hi"')
  })

  it("handler returns isError=true when ToolError is raised", async () => {
    const def = defineTool({
      name: "boom",
      description: "d",
      inputSchema: emptyShape,
      handler: () =>
        Effect.fail(
          new ToolError({ tool: "boom", op: "invoke", cause: "kapow" }),
        ),
    })
    const result = await def.handler({}, undefined)
    expect(result.isError).toBe(true)
    const first = result.content?.[0]
    expect((first as { text: string }).text).toContain("boom.invoke")
    expect((first as { text: string }).text).toContain("kapow")
  })

  it("handler passes parsed args through to the Effect body", async () => {
    let seen: unknown = null
    const def = defineTool({
      name: "capture",
      description: "d",
      inputSchema: emptyShape,
      handler: (args) =>
        Effect.sync(() => {
          seen = args
          return "done"
        }),
    })
    await def.handler({ passed: "through", n: 7 }, undefined)
    expect(seen).toEqual({ passed: "through", n: 7 })
  })

  it("passes SDK discovery metadata through to the MCP tool definition", () => {
    const def = defineTool({
      name: "discoverable",
      description: "d",
      inputSchema: emptyShape,
      searchHint: "Find durable user facts and preferences.",
      alwaysLoad: true,
      handler: () => Effect.succeed("ok"),
    })

    expect(def._meta).toMatchObject({
      "anthropic/searchHint": "Find durable user facts and preferences.",
      "anthropic/alwaysLoad": true,
    })
  })

  // issue #334: MCP request cancellation must interrupt the Effect fiber.
  it("interrupts a hanging handler when the MCP AbortSignal aborts (#334)", async () => {
    const started = await Effect.runPromise(Ref.make(false))
    const def = defineTool({
      name: "hang",
      description: "d",
      inputSchema: emptyShape,
      handler: () =>
        Effect.gen(function* () {
          yield* Ref.set(started, true)
          // Intentionally never completes unless interrupted.
          yield* Effect.never
          return "unreachable"
        }),
    })

    const ac = new AbortController()
    const pending = def.handler({}, { signal: ac.signal })
    // Wait until the fiber has entered the handler body.
    for (let i = 0; i < 50; i++) {
      if (await Effect.runPromise(Ref.get(started))) break
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(await Effect.runPromise(Ref.get(started))).toBe(true)

    ac.abort()
    const result = await pending
    expect(result.isError).toBe(true)
    const first = result.content?.[0]
    expect((first as { text: string }).text).toContain("cancelled")
  })

  it("interrupts immediately when the AbortSignal is already aborted (#334)", async () => {
    let entered = false
    const def = defineTool({
      name: "pre-aborted",
      description: "d",
      inputSchema: emptyShape,
      handler: () =>
        Effect.gen(function* () {
          entered = true
          yield* Effect.sleep("5 seconds")
          return "late"
        }),
    })

    const ac = new AbortController()
    ac.abort()
    const result = await def.handler({}, { signal: ac.signal })
    expect(result.isError).toBe(true)
    expect((result.content?.[0] as { text: string }).text).toContain("cancelled")
    // The fiber may briefly enter before interruption lands; the critical
    // property is the handler does not complete successfully.
    void entered
  })

  it("still succeeds when extra has no AbortSignal (#334 regression)", async () => {
    const def = defineTool({
      name: "echo",
      description: "d",
      inputSchema: emptyShape,
      handler: () => Effect.succeed({ ok: true }),
    })
    const result = await def.handler({}, { notASignal: 1 })
    expect(result.isError).toBeFalsy()
    expect((result.content?.[0] as { text: string }).text).toContain('"ok":true')
  })
})

describe("abortSignalFromToolExtra", () => {
  it("extracts AbortSignal from MCP-shaped extra", () => {
    const ac = new AbortController()
    expect(abortSignalFromToolExtra({ signal: ac.signal })).toBe(ac.signal)
  })

  it("returns undefined for missing / malformed extra", () => {
    expect(abortSignalFromToolExtra(undefined)).toBeUndefined()
    expect(abortSignalFromToolExtra(null)).toBeUndefined()
    expect(abortSignalFromToolExtra({})).toBeUndefined()
    expect(abortSignalFromToolExtra({ signal: "nope" })).toBeUndefined()
  })
})

describe("makeSdkMcpServer", () => {
  it("creates an sdk-type server carrying the registered tools", () => {
    const t = defineTool({
      name: "ping",
      description: "p",
      inputSchema: emptyShape,
      handler: () => Effect.succeed("pong"),
    })
    const server = makeSdkMcpServer("my-server", "0.0.1", [t])
    expect(server.type).toBe("sdk")
    expect(server.name).toBe("my-server")
    expect(server.instance).toBeDefined()
  })
})
