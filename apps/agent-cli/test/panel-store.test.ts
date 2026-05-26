import { describe, expect, it } from "vitest"
import { createTuiStore } from "../src/tui/store.js"
import { CONTEXT_TAB_ORDER, FRAME_RING_CAPACITY } from "../src/tui/panel-types.js"
import type { ServerFrame } from "@luna/ui-ws"

const makeFrame = (i: number): ServerFrame => ({ type: "ping", ts: i })

describe("tui store panel state", () => {
  it("defaults contextPanelTab to memories", () => {
    const store = createTuiStore()
    expect(store.contextPanelTab()).toBe("memories")
  })

  it("setContextPanelTab updates the active tab", () => {
    const store = createTuiStore()
    store.setContextPanelTab("events")
    expect(store.contextPanelTab()).toBe("events")
  })

  it("cycleContextPanelTab walks the canonical order and wraps", () => {
    const store = createTuiStore()
    expect(store.contextPanelTab()).toBe("memories")
    store.cycleContextPanelTab()
    expect(store.contextPanelTab()).toBe("events")
    store.cycleContextPanelTab()
    expect(store.contextPanelTab()).toBe("artifacts")
    store.cycleContextPanelTab()
    expect(store.contextPanelTab()).toBe("memories")
  })

  it("lastUserMessage defaults to empty string and setLastUserMessage updates it", () => {
    const store = createTuiStore()
    expect(store.lastUserMessage()).toBe("")
    store.setLastUserMessage("hi luna")
    expect(store.lastUserMessage()).toBe("hi luna")
  })

  it("pushRawFrame appends frames in order with timestamps", () => {
    const store = createTuiStore()
    store.pushRawFrame(makeFrame(1))
    store.pushRawFrame(makeFrame(2))
    const frames = store.rawFrames()
    expect(frames.length).toBe(2)
    expect(frames[0]?.frame).toMatchObject({ type: "ping", ts: 1 })
    expect(frames[1]?.frame).toMatchObject({ type: "ping", ts: 2 })
    expect(typeof frames[0]?.receivedAt).toBe("number")
  })

  it("pushRawFrame drops oldest when ring buffer exceeds capacity", () => {
    const store = createTuiStore()
    for (let i = 0; i < FRAME_RING_CAPACITY + 5; i++) store.pushRawFrame(makeFrame(i))
    const frames = store.rawFrames()
    expect(frames.length).toBe(FRAME_RING_CAPACITY)
    expect(frames[0]?.frame).toMatchObject({ ts: 5 })
    expect(frames[FRAME_RING_CAPACITY - 1]?.frame).toMatchObject({ ts: FRAME_RING_CAPACITY + 4 })
  })

  it("memorySearch defaults to idle and setMemorySearch updates state", () => {
    const store = createTuiStore()
    expect(store.memorySearch().status).toBe("idle")
    store.setMemorySearch({ status: "loading", query: "hi" })
    expect(store.memorySearch()).toEqual({ status: "loading", query: "hi" })
    store.setMemorySearch({
      status: "ready",
      query: "hi",
      hits: [{ id: "m1", kind: "feedback", content: "test", score: 0.9 }],
    })
    expect(store.memorySearch().status).toBe("ready")
  })

  it("setArtifactsForThread stores artifacts keyed by thread id", () => {
    const store = createTuiStore()
    expect(store.artifactsByThread().size).toBe(0)
    store.setArtifactsForThread("thr_a", [
      { kind: "file", path: "/x.txt", mime: "text/plain", bytes: 10 } as never,
    ])
    expect(store.artifactsByThread().get("thr_a")?.length).toBe(1)
    expect(store.artifactsByThread().get("thr_b")).toBeUndefined()
  })

  it("CONTEXT_TAB_ORDER matches store cycle", () => {
    expect(CONTEXT_TAB_ORDER).toEqual(["memories", "events", "artifacts"])
  })
})
