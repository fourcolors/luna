import { Effect, Layer } from "effect"
import { makeSdkMcpServer } from "@luna/tools"
import type { LocalShellBridge } from "@luna/ui-ws"
import type {
  AnyZodRawShape,
  McpSdkServerConfigWithInstance,
  SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk"
import { makeLocalShellTools } from "./tools.js"

export interface LocalShellToolsConfig {
  readonly serverName: "local_shell"
  readonly server: McpSdkServerConfigWithInstance
  readonly systemPromptAddendum: string
  readonly bindSession: (sessionId: string) => void
  readonly clearSession: (sessionId: string) => void
}

export class LocalShellToolsService extends Effect.Tag(
  "luna/LocalShellToolsService",
)<LocalShellToolsService, LocalShellToolsConfig>() {}

export const LOCAL_SHELL_SYSTEM_PROMPT_ADDENDUM =
  "You have one local shell MCP server (`local_shell`) with tool " +
  "`local_shell_run(command, cwd?, timeout_ms?, thread_id?)`. It requests command " +
  "execution in Sterling's attached Luna terminal client for the current thread. " +
  "Every command requires explicit user approval in that terminal before it runs. " +
  "If the local shell client is unavailable, no session is bound, or the user denied " +
  "approval, report that the command could not run and do not claim local execution " +
  "succeeded. Non-zero exit codes, stdout, stderr, and timeouts are returned as command " +
  "results so you can explain what happened."

export interface LocalShellToolsLayerOptions {
  readonly bridge: LocalShellBridge
}

export const buildLocalShellMcpServer = (
  tools: ReturnType<typeof makeLocalShellTools>,
): McpSdkServerConfigWithInstance => {
  const widened = tools as unknown as ReadonlyArray<
    SdkMcpToolDefinition<AnyZodRawShape>
  >
  return makeSdkMcpServer("local_shell", "0.1.0", widened)
}

export const LocalShellToolsLayer = (
  opts: LocalShellToolsLayerOptions,
): Layer.Layer<LocalShellToolsService> =>
  Layer.scoped(
    LocalShellToolsService,
    Effect.gen(function* () {
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

      const tools = makeLocalShellTools(opts.bridge, currentThreadId)
      const server = buildLocalShellMcpServer(tools)

      return {
        serverName: "local_shell" as const,
        server,
        systemPromptAddendum: LOCAL_SHELL_SYSTEM_PROMPT_ADDENDUM,
        bindSession,
        clearSession,
      }
    }),
  )
