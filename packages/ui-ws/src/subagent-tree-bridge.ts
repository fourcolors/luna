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
 *   - a BACKGROUND Agent (SDK >= 0.3.202 default) answers its tool_use at once
 *     with a launch ack (`async: true` on the tool-result). That node stays
 *     running across turn-complete until `subagent-settled` (SDK
 *     task_notification) or the idle TTL closes it. Closing it on the ack was
 *     the sidebar flicker: the row painted and vanished within milliseconds.
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
  /** "ok" | "error" on a tool-result; "done" | "error" on subagent-settled. */
  readonly status?: string
  /** tool-result: a background Agent's launch ack. subagent-progress: the
   *  agent was registered in, or moved to, the background. */
  readonly async?: boolean
  /** subagent-progress only. */
  readonly tool?: string
  readonly toolCount?: number
}

export interface SubagentTreeBridgeOptions {
  /** Injectable clock for the idle TTL. Defaults to Date.now. */
  readonly now?: () => number
  /** Period of the background TTL sweep while any background node is
   *  running. 0 disables the timer (the per-observe check still runs). */
  readonly sweepIntervalMs?: number
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
  /** Run the idle-TTL check over every thread now (the timer calls this). */
  readonly sweep: () => void
  /** Stop the TTL timer. */
  readonly dispose: () => void
}

/** A background subagent with no observed activity for this long is closed
 *  as `done` (and flagged `stale`), so a lost `task_notification` cannot
 *  leave a row running forever. */
export const SUBAGENT_IDLE_TTL_MS = 30 * 60_000

export const SUBAGENT_SWEEP_INTERVAL_MS = 60_000

/** Cap on remembered tool-call ids per thread. They are kept across turns so
 *  a slow forwarder replaying an old call cannot resurrect a pruned node,
 *  which only needs roughly the current and previous turn's ids. */
export const MAX_SEEN_CALLS = 256

/** Finished nodes kept between turns, newest first, beyond what running
 *  nodes need as ancestors. A background run can spawn agents for hours
 *  before the parent's next turn-complete prunes them; without this cap every
 *  broadcast would carry the whole history. */
export const MAX_SETTLED_NODES = 32

/** Cap on remembered ids of nodes dropped by bounding or pruning. A delayed
 *  replay of such a call may arrive after its id left the capped seenCalls;
 *  this set stops it from being re-created as a running node. */
export const MAX_REMOVED_NODES = 512

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
  /** Launched in the background: outlives its own tool-result and the turn. */
  async: boolean
  lastActivityAt: number
  stale: boolean
  /** Order in which the node reached a terminal status (0 while running). */
  settledSeq: number
}

