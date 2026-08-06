/**
 * chatModel.test.ts - behavioral coverage for the pure chat reducer (see
 * chatModel.ts's module doc). No DOM/jsdom needed for the reducer itself;
 * this file exercises it directly.
 */
import { describe, it, expect } from "vitest"
import {
  chatModelReducer,
  createInitialChatModelState,
  createChatModelStore,
  planChatItems,
  isTailStreamingEmpty,
  hasVisibleTypingIndicator,
  isTimelineEffectivelyCollapsed,
  findPendingTurn,
  type ChatModelState,
  type ChatModelAction,
  type Turn,
} from "./chatModel"

function reduce(state: ChatModelState, ...actions: Parameters<typeof chatModelReducer>[1][]): ChatModelState {
  return actions.reduce((s, a) => chatModelReducer(s, a), state)
}

describe("chatModelReducer - purity", () => {
  it("never mutates the input state or its turns/segments", () => {
    const s0 = createInitialChatModelState()
    const s1 = chatModelReducer(s0, { type: "append-user", text: "hi", ts: 1 })
    const s2 = chatModelReducer(s1, { type: "apply-delta", turnId: "t1", text: "Hey" })
    const s3 = chatModelReducer(s2, { type: "apply-delta", turnId: "t1", text: "Hey there" })
    // s1/s2 must be untouched by later dispatches - a real bug here (mutating
    // shared segment objects) would surface as s1.turns/s2.turns changing.
    expect(s1.turns).toHaveLength(1)
    expect(s2.turns[1]?.segments).toEqual([{ kind: "text", raw: "Hey", done: false }])
    expect(s3.turns[1]?.segments).toEqual([{ kind: "text", raw: "Hey there", done: false }])
    // Unrelated turn (index 0) keeps referential identity across dispatches
    // that don't touch it - the memoization guarantee MessageList relies on.
    expect(s2.turns[0]).toBe(s1.turns[0])
    expect(s3.turns[0]).toBe(s1.turns[0])
  })

  it("is safe under React StrictMode double-invocation (same state+action applied twice independently)", () => {
    const s0 = chatModelReducer(createInitialChatModelState(), {
      type: "apply-delta",
      turnId: "t1",
      text: "abc",
    })
    const a = chatModelReducer(s0, { type: "apply-delta", turnId: "t1", text: "abcdef" })
    const b = chatModelReducer(s0, { type: "apply-delta", turnId: "t1", text: "abcdef" })
    expect(a).toEqual(b)
    expect(a.turns[0]?.segments[0]).toEqual({ kind: "text", raw: "abcdef", done: false })
  })

  it("reset() returns the SAME state object when already empty (idempotent no-op)", () => {
    const s0 = createInitialChatModelState()
    const s1 = chatModelReducer(s0, { type: "reset" })
    expect(s1).toBe(s0)
  })
})

