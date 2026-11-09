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

describe("FakeWebSocket on* property handlers", () => {
  beforeEach(() => {
    FakeWebSocket.reset()
  })

  it("delivers open/message/close/error to assigned on* handlers", () => {
    const sock = new FakeWebSocket("ws://test")
    const seen: string[] = []
    sock.onopen = () => seen.push("open")
    sock.onmessage = (evt: any) => seen.push(`message:${JSON.parse(evt.data).type}`)
    sock.onclose = () => seen.push("close")
    sock.onerror = () => seen.push("error")
    sock.simulateOpen()
    sock.simulateMessage({ type: "hello" })
    sock.simulateError()
    sock.simulateDrop()
    expect(seen).toEqual(["open", "message:hello", "error", "close"])
  })

  it("assigning null clears the on* handler", () => {
    const sock = new FakeWebSocket("ws://test")
    let calls = 0
    sock.onmessage = () => calls++
    sock.onmessage = null
    sock.simulateOpen()
    sock.simulateMessage({ type: "hello" })
    expect(calls).toBe(0)
  })

  it("fires both the on* handler and addEventListener listeners, once each", () => {
    const sock = new FakeWebSocket("ws://test")
    let propCalls = 0
    let listenerCalls = 0
    sock.onmessage = () => propCalls++
    sock.addEventListener("message", () => listenerCalls++)
    sock.simulateOpen()
    sock.simulateMessage({ type: "hello" })
    expect(propCalls).toBe(1)
    expect(listenerCalls).toBe(1)
  })

  it("binds `this` to the socket inside on* handlers and listeners", () => {
    const sock = new FakeWebSocket("ws://test")
    const seen: unknown[] = []
    sock.onmessage = function (this: any) {
      seen.push(this)
    }
    sock.addEventListener("message", function (this: any) {
      seen.push(this)
    })
    sock.simulateOpen()
    sock.simulateMessage({ type: "hello" })
    // A browser binds `this` to the socket for both halves; a bare call
    // in a strict-mode module would leave it `undefined` instead.
    expect(seen).toEqual([sock, sock])
  })

  it("does not fire an on* handler assigned mid-dispatch for that same event", () => {
    const sock = new FakeWebSocket("ws://test")
    let propCalls = 0
    sock.addEventListener("message", () => {
      sock.onmessage = () => propCalls++
    })
    sock.simulateOpen()
    sock.simulateMessage({ type: "hello" })
    expect(propCalls).toBe(0)
    sock.simulateMessage({ type: "hello" })
    expect(propCalls).toBe(1)
  })
})
