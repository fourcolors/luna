/**
 * SubagentTreeBridge — the server-side half of the live "Agents" view (S4).
 *
 * When a chat turn delegates to a subagent, the SDK emits an `Agent`/`Task`
 * tool-call plus `parentToolUseId`-tagged tool-call / tool-result frames for
 * the work that ran INSIDE it (chat-subagents). Those frames already flow to
 * the chat window over the per-thread PubSub. This bridge OBSERVES them, folds
 * them into a per-thread tree of subagent nodes, and BROADCASTS a compact
 * `subagent-tree` frame to every connected client.
 *
 * Why a broadcast bridge and not "let the agents panel subscribe the thread":
 * subscribing a thread registers the connection as the secret-entry / local-
 * shell target (server.ts `subscribe` → registerSecretClient — last-subscriber-
 * wins), so a second window subscribing the SAME thread would STEAL the chat
 * window's interactive bindings (the one-window-per-thread rule, widget-system
 * .md). The agents panel therefore NEVER subscribes — it only reads broadcast
 * `subagent-tree` frames, so it is read-only by construction.
 *
 * Design properties:
 *   - observe() is IDEMPOTENT per toolCallId (a frame seen twice — e.g. two
 *     windows feeding the bridge from the same thread PubSub — never double-
 *     counts), and broadcasts ONLY on a real change.
 *   - autoOpen fires exactly ONCE per thread (the first delegation), so the
 *     server can summon the panel without re-opening it on every subagent.
 *   - the tree is metadata only (no tool output / no prompt body beyond a short
 *     description) — wire-safe and context-cheap.
 */
import type { SubagentNode, SubagentTreeFrame } from "./protocol.js"

export type SendSubagentFrame = (frame: SubagentTreeFrame) => void

/** The minimal frame shape observe() reads — a structural subset of the chat
 *  tool-call / tool-result / turn-complete frames. */
export interface ObservableThreadFrame {
  readonly type: string
  readonly toolCallId?: string
  readonly name?: string
  readonly input?: unknown
  readonly parentToolUseId?: string
  readonly status?: "ok" | "error"
}

export interface SubagentTreeBridge {
  /** Every connection registers at setup (broadcast model, like the job-input
   *  bridge) so it can receive `subagent-tree` frames for any thread. */
  readonly registerClient: (connId: string, send: SendSubagentFrame) => void
  readonly unregisterClient: (connId: string) => void
  /**
   * Fold one thread frame into the tree. Broadcasts a fresh `subagent-tree`
   * to all clients when the tree changed. Returns `{ autoOpen: true }` on a
   * delegation while the thread is not yet announced — the caller summons the
   * Agents panel and calls `markAnnounced` ONLY on a successful open, so a
   * failed open (e.g. the hub hasn't announced its directory yet) retries on
   * the next delegation instead of latching off permanently.
   */
  readonly observe: (
    threadId: string,
    frame: ObservableThreadFrame,
  ) => { readonly autoOpen: boolean }
  /** Mark a thread's Agents panel as successfully summoned, so later
   *  delegations don't re-open it. Call ONLY after a successful open. */
  readonly markAnnounced: (threadId: string) => void
  /** Snapshot the current tree for a thread (request replies / tests). */
  readonly treeFor: (threadId: string) => ReadonlyArray<SubagentNode>
}

/** The SDK's subagent spawn tool surfaces under these wire names. */
const AGENT_TOOL_NAMES = new Set(["Agent", "Task"])

/** Cap on tracked threads. One (small) ThreadState was retained per thread for
 *  the process lifetime — a slow unbounded leak on a long-lived server. We
 *  evict the oldest-inserted thread past this bound. Far above any realistic
 *  concurrent-thread count, so active threads are never evicted in practice. */
const MAX_TRACKED_THREADS = 512

interface MutableNode {
  id: string
  parentId: string | null
  name: string
  description: string
  status: "running" | "done" | "error"
  tool: string | null
  toolCount: number
}

interface ThreadState {
  readonly nodes: Map<string, MutableNode>
  readonly order: string[]
  readonly seenCalls: Set<string>
  announced: boolean
}

/** Recover a readable name + description from an Agent tool-call's input,
 *  defensively (the input is model-authored and untyped on the wire). */
const agentMeta = (input: unknown): { name: string; description: string } => {
  const o =
    input && typeof input === "object" ? (input as Record<string, unknown>) : {}
  const subagentType =
    typeof o.subagent_type === "string" && o.subagent_type.trim()
      ? o.subagent_type.trim()
      : null
  const fromDesc =
    typeof o.description === "string" && o.description.trim()
      ? o.description.trim()
      : null
  const fromPrompt =
    typeof o.prompt === "string" && o.prompt.trim()
      ? o.prompt.trim().slice(0, 100)
      : null
  return {
    name: subagentType ?? "Agent",
    description: fromDesc ?? fromPrompt ?? subagentType ?? "subagent",
  }
}

export interface SubagentTreeBridgeOptions {
  /**
   * Agent participation (PR2): fired once per OBSERVED subagent spawn with
   * the thread and the spawned subagent_type. The bridge is the one place
   * every delegation already passes through (this exact tool-call decode
   * powers the live Agents panel), so involvement recording taps it
   * instead of growing a second parser. Fire-and-forget: the callback must
   * never throw into the frame path — the bridge guards it anyway.
   */
  readonly onDelegation?: (threadId: string, agentName: string) => void
}

