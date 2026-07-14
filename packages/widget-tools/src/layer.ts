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
import {
  makeMcpAppTools,
  makeOpenArtifactTool,
  makeOpenWidgetTool,
  makeSearchArtifactsTool,
  makeShowArtifactTool,
  makeWidgetTools,
} from "./tools.js"
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

/**
 * The widget_tools system-prompt addendum (S3 "best-guess open/create"). A
 * terse decision rubric so the agent picks the smallest action — open an
 * existing panel, reopen a built artifact, or create a new one — on the FIRST
 * try, plus a best-effort snapshot of the host's live panel directory so the
 * first open_widget guess can land without a failed round-trip.
 */
export const buildWidgetToolsAddendum = (
  summoner: WidgetSummonerPort | null,
): string => {
  const dir = summoner ? summoner.directory() : []
  const dirLines =
    dir.length > 0
      ? "\n\nThe user's app currently offers these panels (open by `kind` with open_widget):\n" +
        dir.map((w) => `- ${w.kind} — ${w.description}`).join("\n")
      : ""
  return (
    "## Showing things on the user's screen\n" +
    "You can open windows on the user's screen. Pick the smallest action that fits the request:\n" +
    "- Show an EXISTING panel or settings page ('open my voice settings'): call `open_widget` with the closest matching kind — guess from the descriptions; a wrong guess returns the full list so you can retry.\n" +
    "- SHOW CONTENT you just produced (code, a markdown doc, an HTML preview) in a panel ('show me that in a panel', 'put the code somewhere I can see it'): call `show_artifact` with the content inline — it is pinned and opened, rendered for its kind.\n" +
    "- REOPEN something built earlier (a widget/app/doc the user asks to see again): `search_artifacts` to find it, then `open_artifact` with the id. ALWAYS search before creating so you never make a duplicate.\n" +
    "- CREATE a new INTERACTIVE panel: `widget_write` for a self-contained static or obs-event widget; `mcp_app_write` when it must pull LIVE data via the curated tools (pulse, list-artifacts, memory-list, memory-search). Newly created widgets/apps open automatically.\n" +
    "You only SUMMON UI — you cannot read or operate what is inside an opened window, and panel mutations stay the user's own gesture." +
    dirLines
  )
}

const createWidgetToolsConfig = (
  store: (typeof ArtifactStore)["Service"],
  summoner: WidgetSummonerPort | null,
): WidgetToolsSessionConfig => {
  // widget_write creates sandboxed content (auto-opening it on create when a
  // summoner is wired); search_artifacts reads the durable store so the agent
  // can find a closed artifact; open_widget SUMMONS system surfaces by registry
  // kind and open_artifact pops a CONTENT artifact by id — both need a host.
  const tools = [
    ...makeWidgetTools(store, summoner),
    ...makeMcpAppTools(store, summoner),
    makeSearchArtifactsTool(store),
    ...(summoner
      ? [
          makeOpenWidgetTool(summoner),
          makeOpenArtifactTool(store, summoner),
          // show_artifact pins a CONTENT artifact (code/markdown/html) then
          // opens it — summoner-gated like open_artifact (no host → nothing
          // to show; opens buffer + replay on reconnect via the bridge).
          makeShowArtifactTool(store, summoner),
        ]
      : []),
  ]
  const server = buildWidgetToolsMcpServer(tools)
  return {
    serverName: "widget_tools",
    server,
    systemPromptAddendum: buildWidgetToolsAddendum(summoner),
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
