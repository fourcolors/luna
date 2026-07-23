/**
 * Unit tests for the SecretRequestBridge — the security-critical core of
 * agent-summoned secure secret entry. Focus: the secret value is contained and
 * never returned/logged; the request/await/persist/status flow; the
 * connection-ownership guard (a stale connection can't clobber a live one); the
 * deferred-activation arming; and the defensive normalization that prevents a
 * malformed persist result from hanging the awaiting turn.
 */
import { describe, expect, it, vi } from "vitest"
import {
  createSecretRequestBridge,
  type SecretRequestBridge,
  type SecretRequestBridgeDeps,
  type SecretStoreResult,
} from "../src/secret-request-bridge.js"
import type { SecretRequestFrame, SecretStatusFrame } from "../src/protocol.js"

const TIMEOUT = 60_000
const DEST = { kind: "op-token", label: "primary" } as const

interface Harness {
  bridge: SecretRequestBridge
  sent: Array<SecretRequestFrame | SecretStatusFrame>
  persist: ReturnType<typeof vi.fn>
  activate: ReturnType<typeof vi.fn>
  logs: string[]
}

const make = (over: Partial<SecretRequestBridgeDeps> = {}): Harness => {
  const sent: Array<SecretRequestFrame | SecretStatusFrame> = []
  const persist = vi.fn(
    async (_d: unknown, _s: string): Promise<SecretStoreResult> => ({
      ok: true,
      message: "stored",
    }),
  )
  const activate = vi.fn(() => {})
  const logs: string[] = []
  const deps: SecretRequestBridgeDeps = {
    persistSecret: persist,
    scheduleActivation: activate,
    log: (m) => logs.push(m),
    ...over,
  }
  return { bridge: createSecretRequestBridge(deps), sent, persist, activate, logs }
}

/** Register a client and return its captured-send array. */
const wire = (h: Harness, threadId: string, connId: string): void => {
  h.bridge.registerClient(threadId, connId, (f) => h.sent.push(f))
}

const lastRequestId = (h: Harness): string => {
  const f = h.sent.find((x) => x.type === "secret-request") as
    | SecretRequestFrame
    | undefined
  if (!f) throw new Error("no secret-request frame sent")
  return f.requestId
}

describe("SecretRequestBridge — happy path", () => {
  it("sends a secret-request, stores the value, acks ok, resolves {ok}, arms activation", async () => {
    const h = make()
    wire(h, "T1", "connA")
    const p = h.bridge.request({
      threadId: "T1",
      destination: DEST,
      prompt: "Paste token",
      destinationLabel: "1Password token for primary",
      timeoutMs: TIMEOUT,
    })
    // request frame went out (with prompt + label, NO secret field)
    const reqFrame = h.sent[0] as SecretRequestFrame
    expect(reqFrame.type).toBe("secret-request")
    expect(reqFrame.threadId).toBe("T1")
    expect(reqFrame.prompt).toBe("Paste token")
    expect(reqFrame.destinationLabel).toBe("1Password token for primary")
    expect((reqFrame as Record<string, unknown>).secret).toBeUndefined()

    h.bridge.acceptResult({
      type: "secret-result",
      requestId: reqFrame.requestId,
      secret: "ops_realtoken",
    })
    const res = await p
    expect(res.ok).toBe(true)
    expect(h.persist).toHaveBeenCalledWith(DEST, "ops_realtoken")
    // status ack sent, ok, and NEVER carries the secret
    const status = h.sent.find((f) => f.type === "secret-status") as SecretStatusFrame
    expect(status.ok).toBe(true)
    expect(JSON.stringify(h.sent)).not.toContain("ops_realtoken")
    // the resolved result carries no secret either
    expect(JSON.stringify(res)).not.toContain("ops_realtoken")
    // activation armed → fires on turn-complete
    expect(h.activate).not.toHaveBeenCalled()
    h.bridge.notifyTurnComplete("T1")
    expect(h.activate).toHaveBeenCalledTimes(1)
  })

  it("never logs the secret value", async () => {
    const h = make()
    wire(h, "T1", "connA")
    const p = h.bridge.request({
      threadId: "T1",
      destination: DEST,
      prompt: "x",
      destinationLabel: "y",
      timeoutMs: TIMEOUT,
    })
    h.bridge.acceptResult({ type: "secret-result", requestId: lastRequestId(h), secret: "SUPER_SECRET" })
    await p
    for (const line of h.logs) expect(line).not.toContain("SUPER_SECRET")
  })
})

