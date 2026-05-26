import { describe, expect, it, vi } from "vitest"
import type { ServerFrame, ClientFrame } from "@luna/ui-ws"
import { LunaHeadlessSession } from "../src/chat/headless.js"

class StubWsClient {
  readonly sent: ClientFrame[] = []
  private queue: ServerFrame[] = []
  private waiters: ((f: ServerFrame) => void)[] = []
  send(f: ClientFrame) { this.sent.push(f) }
  nextFrame(): Promise<ServerFrame> {
    const head = this.queue.shift()
    if (head !== undefined) return Promise.resolve(head)
    return new Promise((resolve) => this.waiters.push(resolve))
  }
  emit(frame: ServerFrame) {
    const waiter = this.waiters.shift()
    if (waiter !== undefined) waiter(frame)
    else this.queue.push(frame)
  }
  async close() {}
}

describe("LunaHeadlessSession", () => {
  it("emits onThreadChange when a thread-created frame arrives", async () => {
    const client = new StubWsClient()
    const session = new LunaHeadlessSession({
      client: client as never,
      profileName: "stable",
      model: "claude-sonnet-4-5",
      saveLastThread: () => undefined,
      clearLastThread: () => undefined,
    })
    const onThread = vi.fn()
    session.on("threadChange", onThread)
    void session.run()
    client.emit({
      type: "thread-created",
      thread: { id: "t1", parentId: null, title: null, tags: [], createdAt: 1, updatedAt: 1, status: "open" },
    } as never)
    await new Promise((r) => setTimeout(r, 5))
    expect(onThread).toHaveBeenCalledWith("t1")
    expect(client.sent).toContainEqual({ type: "subscribe", threadId: "t1" })
  })

  it("buffers user messages until a thread is bound", async () => {
    const client = new StubWsClient()
    const session = new LunaHeadlessSession({
      client: client as never,
      profileName: "stable",
      model: "claude-sonnet-4-5",
      saveLastThread: () => undefined,
      clearLastThread: () => undefined,
    })
    void session.run()
    session.sendUser("hello")
    expect(client.sent.filter((f) => f.type === "user-message")).toHaveLength(0)
    client.emit({
      type: "thread-created",
      thread: { id: "t2", parentId: null, title: null, tags: [], createdAt: 1, updatedAt: 1, status: "open" },
    } as never)
    await new Promise((r) => setTimeout(r, 5))
    expect(client.sent).toContainEqual({ type: "user-message", threadId: "t2", text: "hello" })
  })

  it("emits rawFrame for every received ServerFrame, before dispatch", async () => {
    const client = new StubWsClient()
    const session = new LunaHeadlessSession({
      client: client as never,
      profileName: "stable",
      model: "claude-sonnet-4-5",
      saveLastThread: () => undefined,
      clearLastThread: () => undefined,
    })
    const rawFrameListener = vi.fn()
    const threadChangeListener = vi.fn()
    session.on("rawFrame", rawFrameListener)
    session.on("threadChange", threadChangeListener)

    void session.run() // start the consume loop

    client.emit({ type: "hello", protocolVersion: 1, kinds: [], capabilities: {} } as never)
    client.emit({ type: "ping", ts: 1234 } as never)
    client.emit({
      type: "thread-created",
      thread: { id: "thr_test", parentId: null, title: null, tags: [], createdAt: 0, updatedAt: 0, status: "open" },
    } as never)

    await new Promise((r) => setTimeout(r, 5))

    expect(rawFrameListener).toHaveBeenCalledTimes(3)
    expect(rawFrameListener.mock.calls[0]?.[0]).toMatchObject({ type: "hello" })
    expect(rawFrameListener.mock.calls[1]?.[0]).toMatchObject({ type: "ping" })
    expect(rawFrameListener.mock.calls[2]?.[0]).toMatchObject({ type: "thread-created" })

    // rawFrame fires BEFORE the high-level dispatch
    const rawFrameOrder = rawFrameListener.mock.invocationCallOrder[2] ?? 0
    const threadChangeOrder = threadChangeListener.mock.invocationCallOrder[0] ?? 0
    expect(rawFrameOrder).toBeLessThan(threadChangeOrder)
  })
})