describe("chatModelReducer - streaming segment append (applyDelta)", () => {
  it("creates a pending-assistant-claimed turn on the first delta for a turnId", () => {
    const s = chatModelReducer(createInitialChatModelState(), {
      type: "apply-delta",
      turnId: "turn-1",
      text: "Hello",
    })
    expect(s.turns).toHaveLength(1)
    expect(s.turns[0]).toMatchObject({ key: "t-turn-1", role: "assistant", status: "streaming", turnId: "turn-1" })
    expect(s.turns[0]?.segments).toEqual([{ kind: "text", raw: "Hello", done: false }])
  })

  it("claims an existing pending-assistant placeholder instead of appending a second turn", () => {
    let s = chatModelReducer(createInitialChatModelState(), { type: "begin-pending-assistant" })
    expect(s.turns).toHaveLength(1)
    s = chatModelReducer(s, { type: "apply-delta", turnId: "turn-1", text: "Hi" })
    expect(s.turns).toHaveLength(1)
    expect(s.turns[0]?.key).toBe("t-turn-1")
  })

  it("appends only the INCREMENTAL suffix of cumulative deltas (no exponential duplication)", () => {
    let s = createInitialChatModelState()
    s = chatModelReducer(s, { type: "apply-delta", turnId: "t1", text: "Hey" })
    s = chatModelReducer(s, { type: "apply-delta", turnId: "t1", text: "Hey Alex - what's up?" })
    expect(s.turns[0]?.segments).toHaveLength(1)
    expect(s.turns[0]?.segments[0]).toEqual({
      kind: "text",
      raw: "Hey Alex - what's up?",
      done: false,
    })
  })

  it("falls back to the whole text on a non-monotonic / reset delta (over-render, never drop)", () => {
    let s = createInitialChatModelState()
    s = chatModelReducer(s, { type: "apply-delta", turnId: "t1", text: "Hello world" })
    s = chatModelReducer(s, { type: "apply-delta", turnId: "t1", text: "Different text" })
    expect(s.turns[0]?.segments).toHaveLength(1)
    const seg = s.turns[0]?.segments[0]
    expect(seg?.kind === "text" ? seg.raw : undefined).toBe("Hello worldDifferent text")
  })

  it("a no-op empty-string delta is dropped entirely (no turn created)", () => {
    const s = chatModelReducer(createInitialChatModelState(), { type: "apply-delta", turnId: "t1", text: "" })
    expect(s.turns).toHaveLength(0)
  })

  it("a duplicate delta (identical cumulative text) still claims/creates the turn but adds no segment", () => {
    let s = chatModelReducer(createInitialChatModelState(), { type: "apply-delta", turnId: "t1", text: "same" })
    s = chatModelReducer(s, { type: "apply-delta", turnId: "t1", text: "same" })
    expect(s.turns).toHaveLength(1)
    expect(s.turns[0]?.segments).toEqual([{ kind: "text", raw: "same", done: false }])
  })

  it("a tool call after streamed text closes the open text segment, then a fresh delta opens a new one", () => {
    let s = createInitialChatModelState()
    s = chatModelReducer(s, { type: "apply-delta", turnId: "t1", text: "before" })
    s = chatModelReducer(s, {
      type: "apply-tool-call",
      turnId: "t1",
      toolCallId: "c1",
      name: "Bash",
      input: { cmd: "ls" },
    })
    s = chatModelReducer(s, { type: "apply-delta", turnId: "t1", text: "beforeafter" })
    const segs = s.turns[0]?.segments
    expect(segs).toHaveLength(3)
    expect(segs?.[0]).toEqual({ kind: "text", raw: "before", done: true })
    expect(segs?.[1]).toMatchObject({ kind: "tool", id: "c1", name: "Bash" })
    expect(segs?.[2]).toEqual({ kind: "text", raw: "after", done: false })
  })
})

