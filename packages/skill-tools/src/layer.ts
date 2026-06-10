/**
 * SkillToolsService — the `skill_tools` MCP server (PRD Part B §11).
 *
 * Mirrors the secret-tools/local-shell-tools service shape so the
 * chat-server's ThreadToolsProvider wires it identically. skill_load is
 * stateless per-session (the registry handle is process-wide and toggles
 * apply instantly), so bindSession/clearSession are no-ops kept for
 * uniformity with the other per-thread tool bindings.
 *
 * No systemPromptAddendum: the Skills INDEX block (registry "index"
 * disclosure, injected by decorate()) already carries the usage
 * instruction — duplicating it here would spend context twice.
 */
import { Effect, Layer } from "effect"
import { makeSdkMcpServer } from "@luna/tools"
import { SkillRegistry } from "@luna/core"
import type {
  AnyZodRawShape,
  McpSdkServerConfigWithInstance,
  SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk"
import { makeSkillTools } from "./tools.js"

export interface SkillToolsSessionConfig {
  readonly serverName: "skill_tools"
  readonly server: McpSdkServerConfigWithInstance
  readonly systemPromptAddendum: string
  readonly bindSession: (sessionId: string) => void
  readonly clearSession: (sessionId: string) => void
}

export interface SkillToolsConfig extends SkillToolsSessionConfig {
  readonly createSessionBinding: () => SkillToolsSessionConfig
}

export class SkillToolsService extends Effect.Tag("luna/SkillToolsService")<
  SkillToolsService,
  SkillToolsConfig
>() {}

export const buildSkillToolsMcpServer = (
  tools: ReturnType<typeof makeSkillTools>,
): McpSdkServerConfigWithInstance => {
  const widened = tools as unknown as ReadonlyArray<
    SdkMcpToolDefinition<AnyZodRawShape>
  >
  return makeSdkMcpServer("skill_tools", "0.1.0", widened)
}

const createSkillToolsConfig = (
  registry: (typeof SkillRegistry)["Service"],
): SkillToolsSessionConfig => {
  const tools = makeSkillTools(registry)
  const server = buildSkillToolsMcpServer(tools)
  return {
    serverName: "skill_tools",
    server,
    systemPromptAddendum: "",
    bindSession: () => {},
    clearSession: () => {},
  }
}

export const SkillToolsLayer = (): Layer.Layer<
  SkillToolsService,
  never,
  SkillRegistry
> =>
  Layer.effect(
    SkillToolsService,
    Effect.gen(function* () {
      const registry = yield* SkillRegistry
      const config = createSkillToolsConfig(registry)
      return {
        ...config,
        createSessionBinding: () => createSkillToolsConfig(registry),
      }
    }),
  )
