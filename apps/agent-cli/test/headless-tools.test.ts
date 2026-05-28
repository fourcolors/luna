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

function makeSessionUnderTest() {
  const client = new StubWsClient()
  const session = new LunaHeadlessSession({
    client: client as never,
    profileName: "stable",
    model: "claude-sonnet-4-5",
    saveLastThread: () => undefined,
    clearLastThread: () => undefined,
  })
  return { session, client }
}

describe("LunaHeadlessSession tool frames", () => {
  it("emits toolCall and toolResult events from wire frames", async () => {
    const { session, client } = makeSessionUnderTest()
    const onToolCall = vi.fn()
    const onToolResult = vi.fn()
    session.on("toolCall", onToolCall)
    session.on("toolResult", onToolResult)

    void session.run()

    client.emit({
      type: "tool-call",
      threadId: "t",
      turnId: "u",
      toolCallId: "tu_1",
      name: "bash",
      input: { cmd: "ls" },
    } as never)
    client.emit({
      type: "tool-result",
      threadId: "t",
      toolCallId: "tu_1",
      status: "ok",
      output: "ok",
      truncated: false,
    } as never)

    await new Promise((r) => setTimeout(r, 5))

    expect(onToolCall).toHaveBeenCalledWith({
      toolCallId: "tu_1",
      name: "bash",
      input: { cmd: "ls" },
      turnId: "u",
    })
    expect(onToolResult).toHaveBeenCalledWith({
      toolCallId: "tu_1",
      status: "ok",
      output: "ok",
      truncated: false,
    })
  })
})
