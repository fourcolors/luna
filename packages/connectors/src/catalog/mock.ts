/**
 * Mock connector — M1's proof that the whole pipeline works with zero
 * OAuth: definition → connect → instance row → refreshMounts →
 * mountSnapshotSync → per-thread mcpServers → the agent can call
 * `mcp__mock_connector__connector_ping`.
 *
 * Ships in the catalog but is harmless: auth "none", one echo tool, no
 * external calls. Doubles as the reference `native`-transport definition.
 */
import { Effect } from "effect"
import { z } from "zod"
import { defineTool, makeSdkMcpServer } from "@luna/tools"
import type {
  AnyZodRawShape,
  SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk"
import type { ConnectorDefinition } from "../types.js"

const makeMockServer = () => {
  const ping = defineTool({
    name: "connector_ping",
    description:
      "Echo test for the mock connector. Returns pong with your message — " +
      "proves the connector pipeline delivered this tool to the agent.",
    inputSchema: {
      message: z.string().describe("Anything; it is echoed back."),
    },
    handler: (args) =>
      Effect.succeed({ pong: true, echoed: args.message }),
  })
  const widened = [ping] as unknown as ReadonlyArray<
    SdkMcpToolDefinition<AnyZodRawShape>
  >
  return makeSdkMcpServer("mock_connector", "0.1.0", widened)
}

export const MOCK_CONNECTOR: ConnectorDefinition = {
  id: "mock-connector",
  name: "Mock Connector",
  blurb:
    "A harmless test connector — gives the agent one echo tool so you can see the pipeline work end-to-end.",
  category: "other",
  auth: { kind: "none" },
  transport: { kind: "native", makeServer: makeMockServer },
  capabilities: [
    {
      id: "ping",
      label: "Echo test tool",
      scopes: [],
      defaultGranted: true,
    },
  ],
  serverKey: "mock_connector",
}
