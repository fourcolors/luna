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

/**
 * Thread tags that mark a thread as UNATTENDED — nobody is watching it in a UI.
 * A non-sandbox client (a desktop/CLI shell on someone's actual machine) is
 * never resolvable from these, because an inbound channel message is an
 * injection surface, and a forked child or an agent-created chat
 * (create_thread) runs its first turn without anyone present.
 *
 * The single source of truth: local-shell-tools reads this list too. The
 * strings match FORK_CHILD_TAG / AGENT_CREATED_TAG in @luna/thread-tools
 * (thread-tools test pins that).
 */
export const UNATTENDED_THREAD_TAGS: ReadonlyArray<string> = [
  "forked-from-parent",
  "channel",
  "agent-created",
]

const isUnattended = (tags: ReadonlyArray<string> | undefined): boolean =>
  (tags ?? []).some((t) => UNATTENDED_THREAD_TAGS.includes(t))

interface RegisteredClient {
  readonly capability: LocalShellCapabilityFrame
  readonly send: SendLocalShellFrame
  /** Monotonic registration order: the newest live client wins a label collision. */
  readonly seq: number
  /**
   * Per-connection owner id (the connection's `secretConnId`, or a stable id
   * for the in-process sandbox). Only the connection that holds the CURRENT
   * registration may remove it — a stale connection closing after a reconnect
   * (same clientId, newer registration already live) must not wipe the live
   * one. Mirrors SecretRequestBridge's connId guard.
   */
  readonly connId: string
}

/**
 * Who actually ran a command. Snapshotted at DISPATCH time, not at result
 * time: a client can register or drop while a request is in flight, and a
 * result that named the *current* resolution rather than the one it was sent
 * to would misreport history — the precise failure this field prevents.
 */
// Declared as a `type`, not an `interface`, deliberately: this value is
// returned straight out of the `local_shell_run` MCP tool, whose output must
// satisfy a JSON index signature. TypeScript gives object *type aliases* an
// implicit index signature but never gives interfaces one, so an interface
// here fails to typecheck at the tool boundary.
export type LocalShellDispatchIdentity = {
  readonly clientId: string
  readonly label: string
  readonly platform: string
  /** Effective working directory: the request's `cwd` if it set one, else the client's. */
  readonly cwd: string
  readonly roots: ReadonlyArray<string>
  readonly fullAccess: boolean
  readonly sandbox: boolean
}

/** One addressable machine, as offered to the agent. */
export type LocalShellTarget = {
  readonly label: string
  readonly clientId: string
  readonly platform: string
  readonly cwd: string
  readonly roots: ReadonlyArray<string>
  readonly fullAccess: boolean
  readonly sandbox: boolean
}

/** A completed request plus the identity of the client that served it. */
export interface LocalShellRequestOutcome {
  readonly result: LocalShellResultFrame
  readonly dispatchedTo: LocalShellDispatchIdentity
}

export interface LocalShellRequestInput {
  readonly threadId: string
  readonly command: string
  readonly cwd?: string
  readonly timeoutMs: number
  /** Label of the machine to run on. Required when more than one is attached. */
  readonly target?: string
  /** Thread tags, used to refuse non-sandbox targets for unattended threads. */
  readonly threadTags?: ReadonlyArray<string>
}

