/**
 * The curated, in-repo connector catalog (PRD §23: definitions ship with
 * Luna — pinned URLs/commands, no user-entered MCP servers in v1).
 *
 * M1 ships the mock connector; M2.5 adds google-workspace (+ guided
 * per-operator client setup) and slack.
 */
import type { ConnectorDefinition } from "../types.js"
import { MOCK_CONNECTOR } from "./mock.js"

export { MOCK_CONNECTOR } from "./mock.js"

export const BUILTIN_CONNECTORS: ReadonlyArray<ConnectorDefinition> = [
  MOCK_CONNECTOR,
]
