import { describe, expect, it, vi } from "vitest"
import type { ClientFrame, ServerFrame } from "@luna/ui-shared/core"
import type { ConnectionState } from "@luna/ui-transport/browser"
import { createReconnectingLunaTransport, type StudioLunaAdapter } from "./reconnecting-transport"

class FakeAdapter implements StudioLunaAdapter {
  frameListener: ((frame: ServerFrame) => void) | null = null
  stateListener: ((state: ConnectionState) => void) | null = null
  sent: unknown[] = []
  disposed = false

  subscribeFrames(listener: (frame: ServerFrame) => void) {
    this.frameListener = listener
    return () => { this.frameListener = null }
  }

  subscribeConnection(listener: (state: ConnectionState) => void) {
    this.stateListener = listener
    return () => { this.stateListener = null }
  }

  async attach() {
    this.stateListener?.({ status: "connecting" })
    this.stateListener?.({ status: "ready" })
  }

  sendFrame(frame: unknown) { this.sent.push(frame) }
  async dispose() { this.disposed = true }
}

describe("Studio reconnecting transport bridge", () => {
  it("uses the reconnecting adapter and maps recovery back to app status", async () => {
    const adapter = new FakeAdapter()
    const makeAdapter = vi.fn(() => adapter)
    const statuses: string[] = []
    const frames: ServerFrame[] = []
    const transport = createReconnectingLunaTransport(makeAdapter)
    const handle = transport.connect({
      url: "ws://127.0.0.1:4753/ui",
      token: "1234567890abcdef",
      onFrame: (frame) => frames.push(frame),
      onStatus: (status) => statuses.push(status.kind),
    })

    await vi.waitFor(() => expect(statuses).toContain("open"))
    expect(makeAdapter).toHaveBeenCalledWith({
      routeKey: "studio",
      endpoints: ["ws://127.0.0.1:4753/ui"],
      tokenRef: "1234567890abcdef",
    })

    adapter.stateListener?.({ status: "recovering", reason: "server restart" })
    adapter.stateListener?.({ status: "ready" })
    expect(statuses.slice(-2)).toEqual(["connecting", "open"])

    adapter.frameListener?.({ type: "ping", ts: "heartbeat" })
    expect(adapter.sent).toEqual([{ type: "pong", ts: "heartbeat" }])

    const pong = { type: "pong", ts: "now" } as ClientFrame
    handle.send(pong)
    expect(adapter.sent).toEqual([{ type: "pong", ts: "heartbeat" }, pong])

    handle.disconnect()
    await vi.waitFor(() => expect(adapter.disposed).toBe(true))
  })

  it("buffers frames sent before ready and flushes them on open", async () => {
    const adapter = new FakeAdapter()
    let releaseAttach: () => void = () => {}
    adapter.attach = async () => {
      adapter.stateListener?.({ status: "connecting" })
      await new Promise<void>((resolve) => { releaseAttach = resolve })
      adapter.stateListener?.({ status: "ready" })
    }
    const statuses: string[] = []
    const transport = createReconnectingLunaTransport(() => adapter)
    const handle = transport.connect({
      url: "ws://127.0.0.1:4753/ui",
      token: "1234567890abcdef",
      onFrame: () => {},
      onStatus: (status) => statuses.push(status.kind),
    })

    const early = { type: "list-threads" } as ClientFrame
    handle.send(early)
    expect(adapter.sent).toEqual([])

    releaseAttach()
    await vi.waitFor(() => expect(statuses).toContain("open"))
    expect(adapter.sent).toEqual([early])

    handle.disconnect()
  })

  it("buffers frames during transparent recovery and flushes on re-open", async () => {
    const adapter = new FakeAdapter()
    const statuses: string[] = []
    const transport = createReconnectingLunaTransport(() => adapter)
    const handle = transport.connect({
      url: "ws://127.0.0.1:4753/ui",
      token: "1234567890abcdef",
      onFrame: () => {},
      onStatus: (status) => statuses.push(status.kind),
    })
    await vi.waitFor(() => expect(statuses).toContain("open"))

    adapter.stateListener?.({ status: "recovering", reason: "server restart" })
    const midRecovery = { type: "list-threads" } as ClientFrame
    handle.send(midRecovery)
    expect(adapter.sent).toEqual([])

    adapter.stateListener?.({ status: "ready" })
    expect(adapter.sent).toEqual([midRecovery])

    handle.disconnect()
  })

  it("treats auth failure as terminal: disposes the adapter so unbounded retry can't hammer a rejected token", async () => {
    const adapter = new FakeAdapter()
    const statuses: string[] = []
    const transport = createReconnectingLunaTransport(() => adapter)
    const handle = transport.connect({
      url: "ws://127.0.0.1:4753/ui",
      token: "1234567890abcdef",
      onFrame: () => {},
      onStatus: (status) => statuses.push(status.kind),
    })
    await vi.waitFor(() => expect(statuses).toContain("open"))

    // Server rejects the credential mid-session (1008 -> auth-failed).
    adapter.stateListener?.({ status: "auth-failed", reason: "authentication failed" })
    // Surfaced as a terminal closed status (drives the Reconnect prompt)...
    expect(statuses.at(-1)).toBe("closed")
    // ...and the adapter is disposed so its unbounded reconnect loop stops.
    await vi.waitFor(() => expect(adapter.disposed).toBe(true))

    // Any later state the adapter might still emit is ignored (terminal).
    statuses.length = 0
    adapter.stateListener?.({ status: "recovering" })
    expect(statuses).toEqual([])

    handle.disconnect()
  })
})
