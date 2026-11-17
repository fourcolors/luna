import { describe, expect, it } from "vitest"
import WebSocket from "ws"
import { startHermesStub } from "../src/dev/hermes-stub.js"
import { startLunaStub } from "../src/dev/luna-stub.js"

const timeout = (ms: number) =>
  new Promise<"TIMEOUT">((r) => setTimeout(() => r("TIMEOUT"), ms))

describe("dev stubs stop()", () => {
  it("luna: stop() resolves promptly with a live client connected", async () => {
    const stub = await startLunaStub()
    const ws = new WebSocket(`${stub.url}?token=test-luna-token`)
    await new Promise<void>((res, rej) => {
      ws.on("open", () => res())
      ws.on("error", rej)
    })
    const stopping = stub.stop()
    try {
      // Pre-fix this hangs forever: httpServer.close() waits for the live
      // connection. Race it so the failure is a fast assertion, not a hang.
      await expect(Promise.race([stopping, timeout(2000)])).resolves.toBeUndefined()
    } finally {
      ws.terminate()
      await Promise.race([stopping, timeout(2000)])
    }
  })

  it("luna: stop() is idempotent (sequential and concurrent)", async () => {
    const stub = await startLunaStub()
    await expect(stub.stop()).resolves.toBeUndefined()
    await expect(stub.stop()).resolves.toBeUndefined()
    const stub2 = await startLunaStub()
    await expect(Promise.all([stub2.stop(), stub2.stop()])).resolves.toEqual([
      undefined,
      undefined,
    ])
  })

  it("hermes: stop() is idempotent (sequential and concurrent)", async () => {
    const stub = await startHermesStub()
    await expect(stub.stop()).resolves.toBeUndefined()
    await expect(stub.stop()).resolves.toBeUndefined()
    const stub2 = await startHermesStub()
    await expect(Promise.all([stub2.stop(), stub2.stop()])).resolves.toEqual([
      undefined,
      undefined,
    ])
  })
})
