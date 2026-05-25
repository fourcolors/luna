/**
 * defineTool / makeSdkMcpServer Tier-1 tests.
 *
 * Per the phase brief, zod is NOT a direct dep of this package — it's a
 * transitive peer via @anthropic-ai/claude-agent-sdk. The SDK's runtime
 * `tool()` treats the inputSchema opaquely (it's only inspected at JSON
 * schema conversion time when the MCP server actually starts serving
 * requests), so we exercise the builder with an empty raw shape for
 * unit-level verification.
 */
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { defineTool, makeSdkMcpServer } from "../src/builder.js"
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
