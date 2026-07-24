/**
 * agentsReducer.ts - pure state/reducer for the Agents panel's React port.
 *
 * Framework-agnostic on purpose (no DOM, no React) so it is trivially unit
 * testable and so AgentsPanel.tsx can consume it via useLocalStore/
 * useMoonSelector (src/state/store.ts) instead of touching the DOM from
 * inside WS frame handlers - the transport callback's whole job is to
 * dispatch an action; only the component's render return value decides what
 * appears on screen.
 *
 * Mirrors the wire behavior of the superseded
 * frontend/panels/agents.js exactly:
 *  - `agents === null` (here: `state.agents === null`) means "not yet
 *    received" (renders "Connecting…").
 *  - a `hello` frame without the `subagents` capability flips the panel into
 *    the terminal "doesn't report subagents" state - once unsupported, later
 *    frames (there shouldn't be any - the panel never requests a tree) leave
 *    it unsupported.
 *  - only `subagent-tree` frames whose `threadId` matches this panel's
 *    thread are applied; frames for other threads are silently ignored (the
 *    NEVER-subscribe security invariant is enforced by the caller, not this
 *    reducer - see AgentsPanel.tsx's registry, which never registers a
 *    handler that could send `subscribe`).
 */

export interface AgentNode {
  readonly id: string
  readonly parentId: string | null
  readonly name: string
  readonly description: string
  readonly status: "running" | "done" | "error"
  readonly tool: string | null
  readonly toolCount: number
}

export type AgentsCapability = "pending" | "unsupported" | "supported"

export interface AgentsPanelState {
  readonly threadId: string
  readonly capability: AgentsCapability
  /** null = not yet received; [] = empty; [...] = live nodes. */
  readonly agents: readonly AgentNode[] | null
}

export type AgentsPanelAction =
  | { readonly type: "hello-checked"; readonly hasSubagents: boolean }
  | { readonly type: "subagent-tree"; readonly threadId: string; readonly agents: readonly AgentNode[] }

export function initialAgentsPanelState(threadId: string): AgentsPanelState {
  return { threadId, capability: "pending", agents: null }
}

export function reduceAgentsPanel(
  state: AgentsPanelState,
  action: AgentsPanelAction,
): AgentsPanelState {
  switch (action.type) {
    case "hello-checked": {
      const nextCapability: AgentsCapability = action.hasSubagents ? "supported" : "unsupported"
      if (state.capability === nextCapability) return state
      return { ...state, capability: nextCapability }
    }
    case "subagent-tree": {
      if (action.threadId !== state.threadId) return state
      return { ...state, agents: action.agents }
    }
    default:
      return state
  }
}