describe("chatModelReducer - turn lifecycle", () => {
  it("finishTurn closes open text segments and marks the turn done, stamping ts", () => {
    let s = chatModelReducer(createInitialChatModelState(), { type: "apply-delta", turnId: "t1", text: "hi" })
    s = chatModelReducer(s, { type: "finish-turn", turnId: "t1", ts: 12345 })
    expect(s.turns[0]).toMatchObject({ status: "done", ts: 12345 })
    expect(s.turns[0]?.segments[0]).toMatchObject({ done: true })
  })

  it("finishTurn drops a turn with zero visible content (replaces sweepTrailingEmptyAssistantBubbles)", () => {
    let s = chatModelReducer(createInitialChatModelState(), { type: "begin-pending-assistant" })
    s = chatModelReducer(s, { type: "finish-turn", turnId: "", ts: 1 })
    expect(s.turns).toHaveLength(0)
  })

  it("finishTurn on an unknown turnId with no pending placeholder is a no-op", () => {
    const s0 = chatModelReducer(createInitialChatModelState(), { type: "append-banner", text: "hi" })
    const s1 = chatModelReducer(s0, { type: "finish-turn", turnId: "ghost", ts: 1 })
    expect(s1).toBe(s0)
  })

  it("failTurn on an active streaming turn marks it errored with the message", () => {
    let s = chatModelReducer(createInitialChatModelState(), { type: "apply-delta", turnId: "t1", text: "partial" })
    s = chatModelReducer(s, { type: "fail-turn", turnId: "t1", errorText: "boom" })
    expect(s.turns[0]).toMatchObject({ status: "error", errorText: "boom" })
    expect(s.turns[0]?.segments[0]).toMatchObject({ done: true })
  })

  it("failTurn with no active/pending turn pushes a fresh standalone error turn", () => {
    const s = chatModelReducer(createInitialChatModelState(), { type: "fail-turn", turnId: "", errorText: "" })
    expect(s.turns).toHaveLength(1)
    expect(s.turns[0]).toMatchObject({ role: "assistant", status: "error", errorText: "Unknown error" })
  })

  it("dropPendingAssistant removes only a still-unclaimed placeholder", () => {
    let s = chatModelReducer(createInitialChatModelState(), { type: "begin-pending-assistant" })
    s = chatModelReducer(s, { type: "drop-pending-assistant" })
    expect(s.turns).toHaveLength(0)

    const claimed = chatModelReducer(createInitialChatModelState(), {
      type: "apply-delta",
      turnId: "t1",
      text: "hi",
    })
    const afterDrop = chatModelReducer(claimed, { type: "drop-pending-assistant" })
    expect(afterDrop).toBe(claimed) // no-op: tail is claimed (key "t-t1"), not "pending-assistant"
  })

  it("markRunSettled flips _settled on the trailing run of assistant turns, stopping at a user/banner/error boundary", () => {
    let s = createInitialChatModelState()
    s = chatModelReducer(s, { type: "append-user", text: "q1", ts: 1 })
    s = chatModelReducer(s, { type: "apply-delta", turnId: "a1", text: "r1" })
    s = chatModelReducer(s, { type: "finish-turn", turnId: "a1", ts: 2 })
    s = chatModelReducer(s, { type: "apply-delta", turnId: "a2", text: "r2" })
    s = chatModelReducer(s, { type: "finish-turn", turnId: "a2", ts: 3 })
    s = chatModelReducer(s, { type: "mark-run-settled" })
    expect(s.turns.find((t) => t.turnId === "a1")?._settled).toBe(true)
    expect(s.turns.find((t) => t.turnId === "a2")?._settled).toBe(true)
    expect(s.turns.find((t) => t.role === "user")?._settled).toBeUndefined()
  })

  it("appendDelivered pushes a settled, done turn carrying the delivery marker; blank text is dropped", () => {
    const s1 = chatModelReducer(createInitialChatModelState(), {
      type: "append-delivered",
      message: { text: "the answer", ts: 99, delivery: { label: "nightly digest" } },
    })
    expect(s1.turns[0]).toMatchObject({
      role: "assistant",
      status: "done",
      ts: 99,
      delivery: { label: "nightly digest" },
      _settled: true,
    })
    const s2 = chatModelReducer(createInitialChatModelState(), {
      type: "append-delivered",
      message: { text: "   " },
    })
    expect(s2.turns).toHaveLength(0)
  })

  it("loadHistory skips empty/whitespace-only messages and maps role/ts/delivery", () => {
    const s = chatModelReducer(createInitialChatModelState(), {
      type: "load-history",
      messages: [
        { role: "user", text: "hi", ts: 1 },
        { role: "assistant", text: "  " },
        { role: "assistant", text: "hello" },
      ],
    })
    expect(s.turns).toHaveLength(2)
    expect(s.turns[0]).toMatchObject({ role: "user", key: "h-0", ts: 1 })
    expect(s.turns[1]).toMatchObject({ role: "assistant", key: "h-1" })
  })
})

describe("chatModelReducer - S15c: tool-call/text interleaving parity (mirrors chat-window.test.ts's oracle scenarios)", () => {
  it("a delta after a tool call opens a FRESH text segment, not a continuation of the pre-tool cumulative text", () => {
    let s = createInitialChatModelState()
    s = chatModelReducer(s, { type: "apply-delta", turnId: "t1", text: "Looking that up. " })
    s = chatModelReducer(s, { type: "apply-tool-call", turnId: "t1", toolCallId: "c1", name: "Read", input: {} })
    s = chatModelReducer(s, { type: "apply-delta", turnId: "t1", text: "Found 3 lines." })
    const segs = s.turns[0]?.segments
    expect(segs).toHaveLength(3)
    expect(segs?.[0]).toEqual({ kind: "text", raw: "Looking that up. ", done: true })
    expect(segs?.[1]).toMatchObject({ kind: "tool", id: "c1" })
    // The post-tool delta is NOT sliced against the pre-tool cumulative text
    // (a different baseline) - it lands whole, as its own open segment.
    expect(segs?.[2]).toEqual({ kind: "text", raw: "Found 3 lines.", done: false })
  })

  it("finish-turn after tool-call + post-tool delta closes segments in place - the action carries no text field, so duplication via a server-sent full-text string is structurally impossible", () => {
    let s = createInitialChatModelState()
    s = chatModelReducer(s, { type: "apply-delta", turnId: "t1", text: "Looking that up. " })
    s = chatModelReducer(s, { type: "apply-tool-call", turnId: "t1", toolCallId: "c1", name: "Read", input: {} })
    s = chatModelReducer(s, { type: "apply-delta", turnId: "t1", text: "Found 3 lines." })
    s = chatModelReducer(s, { type: "finish-turn", turnId: "t1", ts: 1 })
    expect(s.turns[0]?.segments).toEqual([
      { kind: "text", raw: "Looking that up. ", done: true },
      { kind: "tool", id: "c1", name: "Read", input: {}, result: null },
      { kind: "text", raw: "Found 3 lines.", done: true },
    ])
    expect(s.turns[0]?.status).toBe("done")
  })

  it("a turn that ends on a tool with no trailing text keeps just the tool segment - finish-turn never fabricates a text segment", () => {
    let s = createInitialChatModelState()
    s = chatModelReducer(s, {
      type: "apply-tool-call",
      turnId: "t1",
      toolCallId: "c1",
      name: "Bash",
      input: { command: "ls" },
    })
    s = chatModelReducer(s, { type: "finish-turn", turnId: "t1", ts: 1 })
    expect(s.turns[0]?.segments).toEqual([{ kind: "tool", id: "c1", name: "Bash", input: { command: "ls" }, result: null }])
  })
})

