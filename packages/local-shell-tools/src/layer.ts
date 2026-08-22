import { Context, Effect, Layer } from "effect"
import { defineToolPackage } from "@luna/tools"
import type { LocalShellBridge } from "@luna/ui-ws"
import type {
  AnyZodRawShape,
  McpSdkServerConfigWithInstance,
  SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk"
import { makeLocalShellTools } from "./tools.js"

export interface LocalShellToolsSessionConfig {
  readonly serverName: "local_shell"
  readonly server: McpSdkServerConfigWithInstance
  readonly systemPromptAddendum: string
  readonly bindSession: (sessionId: string) => void
  readonly clearSession: (sessionId: string) => void
}

export interface LocalShellToolsConfig extends LocalShellToolsSessionConfig {
  readonly createSessionBinding: () => LocalShellToolsSessionConfig
}

export class LocalShellToolsService extends Context.Service<
  LocalShellToolsService,
  LocalShellToolsConfig
>()("luna/LocalShellToolsService") {}

export const LOCAL_SHELL_SYSTEM_PROMPT_ADDENDUM =
  "You have one local shell MCP server (`local_shell`) with tools " +
  "`mcp__local_shell__local_shell_run(command, cwd?, timeout_ms?)` and " +
  "`mcp__local_shell__local_shell_list_roots()`. Use these fully qualified MCP tool names " +
  "exactly; do not call the bare names. They operate on the current thread's local shell " +
  "binding. The binding may be Operator's attached Luna terminal client or an auto-approved " +
  "Luna container sandbox. " +
  "The client may attach one or more working-directory roots (specific folders) and/or grant " +
  "full-machine access. Call `local_shell_list_roots` first to see what is attached, then pass " +
  "a `cwd` inside one of the attached roots: commands whose working directory is inside a root " +
  "are auto-approved by the client. A command outside every attached root may be denied " +
  "outright (e.g. in the desktop widget) or require explicit per-command approval (e.g. the " +
  "terminal client); when `fullAccess` is true the client allows any working directory. A " +
  "trusted container session may advertise auto approval; in that mode commands run inside the " +
  "attached container without a per-command prompt. " +
  "If the local shell client is unavailable, no session is bound, or the user denied " +
  "approval, report that the command could not run and do not claim local execution " +
  "succeeded. Non-zero exit codes, stdout, stderr, and timeouts are returned as command " +
  "results so you can explain what happened."

export interface LocalShellToolsLayerOptions {
  readonly bridge: LocalShellBridge
}

const createLocalShellToolsConfig = (
  bridge: LocalShellBridge,
): LocalShellToolsSessionConfig => {
  const sessionCell: { value: string | null } = { value: null }
  const currentThreadId = () => sessionCell.value
  const bindSession = (sessionId: string) => {
    sessionCell.value = sessionId
  }
  const clearSession = (sessionId: string) => {
    if (sessionCell.value === sessionId) {
      sessionCell.value = null
    }
  }

  const tools = makeLocalShellTools(bridge, currentThreadId)
  const server = buildLocalShellMcpServer(tools)

  return {
    serverName: "local_shell",
    server,
    systemPromptAddendum: LOCAL_SHELL_SYSTEM_PROMPT_ADDENDUM,
    bindSession,
    clearSession,
  }
}

export const buildLocalShellMcpServer = (
  tools: ReturnType<typeof makeLocalShellTools>,
): McpSdkServerConfigWithInstance => {
  const widened = tools as unknown as ReadonlyArray<
    SdkMcpToolDefinition<AnyZodRawShape>
  >
  return defineToolPackage({ name: "local_shell", tools: widened }).server
}

export const LocalShellToolsLayer = (
  opts: LocalShellToolsLayerOptions,
): Layer.Layer<LocalShellToolsService> =>
  Layer.effect(
    LocalShellToolsService,
    Effect.gen(function* () {
      const config = createLocalShellToolsConfig(opts.bridge)
      return {
        ...config,
        createSessionBinding: () => createLocalShellToolsConfig(opts.bridge),
      }
    }),
  )