interface PendingRequest {
  readonly threadId: string
  readonly clientId: string
  readonly dispatchedTo: LocalShellDispatchIdentity
  readonly resolve: (outcome: LocalShellRequestOutcome) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

export interface LocalShellBridge {
  /**
   * Register (or refresh) a client's capability. `connId` is the registering
   * connection's stable owner id; it is stored with the registration so the
   * connection finalizer's `removeClient` can prove it still owns the
   * registration it is tearing down.
   */
  readonly setCapability: (
    frame: LocalShellCapabilityFrame,
    send: SendLocalShellFrame,
    connId: string,
  ) => LocalShellStatusFrame
  /**
   * Drop a client on connection teardown. No-op unless `connId` matches the
   * CURRENT registration — a stale connection closing after a reconnect (same
   * clientId, newer connection already active) does not wipe the live
   * registration or reject the live connection's in-flight requests.
   */
  readonly removeClient: (clientId: string, connId: string) => void
  /** Every machine addressable from this thread, newest-per-label, deduped. */
  readonly listTargets: (
    threadTags?: ReadonlyArray<string>,
  ) => ReadonlyArray<LocalShellTarget>
  readonly request: (input: LocalShellRequestInput) => Promise<LocalShellRequestOutcome>
  /**
   * `fromClientId` is the identity the TRANSPORT vouches for (the connection's
   * registered client, or the sandbox's own id) — never a value read out of the
   * frame, which the sender authors and could forge.
   */
  readonly acceptResult: (
    frame: LocalShellResultFrame,
    fromClientId: string,
  ) => void
}

export const createLocalShellBridge = (): LocalShellBridge => {
  const clients = new Map<string, RegisteredClient>()
  const pending = new Map<string, PendingRequest>()
  let seq = 0

  const rejectPendingForClient = (clientId: string, message: string): void => {
    for (const [requestId, request] of pending) {
      if (request.clientId !== clientId) continue
      clearTimeout(request.timer)
      pending.delete(requestId)
      request.reject(new Error(message))
    }
  }

  /**
   * Clients this thread may address, before label dedup. Every registered
   * client serves every thread; the only filter is the unattended-origin gate.
   */
  const eligibleFor = (
    threadTags: ReadonlyArray<string> | undefined,
  ): ReadonlyArray<RegisteredClient> =>
    isUnattended(threadTags)
      ? [...clients.values()].filter((c) => c.capability.sandbox)
      : [...clients.values()]

  /** Newest live client per label — a reconnect or a second window never locks anyone out. */
  const dedupeByLabel = (
    list: ReadonlyArray<RegisteredClient>,
  ): ReadonlyArray<RegisteredClient> => {
    const best = new Map<string, RegisteredClient>()
    for (const c of list) {
      const prev = best.get(c.capability.label)
      if (prev === undefined || c.seq > prev.seq) best.set(c.capability.label, c)
    }
    return [...best.values()].sort((a, b) =>
      a.capability.label.localeCompare(b.capability.label),
    )
  }

  const toTarget = (c: RegisteredClient): LocalShellTarget => ({
    label: c.capability.label,
    clientId: c.capability.clientId,
    platform: c.capability.platform,
    cwd: c.capability.cwd,
    roots: c.capability.roots,
    fullAccess: c.capability.fullAccess,
    sandbox: c.capability.sandbox,
  })

  const listTargets = (
    threadTags?: ReadonlyArray<string>,
  ): ReadonlyArray<LocalShellTarget> =>
    dedupeByLabel(eligibleFor(threadTags)).map(toTarget)

  const setCapability = (
    frame: LocalShellCapabilityFrame,
    send: SendLocalShellFrame,
    connId: string,
  ): LocalShellStatusFrame => {
    const base = {
      type: "local-shell-status" as const,
      clientId: frame.clientId,
    }

    if (!frame.enabled) {
      if (clients.delete(frame.clientId)) {
        rejectPendingForClient(
          frame.clientId,
          `local shell disabled for ${frame.clientId}`,
        )
      }
      return { ...base, enabled: false, accepted: true, message: "local shell disabled" }
    }

    // Coexistence: registering never displaces anyone. Re-registering the same
    // clientId refreshes its scope in place. This is the change that retires
    // the old preempt-and-reattach handoff entirely.
    seq += 1
    clients.set(frame.clientId, { capability: frame, send, seq, connId })

    return { ...base, enabled: true, accepted: true, message: "local shell enabled" }
  }

  const removeClient = (clientId: string, connId: string): void => {
    const cur = clients.get(clientId)
    // Only the CURRENT registration's own connection may remove it. A stale
    // connection closing after a reconnect (newer conn already active for the
    // same clientId) is a no-op — it must not wipe the live registration or
    // reject the live connection's in-flight requests.
    if (cur === undefined || cur.connId !== connId) return
    clients.delete(clientId)
    rejectPendingForClient(clientId, `local shell client removed: ${clientId}`)
  }

  const resolve = (input: LocalShellRequestInput): RegisteredClient => {
    const targets = dedupeByLabel(eligibleFor(input.threadTags))

    if (input.target !== undefined) {
      const want = input.target.trim().toLowerCase()
      const hit = targets.find(
        (c) => c.capability.label.toLowerCase() === want,
      )
      if (hit === undefined) {
        const names =
          targets.map((c) => c.capability.label).join(", ") || "(none)"
        // Never fall back to "some other machine": running a command somewhere
        // the caller did not name is the failure this whole design removes.
        throw new Error(
          `local shell target "${input.target}" is not attached to ${input.threadId}. Attached: ${names}`,
        )
      }
      return hit
    }

    if (targets.length === 0) {
      throw new Error(`local shell unavailable for ${input.threadId}`)
    }
    if (targets.length > 1) {
      const names = targets.map((c) => c.capability.label).join(", ")
      // No implicit default. Every candidate default rule is either the silent
      // reassignment this design removes or a foot-gun for a cwd-less command.
      throw new Error(
        `local shell has ${targets.length} targets attached (${names}); pass "target" to choose one`,
      )
    }
    return targets[0] as RegisteredClient
  }

  const request = (
    input: LocalShellRequestInput,
  ): Promise<LocalShellRequestOutcome> => {
    let client: RegisteredClient
    try {
      client = resolve(input)
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)))
    }

    const dispatchedTo: LocalShellDispatchIdentity = {
      clientId: client.capability.clientId,
      label: client.capability.label,
      platform: client.capability.platform,
      cwd: input.cwd ?? client.capability.cwd,
      roots: client.capability.roots,
      fullAccess: client.capability.fullAccess,
      sandbox: client.capability.sandbox,
    }

    const requestId = `lsh_${randomUUID()}`

    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        pending.delete(requestId)
        rej(new Error(`local shell request timed out: ${requestId}`))
      }, input.timeoutMs)

      pending.set(requestId, {
        threadId: input.threadId,
        clientId: client.capability.clientId,
        dispatchedTo,
        resolve: res,
        reject: rej,
        timer,
      })

      client.send({
        type: "local-shell-request",
        requestId,
        threadId: input.threadId,
        command: input.command,
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        timeoutMs: input.timeoutMs,
        ...(input.threadTags !== undefined ? { threadTags: input.threadTags } : {}),
      })
    })
  }

  const acceptResult = (
    frame: LocalShellResultFrame,
    fromClientId: string,
  ): void => {
    const entry = pending.get(frame.requestId)
    if (!entry) return
    if (entry.threadId !== frame.threadId) return
    // With several clients attached, any of them could otherwise answer another
    // client's pending request. The transport's identity is the authority.
    if (fromClientId !== entry.clientId) return

    clearTimeout(entry.timer)
    pending.delete(frame.requestId)
    entry.resolve({ result: frame, dispatchedTo: entry.dispatchedTo })
  }

  return { setCapability, removeClient, listTargets, request, acceptResult }
}
