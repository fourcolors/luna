import { describe, it, expect, beforeEach } from "vitest"
import { FakeWebSocket } from "./helpers/FakeWebSocket"

describe("FakeWebSocket.simulateFlap", () => {
  beforeEach(() => {
    FakeWebSocket.reset()
  })

  it("throws when the engine never reconnects after a drop", () => {
    new FakeWebSocket("ws://test")
    expect(() =>
      FakeWebSocket.simulateFlap(3, { advance: () => {} }),
    ).toThrow(/did not reconnect/)
    expect(FakeWebSocket.instances.length).toBe(1)
  })

  it("throws when no socket exists at all", () => {
    expect(() =>
      FakeWebSocket.simulateFlap(1, { advance: () => {} }),
    ).toThrow(/no socket instance/)
  })

  it("completes when each advance produces a fresh socket", () => {
    new FakeWebSocket("ws://test")
    FakeWebSocket.simulateFlap(3, {
      advance: () => {
        new FakeWebSocket("ws://test")
      },
    })
    expect(FakeWebSocket.instances.length).toBe(4)
  })
})

describe("FakeWebSocket.simulateOpen", () => {
  it("is a no-op on an already-OPEN socket (no second 'open' event)", () => {
    const sock = new FakeWebSocket("ws://test")
    let opens = 0
    sock.addEventListener("open", () => opens++)
    sock.simulateOpen()
    sock.simulateOpen()
    expect(sock.readyState).toBe(FakeWebSocket.OPEN)
    expect(opens).toBe(1)
  })

  it("throws on a dropped (CLOSED) socket instead of resurrecting it", () => {
    const sock = new FakeWebSocket("ws://test")
    let opens = 0
    sock.addEventListener("open", () => opens++)
    sock.simulateOpen()
    sock.simulateDrop()
    expect(() => sock.simulateOpen()).toThrow(/not CONNECTING/)
    expect(sock.readyState).toBe(FakeWebSocket.CLOSED)
    expect(opens).toBe(1)
  })

  it("throws on a client-closed (CLOSED) socket instead of resurrecting it", () => {
    const sock = new FakeWebSocket("ws://test")
    sock.simulateOpen()
    sock.close()
    expect(() => sock.simulateOpen()).toThrow(/not CONNECTING/)
    expect(sock.readyState).toBe(FakeWebSocket.CLOSED)
  })
})