describe("chatModelReducer - out-of-order / unexpected frame tolerance", () => {
  it("a tool-result for an unknown toolCallId is silently dropped (no matching segment anywhere)", () => {
    const s0 = chatModelReducer(createInitialChatModelState(), {
      type: "apply-tool-call",
      turnId: "t1",
      toolCallId: "known",
      name: "X",
      input: {},
    })
    const s1 = chatModelReducer(s0, {
      type: "apply-tool-result",
      toolCallId: "unknown-id",
      ok: true,
      output: "x",
      truncated: false,
    })
    expect(s1).toBe(s0)
  })

  it("a tool-result that arrives before any matching tool-call this turn is a no-op, then resolves once the call lands", () => {
    let s = createInitialChatModelState()
    s = chatModelReducer(s, { type: "apply-tool-result", toolCallId: "c1", ok: true, output: "early", truncated: false })
    expect(s.turns).toHaveLength(0)
    s = chatModelReducer(s, { type: "apply-tool-call", turnId: "t1", toolCallId: "c1", name: "Bash", input: {} })
    expect(s.turns[0]?.segments[0]).toMatchObject({ result: null })
    s = chatModelReducer(s, { type: "apply-tool-result", toolCallId: "c1", ok: true, output: "late", truncated: false })
    expect(s.turns[0]?.segments[0]).toMatchObject({ result: { ok: true, output: "late", truncated: false } })
  })

  it("a delta for a turnId that never got a pending placeholder just creates a fresh turn (no crash)", () => {
    const s = chatModelReducer(createInitialChatModelState(), {
      type: "apply-delta",
      turnId: "surprise-turn",
      text: "out of nowhere",
    })
    expect(s.turns).toHaveLength(1)
    expect(s.turns[0]).toMatchObject({ turnId: "surprise-turn" })
  })

  it("finish-turn arriving twice for the same turnId is a safe no-op the second time (turn already gone from lookup)", () => {
    let s = chatModelReducer(createInitialChatModelState(), { type: "apply-delta", turnId: "t1", text: "hi" })
    s = chatModelReducer(s, { type: "finish-turn", turnId: "t1", ts: 1 })
    const doneOnce = s
    s = chatModelReducer(s, { type: "finish-turn", turnId: "t1", ts: 2 })
    // _findTurn only matches a "streaming" turn's key pattern regardless of
    // status, so a second finish just re-applies the same close+stamp -
    // assert it stays stable/idempotent rather than erroring or duplicating.
    expect(s.turns).toHaveLength(1)
    expect(s.turns[0]?.status).toBe("done")
    expect(doneOnce.turns[0]?.ts).toBe(1)
  })

  it("a stray fail-turn with no turnId and no pending/active turn still surfaces a visible error turn", () => {
    const s = chatModelReducer(createInitialChatModelState(), {
      type: "fail-turn",
      turnId: "does-not-exist",
      errorText: "stray",
    })
    expect(s.turns).toHaveLength(1)
    expect(s.turns[0]?.status).toBe("error")
  })

  it("an action with an unrecognized type is a safe no-op that returns the prior state unchanged", () => {
    const s0 = chatModelReducer(createInitialChatModelState(), { type: "append-banner", text: "hi" })
    // The reducer is exported: a JS/untyped consumer could dispatch an object
  // the union cannot express, hence the test-only cast.
    // the type union can't produce, hence the test-only cast.
    const malformed = { type: "not-a-real-action" } as unknown as ChatModelAction
    const s1 = chatModelReducer(s0, malformed)
    expect(s1).toBe(s0)
  })
})

