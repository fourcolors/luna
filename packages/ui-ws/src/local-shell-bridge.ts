import { randomUUID } from "node:crypto"
import type {
  LocalShellCapabilityFrame,
  LocalShellRequestFrame,
  LocalShellResultFrame,
  LocalShellStatusFrame,
} from "./protocol.js"

export type SendLocalShellFrame = (
  frame: LocalShellRequestFrame | LocalShellStatusFrame,
) => void

interface RegisteredClient {
  readonly capability: LocalShellCapabilityFrame
  readonly send: SendLocalShellFrame
}

interface PendingRequest {
  readonly threadId: string
  readonly resolve: (frame: LocalShellResultFrame) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

export interface LocalShellBridge {
  readonly setCapability: (
    frame: LocalShellCapabilityFrame,
    send: SendLocalShellFrame,
  ) => LocalShellStatusFrame
  readonly removeClient: (clientId: string) => void
  readonly getCapability: (threadId: string) => LocalShellCapabilityFrame | null
  readonly request: (input: {
    readonly threadId: string
    readonly command: string
    readonly cwd?: string
    readonly timeoutMs: number
  }) => Promise<LocalShellResultFrame>
  readonly acceptResult: (frame: LocalShellResultFrame) => void
}

export const createLocalShellBridge = (): LocalShellBridge => {
  const clients = new Map<string, RegisteredClient>()
  const pending = new Map<string, PendingRequest>()

  const rejectPendingForThread = (threadId: string, message: string): void => {
    for (const [requestId, request] of pending) {
      if (request.threadId !== threadId) continue

      clearTimeout(request.timer)
      pending.delete(requestId)
      request.reject(new Error(message))
    }
  }

  const setCapability = (
    frame: LocalShellCapabilityFrame,
    send: SendLocalShellFrame,
  ): LocalShellStatusFrame => {
    const existing = clients.get(frame.threadId)

    if (!frame.enabled) {
      if (existing?.capability.clientId === frame.clientId) {
        clients.delete(frame.threadId)
        rejectPendingForThread(
          frame.threadId,
          `local shell disabled for ${frame.threadId}`,
        )
      }

      return {
        type: "local-shell-status",
        threadId: frame.threadId,
        enabled: false,
        accepted: true,
        message: "local shell disabled",
      }
    }

    if (
      existing &&
      existing.capability.clientId !== frame.clientId &&
      existing.capability.replaceable !== true
    ) {
      return {
        type: "local-shell-status",
        threadId: frame.threadId,
        enabled: false,
        accepted: false,
        message: `local shell already attached for ${frame.threadId}`,
      }
    }

    clients.set(frame.threadId, { capability: frame, send })

    return {
      type: "local-shell-status",
      threadId: frame.threadId,
      enabled: true,
      accepted: true,
      message: "local shell enabled",
    }
  }

  const removeClient = (clientId: string): void => {
    for (const [threadId, client] of clients) {
      if (client.capability.clientId === clientId) {
        clients.delete(threadId)
        rejectPendingForThread(
          threadId,
          `local shell client removed for ${threadId}`,
        )
      }
    }
  }

  const getCapability = (threadId: string): LocalShellCapabilityFrame | null =>
    clients.get(threadId)?.capability ?? null

  const request = (input: {
    readonly threadId: string
    readonly command: string
    readonly cwd?: string
    readonly timeoutMs: number
  }): Promise<LocalShellResultFrame> => {
    const client = clients.get(input.threadId)
    if (!client) {
      return Promise.reject(
        new Error(`local shell unavailable for ${input.threadId}`),
      )
    }

    const requestId = `lsh_${randomUUID()}`

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId)
        reject(new Error(`local shell request timed out: ${requestId}`))
      }, input.timeoutMs)

      pending.set(requestId, {
        threadId: input.threadId,
        resolve,
        reject,
        timer,
      })

      client.send({
        type: "local-shell-request",
        requestId,
        threadId: input.threadId,
        command: input.command,
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        timeoutMs: input.timeoutMs,
      })
    })
  }

  const acceptResult = (frame: LocalShellResultFrame): void => {
    const entry = pending.get(frame.requestId)
    if (!entry) return
    if (entry.threadId !== frame.threadId) return

    clearTimeout(entry.timer)
    pending.delete(frame.requestId)
    entry.resolve(frame)
  }

  return { setCapability, removeClient, getCapability, request, acceptResult }
}
