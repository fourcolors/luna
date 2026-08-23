/**
 * SubagentTreeBridge — the live Agents-view fold (S4).
 *
 * Pins the load-bearing behavior: a delegation builds a node, inner tool frames
 * update it, results/turn-complete close it, observe() is idempotent per
 * toolCallId (safe against double-feed), broadcasts fire ONLY on change, and
 * autoOpen fires exactly once per thread.
 */
import { describe, expect, it } from "vitest"
import { createSubagentTreeBridge } from "../src/subagent-tree-bridge.js"
import type { SubagentTreeFrame } from "../src/protocol.js"

const sink = () => {
  const frames: SubagentTreeFrame[] = []
  return { frames, send: (f: SubagentTreeFrame) => frames.push(f) }
}

describe("subagent-tree-bridge", () => {
  it("a first Agent spawn creates a node, broadcasts, and signals autoOpen until markAnnounced", () => {
    const b = createSubagentTreeBridge()
    const a = sink()
    b.registerClient("c1", a.send)

    const r1 = b.observe("t1", {
      type: "tool-call",
      toolCallId: "ag1",
      name: "Agent",
      input: { subagent_type: "Explore", description: "map the repo" },
    })
    expect(r1.autoOpen).toBe(true)
    expect(a.frames).toHaveLength(1)
    expect(a.frames[0]).toMatchObject({ type: "subagent-tree", threadId: "t1" })
    expect(a.frames[0]!.agents[0]).toMatchObject({
      id: "ag1",
      parentId: null,
      name: "Explore",
      description: "map the repo",
      status: "running",
      tool: null,
      toolCount: 0,
    })

    // The caller latches it ONLY after a successful open.
    b.markAnnounced("t1")
    const r2 = b.observe("t1", { type: "tool-call", toolCallId: "ag2", name: "Task", input: {} })
    expect(r2.autoOpen).toBe(false)
    expect(a.frames).toHaveLength(2)
  })

  it("autoOpen RETRIES on the next delegation when the open was never confirmed (race fix)", () => {
    const b = createSubagentTreeBridge()
    b.registerClient("c1", () => {})
    // First spawn signals autoOpen — but the caller never markAnnounced (the
    // open failed, e.g. the hub hadn't announced its directory yet).
    expect(b.observe("t1", { type: "tool-call", toolCallId: "ag1", name: "Agent", input: {} }).autoOpen).toBe(true)
    // The NEXT delegation must retry, not stay latched-off.
    expect(b.observe("t1", { type: "tool-call", toolCallId: "ag2", name: "Agent", input: {} }).autoOpen).toBe(true)
    // Once confirmed, later delegations stop re-opening.
    b.markAnnounced("t1")
    expect(b.observe("t1", { type: "tool-call", toolCallId: "ag3", name: "Agent", input: {} }).autoOpen).toBe(false)
  })

  it("inner tool frames update the parent node; observe is idempotent per toolCallId", () => {
    const b = createSubagentTreeBridge()
    const a = sink()
    b.registerClient("c1", a.send)
    b.observe("t1", { type: "tool-call", toolCallId: "ag1", name: "Agent", input: {} })

    b.observe("t1", { type: "tool-call", toolCallId: "call1", name: "Grep", parentToolUseId: "ag1" })
    let node = b.treeFor("t1")[0]!
    expect(node).toMatchObject({ tool: "Grep", toolCount: 1 })

    // Re-feeding the SAME inner call (e.g. a second window feeding the bridge)
    // must NOT double-count.
    const framesBefore = a.frames.length
    b.observe("t1", { type: "tool-call", toolCallId: "call1", name: "Grep", parentToolUseId: "ag1" })
    node = b.treeFor("t1")[0]!
    expect(node.toolCount).toBe(1)
    expect(a.frames.length).toBe(framesBefore) // no change → no broadcast

    // A different inner call advances the count.
    b.observe("t1", { type: "tool-call", toolCallId: "call2", name: "Read", parentToolUseId: "ag1" })
    expect(b.treeFor("t1")[0]!).toMatchObject({ tool: "Read", toolCount: 2 })
  })

  it("the Agent's own tool-result closes the node (done / error)", () => {
    const b = createSubagentTreeBridge()
    b.registerClient("c1", () => {})
    b.observe("t1", { type: "tool-call", toolCallId: "ag1", name: "Agent", input: {} })
    b.observe("t1", { type: "tool-result", toolCallId: "ag1", status: "ok" })
    expect(b.treeFor("t1")[0]!.status).toBe("done")

    b.observe("t1", { type: "tool-call", toolCallId: "ag2", name: "Agent", input: {} })
    b.observe("t1", { type: "tool-result", toolCallId: "ag2", status: "error" })
    expect(b.treeFor("t1").find((n) => n.id === "ag2")!.status).toBe("error")
  })

  it("turn-complete broadcasts the done state, then resets the per-thread tree (bounded to one turn)", () => {
    const b = createSubagentTreeBridge()
    const a = sink()
    b.registerClient("c1", a.send)
    b.observe("t1", { type: "tool-call", toolCallId: "ag1", name: "Agent", input: {} })
    b.observe("t1", { type: "turn-complete" })
    // The LAST broadcast shows the agent done (the panel's final view)…
    const last = a.frames[a.frames.length - 1]!
    expect(last.agents[0]).toMatchObject({ id: "ag1", status: "done" })
    // …but the internal tree is reset so the NEXT turn starts fresh (no stale
    // pile-up across turns, memory bounded to the current turn).
    expect(b.treeFor("t1")).toEqual([])
  })

  it("a NEW turn after turn-complete shows ONLY the new turn's agents (no stale carry-over)", () => {
    const b = createSubagentTreeBridge()
    const a = sink()
    b.registerClient("c1", a.send)
    b.observe("t1", { type: "tool-call", toolCallId: "ag1", name: "Agent", input: {} })
    b.observe("t1", { type: "turn-complete" })
    b.observe("t1", { type: "tool-call", toolCallId: "ag2", name: "Agent", input: {} })
    const last = a.frames[a.frames.length - 1]!
    expect(last.agents.map((n) => n.id)).toEqual(["ag2"]) // ag1 is gone
  })

  it("nested subagents carry parentId; threads are isolated", () => {
    const b = createSubagentTreeBridge()
    b.registerClient("c1", () => {})
    b.observe("t1", { type: "tool-call", toolCallId: "ag1", name: "Agent", input: {} })
    b.observe("t1", { type: "tool-call", toolCallId: "ag2", name: "Agent", parentToolUseId: "ag1", input: {} })
    const tree = b.treeFor("t1")
    expect(tree.map((n) => [n.id, n.parentId])).toEqual([
      ["ag1", null],
      ["ag2", "ag1"],
    ])
    // A different thread has its own tree.
    expect(b.treeFor("t2")).toEqual([])
  })

  it("treeFor reflects insertion order and a top-level tool (no parent) is ignored", () => {
    const b = createSubagentTreeBridge()
    b.registerClient("c1", () => {})
    // A top-level tool with no parentToolUseId and not an Agent → not in tree.
    b.observe("t1", { type: "tool-call", toolCallId: "top1", name: "Bash" })
    expect(b.treeFor("t1")).toEqual([])
  })

  it("a throwing client send never poisons the fan-out to other clients", () => {
    const b = createSubagentTreeBridge()
    const good = sink()
    b.registerClient("bad", () => { throw new Error("dead socket") })
    b.registerClient("good", good.send)
    b.observe("t1", { type: "tool-call", toolCallId: "ag1", name: "Agent", input: {} })
    expect(good.frames).toHaveLength(1) // good client still got it
  })

  it("unregisterClient stops further broadcasts to that client", () => {
    const b = createSubagentTreeBridge()
    const a = sink()
    b.registerClient("c1", a.send)
    b.observe("t1", { type: "tool-call", toolCallId: "ag1", name: "Agent", input: {} })
    b.unregisterClient("c1")
    b.observe("t1", { type: "tool-call", toolCallId: "ag2", name: "Agent", input: {} })
    expect(a.frames).toHaveLength(1) // only the pre-unregister broadcast
  })

  it("bounds the tracked-thread map: evicts the oldest thread past the cap", () => {
    const b = createSubagentTreeBridge()
    const old = "thr_oldest"
    // Announce it, then a delegation: while the entry is RETAINED, a repeat
    // delegation must NOT auto-open (announced state is remembered).
    b.markAnnounced(old)
    expect(
      b.observe(old, { type: "tool-call", toolCallId: "c0", name: "Agent", input: {} })
        .autoOpen,
    ).toBe(false)
    // Touch enough fresh threads to push `old` past the LRU cap (512) so its
    // entry is evicted instead of lingering for the whole process lifetime.
    for (let i = 0; i < 520; i++) {
      b.observe(`thr_${i}`, {
        type: "tool-call",
        toolCallId: `n${i}`,
        name: "Agent",
        input: {},
      })
    }
    // `old` was evicted → its `announced` flag is gone → a brand-new
    // delegation auto-opens again. Proves the entry was dropped (the leak
    // fix), not silently retained forever.
    expect(
      b.observe(old, { type: "tool-call", toolCallId: "c1", name: "Agent", input: {} })
        .autoOpen,
    ).toBe(true)
  })

  it("is TRUE LRU: an actively-touched thread survives churn past the cap", () => {
    const b = createSubagentTreeBridge()
    const hot = "thr_hot"
    b.markAnnounced(hot)
    // Churn well past the cap, but keep touching `hot` every iteration so it
    // stays most-recently-used. A FIFO cap would evict it (created first);
    // true LRU must not.
    for (let i = 0; i < 600; i++) {
      b.observe(`thr_${i}`, {
        type: "tool-call",
        toolCallId: `n${i}`,
        name: "Agent",
        input: {},
      })
      // A top-level non-Agent tool is ignored for the tree but still routes
      // through ensureThread(hot), refreshing its recency.
      b.observe(hot, { type: "tool-call", toolCallId: `h${i}`, name: "Bash" })
    }
    // `hot` was never the LRU → still tracked → `announced` survived, so a
    // fresh delegation does NOT re-pop the panel.
    expect(
      b.observe(hot, { type: "tool-call", toolCallId: "final", name: "Agent", input: {} })
        .autoOpen,
    ).toBe(false)
  })

  // ── Agent participation (PR2): the onDelegation tap ───────────────────────

  it("onDelegation fires once per NAMED spawn — never for untyped, duplicate, or inner tool calls, and a throwing callback never breaks the frame path", () => {
    const seen: Array<[string, string]> = []
    const b = createSubagentTreeBridge({
      onDelegation: (threadId, agentName) => {
        seen.push([threadId, agentName])
        throw new Error("observer blew up — must be swallowed")
      },
    })

    // Named spawn → recorded (and the throw above is contained). A first
    // spawn also signals autoOpen — proof the frame path survived the
    // throwing observer.
    const r = b.observe("t1", {
      type: "tool-call",
      toolCallId: "ag1",
      name: "Agent",
      input: { subagent_type: "advisor", description: "d" },
    })
    expect(r.autoOpen).toBe(true)
    // Duplicate toolCallId → seenCalls dedupe, no second record.
    b.observe("t1", {
      type: "tool-call",
      toolCallId: "ag1",
      name: "Agent",
      input: { subagent_type: "advisor" },
    })
    // Untyped general-purpose spawn → tree node yes, involvement NO (the
    // "Agent" display fallback must never masquerade as a lookup target).
    b.observe("t1", {
      type: "tool-call",
      toolCallId: "ag2",
      name: "Task",
      input: { description: "general purpose" },
    })
    // A tool running INSIDE a subagent → not a spawn.
    b.observe("t1", {
      type: "tool-call",
      toolCallId: "inner1",
      name: "Read",
      input: {},
      parentToolUseId: "ag1",
    })
    // Old wire name still counts when typed.
    b.observe("t2", {
      type: "tool-call",
      toolCallId: "ag3",
      name: "Task",
      input: { subagent_type: "auditor" },
    })

    expect(seen).toEqual([
      ["t1", "advisor"],
      ["t2", "auditor"],
    ])
  })
})