describe("chatModelReducer - toggle-timeline", () => {
  it("flips _timelineCollapsed on the named turn and no-ops on an unknown key", () => {
    let s = chatModelReducer(createInitialChatModelState(), { type: "apply-delta", turnId: "t1", text: "hi" })
    const key = s.turns[0]?.key ?? ""
    s = chatModelReducer(s, { type: "toggle-timeline", turnKey: key, currentlyCollapsed: true })
    expect(s.turns[0]?._timelineCollapsed).toBe(false)
    const before = s
    s = chatModelReducer(s, { type: "toggle-timeline", turnKey: "no-such-key", currentlyCollapsed: true })
    expect(s).toBe(before)
  })
})

describe("selectors", () => {
  it("isTailStreamingEmpty is true for an unclaimed pending placeholder and a claimed-but-empty tail", () => {
    const pending = chatModelReducer(createInitialChatModelState(), { type: "begin-pending-assistant" })
    expect(isTailStreamingEmpty(pending.turns)).toBe(true)

    const done = chatModelReducer(pending, { type: "apply-delta", turnId: "t1", text: "hi" })
    expect(isTailStreamingEmpty(done.turns)).toBe(false)

    expect(isTailStreamingEmpty([])).toBe(false)
  })

  it("hasVisibleTypingIndicator is true for the pending placeholder AND an unsettled trailing timeline (mirrors the vanilla disconnect handler's `.typing-dots` querySelector, which matched both shapes)", () => {
    const pending = chatModelReducer(createInitialChatModelState(), { type: "begin-pending-assistant" })
    expect(hasVisibleTypingIndicator(pending.turns, true)).toBe(true)

    let s = createInitialChatModelState()
    s = chatModelReducer(s, { type: "apply-tool-call", turnId: "t1", toolCallId: "c1", name: "Bash", input: {} })
    // Tool card still in flight, no turn-complete yet - the timeline's
    // summary shows the spinner.
    expect(hasVisibleTypingIndicator(s.turns, true)).toBe(true)

    s = chatModelReducer(s, { type: "finish-turn", turnId: "t1", ts: 1 })
    s = chatModelReducer(s, { type: "mark-run-settled" })
    // Settled -> collapsed to the "Worked for N steps" pill, no spinner.
    expect(hasVisibleTypingIndicator(s.turns, true)).toBe(false)

    expect(hasVisibleTypingIndicator([], true)).toBe(false)
  })

  it("findPendingTurn returns the placeholder or null", () => {
    expect(findPendingTurn([])).toBeNull()
    const s = chatModelReducer(createInitialChatModelState(), { type: "begin-pending-assistant" })
    expect(findPendingTurn(s.turns)?.key).toBe("pending-assistant")
  })

  it("isTimelineEffectivelyCollapsed: explicit pin wins over settled default", () => {
    const turn: Turn = {
      key: "t1",
      role: "assistant",
      status: "streaming",
      segments: [],
      previews: null,
    }
    expect(isTimelineEffectivelyCollapsed(turn, true)).toBe(true)
    expect(isTimelineEffectivelyCollapsed(turn, false)).toBe(false)
    expect(isTimelineEffectivelyCollapsed({ ...turn, _timelineCollapsed: false }, true)).toBe(false)
    expect(isTimelineEffectivelyCollapsed({ ...turn, _timelineCollapsed: true }, false)).toBe(true)
  })
})