export const createSubagentTreeBridge = (
  options?: SubagentTreeBridgeOptions,
): SubagentTreeBridge => {
  const clients = new Map<string, SendSubagentFrame>()
  const threads = new Map<string, ThreadState>()

  const ensureThread = (threadId: string): ThreadState => {
    const existing = threads.get(threadId)
    if (existing) {
      // Refresh recency for TRUE LRU: Map#get does NOT reorder, so re-insert
      // (delete+set) to move this thread to the most-recently-used end. Without
      // this the cap would be FIFO — an actively-updating thread created early
      // could be evicted by newer ones, unexpectedly resetting its `announced`
      // / in-turn tree state.
      threads.delete(threadId)
      threads.set(threadId, existing)
      return existing
    }
    const t: ThreadState = {
      nodes: new Map(),
      order: [],
      seenCalls: new Set(),
      announced: false,
    }
    threads.set(threadId, t)
    // Bound the map: evict the least-recently-used thread (oldest in iteration
    // order, since active threads are bumped to the end above). The only
    // persistent per-thread state is `announced`; evicting a genuinely idle
    // thread at worst re-pops its Agents panel once on a brand-new delegation.
    if (threads.size > MAX_TRACKED_THREADS) {
      const lru = threads.keys().next().value
      if (lru !== undefined && lru !== threadId) threads.delete(lru)
    }
    return t
  }

  const snapshot = (t: ThreadState): ReadonlyArray<SubagentNode> =>
    t.order.map((id) => {
      const n = t.nodes.get(id)!
      return {
        id: n.id,
        parentId: n.parentId,
        name: n.name,
        description: n.description,
        status: n.status,
        tool: n.tool,
        toolCount: n.toolCount,
      }
    })

  const broadcast = (threadId: string, t: ThreadState): void => {
    const frame: SubagentTreeFrame = {
      type: "subagent-tree",
      threadId,
      agents: snapshot(t),
    }
    for (const send of clients.values()) {
      try {
        send(frame)
      } catch {
        /* a dead socket must not poison the fan-out */
      }
    }
  }

  return {
    registerClient(connId, send) {
      clients.set(connId, send)
    },
    unregisterClient(connId) {
      clients.delete(connId)
    },
    observe(threadId, frame) {
      const t = ensureThread(threadId)
      let changed = false
      let autoOpen = false

      if (frame.type === "tool-call" && typeof frame.toolCallId === "string") {
        if (!t.seenCalls.has(frame.toolCallId)) {
          t.seenCalls.add(frame.toolCallId)
          if (frame.name && AGENT_TOOL_NAMES.has(frame.name)) {
            // A subagent spawn → a new node in the tree.
            const meta = agentMeta(frame.input)
            // Agent participation (PR2): record involvement for NAMED
            // subagent types only — an untyped general-purpose delegation
            // is not "an agent the operator can look up", and agentMeta's
            // "Agent" fallback must never masquerade as one.
            if (options?.onDelegation) {
              const rawType = (frame.input as { subagent_type?: unknown } | null | undefined)
                ?.subagent_type
              if (typeof rawType === "string" && rawType.trim()) {
                try {
                  options.onDelegation(threadId, rawType.trim())
                } catch {
                  /* observation must never break the frame path */
                }
              }
            }
            t.nodes.set(frame.toolCallId, {
              id: frame.toolCallId,
              parentId: frame.parentToolUseId ?? null,
              name: meta.name,
              description: meta.description,
              status: "running",
              tool: null,
              toolCount: 0,
            })
            t.order.push(frame.toolCallId)
            changed = true
            // Signal auto-open, but DON'T latch `announced` here — the caller
            // latches it via markAnnounced only when the open actually
            // succeeded, so a failed summon (hub not yet announced) retries.
            if (!t.announced) autoOpen = true
          } else if (typeof frame.parentToolUseId === "string") {
            // A tool that ran INSIDE a subagent → update that node's activity.
            const node = t.nodes.get(frame.parentToolUseId)
            if (node) {
              node.tool = frame.name ?? node.tool
              node.toolCount += 1
              changed = true
            }
          }
          // A top-level tool (no parentToolUseId, not an Agent) is the parent
          // turn's own work — not part of the subagent tree; ignore.
        }
      } else if (
        frame.type === "tool-result" &&
        typeof frame.toolCallId === "string"
      ) {
        // The Agent's OWN tool-result closes that subagent.
        const node = t.nodes.get(frame.toolCallId)
        if (node && node.status === "running") {
          node.status = frame.status === "error" ? "error" : "done"
          changed = true
        }
      } else if (frame.type === "turn-complete") {
        // Safety net: the turn ended, so nothing is still running.
        for (const node of t.nodes.values()) {
          if (node.status === "running") {
            node.status = "done"
            changed = true
          }
        }
      }

      if (changed) broadcast(threadId, t)
      // Bound the live tree to ONE turn: after the turn ends, reset the per-
      // thread node set (memory stays O(current turn), and the panel stops
      // piling up stale 'done' agents from prior turns). The just-broadcast
      // done-state is the panel's last view until the next delegation;
      // `announced` is intentionally KEPT so we never re-pop a panel the user
      // closed.
      if (frame.type === "turn-complete") {
        t.nodes.clear()
        t.order.length = 0
        t.seenCalls.clear()
      }
      return { autoOpen }
    },
    markAnnounced(threadId) {
      ensureThread(threadId).announced = true
    },
    treeFor(threadId) {
      const t = threads.get(threadId)
      return t ? snapshot(t) : []
    },
  }
}
