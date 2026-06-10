/**
 * Slack — api-key connector (PRD A M4 catalog breadth; derisked: no
 * official Slack MCP server exists, korotovsky/slack-mcp-server is the
 * maintained community standard, stdio + env-token auth).
 *
 * The bot token is collected via the SECURE-ENTRY flow (request_secret /
 * the Secrets tab), stored as env:LUNA_SLACK_BOT_TOKEN, and only its
 * POINTER is passed at connect time — the token never rides a connector
 * frame. Run `npx slack-mcp-server` is handled by the stdio transport.
 */
import type { ConnectorDefinition } from "../types.js"

export const SLACK_CONNECTOR: ConnectorDefinition = {
  id: "slack",
  name: "Slack",
  blurb:
    "Channels and DMs via a bot token. Create a Slack app in your workspace, grab the xoxb- token, store it securely, then connect.",
  category: "communication",
  auth: {
    kind: "api-key",
    fieldLabel: "Slack bot token (xoxb-…)",
  },
  transport: {
    kind: "mcp-stdio",
    command: "npx",
    args: ["-y", "slack-mcp-server@latest", "--transport", "stdio"],
    secretEnvVar: "SLACK_MCP_XOXB_TOKEN",
  },
  capabilities: [
    {
      id: "read",
      label: "Read channels & messages",
      scopes: [],
      defaultGranted: true,
    },
    {
      id: "post",
      label: "Post messages",
      scopes: [],
      defaultGranted: false,
    },
  ],
  serverKey: "slack",
}
