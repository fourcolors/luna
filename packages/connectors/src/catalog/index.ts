/**
 * The curated, in-repo connector catalog (PRD §23: definitions ship with
 * Luna — pinned URLs/commands, no user-entered MCP servers in v1).
 */
import type { ConnectorDefinition } from "../types.js"
import { GITHUB_CONNECTOR } from "./github.js"
import { GOOGLE_WORKSPACE_CONNECTOR } from "./google-workspace.js"
import { MOCK_CONNECTOR } from "./mock.js"
import { SLACK_CONNECTOR } from "./slack.js"

export { GITHUB_CONNECTOR } from "./github.js"
export { GOOGLE_WORKSPACE_CONNECTOR } from "./google-workspace.js"
export { MOCK_CONNECTOR } from "./mock.js"
export { SLACK_CONNECTOR } from "./slack.js"

export const BUILTIN_CONNECTORS: ReadonlyArray<ConnectorDefinition> = [
  GOOGLE_WORKSPACE_CONNECTOR,
  SLACK_CONNECTOR,
  GITHUB_CONNECTOR,
  MOCK_CONNECTOR,
]
