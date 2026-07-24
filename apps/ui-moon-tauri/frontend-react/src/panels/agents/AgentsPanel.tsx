/**
 * AgentsPanel.tsx - React 19 + Astryx port of the live Agents panel (S4
 * "Agents" panel), superseding frontend/panels/agents.js.
 *
 * WS-backed: connects via ctx.connectWs, gates on parseHelloCapabilities
 * (frame).subagents, renders the live subagent tree for a single chat thread
 * (identified by the `thread` URL param). NEVER sends a `subscribe` frame -
 * subscribing would steal the chat window's interactive bindings. Instead,
 * sends a `subagent-tree-request` on hello (so a panel summoned mid-turn
 * paints immediately) and listens for broadcasted `subagent-tree` frames,
 * ignoring those for other threads. See agentsReducer.ts's module doc for
 * the full state-machine rationale.
 *
 * State flows one way only: the WS frame registry (registered in the
 * useEffect below) NEVER touches the DOM directly - every frame handler's
 * entire job is `store.dispatch(...)`. The JSX below is the only thing that
 * reads state (via useMoonSelector, src/state/store.ts's useSyncExternalStore
 * binding) and decides what appears on screen, so there is exactly one
 * source of truth for "what is rendered" and it can never desync from a
 * stray imperative DOM write in a transport callback.
 */
import { useEffect, useMemo } from "react"
import { Badge, EmptyState } from "../../astryx-kit"
import { useLocalStore, useMoonSelector } from "../../state/store"
import {
  initialAgentsPanelState,
  reduceAgentsPanel,
  type AgentNode,
  type AgentsPanelAction,
  type AgentsPanelState,
} from "./agentsReducer"
import type { LunaFrameRegistry, LunaWsClient, PanelCtx } from "../panel-ctx"
import "./agents-panel.css"

/**
 * moon-protocol.js (frontend/vendor/moon-protocol.js) attaches this classic
 * global exactly like moon-ws.js attaches LunaWS (typed by panel-ctx.ts) -
 * both load as plain <script> tags in panel.html's <head>, ahead of this
 * module. Declared locally (rather than widening the shared panel-ctx.ts)
 * since AgentsPanel is, so far, the only React panel that needs
 * parseHelloCapabilities.
 */
declare global {
  interface Window {
    LunaProtocol?: {
      PROTOCOL_VERSION: number
      parseHelloCapabilities: (frame: any) => Record<string, boolean>
      buildWsUrl: (url: string, token?: string | null) => string
    }
  }
}

export interface AgentsPanelProps {
  ctx: PanelCtx
}

function readThreadId(): string {
  return new URLSearchParams(location.search).get("thread") || ""
}

function badgeVariant(status: AgentNode["status"]): "info" | "success" | "error" {
  if (status === "done") return "success"
  if (status === "error") return "error"
  return "info"
}

function describeActivity(node: AgentNode): string {
  if (node.tool) {
    return `${node.tool} · ${node.toolCount} tool${node.toolCount === 1 ? "" : "s"}`
  }
  if (node.toolCount > 0) {
    return `${node.toolCount} tool${node.toolCount === 1 ? "" : "s"}`
  }
  return "starting…"
}

function AgentNodeRow({
  node,
  agents,
}: {
  node: AgentNode
  agents: readonly AgentNode[]
}): React.JSX.Element {
  const children = agents.filter((candidate) => candidate.parentId === node.id)

  return (
    <div>
      <div className="agent-row">
        <div className="agent-blot" data-status={node.status} aria-hidden="true" />
        <div className="agent-row-info">
          <span className="agent-row-name">
            {node.name}
            <Badge
              className={`agent-status-badge ${node.status}`}
              data-status={node.status}
              variant={badgeVariant(node.status)}
              label={node.status}
            />
          </span>
          <span className="agent-row-desc">{node.description}</span>
          <span className="agent-row-activity">{describeActivity(node)}</span>
        </div>
      </div>
      {children.length > 0 && (
        <div className="agent-children">
          {children.map((child) => (
            <AgentNodeRow key={child.id} node={child} agents={agents} />
          ))}
        </div>
      )}
    </div>
  )
}

export function AgentsPanel({ ctx }: AgentsPanelProps): React.JSX.Element {
  // Read once at mount - matches the vanilla module's behavior (the `thread`
  // param never changes without a full panel reload, since panel.html only
  // ever spawns a fresh window per thread).
  const threadId = useMemo(readThreadId, [])
  const store = useLocalStore<AgentsPanelState, AgentsPanelAction>(
    reduceAgentsPanel,
    initialAgentsPanelState(threadId),
  )
  const state = useMoonSelector(store, (snapshot) => snapshot)

  // Debug/observability hook, mirroring chat.html's window.__MoonInternals -
  // lets agent-browser (and a human) drive this panel's state without a live
  // WS connection (screenshotting, smoke checks). Read-only intent: exposes
  // dispatch/getState, never a substitute for the real transport.
  useEffect(() => {
    window.__AgentsPanelInternals = { dispatch: store.dispatch, getState: store.getState }
    return () => {
      delete window.__AgentsPanelInternals
    }
  }, [store])

  useEffect(() => {
    if (!threadId) return
    const LunaWS = window.LunaWS
    const LunaProtocol = window.LunaProtocol
    if (!LunaWS || !LunaProtocol || !ctx.connectWs) return

    const registry: LunaFrameRegistry = LunaWS.createFrameRegistry()
    let client: LunaWsClient | null = null

    registry.register("hello", (frame) => {
      const caps = LunaProtocol.parseHelloCapabilities(frame)
      const hasSubagents = !!caps.subagents || !!(frame && frame.capabilities && frame.capabilities.subagents)
      store.dispatch({ type: "hello-checked", hasSubagents })
      // Request current tree immediately so a mid-turn open paints at once.
      if (hasSubagents) client?.send({ type: "subagent-tree-request", threadId })
    })

    registry.register("subagent-tree", (frame: any) => {
      if (!frame || frame.threadId !== threadId) return
      store.dispatch({
        type: "subagent-tree",
        threadId: frame.threadId,
        agents: Array.isArray(frame.agents) ? frame.agents : [],
      })
    })

    client = ctx.connectWs(registry, { autoPong: true })

    return () => {
      client?.close()
    }
    // ctx/store are stable for this component's lifetime (useLocalStore
    // memoizes the store; ctx is panel.html's single window.__panelCtx); only
    // threadId (read once) matters for re-running this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId])

  if (!threadId) {
    return <EmptyState className="notice" isCompact title="No conversation selected." />
  }

  if (state.capability === "unsupported") {
    return <EmptyState className="notice" isCompact title="This server doesn't report subagents." />
  }

  if (state.agents === null) {
    return (
      <div className="agents-list">
        <span className="agents-notice">Connecting…</span>
      </div>
    )
  }

  if (state.agents.length === 0) {
    return (
      <div className="agents-list">
        <span className="agents-notice">
          No subagents yet — this lights up when Luna delegates.
        </span>
      </div>
    )
  }

  const topLevel = state.agents.filter((node) => node.parentId === null)

  return (
    <div className="agents-list">
      {topLevel.map((node) => (
        <AgentNodeRow key={node.id} node={node} agents={state.agents!} />
      ))}
    </div>
  )
}

declare global {
  interface Window {
    __AgentsPanelInternals?: {
      dispatch: (action: AgentsPanelAction) => void
      getState: () => AgentsPanelState
    }
  }
}
