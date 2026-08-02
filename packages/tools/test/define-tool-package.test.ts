/**
 * defineToolPackage tests.
 *
 * The prior attempt at this factory failed review because its registration
 * test asserted nothing about which tools actually landed on the MCP server
 * — emptying the tools array left it green. Every assertion below that
 * claims tools are registered probes the real SDK `McpServer` instance's
 * `_registeredTools` record (the same introspection local-shell-tools'
 * mcp-structure test already uses), not the input array we passed in.
 */
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { defineTool } from "../src/builder.js"
import { defineToolPackage } from "../src/define-tool-package.js"
import type {
  AnyZodRawShape,
  SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk"

// `AnyZodRawShape` is structurally `{[k]: ZodType}` — empty satisfies it,
// same convention as builder.test.ts.
const emptyShape = {} as never

const makeTool = (name: string) =>
  defineTool({
    name,
    description: `does ${name}`,
    inputSchema: emptyShape,
    handler: () => Effect.succeed(name),
  })

const widen = (
  tools: ReadonlyArray<ReturnType<typeof makeTool>>,
): ReadonlyArray<SdkMcpToolDefinition<AnyZodRawShape>> =>
  tools as unknown as ReadonlyArray<SdkMcpToolDefinition<AnyZodRawShape>>

/**
 * Pull the actually-registered tool names off the real SDK `McpServer`
 * instance produced by `createSdkMcpServer`, rather than trusting the
 * spec's input array. This is the introspection the reviewer asked for.
 */
const registeredToolNames = (server: unknown): ReadonlyArray<string> => {
  const instance = (
    server as { instance?: { _registeredTools?: Record<string, unknown> } }
  ).instance
  return Object.keys(instance?._registeredTools ?? {})
}

describe("defineToolPackage", () => {
  it("registers exactly the given tools on the produced MCP server", () => {
    const tools = widen([makeTool("alpha"), makeTool("beta"), makeTool("gamma")])
    const config = defineToolPackage({ name: "sample_tools", tools })

    expect(config.serverName).toBe("sample_tools")
    expect((config.server as { type?: string }).type).toBe("sdk")
    expect((config.server as { name?: string }).name).toBe("sample_tools")
    expect(registeredToolNames(config.server).sort()).toEqual([
      "alpha",
      "beta",
      "gamma",
    ])
  })

  it("surfaces the addendum text identically, defaulting to empty string", () => {
    const tools = widen([makeTool("solo")])

    const withAddendum = defineToolPackage({
      name: "sample_tools",
      tools,
      addendum: "Call mcp__sample_tools__solo when needed.",
    })
    expect(withAddendum.systemPromptAddendum).toBe(
      "Call mcp__sample_tools__solo when needed.",
    )

    const withoutAddendum = defineToolPackage({ name: "sample_tools", tools })
    expect(withoutAddendum.systemPromptAddendum).toBe("")
  })

  it("exposes bindSession/clearSession as no-ops, matching skill-tools' stateless shape", () => {
    const tools = widen([makeTool("solo")])
    const config = defineToolPackage({ name: "sample_tools", tools })

    expect(typeof config.bindSession).toBe("function")
    expect(typeof config.clearSession).toBe("function")
    expect(config.bindSession("thread-1")).toBeUndefined()
    expect(config.clearSession("thread-1")).toBeUndefined()

    const binding = config.createSessionBinding()
    expect(typeof binding.bindSession).toBe("function")
    expect(typeof binding.clearSession).toBe("function")
    expect(binding.bindSession("thread-2")).toBeUndefined()
    expect(binding.clearSession("thread-2")).toBeUndefined()
  })

  it("createSessionBinding builds a fresh MCP server instance per call, each still carrying the tools", () => {
    const tools = widen([makeTool("solo")])
    const config = defineToolPackage({ name: "sample_tools", tools })

    const first = config.createSessionBinding()
    const second = config.createSessionBinding()

    expect(first.serverName).toBe("sample_tools")
    expect(second.serverName).toBe("sample_tools")
    expect((first.server as { instance?: unknown }).instance).not.toBe(
      (second.server as { instance?: unknown }).instance,
    )
    expect(registeredToolNames(first.server).sort()).toEqual(["solo"])
    expect(registeredToolNames(second.server).sort()).toEqual(["solo"])
  })
})
