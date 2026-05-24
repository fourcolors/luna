import { PassThrough } from "node:stream"
import { AddressInfo } from "node:net"
import { afterEach, describe, expect, it, vi } from "vitest"
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

const assistantMessage = (text: string, seq = 1): ChatMessage => ({
  id: `asst_${seq}`,
  seq,
  ts: 1,
  role: "assistant",
  text,
  toolUses: [],
  attachments: [],
})

const helloFrame: ServerFrame = {
  type: "hello",
  protocolVersion: 2,
  kinds: [],
  capabilities: { chat: true, streamingDeltas: true, localShell: true },
}

const collectStream = (stream: PassThrough): { readonly read: () => string } => {
  let text = ""
  stream.on("data", (chunk) => {
    text += chunk.toString()
  })
  return { read: () => text }
}

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
      socket.send(JSON.stringify(helloFrame))

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

  it("can quit while a user message is waiting for thread creation", async () => {
    server = new WebSocketServer({ port: 0 })
    await new Promise<void>((resolve) => server?.once("listening", resolve))
    const address = server.address() as AddressInfo
    const socketClosed = new Promise<void>((resolve) => {
      server?.on("connection", (socket) => {
        socket.send(JSON.stringify(helloFrame))
        socket.once("close", () => resolve())
      })
    })
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()

    const done = runLunaCli(["chat", "--url", `ws://127.0.0.1:${address.port}/ui`], {
      stdin,
      stdout,
      stderr,
      env: { LUNA_UI_WS_TOKEN: "token-from-env" },
      cwd: process.cwd(),
    })

    stdin.write("hello\n")
    stdin.write("/quit\n")
    stdin.end()

    await expect(waitFor(done, 250)).resolves.toEqual({ exitCode: 0 })
    await expect(waitFor(socketClosed, 250)).resolves.toBeUndefined()
  })

  it("drains all assistant replies before quitting after quick user messages", async () => {
    const received: ClientFrame[] = []
    server = new WebSocketServer({ port: 0 })
    await new Promise<void>((resolve) => server?.once("listening", resolve))
    const address = server.address() as AddressInfo

    server.on("connection", (socket) => {
      socket.send(JSON.stringify(helloFrame))
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
          const seq = frame.text === "one" ? 1 : 2
          setTimeout(() => {
            socket.send(JSON.stringify({
              type: "assistant-delta",
              threadId: "thr_1",
              turnId: `turn_${seq}`,
              text: `reply ${seq}`,
            } satisfies ServerFrame))
            socket.send(JSON.stringify({
              type: "assistant-done",
              threadId: "thr_1",
              turnId: `turn_${seq}`,
              seq,
              message: assistantMessage(`reply ${seq}`, seq),
            } satisfies ServerFrame))
          }, seq === 1 ? 20 : 40)
        }
      })
    })

    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const output = collectStream(stdout)

    const done = runLunaCli(["chat", "--url", `ws://127.0.0.1:${address.port}/ui`], {
      stdin,
      stdout,
      stderr,
      env: { LUNA_UI_WS_TOKEN: "token-from-env" },
      cwd: process.cwd(),
    })

    stdin.write("one\n")
    stdin.write("two\n")
    stdin.write("/quit\n")
    stdin.end()

    await expect(waitFor(done, 500)).resolves.toEqual({ exitCode: 0 })
    expect(received).toContainEqual({ type: "user-message", threadId: "thr_1", text: "one" })
    expect(received).toContainEqual({ type: "user-message", threadId: "thr_1", text: "two" })
    expect(output.read()).toContain("reply 1")
    expect(output.read()).toContain("reply 2")
  })

  it("does not wait for unresolved local shell approval during quit", async () => {
    server = new WebSocketServer({ port: 0 })
    await new Promise<void>((resolve) => server?.once("listening", resolve))
    const address = server.address() as AddressInfo
    const approveLocalCommand = vi.fn(() => new Promise<boolean>(() => undefined))

    server.on("connection", (socket) => {
      socket.send(JSON.stringify(helloFrame))
      socket.send(JSON.stringify({
        type: "local-shell-request",
        requestId: "req_1",
        threadId: "thr_1",
        command: "printf hello",
      } satisfies ServerFrame))
    })

    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()

    const done = runLunaCli(["chat", "--url", `ws://127.0.0.1:${address.port}/ui`], {
      stdin,
      stdout,
      stderr,
      env: { LUNA_UI_WS_TOKEN: "token-from-env" },
      cwd: process.cwd(),
      approveLocalCommand,
    })

    stdin.write("/quit\n")
    stdin.end()

    await expect(waitFor(done, 250)).resolves.toEqual({ exitCode: 0 })
    expect(approveLocalCommand).toHaveBeenCalledWith("printf hello")
  })
})
