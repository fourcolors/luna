/**
 * SecretRequestBridge — the server-side half of agent-summoned secure secret
 * entry. The chat agent's `request_secret` tool calls `request()`, which sends
 * a `secret-request` frame to the connected Moon client and AWAITS the
 * operator's `secret-result`. This suspends the model turn (the tool's Promise
 * is unresolved) until the operator types the value or cancels — the same
 * pause-resume shape as the local-shell bridge.
 *
 * SECURITY — the secret value is contained here and NOWHERE else:
 *   - It arrives on `acceptResult(frame)`, is handed straight to the injected
 *     `persistSecret(destination, secret)`, and is never returned to the caller
 *     (the tool only ever receives `{ok, message}`), never logged, and never
 *     placed in any frame sent back to the client.
 *   - `destination` is OPAQUE to this package: the chat-server owns what a
 *     destination means and how to store it. ui-ws stays decoupled from secret
 *     storage. Only a human `destinationLabel` crosses the wire (for consent).
 *
 * ACTIVATION — a stored secret is not live until the server re-runs token
 * discovery / account-broker hydration, which happen at boot. So on a
 * successful store we DEFER `scheduleActivation()` (a graceful restart) until
 * the requesting thread's turn completes (`notifyTurnComplete`), so we never
 * kill the very turn that called the tool. A long fallback timer covers the
 * pathological case where a turn-complete never arrives (e.g. the connection
 * drops mid-turn); it is `unref`'d so it never keeps the process alive.
 *
 * SCOPE OF THE TURN-SAFETY GUARANTEE: the deferral protects ONLY the thread
 * that stored the secret. `scheduleActivation` is a process-wide graceful
 * restart, so any OTHER turn in flight at that moment — a parallel chat, the
 * nightly Dream cron, the wake-reasoner — is interrupted. That is the same
 * blast radius as the Settings `register-op-token` restart, and it is
 * acceptable here: the restart is graceful (finalizers run), the operator's own
 * secret is persisted BEFORE activation arms (so it is never the victim), and
 * interrupted background work is recoverable (chat retries; crons re-fire on
 * schedule). We do NOT gate on global quiescence in v1.
 */
import { randomUUID } from "node:crypto"
import type {
  SecretRequestFrame,
  SecretResultFrame,
  SecretStatusFrame,
} from "./protocol.js"

export type SendSecretFrame = (
  frame: SecretRequestFrame | SecretStatusFrame,
) => void

/** Outcome of storing a captured secret. NEVER carries the secret value. */
export interface SecretStoreResult {
  readonly ok: boolean
  readonly message: string
}

export interface SecretRequestBridgeDeps {
  /**
   * Persist a captured secret to its destination. `destination` is opaque to
   * this package; `secret` is the SENSITIVE value the operator typed. Returns
   * ok/message and MUST never echo the secret. Should not throw (catch
   * internally → `{ok:false}`); a throw is still guarded here defensively.
   */
  readonly persistSecret: (
    destination: unknown,
    secret: string,
  ) => Promise<SecretStoreResult>
  /**
   * Fire a deferred server activation (real impl: graceful restart so token
   * discovery + account-broker hydration re-run with the stored secret). Called
   * at most once per armed thread, AFTER its turn completes (or the fallback).
   */
  readonly scheduleActivation: () => void
  /** Optional non-sensitive audit logger (label/thread only — never the secret). */
  readonly log?: (message: string) => void
}

export interface SecretRequestInput {
  readonly threadId: string
  /** Opaque destination descriptor — passed through verbatim to `persistSecret`. */
  readonly destination: unknown
  /** Human prompt shown above the secure field. */
  readonly prompt: string
  /** Human-readable destination shown for operator consent. */
  readonly destinationLabel: string
  /** Wall-clock the operator has to respond before the request resolves failed. */
  readonly timeoutMs: number
}

export interface SecretRequestBridge {
  /**
   * Register (or replace) the client send-handle for a thread (subscribe-time).
   * `connId` is a stable per-connection id so a later `unregisterClient` from a
   * STALE connection can't clobber a newer connection's registration.
   */
  readonly registerClient: (
    threadId: string,
    connId: string,
    send: SendSecretFrame,
  ) => void
  /**
   * Drop a thread's client on connection teardown. No-op unless `connId` matches
   * the CURRENT registration — so a stale connection closing after a reconnect
   * (same threadId, newer connection already active) does not wipe the live
   * registration or reject the live connection's in-flight requests.
   */
  readonly unregisterClient: (threadId: string, connId: string) => void
  /** Summon a secure field, await the value, store it, return only `{ok,message}`. */
  readonly request: (input: SecretRequestInput) => Promise<SecretStoreResult>
  /** Inbound `secret-result` from the client — resolves the pending request. */
  readonly acceptResult: (frame: SecretResultFrame) => void
  /** A thread's turn ended — fire any deferred activation armed for it. */
  readonly notifyTurnComplete: (threadId: string) => void
}

interface PendingRequest {
  readonly threadId: string
  readonly destination: unknown
  readonly send: SendSecretFrame
  readonly resolve: (r: SecretStoreResult) => void
  readonly timer: ReturnType<typeof setTimeout>
}

