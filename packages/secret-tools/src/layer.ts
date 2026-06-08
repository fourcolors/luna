import { Effect, Layer } from "effect"
import { makeSdkMcpServer } from "@luna/tools"
import type { SecretRequestBridge } from "@luna/ui-ws"
import type {
  AnyZodRawShape,
  McpSdkServerConfigWithInstance,
  SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk"
import { makeSecretTools } from "./tools.js"

export interface SecretToolsSessionConfig {
  readonly serverName: "secret_tools"
  readonly server: McpSdkServerConfigWithInstance
  readonly systemPromptAddendum: string
  readonly bindSession: (sessionId: string) => void
  readonly clearSession: (sessionId: string) => void
}

export interface SecretToolsConfig extends SecretToolsSessionConfig {
  readonly createSessionBinding: () => SecretToolsSessionConfig
}

export class SecretToolsService extends Effect.Tag("luna/SecretToolsService")<
  SecretToolsService,
  SecretToolsConfig
>() {}

export const SECRET_TOOLS_SYSTEM_PROMPT_ADDENDUM =
  "You have a secret-entry MCP server (`secret_tools`) with the tool " +
  "`mcp__secret_tools__request_secret(prompt, destination_kind, label)`. Use this " +
  "fully qualified name exactly; do not call the bare name. When the operator " +
  "needs to give you a credential (a 1Password service-account token, an API " +
  "key, a password), NEVER ask them to paste it into the chat — call " +
  "request_secret, which opens a protected input field in their Luna client and " +
  "stores the value server-side without it ever entering this conversation or " +
  "your context. You only learn whether storage succeeded. The stored secret " +
  "activates after a brief server restart at the END of this turn, so do not " +
  "try to use it within the same turn — tell the operator it will be live " +
  "momentarily. destination_kind 'op-token' stores a 1Password service-account " +
  "token for an account label (must already be in LUNA_OP_ACCOUNTS; pass " +
  "`label`). destination_kind 'env-secret' stores a value as an environment " +
  "variable (pass `var_name`); afterwards an account whose secret_ref is " +
  "'env:<var_name>' resolves it."

export interface SecretToolsLayerOptions {
  readonly bridge: SecretRequestBridge
}

const createSecretToolsConfig = (
  bridge: SecretRequestBridge,
): SecretToolsSessionConfig => {
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

  const tools = makeSecretTools(bridge, currentThreadId)
  const server = buildSecretToolsMcpServer(tools)

  return {
    serverName: "secret_tools",
    server,
    systemPromptAddendum: SECRET_TOOLS_SYSTEM_PROMPT_ADDENDUM,
    bindSession,
    clearSession,
  }
}

export const buildSecretToolsMcpServer = (
  tools: ReturnType<typeof makeSecretTools>,
): McpSdkServerConfigWithInstance => {
  const widened = tools as unknown as ReadonlyArray<
    SdkMcpToolDefinition<AnyZodRawShape>
  >
  return makeSdkMcpServer("secret_tools", "0.1.0", widened)
}

export const SecretToolsLayer = (
  opts: SecretToolsLayerOptions,
): Layer.Layer<SecretToolsService> =>
  Layer.scoped(
    SecretToolsService,
    Effect.gen(function* () {
      const config = createSecretToolsConfig(opts.bridge)
      return {
        ...config,
        createSessionBinding: () => createSecretToolsConfig(opts.bridge),
      }
    }),
  )
