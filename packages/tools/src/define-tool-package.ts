/**
 * defineToolPackage — the ceremony every tool package's `layer.ts` currently
 * hand-rolls, factored into one call.
 *
 * Reading skill-tools/secret-tools/thread-tools side by side, each package
 * repeats the same shape around a different tool list:
 *   - build an SDK MCP server from the tool list (`makeSdkMcpServer`)
 *   - wrap it as `{ serverName, server, systemPromptAddendum, bindSession,
 *     clearSession }`, the record `ThreadToolsProvider` and chat-server
 *     expect
 *   - expose `createSessionBinding()` so each chat thread gets its own SDK
 *     `McpServer` instance instead of a shared one
 *
 * This factory produces exactly that record for the common, stateless case
 * (skill-tools' shape): `bindSession`/`clearSession` are deliberate no-ops.
 * Packages that need session-scoped state — secret-tools' request routing,
 * thread-tools' fork-child tagging — keep their own closures for those two
 * hooks; this factory only removes the boilerplate shared by all ten
 * packages, not the bespoke parts. Wrapping the result in a package's own
 * `Context.Service` service class and `Layer` is unchanged.
 */
import { makeSdkMcpServer } from "./builder.js"
import type {
  AnyZodRawShape,
  McpSdkServerConfigWithInstance,
  SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk"

/** Every tool package's MCP server is versioned "0.1.0", matching house style. */
const TOOL_PACKAGE_SERVER_VERSION = "0.1.0"

export interface ToolPackageSessionConfig {
  readonly serverName: string
  readonly server: McpSdkServerConfigWithInstance
  readonly systemPromptAddendum: string
  readonly bindSession: (sessionId: string) => void
  readonly clearSession: (sessionId: string) => void
}

export interface ToolPackageConfig extends ToolPackageSessionConfig {
  readonly createSessionBinding: () => ToolPackageSessionConfig
}

export interface DefineToolPackageSpec {
  readonly name: string
  readonly tools: ReadonlyArray<SdkMcpToolDefinition<AnyZodRawShape>>
  readonly addendum?: string
}

const buildSessionConfig = (
  spec: DefineToolPackageSpec,
): ToolPackageSessionConfig => ({
  serverName: spec.name,
  server: makeSdkMcpServer(spec.name, TOOL_PACKAGE_SERVER_VERSION, spec.tools),
  systemPromptAddendum: spec.addendum ?? "",
  bindSession: () => {},
  clearSession: () => {},
})

/**
 * Build the {@link ToolPackageConfig} artifacts for a tool package: an SDK
 * MCP server named `spec.name` that registers exactly `spec.tools`, plus the
 * session-binding shape callers already expect. `createSessionBinding()`
 * rebuilds the server so every chat thread gets its own `McpServer`
 * instance, the same isolation every hand-rolled package already provides.
 */
export const defineToolPackage = (
  spec: DefineToolPackageSpec,
): ToolPackageConfig => ({
  ...buildSessionConfig(spec),
  createSessionBinding: () => buildSessionConfig(spec),
})
