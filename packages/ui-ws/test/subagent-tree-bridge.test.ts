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
})
