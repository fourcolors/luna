/**
 * SubagentTreeBridge — the live Agents-view fold (S4).
 *
 * Pins the load-bearing behavior: a delegation builds a node, inner tool frames
 * update it, results/turn-complete close it, observe() is idempotent per
 * toolCallId (safe against double-feed), broadcasts fire ONLY on change, and
 * autoOpen fires exactly once per thread.
 */
import { describe, expect, it, vi } from "vitest"
import {
  MAX_REMOVED_NODES,
  MAX_SEEN_CALLS,
  MAX_SETTLED_NODES,
  SUBAGENT_IDLE_TTL_MS,
  SUBAGENT_SWEEP_INTERVAL_MS,
  createSubagentTreeBridge,
} from "../src/subagent-tree-bridge.js"
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

  describe("background (async) agents", () => {
    const launch = (b: ReturnType<typeof createSubagentTreeBridge>, id = "a1") => {
      b.observe("t1", { type: "tool-call", toolCallId: id, name: "Agent", input: { description: "x" } })
      b.observe("t1", { type: "tool-result", toolCallId: id, status: "ok", async: true })
    }
    const lastAgents = (frames: SubagentTreeFrame[]) => frames[frames.length - 1]!.agents

    it("async Agent stays running after launch ack", () => {
      const b = createSubagentTreeBridge({ sweepIntervalMs: 0 })
      const a = sink()
      b.registerClient("c1", a.send)
      launch(b)
      expect(lastAgents(a.frames)[0]!.status).toBe("running")
    })

    it("async Agent survives turn-complete and keeps counting", () => {
      const b = createSubagentTreeBridge({ sweepIntervalMs: 0 })
      const a = sink()
      b.registerClient("c1", a.send)
      launch(b)
      b.observe("t1", { type: "turn-complete" })
      b.observe("t1", { type: "tool-call", toolCallId: "b1", name: "Read", parentToolUseId: "a1" })
      expect(lastAgents(a.frames)).toEqual([
        expect.objectContaining({ id: "a1", status: "running", toolCount: 1, tool: "Read" }),
      ])
    })

    it("subagent-settled closes it (done / error)", () => {
      const b = createSubagentTreeBridge({ sweepIntervalMs: 0 })
      const a = sink()
      b.registerClient("c1", a.send)
      launch(b, "a1")
      b.observe("t1", { type: "subagent-settled", toolCallId: "a1", status: "done" })
      expect(lastAgents(a.frames).find((n) => n.id === "a1")!.status).toBe("done")

      launch(b, "a2")
      b.observe("t1", { type: "subagent-settled", toolCallId: "a2", status: "error" })
      expect(lastAgents(a.frames).find((n) => n.id === "a2")!.status).toBe("error")
    })

    it("subagent-settled also closes running agents nested under it", () => {
      const b = createSubagentTreeBridge({ sweepIntervalMs: 0 })
      b.registerClient("c1", () => {})
      launch(b, "a1")
      b.observe("t1", { type: "tool-call", toolCallId: "n1", name: "Agent", parentToolUseId: "a1", input: {} })
      b.observe("t1", { type: "turn-complete" })
      // The nested agent belongs to the background run, so the turn's end
      // does not close it.
      expect(b.treeFor("t1").find((n) => n.id === "n1")!.status).toBe("running")
      b.observe("t1", { type: "subagent-settled", toolCallId: "a1", status: "done" })
      expect(b.treeFor("t1").map((n) => n.status)).toEqual(["done", "done"])
    })

    it("subagent-progress updates tool and count, never lowering the count", () => {
      const b = createSubagentTreeBridge({ sweepIntervalMs: 0 })
      const a = sink()
      b.registerClient("c1", a.send)
      launch(b)
      b.observe("t1", { type: "subagent-progress", toolCallId: "a1", tool: "Grep", toolCount: 5 })
      expect(lastAgents(a.frames)[0]).toMatchObject({ tool: "Grep", toolCount: 5, status: "running" })
      b.observe("t1", { type: "subagent-progress", toolCallId: "a1", tool: "Grep", toolCount: 3 })
      expect(b.treeFor("t1")[0]!.toolCount).toBe(5)
    })

    it("sync Agent is unchanged: a tool-result without async closes it", () => {
      const b = createSubagentTreeBridge({ sweepIntervalMs: 0 })
      b.registerClient("c1", () => {})
      b.observe("t1", { type: "tool-call", toolCallId: "s1", name: "Agent", input: {} })
      b.observe("t1", { type: "tool-result", toolCallId: "s1", status: "ok" })
      expect(b.treeFor("t1")[0]!.status).toBe("done")
    })

    it("turn-complete still closes sync nodes and prunes them; the async node remains", () => {
      const b = createSubagentTreeBridge({ sweepIntervalMs: 0 })
      const a = sink()
      b.registerClient("c1", a.send)
      launch(b, "a1")
      b.observe("t1", { type: "tool-call", toolCallId: "s1", name: "Agent", input: {} })
      b.observe("t1", { type: "turn-complete" })
      // The turn-complete frame itself shows the sync agent done.
      expect(lastAgents(a.frames).find((n) => n.id === "s1")!.status).toBe("done")
      b.observe("t1", { type: "subagent-progress", toolCallId: "a1", tool: "Bash", toolCount: 2 })
      expect(lastAgents(a.frames).map((n) => [n.id, n.status])).toEqual([["a1", "running"]])
    })

    it("a replayed tool-call after turn-complete does not resurrect a pruned node", () => {
      const b = createSubagentTreeBridge({ sweepIntervalMs: 0 })
      const a = sink()
      b.registerClient("c1", a.send)
      b.observe("t1", { type: "tool-call", toolCallId: "a1", name: "Agent", input: {} })
      b.observe("t1", { type: "tool-result", toolCallId: "a1", status: "ok" })
      b.observe("t1", { type: "turn-complete" })
      const before = a.frames.length
      // A slower forwarder (second window) replays the same frames.
      b.observe("t1", { type: "tool-call", toolCallId: "a1", name: "Agent", input: {} })
      expect(a.frames.length).toBe(before)
      expect(b.treeFor("t1")).toEqual([])
    })

    it("seenCalls stays bounded while still guarding recent ids", () => {
      const b = createSubagentTreeBridge({ sweepIntervalMs: 0 })
      b.registerClient("c1", () => {})
      b.observe("t1", { type: "tool-call", toolCallId: "first", name: "Bash" })
      for (let i = 0; i < MAX_SEEN_CALLS + 5; i++) {
        b.observe("t1", { type: "tool-call", toolCallId: `x${i}`, name: "Bash" })
      }
      b.observe("t1", { type: "turn-complete" })
      // The most recent id is still remembered...
      b.observe("t1", { type: "tool-call", toolCallId: `x${MAX_SEEN_CALLS + 4}`, name: "Agent", input: {} })
      expect(b.treeFor("t1")).toEqual([])
      // ...while the oldest was evicted, so the set did not grow without bound.
      b.observe("t1", { type: "tool-call", toolCallId: "first", name: "Agent", input: {} })
      expect(b.treeFor("t1").map((n) => n.id)).toEqual(["first"])
    })

    it("a replayed Agent call after seenCalls eviction never resets a live node", () => {
      const b = createSubagentTreeBridge({ sweepIntervalMs: 0 })
      b.registerClient("c1", () => {})
      launch(b, "a1")
      b.observe("t1", { type: "subagent-progress", toolCallId: "a1", tool: "Grep", toolCount: 7 })
      // Later calls push "a1" out of the capped seenCalls.
      for (let i = 0; i < MAX_SEEN_CALLS + 5; i++) {
        b.observe("t1", { type: "tool-call", toolCallId: `x${i}`, name: "Bash" })
      }
      // A delayed forwarder replays the original spawn.
      b.observe("t1", { type: "tool-call", toolCallId: "a1", name: "Agent", input: {} })
      expect(b.treeFor("t1")).toEqual([
        expect.objectContaining({ id: "a1", status: "running", tool: "Grep", toolCount: 7 }),
      ])
      // Still background: the turn's end does not close it.
      b.observe("t1", { type: "turn-complete" })
      expect(b.treeFor("t1").map((n) => [n.id, n.status])).toEqual([["a1", "running"]])
    })

    it("a replayed call for a node dropped by bounding after seenCalls eviction stays gone", () => {
      const b = createSubagentTreeBridge({ sweepIntervalMs: 0 })
      b.registerClient("c1", () => {})
      launch(b, "root")
      b.observe("t1", { type: "turn-complete" })
      for (let i = 0; i < 400; i++) {
        const id = `c${i}`
        b.observe("t1", { type: "tool-call", toolCallId: id, name: "Agent", parentToolUseId: "root", input: {} })
        b.observe("t1", { type: "tool-result", toolCallId: id, status: "ok" })
      }
      expect(b.treeFor("t1").some((n) => n.id === "c0")).toBe(false)
      // A delayed forwarder replays c0's spawn; c0 is out of seenCalls and the tree.
      b.observe("t1", { type: "tool-call", toolCallId: "c0", name: "Agent", parentToolUseId: "root", input: {} })
      expect(b.treeFor("t1").some((n) => n.id === "c0")).toBe(false)
      b.observe("t1", { type: "turn-complete" })
      expect(b.treeFor("t1").map((n) => n.id)).toEqual(["root"])
    })

    it("the removed-node memory stays bounded", () => {
      const b = createSubagentTreeBridge({ sweepIntervalMs: 0 })
      b.registerClient("c1", () => {})
      b.observe("t1", { type: "tool-call", toolCallId: "old", name: "Agent", input: {} })
      b.observe("t1", { type: "turn-complete" })
      for (let i = 0; i < MAX_REMOVED_NODES + MAX_SEEN_CALLS; i++) {
        b.observe("t1", { type: "tool-call", toolCallId: `r${i}`, name: "Agent", input: {} })
        b.observe("t1", { type: "tool-result", toolCallId: `r${i}`, status: "ok" })
      }
      b.observe("t1", { type: "turn-complete" })
      // "old" left both capped sets, so it is accepted again.
      b.observe("t1", { type: "tool-call", toolCallId: "old", name: "Agent", input: {} })
      expect(b.treeFor("t1").map((n) => n.id)).toEqual(["old"])
    })

    it("sustained background activity between turns keeps the tree bounded", () => {
      const b = createSubagentTreeBridge({ sweepIntervalMs: 0 })
      const a = sink()
      b.registerClient("c1", a.send)
      launch(b, "root")
      b.observe("t1", { type: "turn-complete" })
      for (let i = 0; i < 1000; i++) {
        const id = `c${i}`
        b.observe("t1", { type: "tool-call", toolCallId: id, name: "Agent", parentToolUseId: "root", input: {} })
        b.observe("t1", { type: "tool-result", toolCallId: id, status: "ok" })
      }
      const tree = b.treeFor("t1")
      expect(tree.length).toBeLessThanOrEqual(MAX_SETTLED_NODES + 1)
      expect(tree[0]).toMatchObject({ id: "root", status: "running" })
      // The newest finished children are the ones kept.
      expect(tree.some((n) => n.id === "c999")).toBe(true)
      expect(tree.some((n) => n.id === "c0")).toBe(false)
      expect(lastAgents(a.frames).length).toBeLessThanOrEqual(MAX_SETTLED_NODES + 1)

      // Once the root settles its history stays bounded too.
      b.observe("t1", { type: "subagent-settled", toolCallId: "root", status: "done" })
      expect(b.treeFor("t1").length).toBeLessThanOrEqual(MAX_SETTLED_NODES + 1)
    })

    it("bounding keeps the ancestry of running nodes", () => {
      const b = createSubagentTreeBridge({ sweepIntervalMs: 0 })
      b.registerClient("c1", () => {})
      // A foreground parent finished long ago with a background child still
      // running under it.
      b.observe("t1", { type: "tool-call", toolCallId: "p", name: "Agent", input: {} })
      b.observe("t1", { type: "tool-call", toolCallId: "kid", name: "Agent", parentToolUseId: "p", input: {} })
      b.observe("t1", { type: "tool-result", toolCallId: "kid", status: "ok", async: true })
      b.observe("t1", { type: "tool-result", toolCallId: "p", status: "ok" })
      for (let i = 0; i < MAX_SETTLED_NODES * 3; i++) {
        b.observe("t1", { type: "tool-call", toolCallId: `s${i}`, name: "Agent", input: {} })
        b.observe("t1", { type: "tool-result", toolCallId: `s${i}`, status: "ok" })
      }
      const ids = b.treeFor("t1").map((n) => n.id)
      expect(ids).toContain("kid")
      expect(ids).toContain("p")
      expect(ids.length).toBeLessThanOrEqual(MAX_SETTLED_NODES + 2)
    })

    it("TTL backstop: an async node idle past the TTL is closed on the next observe", () => {
      let clock = 1_000_000
      const b = createSubagentTreeBridge({ now: () => clock, sweepIntervalMs: 0 })
      const a = sink()
      b.registerClient("c1", a.send)
      launch(b)
      clock += SUBAGENT_IDLE_TTL_MS - 1
      b.observe("t1", { type: "tool-call", toolCallId: "top", name: "Bash" })
      expect(b.treeFor("t1")[0]!.status).toBe("running")
      clock += 60_000 + 1
      b.observe("t1", { type: "tool-call", toolCallId: "top2", name: "Bash" })
      expect(lastAgents(a.frames)[0]).toMatchObject({ id: "a1", status: "done", stale: true })
    })

    it("TTL backstop: sweep() closes idle async nodes without any new frame", () => {
      let clock = 0
      const b = createSubagentTreeBridge({ now: () => clock, sweepIntervalMs: 0 })
      const a = sink()
      b.registerClient("c1", a.send)
      launch(b)
      clock += 31 * 60_000
      b.sweep()
      expect(lastAgents(a.frames)[0]).toMatchObject({ status: "done", stale: true })
    })

    it("activity resets the idle clock", () => {
      let clock = 0
      const b = createSubagentTreeBridge({ now: () => clock, sweepIntervalMs: 0 })
      b.registerClient("c1", () => {})
      launch(b)
      clock += 20 * 60_000
      b.observe("t1", { type: "subagent-progress", toolCallId: "a1", toolCount: 1 })
      clock += 20 * 60_000
      b.sweep()
      expect(b.treeFor("t1")[0]!.status).toBe("running")
    })

    it("settled / progress for an unknown id is ignored", () => {
      const b = createSubagentTreeBridge({ sweepIntervalMs: 0 })
      const a = sink()
      b.registerClient("c1", a.send)
      expect(() =>
        b.observe("t1", { type: "subagent-settled", toolCallId: "nope", status: "done" }),
      ).not.toThrow()
      b.observe("t1", { type: "subagent-progress", toolCallId: "nope", tool: "Read", toolCount: 2 })
      expect(a.frames).toHaveLength(0)
    })

    it("an agent moved to the background mid-run outlives its tool-result and the turn", () => {
      const b = createSubagentTreeBridge({ sweepIntervalMs: 0 })
      const a = sink()
      b.registerClient("c1", a.send)
      b.observe("t1", { type: "tool-call", toolCallId: "m1", name: "Agent", input: {} })
      b.observe("t1", { type: "subagent-progress", toolCallId: "m1", async: true })
      b.observe("t1", { type: "tool-result", toolCallId: "m1", status: "ok" })
      b.observe("t1", { type: "turn-complete" })
      expect(lastAgents(a.frames)).toEqual([expect.objectContaining({ id: "m1", status: "running" })])
      b.observe("t1", { type: "subagent-settled", toolCallId: "m1", status: "done" })
      expect(lastAgents(a.frames)[0]!.status).toBe("done")
    })

    it("an error result still closes an agent marked background", () => {
      const b = createSubagentTreeBridge({ sweepIntervalMs: 0 })
      b.registerClient("c1", () => {})
      b.observe("t1", { type: "tool-call", toolCallId: "m1", name: "Agent", input: {} })
      b.observe("t1", { type: "subagent-progress", toolCallId: "m1", async: true })
      b.observe("t1", { type: "tool-result", toolCallId: "m1", status: "error" })
      expect(b.treeFor("t1")[0]!.status).toBe("error")
    })

    it("a nested child's activity keeps its background parent out of the TTL", () => {
      let clock = 0
      const b = createSubagentTreeBridge({ now: () => clock, sweepIntervalMs: 0 })
      b.registerClient("c1", () => {})
      launch(b, "a1")
      b.observe("t1", { type: "tool-call", toolCallId: "n1", name: "Agent", parentToolUseId: "a1", input: {} })
      for (let i = 0; i < 4; i++) {
        clock += 20 * 60_000
        b.observe("t1", { type: "tool-call", toolCallId: `g${i}`, name: "Grep", parentToolUseId: "n1" })
      }
      clock += 20 * 60_000
      b.observe("t1", { type: "subagent-progress", toolCallId: "n1" })
      clock += 20 * 60_000
      b.sweep()
      expect(b.treeFor("t1").map((n) => [n.id, n.status])).toEqual([
        ["a1", "running"],
        ["n1", "running"],
      ])
      clock += SUBAGENT_IDLE_TTL_MS
      b.sweep()
      expect(b.treeFor("t1").map((n) => n.status)).toEqual(["done", "done"])
    })

    it("the sweep timer only runs while a background node is running", () => {
      vi.useFakeTimers()
      try {
        let clock = 0
        const b = createSubagentTreeBridge({ now: () => clock })
        const a = sink()
        b.registerClient("c1", a.send)
        expect(vi.getTimerCount()).toBe(0)
        launch(b)
        expect(vi.getTimerCount()).toBe(1)
        clock += 31 * 60_000
        vi.advanceTimersByTime(SUBAGENT_SWEEP_INTERVAL_MS)
        expect(lastAgents(a.frames)[0]!.status).toBe("done")
        expect(vi.getTimerCount()).toBe(0)
        b.dispose()
      } finally {
        vi.useRealTimers()
      }
    })
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
})
