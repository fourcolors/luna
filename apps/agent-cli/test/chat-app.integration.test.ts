import { PassThrough } from "node:stream"
import { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { WebSocketServer } from "ws"
import type { ClientFrame, ServerFrame } from "@luna/ui-ws"
import type { ChatMessage, SessionSummary } from "@luna/core"
import { runLunaCli } from "../src/chat/app.js"

const waitFor = async <T>(promise: Promise<T>, timeoutMs = 1_000): Promise<T> => {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error("timed out waiting")), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

const thread = (id: string): SessionSummary => ({
  id,
  parentId: null,
  title: "Terminal",
  tags: [],
  createdAt: 1,
  endedAt: null,
  model: "claude-sonnet-4-5",
  status: "active",
  lastMessageAt: null,
  lastMessagePreview: null,
})

const assistantMessage = (text: string): ChatMessage => ({
  id: "asst_1",
  seq: 1,
  ts: 1,
  role: "assistant",
  text,
  toolUses: [],
  attachments: [],
})

describe("luna chat app", () => {
  let server: WebSocketServer | undefined

  afterEach(async () => {
    if (server !== undefined) {
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => (error === undefined ? resolve() : reject(error)))
      })
      server = undefined
    }
  })

  const startChatServer = async (): Promise<{
    readonly url: string
    readonly received: ClientFrame[]
    readonly authHeader: Promise<string | undefined>
  }> => {
    const received: ClientFrame[] = []
    server = new WebSocketServer({ port: 0 })
    await new Promise<void>((resolve) => server?.once("listening", resolve))
    const address = server.address() as AddressInfo
    let resolveAuth: (header: string | undefined) => void
    const authHeader = new Promise<string | undefined>((resolve) => {
      resolveAuth = resolve
    })

    server.on("connection", (socket, request) => {
      resolveAuth(request.headers.authorization)
      const hello: ServerFrame = {
        type: "hello",
        protocolVersion: 2,
        kinds: [],
        capabilities: { chat: true, streamingDeltas: true, localShell: true },
      }
      socket.send(JSON.stringify(hello))

      socket.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as ClientFrame
        received.push(frame)
        if (frame.type === "new-thread") {
          socket.send(JSON.stringify({ type: "thread-created", thread: thread("thr_1") } satisfies ServerFrame))
          socket.send(JSON.stringify({
            type: "thread-snapshot",
            threadId: "thr_1",
            throughSeq: -1,
            messages: [],
          } satisfies ServerFrame))
        }
        if (frame.type === "user-message") {
          socket.send(JSON.stringify({
            type: "assistant-delta",
            threadId: "thr_1",
            turnId: "turn_1",
            text: "Hi from Luna",
          } satisfies ServerFrame))
          socket.send(JSON.stringify({
            type: "assistant-done",
            threadId: "thr_1",
            turnId: "turn_1",
            seq: 1,
            message: assistantMessage("Hi from Luna"),
          } satisfies ServerFrame))
        }
      })
    })

    return { url: `ws://127.0.0.1:${address.port}/ui`, received, authHeader }
  }

  it("creates a thread, sends one user message, renders assistant output, and quits", async () => {
    const chat = await startChatServer()
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    let output = ""
    let diagnostics = ""
    stdout.on("data", (chunk) => {
      output += chunk.toString()
    })
    stderr.on("data", (chunk) => {
      diagnostics += chunk.toString()
    })

    const done = runLunaCli(["chat", "--url", chat.url], {
      stdin,
      stdout,
      stderr,
      env: { LUNA_UI_WS_TOKEN: "token-from-env" },
      cwd: process.cwd(),
    })

    stdin.write("hello\n")
    stdin.write("/quit\n")
    stdin.end()

    const result = await waitFor(done)

    expect(result.exitCode, diagnostics).toBe(0)
    await expect(chat.authHeader).resolves.toBe("Bearer token-from-env")
    expect(chat.received).toContainEqual({
      type: "new-thread",
      model: "claude-sonnet-4-5",
    })
    expect(chat.received).toContainEqual({
      type: "user-message",
      threadId: "thr_1",
      text: "hello",
    })
    expect(output).toContain("Hi from Luna")
  })
})
