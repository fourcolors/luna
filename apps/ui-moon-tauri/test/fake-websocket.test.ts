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

describe("FakeWebSocket.simulateMessage readyState gate", () => {
  beforeEach(() => {
    FakeWebSocket.reset()
  })

  it("throws while CONNECTING (a real socket never delivers before open)", () => {
    const sock = new FakeWebSocket("ws://test")
    expect(() => sock.simulateMessage({ type: "hello" })).toThrow(/not OPEN/)
    expect(() => sock.injectServerMessage({ type: "hello" })).toThrow(/not OPEN/)
  })

  it("throws after close (a real socket never delivers after close)", () => {
    const sock = new FakeWebSocket("ws://test")
    sock.simulateOpen()
    sock.simulateDrop()
    expect(() => sock.simulateMessage({ type: "hello" })).toThrow(/not OPEN/)
  })

  it("delivers after simulateOpen", () => {
    const sock = new FakeWebSocket("ws://test")
    const seen: any[] = []
    sock.addEventListener("message", (evt) => seen.push(evt))
    sock.simulateOpen()
    sock.simulateMessage({ type: "hello" })
    expect(seen).toHaveLength(1)
    expect(JSON.parse(seen[0].data)).toEqual({ type: "hello" })
  })
})

describe("FakeWebSocket.close wasClean", () => {
  beforeEach(() => {
    FakeWebSocket.reset()
  })

  it("fires wasClean:false when closing from CONNECTING (failed connection, never clean)", () => {
    const sock = new FakeWebSocket("ws://test")
    const seen: any[] = []
    sock.addEventListener("close", (evt) => seen.push(evt))
    sock.close()
    expect(seen).toHaveLength(1)
    expect(seen[0].wasClean).toBe(false)
  })

  it("keeps wasClean:true for a code-1000 close from OPEN", () => {
    const sock = new FakeWebSocket("ws://test")
    const seen: any[] = []
    sock.addEventListener("close", (evt) => seen.push(evt))
    sock.simulateOpen()
    sock.close()
    expect(seen[0].wasClean).toBe(true)
  })

  it("fires wasClean:false for an abnormal close code from OPEN", () => {
    const sock = new FakeWebSocket("ws://test")
    const seen: any[] = []
    sock.addEventListener("close", (evt) => seen.push(evt))
    sock.simulateOpen()
    sock.close(1006, "abnormal")
    expect(seen[0].wasClean).toBe(false)
  })
})