describe("SecretRequestBridge — cancel / no client / failure", () => {
  it("resolves {ok:false} without persisting when there is no client", async () => {
    const h = make()
    const res = await h.bridge.request({
      threadId: "T-none",
      destination: DEST,
      prompt: "x",
      destinationLabel: "y",
      timeoutMs: TIMEOUT,
    })
    expect(res.ok).toBe(false)
    expect(h.persist).not.toHaveBeenCalled()
  })

  it("resolves {ok:false} and does not persist when cancelled", async () => {
    const h = make()
    wire(h, "T1", "connA")
    const p = h.bridge.request({
      threadId: "T1",
      destination: DEST,
      prompt: "x",
      destinationLabel: "y",
      timeoutMs: TIMEOUT,
    })
    h.bridge.acceptResult({ type: "secret-result", requestId: lastRequestId(h), cancelled: true })
    const res = await p
    expect(res.ok).toBe(false)
    expect(h.persist).not.toHaveBeenCalled()
    expect(h.activate).not.toHaveBeenCalled()
  })

  it("does not arm activation when the store fails", async () => {
    const h = make({
      persistSecret: async () => ({ ok: false, message: "rejected" }),
    })
    wire(h, "T1", "connA")
    const p = h.bridge.request({
      threadId: "T1",
      destination: DEST,
      prompt: "x",
      destinationLabel: "y",
      timeoutMs: TIMEOUT,
    })
    h.bridge.acceptResult({ type: "secret-result", requestId: lastRequestId(h), secret: "v" })
    const res = await p
    expect(res.ok).toBe(false)
    h.bridge.notifyTurnComplete("T1")
    expect(h.activate).not.toHaveBeenCalled()
  })

  it("normalizes a malformed (undefined) persist result instead of hanging the turn", async () => {
    const h = make({
      // a defective dep that resolves undefined (e.g. a future non-exhaustive store)
      persistSecret: (async () => undefined) as unknown as SecretRequestBridgeDeps["persistSecret"],
    })
    wire(h, "T1", "connA")
    const p = h.bridge.request({
      threadId: "T1",
      destination: DEST,
      prompt: "x",
      destinationLabel: "y",
      timeoutMs: TIMEOUT,
    })
    h.bridge.acceptResult({ type: "secret-result", requestId: lastRequestId(h), secret: "v" })
    const res = await p // must settle, not hang
    expect(res.ok).toBe(false)
  })
})

describe("SecretRequestBridge — connection ownership (clobber guard)", () => {
  it("a stale connection's unregister does NOT wipe a newer connection's registration", async () => {
    const h = make()
    wire(h, "T1", "connA") // first connection
    wire(h, "T1", "connB") // reconnect — newer connection now owns T1
    // stale A closes and tries to unregister T1
    h.bridge.unregisterClient("T1", "connA")
    // T1 is still registered (to B) → request succeeds
    const p = h.bridge.request({
      threadId: "T1",
      destination: DEST,
      prompt: "x",
      destinationLabel: "y",
      timeoutMs: TIMEOUT,
    })
    h.bridge.acceptResult({ type: "secret-result", requestId: lastRequestId(h), secret: "v" })
    const res = await p
    expect(res.ok).toBe(true)
  })

  it("the owning connection's unregister DOES drop the registration", async () => {
    const h = make()
    wire(h, "T1", "connA")
    h.bridge.unregisterClient("T1", "connA")
    const res = await h.bridge.request({
      threadId: "T1",
      destination: DEST,
      prompt: "x",
      destinationLabel: "y",
      timeoutMs: TIMEOUT,
    })
    expect(res.ok).toBe(false) // no client
  })

  it("unregister rejects an in-flight request for the owning connection", async () => {
    const h = make()
    wire(h, "T1", "connA")
    const p = h.bridge.request({
      threadId: "T1",
      destination: DEST,
      prompt: "x",
      destinationLabel: "y",
      timeoutMs: TIMEOUT,
    })
    h.bridge.unregisterClient("T1", "connA")
    const res = await p
    expect(res.ok).toBe(false)
  })
})
