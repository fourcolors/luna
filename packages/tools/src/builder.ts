/**
 * Custom tool builder - the Effect-friendly wrapper around the SDK's
 * `tool()` and `createSdkMcpServer()` factories.
 *
 * Per DESIGN.md §4 this lives in the Runtime layer (not Persistence):
 * it produces SDK-native objects ready to be plugged into `Options`
 * or registered with `MCPRegistry`.
 *
 * Handler contract:
 *   - User supplies an `Effect<JSONOutput, ToolError>` (no requirements).
 *   - We `Effect.runPromiseExit` at the SDK boundary because the SDK's
 *     `tool()` signature demands `Promise<CallToolResult>`. This is the
 *     single allowed boundary crossing (§3.4 #1: no runFork outside
 *     Layer scope; runPromise is permitted as the last step at
 *     ecosystem edges where the third-party API is Promise-shaped).
 *   - On success we wrap output in `{ content: [{type:"text", text: JSON}] }`.
 *   - On ToolError we return `{ isError: true, content: [...] }` per
 *     MCP conventions so the model sees the failure.
 *   - On MCP request cancellation we interrupt the Effect fiber via the
 *     AbortSignal on the handler `extra` (issue #334). Without this, an
 *     aborted request left long-running tool fibers running forever.
 */
import { Cause, Effect } from "effect"
import {
  tool as sdkTool,
  createSdkMcpServer as sdkCreateServer,
} from "@anthropic-ai/claude-agent-sdk"
import type {
  SdkMcpToolDefinition,
  McpSdkServerConfigWithInstance,
  AnyZodRawShape,
  InferShape,
} from "@anthropic-ai/claude-agent-sdk"
import { ToolError } from "./errors.js"

/** JSON-serializable output from a tool handler. */
export type JSONOutput =
  | string
  | number
  | boolean
  | null
  | { readonly [k: string]: JSONOutput }
  | ReadonlyArray<JSONOutput>

export interface DefineToolSpec<Schema extends AnyZodRawShape> {
  readonly name: string
  readonly description: string
  readonly inputSchema: Schema
  readonly searchHint?: string
  readonly alwaysLoad?: boolean
  readonly handler: (
    args: InferShape<Schema>,
  ) => Effect.Effect<JSONOutput, ToolError>
}

/**
 * Pull the MCP AbortSignal out of the SDK tool handler's opaque `extra`.
 *
 * The agent SDK types `extra` as `unknown`; at runtime MCP's
 * `RequestHandlerExtra` carries `signal: AbortSignal`. Duck-type so we do
 * not take a hard dependency on `@modelcontextprotocol/sdk` types here.
 * Missing / malformed extra is a no-op (same as pre-#334 behaviour).
 */
export function abortSignalFromToolExtra(extra: unknown): AbortSignal | undefined {
  if (typeof extra !== "object" || extra === null) return undefined
  const signal = (extra as { signal?: unknown }).signal
  return signal instanceof AbortSignal ? signal : undefined
}

/**
 * Build a `SdkMcpToolDefinition` from an Effect-shaped handler. The
 * returned value is what the SDK's `createSdkMcpServer` consumes.
 */
export const defineTool = <Schema extends AnyZodRawShape>(
  spec: DefineToolSpec<Schema>,
): SdkMcpToolDefinition<Schema> =>
  sdkTool(
    spec.name,
    spec.description,
    spec.inputSchema,
    async (args, extra) => {
      const signal = abortSignalFromToolExtra(extra)
      const exit = await Effect.runPromiseExit(
        spec.handler(args),
        signal !== undefined ? { signal } : undefined,
      )
      if (exit._tag === "Success") {
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(exit.value) },
          ],
        }
      }
      // MCP cancelled the request - fiber was interrupted via AbortSignal.
      // Surface a clear cancelled result rather than a generic failure string.
      if (Cause.hasInterruptsOnly(exit.cause)) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `tool "${spec.name}" cancelled`,
            },
          ],
        }
      }
      // Failure: render ToolError (and any defects) as an MCP error result.
      const maybeError = Cause.findErrorOption(exit.cause)
      const message =
        maybeError._tag === "Some" && maybeError.value instanceof ToolError
          ? `${maybeError.value.tool}.${maybeError.value.op}: ${String(maybeError.value.cause)}`
          : `tool "${spec.name}" failed: ${String(exit.cause)}`
      return {
        isError: true,
        content: [{ type: "text" as const, text: message }],
      }
    },
    {
      ...(spec.searchHint !== undefined ? { searchHint: spec.searchHint } : {}),
      ...(spec.alwaysLoad !== undefined ? { alwaysLoad: spec.alwaysLoad } : {}),
    },
  )

/**
 * Thin Effect-friendly wrapper around `createSdkMcpServer`. Returns the
 * `McpSdkServerConfigWithInstance` ready to register with MCPRegistry
 * (via `register(name, config)`) or splat directly into
 * `Options.mcpServers`.
 */
export const makeSdkMcpServer = (
  name: string,
  version: string,
  tools: ReadonlyArray<SdkMcpToolDefinition<AnyZodRawShape>>,
): McpSdkServerConfigWithInstance =>
  sdkCreateServer({
    name,
    version,
    tools: [...tools],
  })
