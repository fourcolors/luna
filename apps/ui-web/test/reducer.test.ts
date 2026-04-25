import { describe, expect, it } from "vitest"
import { filterEvents, initialState, reduce } from "../src/reducer.js"
import type { ObsEvent, ServerFrame } from "../src/wire.js"

const ev = (kind: string, ts = "2026-04-25T00:00:00.000Z"): ObsEvent =>
  ({ kind, ts, level: "info" }) as unknown as ObsEvent

describe("reducer", () => {
  it("hello sets advertisedKinds and clears closeReason", () => {
    const s1 = reduce(
      { ...initialState, closeReason: "stale" },
      { type: "hello", protocolVersion: 1, kinds: ["ToolCall", "Error"] } as ServerFrame,
    )
    expect(s1.advertisedKinds).toEqual(["ToolCall", "Error"])
    expect(s1.closeReason).toBeNull()
  })

  it("event prepends and tracks seenKinds (dedup)", () => {
    let s = initialState
    s = reduce(s, { type: "event", event: ev("ToolCall") })
    s = reduce(s, { type: "event", event: ev("ToolCall") })
    s = reduce(s, { type: "event", event: ev("Error") })
    expect(s.events).toHaveLength(3)
    expect(s.events[0]!.kind).toBe("Error") // latest-first
    expect(s.seenKinds).toEqual(["ToolCall", "Error"])
  })

  it("event retention is bounded at 500", () => {
    let s = initialState
    for (let i = 0; i < 600; i++) {
      s = reduce(s, { type: "event", event: ev("ToolCall", `t-${i}`) })
    }
    expect(s.events).toHaveLength(500)
    // Newest first → last inserted is at index 0.
    expect(s.events[0]!.ts).toBe("t-599")
  })

  it("drop accumulates total and records lastDrop burst", () => {
    let s = initialState
    s = reduce(s, { type: "drop", n: 3, since: "t1" })
    s = reduce(s, { type: "drop", n: 5, since: "t2" })
    expect(s.droppedTotal).toBe(8)
    expect(s.lastDrop).toEqual({ n: 5, since: "t2" })
  })

  it("ping records lastPingAt", () => {
    const s = reduce(initialState, { type: "ping", ts: "p1" })
    expect(s.lastPingAt).toBe("p1")
  })

  it("bye records closeReason", () => {
    const s = reduce(initialState, { type: "bye", reason: "shutdown" })
    expect(s.closeReason).toBe("shutdown")
  })

  it("filterEvents: empty selection returns all", () => {
    const events = [ev("ToolCall"), ev("Error")]
    expect(filterEvents(events, new Set())).toEqual(events)
  })

  it("filterEvents: filters to selected kinds", () => {
    const events = [ev("ToolCall"), ev("Error"), ev("CostAccrued")]
    const out = filterEvents(events, new Set(["Error", "CostAccrued"]))
    expect(out.map((e) => e.kind)).toEqual(["Error", "CostAccrued"])
  })
})
