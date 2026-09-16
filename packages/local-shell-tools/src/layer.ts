import { Context, Effect, Layer } from "effect"
import { defineToolPackage } from "@luna/tools"
import type { LocalShellBridge } from "@luna/ui-ws"
import type {
  AnyZodRawShape,
  McpSdkServerConfigWithInstance,
  SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk"
import { makeLocalShellTools, type LocalShellSessionRef } from "./tools.js"

export interface LocalShellToolsSessionConfig {
  readonly serverName: "local_shell"
  readonly server: McpSdkServerConfigWithInstance
  readonly systemPromptAddendum: string
  readonly bindSession: (
    sessionId: string,
    threadTags?: ReadonlyArray<string>,
  ) => void
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
  "`mcp__local_shell__local_shell_run(command, target?, cwd?, timeout_ms?)` and " +
  "`mcp__local_shell__local_shell_list_roots()`. Use these fully qualified MCP tool names " +
  "exactly; do not call the bare names. " +
  "MORE THAN ONE MACHINE CAN BE ATTACHED TO A THREAD AT ONCE — typically Operator's " +
  "desktop client and the server's own container. Call `local_shell_list_roots` FIRST: it " +
  "returns every attached machine with the `label` you pass as `target`, its platform, and " +
  "its working-directory roots. When it reports `targetRequired: true` you MUST pass " +
  "`target` on every run; there is deliberately no default, and a `target` that is not " +
  "attached is an error rather than a fallback to some other machine. " +
  "Every result carries `ranOn`, naming the machine that actually served the command. READ " +
  "IT. If a path looks missing, check `ranOn.label` before concluding the file is absent — " +
  "asking the wrong machine and the file being gone produce identical output otherwise. " +
  "Commands run inside a machine's attached roots are auto-approved; outside them a client " +
  "may deny or prompt, unless it reports `fullAccess: true`. " +
  "Unattended threads (forked children, and threads created from an inbound channel " +
  "message) can reach ONLY the server's own sandbox, never a personal machine; " +
  "`list_roots` reports that as `unattendedThread: true`. " +
  "If no machine is attached, or the user denied approval, report that the command could " +
  "not run and do not claim local execution succeeded. Non-zero exit codes, stdout, stderr " +
  "and timeouts are returned as results so you can explain what happened."

export interface LocalShellToolsLayerOptions {
  readonly bridge: LocalShellBridge
}

const createLocalShellToolsConfig = (
  bridge: LocalShellBridge,
): LocalShellToolsSessionConfig => {
  const sessionCell: { value: LocalShellSessionRef | null } = { value: null }
  const currentSession = () => sessionCell.value
  const bindSession = (
    sessionId: string,
    threadTags?: ReadonlyArray<string>,
  ) => {
    sessionCell.value = { threadId: sessionId, threadTags: threadTags ?? [] }
  }
  const clearSession = (sessionId: string) => {
    if (sessionCell.value?.threadId === sessionId) {
      sessionCell.value = null
    }
  }

  const tools = makeLocalShellTools(bridge, currentSession)
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
