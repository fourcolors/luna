import { Effect, Layer } from "effect"
import { makeSdkMcpServer } from "@luna/tools"
import type {
  McpSdkServerConfigWithInstance,
  SdkMcpToolDefinition,
  AnyZodRawShape,
} from "@anthropic-ai/claude-agent-sdk"
import { makePlaidTools } from "./tools.js"

export interface PlaidToolsConfig {
  readonly serverName: "plaid_tools"
  readonly server: McpSdkServerConfigWithInstance
  readonly systemPromptAddendum: string
}

export class PlaidToolsService extends Effect.Tag("luna/PlaidToolsService")<
  PlaidToolsService,
  PlaidToolsConfig
>() {}

export const PLAID_TOOLS_SYSTEM_PROMPT =
  "You have a Plaid financial data MCP server (`plaid_tools`). Use fully-qualified " +
  "tool names: `mcp__plaid_tools__plaid_get_accounts()` for balances, " +
  "`mcp__plaid_tools__plaid_get_transactions(days?, account_filter?)` for spending history, " +
  "`mcp__plaid_tools__plaid_get_recurring()` for recurring charges and income, and " +
  "`mcp__plaid_tools__plaid_get_net_worth()` for total assets minus liabilities. " +
  "Use these proactively when the user asks about finances, rent income, mortgage, " +
  "subscriptions, or spending. All access is read-only."

export const PlaidToolsLive = Layer.effect(
  PlaidToolsService,
  Effect.try({
    try: () => {
      const tools = makePlaidTools()
      const server = makeSdkMcpServer("plaid_tools", "0.0.1", tools as ReadonlyArray<SdkMcpToolDefinition<AnyZodRawShape>>)
      return {
        serverName: "plaid_tools" as const,
        server,
        systemPromptAddendum: PLAID_TOOLS_SYSTEM_PROMPT,
      }
    },
    catch: (e) => new Error(`PlaidTools init failed: ${e}`),
  }),
)
