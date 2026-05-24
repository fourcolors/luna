import { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { WebSocketServer } from "ws"
import type { ClientFrame, ServerFrame } from "@luna/ui-ws"
import { LunaWsClient } from "../src/chat/ws-client.js"

const waitFor = async <T>(promise: Promise<T>, timeoutMs = 1_000): Promise<T> => {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error("timed out waiting for frame")), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

describe("LunaWsClient", () => {
  let server: WebSocketServer | undefined
  let client: LunaWsClient | undefined

  afterEach(async () => {
    if (client !== undefined) {
      await client.close()
      client = undefined
    }
    if (server !== undefined) {
      await new Promise<void>((resolve, reject) => {
        server?.close((err) => (err === undefined ? resolve() : reject(err)))
      })
      server = undefined
    }
  })

  const startServer = (): { server: WebSocketServer; url: string } => {
    server = new WebSocketServer({ port: 0 })
    const address = server.address() as AddressInfo
    return { server, url: `ws://127.0.0.1:${address.port}` }
  }

  it("sends bearer auth and receives server frames in order", async () => {
    const { server, url } = startServer()
    const hello: ServerFrame = {
      type: "hello",
      protocolVersion: 2,
      kinds: [],
      capabilities: { chat: true, streamingDeltas: true },
    }
    const authHeader = new Promise<string | undefined>((resolve) => {
      server.on("connection", (socket, request) => {
        resolve(request.headers.authorization)
        socket.send(JSON.stringify(hello))
      })
    })

    client = await LunaWsClient.connect({ url, token: "secret-token" })

    await expect(authHeader).resolves.toBe("Bearer secret-token")
    await expect(waitFor(client.nextFrame())).resolves.toEqual(hello)
  })

  it("serializes client frames as JSON", async () => {
    const { server, url } = startServer()
    const received = new Promise<unknown>((resolve) => {
      server.on("connection", (socket) => {
        socket.on("message", (raw) => resolve(JSON.parse(raw.toString())))
      })
    })
    const frame: ClientFrame = { type: "list-threads", limit: 5 }

    client = await LunaWsClient.connect({ url, token: "secret-token" })
    client.send(frame)

    await expect(waitFor(received)).resolves.toEqual(frame)
  })
})