/**
 * Safety net only: if a turn-complete never arrives for a thread that stored a
 * secret, activate anyway after this long. Deliberately long so it never clips
 * a turn that legitimately keeps working after the store; turn-complete is the
 * normal trigger and fires at the end of every turn.
 */
const ACTIVATION_FALLBACK_MS = 600_000

export const createSecretRequestBridge = (
  deps: SecretRequestBridgeDeps,
): SecretRequestBridge => {
  const clients = new Map<string, { connId: string; send: SendSecretFrame }>()
  const pending = new Map<string, PendingRequest>()
  /** threadId → fallback timer; presence means "activation armed, not yet fired". */
  const activationArmed = new Map<string, ReturnType<typeof setTimeout>>()

  const registerClient = (
    threadId: string,
    connId: string,
    send: SendSecretFrame,
  ): void => {
    clients.set(threadId, { connId, send })
  }

  const unregisterClient = (threadId: string, connId: string): void => {
    const cur = clients.get(threadId)
    // Only the CURRENT registration's own connection may unregister it. A stale
    // connection closing after a reconnect (newer conn already active for the
    // same thread) is a no-op — it must not wipe the live registration.
    if (cur === undefined || cur.connId !== connId) return
    clients.delete(threadId)
    for (const [requestId, p] of pending) {
      if (p.threadId !== threadId) continue
      clearTimeout(p.timer)
      pending.delete(requestId)
      p.resolve({
        ok: false,
        message: "Secure input cancelled (client disconnected).",
      })
    }
  }

  const armActivation = (threadId: string): void => {
    if (activationArmed.has(threadId)) return // keep the earliest arming
    const fallback = setTimeout(() => {
      activationArmed.delete(threadId)
      deps.scheduleActivation()
    }, ACTIVATION_FALLBACK_MS)
    if (typeof fallback.unref === "function") fallback.unref()
    activationArmed.set(threadId, fallback)
  }

  const notifyTurnComplete = (threadId: string): void => {
    const timer = activationArmed.get(threadId)
    if (timer === undefined) return
    clearTimeout(timer)
    activationArmed.delete(threadId)
    deps.scheduleActivation()
  }

  const request = (input: SecretRequestInput): Promise<SecretStoreResult> => {
    const client = clients.get(input.threadId)
    if (client === undefined) {
      return Promise.resolve({
        ok: false,
        message:
          "No connected Moon client to enter the secret. Open this thread in Moon and try again.",
      })
    }
    const send = client.send

    const requestId = `sec_${randomUUID()}`
    return new Promise<SecretStoreResult>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(requestId)
        send({
          type: "secret-status",
          requestId,
          ok: false,
          message: "Timed out waiting for input.",
        })
        resolve({
          ok: false,
          message: "Timed out waiting for the operator to enter the secret.",
        })
      }, input.timeoutMs)

      pending.set(requestId, {
        threadId: input.threadId,
        destination: input.destination,
        send,
        resolve,
        timer,
      })

      send({
        type: "secret-request",
        requestId,
        // #362: consumers (Studio native banners) need the summoning thread
        // for focus-regain routing; delivery still uses the thread-keyed client map.
        threadId: input.threadId,
        prompt: input.prompt,
        destinationLabel: input.destinationLabel,
      })
    })
  }

  const acceptResult = (frame: SecretResultFrame): void => {
    const entry = pending.get(frame.requestId)
    if (entry === undefined) return
    clearTimeout(entry.timer)
    pending.delete(frame.requestId)

    if (
      frame.cancelled === true ||
      typeof frame.secret !== "string" ||
      frame.secret.length === 0
    ) {
      entry.send({
        type: "secret-status",
        requestId: frame.requestId,
        ok: false,
        message: "Cancelled.",
      })
      entry.resolve({
        ok: false,
        message: "The operator cancelled the secure input.",
      })
      return
    }

    // The secret VALUE lives only in this closure → persistSecret. It is never
    // logged, returned to the tool, or echoed in a status frame.
    void Promise.resolve(deps.persistSecret(entry.destination, frame.secret))
      .catch(
        (): SecretStoreResult => ({
          ok: false,
          message: "Failed to store the secret on the server.",
        }),
      )
      .then((raw) => {
        // Normalize defensively: a dep that resolves a non-{ok,message} value
        // (e.g. `undefined` from a future non-exhaustive store) must NOT throw
        // here — that would skip `entry.resolve` and hang the awaiting turn.
        const result: SecretStoreResult =
          raw !== null &&
          typeof raw === "object" &&
          typeof (raw as SecretStoreResult).ok === "boolean"
            ? (raw as SecretStoreResult)
            : {
                ok: false,
                message: "The secret could not be stored (unexpected store result).",
              }
        entry.send({
          type: "secret-status",
          requestId: frame.requestId,
          ok: result.ok,
          message: result.message,
        })
        if (result.ok) {
          deps.log?.(
            `[secret] stored for thread ${entry.threadId}; activation deferred to turn end`,
          )
          armActivation(entry.threadId)
        }
        entry.resolve(result)
      })
  }

  return {
    registerClient,
    unregisterClient,
    request,
    acceptResult,
    notifyTurnComplete,
  }
}