interface ThreadState {
  readonly nodes: Map<string, MutableNode>
  readonly order: string[]
  readonly seenCalls: Set<string>
  /** Ids of nodes removed by boundSettled / pruneSettled, oldest first. */
  readonly removed: Set<string>
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

export const createSubagentTreeBridge = (
  options: SubagentTreeBridgeOptions = {},
): SubagentTreeBridge => {
  const now = options.now ?? Date.now
  const sweepIntervalMs = options.sweepIntervalMs ?? SUBAGENT_SWEEP_INTERVAL_MS
  const clients = new Map<string, SendSubagentFrame>()
  const threads = new Map<string, ThreadState>()
  let sweepTimer: ReturnType<typeof setInterval> | null = null
  let settleCounter = 0

  /** Move a running node to a terminal status. */
  const finish = (node: MutableNode, status: "done" | "error"): void => {
    node.status = status
    node.settledSeq = ++settleCounter
  }

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
      removed: new Set(),
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

  const rememberCall = (t: ThreadState, id: string): void => {
    t.seenCalls.add(id)
    if (t.seenCalls.size > MAX_SEEN_CALLS) {
      const oldest = t.seenCalls.values().next().value
      if (oldest !== undefined) t.seenCalls.delete(oldest)
    }
  }

  /** Drop a node from the tree, remembering its id (capped, oldest out). */
  const removeNode = (t: ThreadState, index: number): void => {
    const id = t.order[index]!
    t.nodes.delete(id)
    t.order.splice(index, 1)
    t.removed.delete(id)
    t.removed.add(id)
    if (t.removed.size > MAX_REMOVED_NODES) {
      const oldest = t.removed.values().next().value
      if (oldest !== undefined) t.removed.delete(oldest)
    }
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
        ...(n.stale ? { stale: true } : {}),
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

  /** True when the node, or any ancestor, is a running background agent: its
   *  work continues past the parent turn's end. */
  const insideRunningAsync = (t: ThreadState, node: MutableNode): boolean => {
    let cur: MutableNode | undefined = node
    for (let hops = 0; cur && hops <= t.nodes.size; hops++) {
      if (cur.async && cur.status === "running") return true
      cur = cur.parentId ? t.nodes.get(cur.parentId) : undefined
    }
    return false
  }

  /** Activity inside a subagent is activity for every agent above it: a
   *  background agent waiting on a nested foreground one is still working. */
  const touchWithAncestors = (t: ThreadState, node: MutableNode): void => {
    const at = now()
    let cur: MutableNode | undefined = node
    for (let hops = 0; cur && hops <= t.nodes.size; hops++) {
      cur.lastActivityAt = at
      cur = cur.parentId ? t.nodes.get(cur.parentId) : undefined
    }
  }

  /** Flag a running node as background. Returns whether it changed. */
  const markAsync = (node: MutableNode): boolean => {
    if (node.async) return false
    node.async = true
    node.lastActivityAt = now()
    ensureSweep()
    return true
  }

  const hasRunningAsync = (t: ThreadState): boolean => {
    for (const n of t.nodes.values()) {
      if (n.async && n.status === "running") return true
    }
    return false
  }

  /** Close a settled node's still-running descendants: they cannot outlive
   *  the agent that spawned them. */
  const settleDescendants = (
    t: ThreadState,
    rootId: string,
    status: "done" | "error",
  ): void => {
    const closed = new Set([rootId])
    for (const id of t.order) {
      const n = t.nodes.get(id)
      if (!n || n.parentId === null || !closed.has(n.parentId)) continue
      closed.add(n.id)
      if (n.status === "running") finish(n, status)
    }
  }

  /** Drop every non-running node. Running background nodes (and anything
   *  still running under them) stay for the next turn. */
  const pruneSettled = (t: ThreadState): void => {
    for (let i = t.order.length - 1; i >= 0; i--) {
      const id = t.order[i]!
      const n = t.nodes.get(id)
      if (!n || n.status !== "running") removeNode(t, i)
    }
  }

  /** Bound finished history between turns: keep every running node, the
   *  MAX_SETTLED_NODES most recently finished, and the ancestors of all of
   *  those so no kept row loses its parent. Drops the rest. */
  const boundSettled = (t: ThreadState): void => {
    const settled: MutableNode[] = []
    for (const n of t.nodes.values()) if (n.status !== "running") settled.push(n)
    if (settled.length <= MAX_SETTLED_NODES) return
    settled.sort((a, b) => b.settledSeq - a.settledSeq)
    const keep = new Set<string>()
    const keepWithAncestors = (node: MutableNode): void => {
      let cur: MutableNode | undefined = node
      for (let hops = 0; cur && hops <= t.nodes.size; hops++) {
        if (keep.has(cur.id)) return
        keep.add(cur.id)
        cur = cur.parentId ? t.nodes.get(cur.parentId) : undefined
      }
    }
    for (const n of t.nodes.values()) if (n.status === "running") keepWithAncestors(n)
    for (const n of settled.slice(0, MAX_SETTLED_NODES)) keepWithAncestors(n)
    for (let i = t.order.length - 1; i >= 0; i--) {
      const id = t.order[i]!
      if (!keep.has(id)) removeNode(t, i)
    }
  }

  /** Close background nodes idle past the TTL. Returns whether any changed. */
  const expireIdle = (t: ThreadState): boolean => {
    const cutoff = now() - SUBAGENT_IDLE_TTL_MS
    let changed = false
    for (const n of t.nodes.values()) {
      if (n.async && n.status === "running" && n.lastActivityAt < cutoff) {
        finish(n, "done")
        n.stale = true
        settleDescendants(t, n.id, "done")
        changed = true
      }
    }
    return changed
  }

  const stopSweep = (): void => {
    if (sweepTimer !== null) {
      clearInterval(sweepTimer)
      sweepTimer = null
    }
  }

  const sweep = (): void => {
    let anyRunningAsync = false
    for (const [threadId, t] of threads) {
      if (expireIdle(t)) {
        boundSettled(t)
        broadcast(threadId, t)
      }
      if (hasRunningAsync(t)) anyRunningAsync = true
    }
    if (!anyRunningAsync) stopSweep()
  }

  const ensureSweep = (): void => {
    if (sweepTimer !== null || sweepIntervalMs <= 0) return
    sweepTimer = setInterval(sweep, sweepIntervalMs)
    const timer = sweepTimer as { unref?: () => void }
    if (typeof timer.unref === "function") timer.unref()
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
      let changed = expireIdle(t)
      let autoOpen = false

      if (frame.type === "tool-call" && typeof frame.toolCallId === "string") {
        // nodes.has guards independently of seenCalls: once later calls
        // evict an id from the capped seenCalls, a delayed replay of a live
        // Agent call must not reset it (losing its async flag and count) or
        // add a duplicate row. `removed` covers a node that was also
        // dropped by bounding, which must not come back as running.
        if (
          !t.seenCalls.has(frame.toolCallId) &&
          !t.nodes.has(frame.toolCallId) &&
          !t.removed.has(frame.toolCallId)
        ) {
          rememberCall(t, frame.toolCallId)
          if (frame.name && AGENT_TOOL_NAMES.has(frame.name)) {
            // A subagent spawn → a new node in the tree. (Involvement
            // recording deliberately does NOT live here: this bridge only
            // observes while a WS subscriber is attached — the durable
            // record is made in chat-service's SDK consumer, which runs
            // for every turn regardless of clients. Codex PR2 finding 1.)
            const meta = agentMeta(frame.input)
            t.nodes.set(frame.toolCallId, {
              id: frame.toolCallId,
              parentId: frame.parentToolUseId ?? null,
              name: meta.name,
              description: meta.description,
              status: "running",
              tool: null,
              toolCount: 0,
              async: false,
              lastActivityAt: now(),
              stale: false,
              settledSeq: 0,
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
              touchWithAncestors(t, node)
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
        const node = t.nodes.get(frame.toolCallId)
        if (node && node.status === "running") {
          if ((frame.async === true || node.async) && frame.status !== "error") {
            // A background launch ack (or the result of an agent already
            // moved to the background), not the end: the subagent keeps
            // running until its subagent-settled frame.
            if (markAsync(node)) changed = true
          } else {
            // A foreground Agent's own tool-result closes that subagent.
            finish(node, frame.status === "error" ? "error" : "done")
            changed = true
          }
        }
      } else if (
        frame.type === "subagent-settled" &&
        typeof frame.toolCallId === "string"
      ) {
        const node = t.nodes.get(frame.toolCallId)
        if (node && node.status === "running") {
          const status = frame.status === "error" ? "error" : "done"
          finish(node, status)
          settleDescendants(t, node.id, status)
          changed = true
        }
      } else if (
        frame.type === "subagent-progress" &&
        typeof frame.toolCallId === "string"
      ) {
        const node = t.nodes.get(frame.toolCallId)
        if (node && node.status === "running") {
          touchWithAncestors(t, node)
          if (frame.async === true && markAsync(node)) changed = true
          if (typeof frame.tool === "string" && frame.tool !== "" && frame.tool !== node.tool) {
            node.tool = frame.tool
            changed = true
          }
          if (typeof frame.toolCount === "number" && frame.toolCount > node.toolCount) {
            node.toolCount = frame.toolCount
            changed = true
          }
        }
      } else if (frame.type === "turn-complete") {
        // The turn ended, so every FOREGROUND agent has ended with it. A
        // background agent (and anything it spawned) keeps running.
        for (const node of t.nodes.values()) {
          if (node.status === "running" && !insideRunningAsync(t, node)) {
            finish(node, "done")
            changed = true
          }
        }
      }

      // The panel's last view of a finished turn is this done-state frame.
      if (changed) {
        boundSettled(t)
        broadcast(threadId, t)
      }
      // Bound the tree to what is still in flight. `seenCalls` is kept (and
      // capped) so a replayed call from a slower forwarder cannot re-add a
      // pruned node as running; `announced` is kept so we never re-pop a
      // panel the user closed.
      if (frame.type === "turn-complete") pruneSettled(t)
      return { autoOpen }
    },
    markAnnounced(threadId) {
      ensureThread(threadId).announced = true
    },
    treeFor(threadId) {
      const t = threads.get(threadId)
      return t ? snapshot(t) : []
    },
    sweep,
    dispose: stopSweep,
  }
}
