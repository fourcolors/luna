/**
 * suggested-actions-reducer.test.ts — reducer cases for the per-thread
 * suggested-action-set (full replace) + suggested-action-update (single delta),
 * plus the capability fold from `hello`.
 *
 * Follows packages/ui-shared/test/vault-reducer.test.ts idioms exactly.
 */
import { describe, expect, it } from "vitest"
import { initialState, reduce } from "../src/reducer.js"
import type { ServerFrame, SuggestedActionWire } from "../src/wire.js"

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const fakeAction = (
  id: string,
  threadId: string,
  over: Partial<SuggestedActionWire> = {},
): SuggestedActionWire => ({
  id,
  threadId,
  actionType: "research",
  title: `Action ${id}`,
  status: "proposed",
  source: "agent",
  createdAt: 1000,
  ...over,
})

/* -------------------------------------------------------------------------- */
/* suggested-action-set reducer case                                           */
/* -------------------------------------------------------------------------- */

describe("reducer: suggested-action-set", () => {
  it("populates the thread's slice from empty initial state", () => {
    const s = reduce(initialState, {
      type: "suggested-action-set",
      threadId: "t1",
      actions: [fakeAction("a", "t1"), fakeAction("b", "t1")],
    } as ServerFrame)
    expect(s.suggestedActions.get("t1")).toHaveLength(2)
    expect(s.suggestedActions.get("t1")?.[0]?.id).toBe("a")
  })

  it("replaces a thread's slice wholesale on re-send", () => {
    const first = reduce(initialState, {
      type: "suggested-action-set",
      threadId: "t1",
      actions: [fakeAction("a", "t1"), fakeAction("b", "t1")],
    } as ServerFrame)
    const second = reduce(first, {
      type: "suggested-action-set",
      threadId: "t1",
      actions: [fakeAction("c", "t1")],
    } as ServerFrame)
    expect(second.suggestedActions.get("t1")).toHaveLength(1)
    expect(second.suggestedActions.get("t1")?.[0]?.id).toBe("c")
  })

  it("leaves other threads untouched (per-thread scope)", () => {
    const withT1 = reduce(initialState, {
      type: "suggested-action-set",
      threadId: "t1",
      actions: [fakeAction("a", "t1")],
    } as ServerFrame)
    const withT2 = reduce(withT1, {
      type: "suggested-action-set",
      threadId: "t2",
      actions: [fakeAction("b", "t2")],
    } as ServerFrame)
    expect(withT2.suggestedActions.get("t1")?.[0]?.id).toBe("a")
    expect(withT2.suggestedActions.get("t2")?.[0]?.id).toBe("b")
  })
})

/* -------------------------------------------------------------------------- */
/* suggested-action-update reducer case                                        */
/* -------------------------------------------------------------------------- */

describe("reducer: suggested-action-update", () => {
  it("replaces one action in place by id (status transition)", () => {
    const seeded = reduce(initialState, {
      type: "suggested-action-set",
      threadId: "t1",
      actions: [fakeAction("a", "t1"), fakeAction("b", "t1")],
    } as ServerFrame)
    const updated = reduce(seeded, {
      type: "suggested-action-update",
      threadId: "t1",
      action: fakeAction("a", "t1", { status: "in_progress", executionId: "job-1" }),
    } as ServerFrame)
    const arr = updated.suggestedActions.get("t1") ?? []
    expect(arr).toHaveLength(2)
    expect(arr.find((x) => x.id === "a")?.status).toBe("in_progress")
    expect(arr.find((x) => x.id === "a")?.executionId).toBe("job-1")
    expect(arr.find((x) => x.id === "b")?.status).toBe("proposed")
  })

  it("appends an unseen action (live update before any set)", () => {
    const updated = reduce(initialState, {
      type: "suggested-action-update",
      threadId: "t1",
      action: fakeAction("a", "t1"),
    } as ServerFrame)
    expect(updated.suggestedActions.get("t1")).toHaveLength(1)
    expect(updated.suggestedActions.get("t1")?.[0]?.id).toBe("a")
  })
})

/* -------------------------------------------------------------------------- */
/* capability fold                                                             */
/* -------------------------------------------------------------------------- */

describe("reducer: suggestedActions capability", () => {
  it("folds capabilities.suggestedActions from hello", () => {
    const s = reduce(initialState, {
      type: "hello",
      protocolVersion: 2,
      kinds: [],
      capabilities: { chat: true, streamingDeltas: true, setup: false, suggestedActions: true },
    } as ServerFrame)
    expect(s.capabilities.suggestedActions).toBe(true)
  })

  it("defaults to undefined against an older server", () => {
    const s = reduce(initialState, {
      type: "hello",
      protocolVersion: 2,
      kinds: [],
      capabilities: { chat: true, streamingDeltas: true, setup: false },
    } as ServerFrame)
    expect(s.capabilities.suggestedActions).toBeUndefined()
  })
})
