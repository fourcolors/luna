/**
 * Regression test: malformed `pty-input` / `pty-resize` setup frames must be
 * rejected before touching the pty.
 *
 * Inbound frames are JSON.parse'd and cast to ClientFrame with only `type`
 * checked, so every field is attacker-controlled JSON. Before the guard:
 * - `pty-input` with a non-string `data` threw a TypeError inside
 *   `Buffer.from(frame.data, "base64")` (fiber defect, log-only), while a
 *   byte-array `data` (e.g. [104,105]) was silently decoded and written to
 *   the pty's stdin;
 * - `pty-resize` forwarded unvalidated `cols`/`rows` straight to the pty.
 *
 * These tests pin the guard: malformed frames never reach write()/resize(),
 * the connection stays healthy afterwards, and well-formed frames still work.
 */
import { afterEach, describe, expect, it } from "vitest"
import { Context, Effect, Layer, ManagedRuntime } from "effect"
import { WebSocket } from "ws"
import { Clock, ObservabilityService, UIService } from "@luna/core"
import { startUIWebSocketServer } from "../src/server.js"
import type { ServerFrame } from "../src/protocol.js"

const TOKEN = "test-token-1234567890" // >=16 chars

class ServerHandle extends Context.Service<
  ServerHandle,
  { readonly port: number; readonly host: string }
>()("test/ServerHandle") {}

interface Rig {
  url: string
  shutdown: () => Promise<void>
  writes: string[]
  resizes: Array<[unknown, unknown]>
}

const startRig = async (): Promise<Rig> => {
  const clockL = Clock.Default
  const obsL = ObservabilityService.makeLayer({ logToConsole: false }).pipe(
    Layer.provide(clockL),
  )
  const uiL = UIService.makeLayer().pipe(
    Layer.provide(obsL),
    Layer.provide(clockL),
  )
  const baseLayer = Layer.mergeAll(uiL, obsL, clockL)

  const writes: string[] = []
  const resizes: Array<[unknown, unknown]> = []

  const serverLayer = Layer.effect(
    ServerHandle,
    startUIWebSocketServer({
      port: 0,
      perConnectionCapacity: 256,
      pingIntervalMs: 0,
      surveyPollIntervalMs: 0,
      setupPty: {
        onConnect: () => ({
          write: (utf8: string) => {
            writes.push(utf8)
          },
          resize: (cols: number, rows: number) => {
            resizes.push([cols, rows])
          },
          close: () => {},
        }),
      },
      token: TOKEN,
    }),
  ).pipe(Layer.provide(baseLayer))

  const fullLayer = Layer.mergeAll(serverLayer, baseLayer)
  const runtime = ManagedRuntime.make(fullLayer)
  const handle = await runtime.runPromise(ServerHandle)
  return {
    url: `ws://127.0.0.1:${handle.port}/ui`,
    shutdown: () => runtime.dispose(),
    writes,
    resizes,
  }
}

/** Connect, wait for hello, then send raw frames and wait a beat. */
const sendFrames = (url: string, frames: ReadonlyArray<unknown>): Promise<ServerFrame[]> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    const out: ServerFrame[] = []
    const stop = setTimeout(() => {
      ws.close()
      resolve(out)
    }, 400)
    ws.on("error", (err) => {
      clearTimeout(stop)
      reject(err)
    })
    ws.on("message", (raw) => {
      try {
        out.push(JSON.parse(raw.toString()) as ServerFrame)
      } catch (e) {
        clearTimeout(stop)
        reject(e)
      }
    })
    ws.on("open", async () => {
      // Wait for the hello frame so the connection is fully established.
      const deadline = Date.now() + 2000
      while (Date.now() < deadline && !out.some((f) => f.type === "hello")) {
        await new Promise((r) => setTimeout(r, 10))
      }
      for (const f of frames) ws.send(JSON.stringify(f))
    })
  })

describe("pty setup-frame malformed-frame guard", () => {
  let shutdown: (() => Promise<void>) | undefined
  afterEach(async () => {
    await shutdown?.()
    shutdown = undefined
  })

  it("never routes malformed pty-input frames to the pty", async () => {
    const rig = await startRig()
    shutdown = rig.shutdown

    await sendFrames(rig.url, [
      // Byte-array data: pre-guard this was silently decoded and WRITTEN
      // to the pty's stdin ("hi").
      { type: "pty-input", data: [104, 105] },
      // Non-string data: pre-guard this threw a TypeError inside
      // Buffer.from (fiber defect, log-only).
      { type: "pty-input", data: 42 },
      { type: "pty-input", data: { bin: "aGk=" } },
      // Missing data entirely.
      { type: "pty-input" },
    ])

    expect(rig.writes).toHaveLength(0)
  })

  it("never routes malformed pty-resize frames to the pty", async () => {
    const rig = await startRig()
    shutdown = rig.shutdown

    await sendFrames(rig.url, [
      // String cols: pre-guard this reached resize() unvalidated.
      { type: "pty-resize", cols: "80", rows: 24 },
      // Missing cols/rows.
      { type: "pty-resize" },
      // Null cols.
      { type: "pty-resize", cols: null, rows: 24 },
    ])

    expect(rig.resizes).toHaveLength(0)
  })

  it("still routes well-formed pty frames, even after malformed ones", async () => {
    const rig = await startRig()
    shutdown = rig.shutdown

    await sendFrames(rig.url, [
      // Malformed frame first: the connection must stay healthy.
      { type: "pty-input", data: 42 },
      { type: "pty-input", data: "aGk=" }, // base64 "hi"
      { type: "pty-resize", cols: 80, rows: 24 },
    ])

    expect(rig.writes).toEqual(["hi"])
    expect(rig.resizes).toEqual([[80, 24]])
  })
})
