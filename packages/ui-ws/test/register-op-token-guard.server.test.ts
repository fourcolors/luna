/**
 * Regression test: malformed `register-op-token` frames must be rejected
 * with a typed status before reaching the handler.
 *
 * Inbound frames are JSON.parse'd and cast to ClientFrame with only `type`
 * checked, so every field is attacker-controlled JSON. Before the guard, a
 * `register-op-token` frame with a non-string (or missing) `label`/`token`
 * reached makeRegisterOpToken, which calls `.trim()` on both — the TypeError
 * rejected the promise, failed the handler fiber, and the client never got
 * its `register-op-token-status` reply, so the Moon Settings form hung with
 * no feedback. Same defect class as the pty-input (#797) and
 * survey-response guards.
 *
 * These tests pin the guard: malformed frames never reach the handler, the
 * client gets an ok:false status for each, and well-formed frames still
 * route afterwards.
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
  calls: Array<{ label: unknown; token: unknown }>
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

  const calls: Array<{ label: unknown; token: unknown }> = []

  const serverLayer = Layer.effect(
    ServerHandle,
    startUIWebSocketServer({
      port: 0,
      perConnectionCapacity: 256,
      pingIntervalMs: 0,
      surveyPollIntervalMs: 0,
      registerOpToken: async (input: { label: string; token: string }) => {
        calls.push({ label: input.label, token: input.token })
        return { ok: true, message: `Saved "${input.label}".` }
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
    calls,
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

const statuses = (frames: ServerFrame[]) =>
  frames.filter((f) => f.type === "register-op-token-status") as Array<{
    type: "register-op-token-status"
    requestId: string
    ok: boolean
    message: string
  }>

describe("register-op-token malformed-frame guard", () => {
  let shutdown: (() => Promise<void>) | undefined
  afterEach(async () => {
    await shutdown?.()
    shutdown = undefined
  })

  it("never routes malformed register-op-token frames to the handler", async () => {
    const rig = await startRig()
    shutdown = rig.shutdown

    const out = await sendFrames(rig.url, [
      // Non-string label: pre-guard, makeRegisterOpToken's label.trim()
      // threw and the client got no status reply.
      { type: "register-op-token", requestId: "m1", label: 42, token: "ops_x" },
      // Non-string token.
      { type: "register-op-token", requestId: "m2", label: "personal", token: 123 },
      // Missing token entirely.
      { type: "register-op-token", requestId: "m3", label: "personal" },
      // Missing label entirely.
      { type: "register-op-token", requestId: "m4", token: "ops_x" },
      // Non-string requestId: status still replies, with "" echoed.
      { type: "register-op-token", requestId: 99, label: 42, token: "ops_x" },
    ])

    expect(rig.calls).toHaveLength(0)
    const got = statuses(out)
    expect(got).toHaveLength(5)
    for (const id of ["m1", "m2", "m3", "m4", ""]) {
      const s = got.find((x) => x.requestId === id)
      expect(s).toBeDefined()
      expect(s!.ok).toBe(false)
      expect(s!.message).toBe("malformed register-op-token frame")
    }
  })

  it("still routes well-formed register-op-token frames, even after malformed ones", async () => {
    const rig = await startRig()
    shutdown = rig.shutdown

    const out = await sendFrames(rig.url, [
      // Malformed frame first: the connection must stay healthy.
      { type: "register-op-token", requestId: "m1", label: 42, token: "ops_x" },
      { type: "register-op-token", requestId: "good1", label: "personal", token: "ops_test-token" },
    ])

    expect(rig.calls).toEqual([{ label: "personal", token: "ops_test-token" }])
    const got = statuses(out)
    expect(got.find((x) => x.requestId === "m1")?.ok).toBe(false)
    const good = got.find((x) => x.requestId === "good1")
    expect(good).toBeDefined()
    expect(good!.ok).toBe(true)
    expect(good!.message).toBe('Saved "personal".')
  })
})
