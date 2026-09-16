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

/** The attached scope a capability frame advertises, normalized for back-compat. */
export interface CapabilityScope {
  /** Attached folder roots (absolute paths). At least one entry for an enabled client. */
  readonly roots: ReadonlyArray<string>
  /** When true, the client allows commands in any working directory. */
  readonly fullAccess: boolean
}

/**
 * Normalize a capability frame's scope. A LEGACY client omits `roots` entirely
 * (`undefined`) — read that as a single-root attachment `[cwd]`. A NEW client
 * always sends `roots`, so an empty array means "nothing attached" and is
 * preserved as-is (auto-approval is opt-in; an empty scope prompts/denies).
 */
export const capabilityRoots = (
  frame: LocalShellCapabilityFrame,
): CapabilityScope => ({
  roots: frame.roots ?? [frame.cwd],
  fullAccess: frame.fullAccess ?? false,
})

interface RegisteredClient {
  readonly capability: LocalShellCapabilityFrame
  readonly send: SendLocalShellFrame
}

/**
 * Who actually ran a command. Snapshotted at DISPATCH time, not at result
 * time: the binding for a thread can be replaced while a request is in
 * flight, and a result that named the *current* binding rather than the one
 * it was sent to would misreport history — the precise failure this field
 * exists to prevent.
 */
// Declared as a `type`, not an `interface`, deliberately: this value is
// returned straight out of the `local_shell_run` MCP tool, whose output must
// satisfy a JSON index signature. TypeScript gives object *type aliases* an
// implicit index signature but never gives interfaces one, so an interface
// here fails to typecheck at the tool boundary.
export type LocalShellDispatchIdentity = {
  readonly clientId: string
  readonly platform: string
  /** Effective working directory: the request's `cwd` if it set one, else the client's. */
  readonly cwd: string
  readonly roots: ReadonlyArray<string>
  readonly fullAccess: boolean
}

/** A completed request plus the identity of the client that served it. */
export interface LocalShellRequestOutcome {
  readonly result: LocalShellResultFrame
  readonly dispatchedTo: LocalShellDispatchIdentity
}

interface PendingRequest {
  readonly threadId: string
  readonly dispatchedTo: LocalShellDispatchIdentity
  readonly resolve: (outcome: LocalShellRequestOutcome) => void
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
  }) => Promise<LocalShellRequestOutcome>
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
  }): Promise<LocalShellRequestOutcome> => {
    const client = clients.get(input.threadId)
    if (!client) {
      return Promise.reject(
        new Error(`local shell unavailable for ${input.threadId}`),
      )
    }

    const scope = capabilityRoots(client.capability)
    const dispatchedTo: LocalShellDispatchIdentity = {
      clientId: client.capability.clientId,
      platform: client.capability.platform,
      cwd: input.cwd ?? client.capability.cwd,
      roots: scope.roots,
      fullAccess: scope.fullAccess,
    }

    const requestId = `lsh_${randomUUID()}`

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId)
        reject(new Error(`local shell request timed out: ${requestId}`))
      }, input.timeoutMs)

      pending.set(requestId, {
        threadId: input.threadId,
        dispatchedTo,
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
    entry.resolve({ result: frame, dispatchedTo: entry.dispatchedTo })
  }

  return { setCapability, removeClient, getCapability, request, acceptResult }
}
