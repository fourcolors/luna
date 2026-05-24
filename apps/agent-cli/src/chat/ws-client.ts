import WebSocket, { type RawData } from "ws"
import type { ClientFrame, ServerFrame } from "@luna/ui-ws"

export interface LunaWsConnectOptions {
  readonly url: string
  readonly token: string
  readonly timeoutMs?: number
}

type FrameWaiter = {
  readonly resolve: (frame: ServerFrame) => void
  readonly reject: (error: Error) => void
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const parseServerFrame = (raw: RawData): ServerFrame => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString())
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    throw new Error(`Invalid WebSocket JSON: ${message}`)
  }
  if (!isRecord(parsed) || typeof parsed["type"] !== "string") {
    throw new Error("Invalid WebSocket frame: missing string type")
  }
  return parsed as unknown as ServerFrame
}

export class LunaWsClient {
  readonly #socket: WebSocket
  readonly #frames: ServerFrame[] = []
  readonly #waiters: FrameWaiter[] = []
  #terminalError: Error | null = null

  private constructor(socket: WebSocket) {
    this.#socket = socket
    socket.on("message", (raw) => this.#handleMessage(raw))
    socket.on("error", (error) => this.#markTerminal(error))
    socket.on("close", () => {
      if (this.#terminalError === null) this.#markTerminal(new Error("WebSocket closed"))
    })
  }

  static connect(options: LunaWsConnectOptions): Promise<LunaWsClient> {
    const timeoutMs = options.timeoutMs ?? 10_000
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(options.url, {
        headers: { Authorization: `Bearer ${options.token}` },
      })
      let settled = false
      let timeout: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
        fail(new Error(`WebSocket connection timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      const cleanup = (): void => {
        socket.off("open", onOpen)
        socket.off("error", onError)
        socket.off("unexpected-response", onUnexpectedResponse)
        if (timeout !== undefined) {
          clearTimeout(timeout)
          timeout = undefined
        }
      }

      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        cleanup()
        socket.terminate()
        reject(error)
      }

      const onOpen = (): void => {
        if (settled) return
        settled = true
        cleanup()
        resolve(new LunaWsClient(socket))
      }

      const onError = (error: Error): void => {
        fail(new Error(`WebSocket connection failed: ${error.message}`))
      }

      const onUnexpectedResponse = (
        _request: unknown,
        response: { statusCode?: number; statusMessage?: string; resume: () => void },
      ): void => {
        const statusCode = response.statusCode ?? "unknown"
        const statusMessage = response.statusMessage ?? "unknown"
        response.resume()
        fail(new Error(`WebSocket upgrade failed with HTTP ${statusCode} ${statusMessage}`))
      }

      socket.on("open", onOpen)
      socket.on("error", onError)
      socket.on("unexpected-response", onUnexpectedResponse)
    })
  }

  send(frame: ClientFrame): void {
    if (this.#socket.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not open")
    }
    this.#socket.send(JSON.stringify(frame))
  }

  nextFrame(): Promise<ServerFrame> {
    if (this.#terminalError !== null) return Promise.reject(this.#terminalError)
    const frame = this.#frames.shift()
    if (frame !== undefined) return Promise.resolve(frame)
    return new Promise((resolve, reject) => {
      this.#waiters.push({ resolve, reject })
    })
  }

  close(): Promise<void> {
    if (this.#socket.readyState === WebSocket.CLOSED) return Promise.resolve()
    return new Promise((resolve) => {
      this.#socket.once("close", () => resolve())
      if (this.#socket.readyState === WebSocket.CLOSING) return
      this.#socket.close()
    })
  }

  #handleMessage(raw: RawData): void {
    let frame: ServerFrame
    try {
      frame = parseServerFrame(raw)
    } catch (error) {
      this.#markTerminal(error instanceof Error ? error : new Error(String(error)))
      this.#socket.terminate()
      return
    }

    const waiter = this.#waiters.shift()
    if (waiter !== undefined) {
      waiter.resolve(frame)
      return
    }
    this.#frames.push(frame)
  }

  #markTerminal(error: Error): void {
    if (this.#terminalError !== null) return
    this.#terminalError = error
    const waiters = this.#waiters.splice(0)
    for (const waiter of waiters) waiter.reject(error)
  }
}
