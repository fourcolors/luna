import { describe, expect, it } from "vitest"
import { filterEvents, initialState, reduce } from "../src/reducer.js"
import type {
  ChatMessage,
  ObsEvent,
  ServerFrame,
  SessionSummary,
} from "../src/wire.js"

const ev = (kind: string, ts = "2026-04-25T00:00:00.000Z"): ObsEvent =>
  ({ kind, ts, level: "info" }) as unknown as ObsEvent

const summary = (id: string, title = "t"): SessionSummary => ({
  id,
  parentId: null,
  title,
  tags: [],
  createdAt: 0,
  endedAt: null,
  model: "m",
  status: "active",
  lastMessageAt: null,
  lastMessagePreview: null,
})

const chatMsg = (
  id: string,
  seq: number,
  role: "user" | "assistant",
  text: string,
): ChatMessage => ({ id, seq, ts: 0, role, text, toolUses: [], attachments: [] })

describe("reducer", () => {
  it("hello sets advertisedKinds and clears closeReason", () => {
    const s1 = reduce(
      { ...initialState, closeReason: "stale" },
      {
        type: "hello",
        protocolVersion: 2,
        kinds: ["ToolCall", "Error"],
        capabilities: { chat: true, streamingDeltas: true, setup: false },
      } as ServerFrame,
    )
    expect(s1.advertisedKinds).toEqual(["ToolCall", "Error"])
    expect(s1.closeReason).toBeNull()
    expect(s1.capabilities).toEqual({ chat: true, streamingDeltas: true, setup: false })
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

  /* ── chat ────────────────────────────────────────────────────────── */

  it("thread-list populates the sidebar projection", () => {
    const s = reduce(initialState, {
      type: "thread-list",
      threads: [summary("a"), summary("b")],
    })
    expect(s.threadList.map((t) => t.id)).toEqual(["a", "b"])
  })

  it("thread-created inserts thread, selects it, prepends to list", () => {
    const s = reduce(
      { ...initialState, threadList: [summary("old")] },
      { type: "thread-created", thread: summary("new") },
    )
    expect(s.selectedThreadId).toBe("new")
    expect(s.threadList[0]!.id).toBe("new")
    expect(s.threads.has("new")).toBe(true)
  })

  it("thread-snapshot installs messages + throughSeq watermark", () => {
    let s = reduce(initialState, {
      type: "thread-created",
      thread: summary("x"),
    })
    s = reduce(s, {
      type: "thread-snapshot",
      threadId: "x",
      throughSeq: 5,
      messages: [chatMsg("u1", 0, "user", "hi"), chatMsg("a1", 1, "assistant", "hey")],
    })
    const t = s.threads.get("x")!
    expect(t.messages).toHaveLength(2)
    expect(t.throughSeq).toBe(5)
  })

  it("user-accepted appends; duplicate seq <= throughSeq is deduped", () => {
    let s = reduce(initialState, { type: "thread-created", thread: summary("x") })
    s = reduce(s, {
      type: "thread-snapshot",
      threadId: "x",
      throughSeq: 3,
      messages: [],
    })
    s = reduce(s, {
      type: "user-accepted",
      threadId: "x",
      seq: 2,
      message: chatMsg("u-old", 2, "user", "stale"),
    })
    expect(s.threads.get("x")!.messages).toHaveLength(0) // deduped
    s = reduce(s, {
      type: "user-accepted",
      threadId: "x",
      seq: 4,
      message: chatMsg("u-new", 4, "user", "fresh"),
    })
    expect(s.threads.get("x")!.messages).toHaveLength(1)
    expect(s.threads.get("x")!.throughSeq).toBe(4)
  })

  it("assistant-delta sets in-flight; assistant-done clears it and appends", () => {
    let s = reduce(initialState, { type: "thread-created", thread: summary("x") })
    s = reduce(s, {
      type: "thread-snapshot",
      threadId: "x",
      throughSeq: -1,
      messages: [],
    })
    s = reduce(s, {
      type: "assistant-delta",
      threadId: "x",
      turnId: "t1",
      text: "hello wor",
    })
    expect(s.threads.get("x")!.inFlight?.text).toBe("hello wor")
    s = reduce(s, {
      type: "assistant-done",
      threadId: "x",
      turnId: "t1",
      seq: 0,
      message: chatMsg("a1", 0, "assistant", "hello world"),
    })
    expect(s.threads.get("x")!.inFlight).toBeNull()
    expect(s.threads.get("x")!.messages).toHaveLength(1)
  })

  it("assistant-error captures lastError and clears in-flight", () => {
    let s = reduce(initialState, { type: "thread-created", thread: summary("x") })
    s = reduce(s, {
      type: "thread-snapshot",
      threadId: "x",
      throughSeq: -1,
      messages: [],
    })
    s = reduce(s, {
      type: "assistant-delta",
      threadId: "x",
      turnId: "t1",
      text: "partial",
    })
    s = reduce(s, {
      type: "assistant-error",
      threadId: "x",
      turnId: "t1",
      error: { kind: "interrupted", message: "stopped" },
    })
    expect(s.threads.get("x")!.inFlight).toBeNull()
    expect(s.threads.get("x")!.lastError).toEqual({
      kind: "interrupted",
      message: "stopped",
    })
  })

  it("select-thread local action sets selectedThreadId", () => {
    const s = reduce(initialState, { tag: "select-thread", threadId: "xyz" })
    expect(s.selectedThreadId).toBe("xyz")
  })

  it("artifacts-extracted appends; same messageId replaces prior set", () => {
    let s = reduce(initialState, {
      type: "thread-created",
      thread: summary("x"),
    })
    s = reduce(s, {
      type: "artifacts-extracted",
      threadId: "x",
      messageId: "m1",
      messageSeq: 0,
      artifacts: [
        {
          id: "m1:0",
          source: "code-fence",
          path: null,
          lang: "ts",
          title: "code (ts)",
          content: "x",
        },
      ],
    })
    expect(s.threads.get("x")!.artifacts).toHaveLength(1)
    // Re-extraction for the same message replaces (idempotent)
    s = reduce(s, {
      type: "artifacts-extracted",
      threadId: "x",
      messageId: "m1",
      messageSeq: 0,
      artifacts: [
        {
          id: "m1:0",
          source: "code-fence",
          path: null,
          lang: "ts",
          title: "code (ts)",
          content: "x",
        },
        {
          id: "m1:1",
          source: "tool-write",
          path: "/a.ts",
          lang: "ts",
          title: "a.ts",
          content: "y",
        },
      ],
    })
    expect(s.threads.get("x")!.artifacts).toHaveLength(2)
    // A different messageId appends
    s = reduce(s, {
      type: "artifacts-extracted",
      threadId: "x",
      messageId: "m2",
      messageSeq: 1,
      artifacts: [
        {
          id: "m2:0",
          source: "code-fence",
          path: null,
          lang: "go",
          title: "code (go)",
          content: "z",
        },
      ],
    })
    expect(s.threads.get("x")!.artifacts.map((a) => a.id)).toEqual([
      "m1:0",
      "m1:1",
      "m2:0",
    ])
  })
})
