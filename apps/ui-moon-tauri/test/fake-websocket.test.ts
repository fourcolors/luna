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
