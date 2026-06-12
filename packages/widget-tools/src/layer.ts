/**
 * WidgetToolsService — the `widget_tools` MCP server (PRD Part C / W4 §16).
 *
 * Mirrors SkillToolsService exactly so the chat-server's ThreadToolsProvider
 * wires it identically. widget_write is stateless per session (the artifact
 * store handle is process-wide and writes apply immediately), so
 * bindSession/clearSession are no-ops kept for uniformity.
 */
import { Effect, Layer } from "effect"
import { makeSdkMcpServer } from "@luna/tools"
import { ArtifactStore } from "@luna/core"
import type {
  AnyZodRawShape,
  McpSdkServerConfigWithInstance,
  SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk"
import { makeOpenWidgetTool, makeWidgetTools } from "./tools.js"
import type { WidgetSummonerPort } from "./tools.js"

export interface WidgetToolsSessionConfig {
  readonly serverName: "widget_tools"
  readonly server: McpSdkServerConfigWithInstance
  readonly systemPromptAddendum: string
  readonly bindSession: (sessionId: string) => void
  readonly clearSession: (sessionId: string) => void
}

export interface WidgetToolsConfig extends WidgetToolsSessionConfig {
  readonly createSessionBinding: () => WidgetToolsSessionConfig
}

export class WidgetToolsService extends Effect.Tag("luna/WidgetToolsService")<
  WidgetToolsService,
  WidgetToolsConfig
>() {}

export const buildWidgetToolsMcpServer = (
  tools: ReadonlyArray<unknown>,
): McpSdkServerConfigWithInstance => {
  const widened = tools as unknown as ReadonlyArray<
    SdkMcpToolDefinition<AnyZodRawShape>
  >
  return makeSdkMcpServer("widget_tools", "0.1.0", widened)
}

const createWidgetToolsConfig = (
  store: (typeof ArtifactStore)["Service"],
  summoner: WidgetSummonerPort | null,
): WidgetToolsSessionConfig => {
  // widget_write creates sandboxed content; open_widget (when a summoner is
  // wired) SUMMONS existing surfaces by registry kind — summon-by-name.
  const tools = [
    ...makeWidgetTools(store),
    ...(summoner ? [makeOpenWidgetTool(summoner)] : []),
  ]
  const server = buildWidgetToolsMcpServer(tools)
  return {
    serverName: "widget_tools",
    server,
    systemPromptAddendum: "",
    bindSession: () => {},
    clearSession: () => {},
  }
}

export const WidgetToolsLayer = (
  summoner: WidgetSummonerPort | null = null,
): Layer.Layer<WidgetToolsService, never, ArtifactStore> =>
  Layer.effect(
    WidgetToolsService,
    Effect.gen(function* () {
      const store = yield* ArtifactStore
      const config = createWidgetToolsConfig(store, summoner)
      return {
        ...config,
        createSessionBinding: () => createWidgetToolsConfig(store, summoner),
      }
    }),
  )