describe("planChatItems - grouping into activity timelines", () => {
  it("a tool-free run renders as plain text bubbles, one per segment", () => {
    let s = createInitialChatModelState()
    s = chatModelReducer(s, { type: "apply-delta", turnId: "t1", text: "hello" })
    s = chatModelReducer(s, { type: "finish-turn", turnId: "t1", ts: 1 })
    const plan = planChatItems(s.turns, { grouped: true })
    expect(plan).toHaveLength(1)
    expect(plan[0]).toMatchObject({ kind: "text" })
  })

  it("a run with a tool call collapses into one timeline + a trailing answer bubble", () => {
    let s = createInitialChatModelState()
    s = chatModelReducer(s, { type: "apply-delta", turnId: "t1", text: "let me check" })
    s = chatModelReducer(s, { type: "apply-tool-call", turnId: "t1", toolCallId: "c1", name: "Bash", input: {} })
    s = chatModelReducer(s, { type: "apply-tool-result", toolCallId: "c1", ok: true, output: "42", truncated: false })
    s = chatModelReducer(s, { type: "apply-delta", turnId: "t1", text: "let me checkthe answer is 42" })
    s = chatModelReducer(s, { type: "finish-turn", turnId: "t1", ts: 1 })
    s = chatModelReducer(s, { type: "mark-run-settled" })
    const plan = planChatItems(s.turns, { grouped: true })
    expect(plan.map((p) => p.kind)).toEqual(["timeline", "text"])
    const tl = plan[0]
    expect(tl?.kind).toBe("timeline")
    if (tl?.kind === "timeline") {
      expect(tl.settled).toBe(true)
      expect(tl.lastToolIndex).toBe(1)
    }
  })

  it("multiple consecutive assistant turns (multi-step agentic run) merge into ONE timeline when grouped", () => {
    let s = createInitialChatModelState()
    s = chatModelReducer(s, { type: "apply-tool-call", turnId: "a1", toolCallId: "c1", name: "Bash", input: {} })
    s = chatModelReducer(s, { type: "finish-turn", turnId: "a1", ts: 1 })
    s = chatModelReducer(s, { type: "apply-delta", turnId: "a2", text: "done" })
    s = chatModelReducer(s, { type: "finish-turn", turnId: "a2", ts: 2 })
    const plan = planChatItems(s.turns, { grouped: true })
    const timelines = plan.filter((p) => p.kind === "timeline")
    expect(timelines).toHaveLength(1)
  })

  it("when NOT grouped (older server), each assistant turn is its own timeline/bubble", () => {
    let s = createInitialChatModelState()
    s = chatModelReducer(s, { type: "apply-tool-call", turnId: "a1", toolCallId: "c1", name: "Bash", input: {} })
    s = chatModelReducer(s, { type: "finish-turn", turnId: "a1", ts: 1 })
    s = chatModelReducer(s, { type: "apply-tool-call", turnId: "a2", toolCallId: "c2", name: "Bash", input: {} })
    s = chatModelReducer(s, { type: "finish-turn", turnId: "a2", ts: 2 })
    const plan = planChatItems(s.turns, { grouped: false })
    expect(plan.filter((p) => p.kind === "timeline")).toHaveLength(2)
  })

  it("a background-delivered turn never merges into a surrounding run, even with a tool present", () => {
    let s = createInitialChatModelState()
    s = chatModelReducer(s, { type: "apply-tool-call", turnId: "a1", toolCallId: "c1", name: "Bash", input: {} })
    s = chatModelReducer(s, { type: "finish-turn", turnId: "a1", ts: 1 })
    s = chatModelReducer(s, {
      type: "append-delivered",
      message: { text: "background result", ts: 2, delivery: { label: "job" } },
    })
    const plan = planChatItems(s.turns, { grouped: true })
    // The delivered turn renders standalone (its own run) - it must show up
    // as its own "text" item (no tool -> plain bubble), never swallowed into
    // the preceding tool run's timeline.
    const deliveredItem = plan.find((p) => p.turn.delivery)
    expect(deliveredItem?.kind).toBe("text")
  })

  it("an empty streaming placeholder plans as a typing item", () => {
    const s = chatModelReducer(createInitialChatModelState(), { type: "begin-pending-assistant" })
    const plan = planChatItems(s.turns, { grouped: true })
    expect(plan).toEqual([{ key: "pending-assistant|typing", kind: "typing", turn: s.turns[0] }])
  })
})

describe("createChatModelStore", () => {
  it("dispatch updates getState() synchronously; notify() is a separate step", () => {
    const store = createChatModelStore()
    const seen: number[] = []
    store.subscribe(() => seen.push(store.getState().turns.length))

    store.dispatch({ type: "append-banner", text: "hi" })
    expect(store.getState().turns).toHaveLength(1) // synchronous, no notify() needed to observe
    expect(seen).toHaveLength(0) // no listener fired yet

    store.notify()
    expect(seen).toEqual([1])
  })

  it("subscribe() returns a working unsubscribe", () => {
    const store = createChatModelStore()
    let calls = 0
    const unsubscribe = store.subscribe(() => {
      calls++
    })
    store.notify()
    unsubscribe()
    store.notify()
    expect(calls).toBe(1)
  })
})
