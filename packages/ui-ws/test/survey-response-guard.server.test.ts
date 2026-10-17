/**
 * Regression test: malformed `survey-response` frames must be rejected
 * before touching survey state.
 *
 * The `survey-response` case used to dereference attacker-controlled JSON
 * with no validation:
 * - a missing/non-array `verdicts` threw a TypeError inside the handler
 *   (defect, log-only, no client signal);
 * - a non-number `issuedAt` pinned every verdict to `at: undefined`, which
 *   makes processVerdict fall back to the live clock — defeating the
 *   D-LOCK-5 idempotency keying (ref, signalKind, at) that exists so a
 *   buggy/replaying client cannot double-move the EWMA.
 *
 * These tests pin the guard: malformed frames never reach submitVerdicts,
 * while a well-formed frame still does.
 */
import { afterEach, describe, expect, it } from "vitest"
import { Context, Effect, Layer, ManagedRuntime } from "effect"
import { WebSocket } from "ws"
import { Clock, ObservabilityService, UIService } from "@luna/core"
import type { SurveyVerdict } from "@luna/core"
import { startUIWebSocketServer, type SurveyWsHandle } from "../src/server.js"
import type { ServerFrame } from "../src/protocol.js"

const TOKEN = "test-token-1234567890" // >=16 chars

class ServerHandle extends Context.Service<
  ServerHandle,
  { readonly port: number; readonly host: string }
>()("test/ServerHandle") {}

interface Rig {
  url: string
  shutdown: () => Promise<void>
}

const startRig = async (
  calls: Array<{ surveyId: string; issuedAt: number; verdicts: ReadonlyArray<SurveyVerdict> }>,
): Promise<Rig> => {
  const clockL = Clock.Default
  const obsL = ObservabilityService.makeLayer({ logToConsole: false }).pipe(
    Layer.provide(clockL),
  )
  const uiL = UIService.makeLayer().pipe(
    Layer.provide(obsL),
    Layer.provide(clockL),
  )
  const baseLayer = Layer.mergeAll(uiL, obsL, clockL)

  const survey: SurveyWsHandle = {
    pendingSurvey: () => Effect.succeed(null),
    submitVerdicts: (surveyId, issuedAt, verdicts) =>
      Effect.sync(() => {
        calls.push({ surveyId, issuedAt, verdicts })
      }),
  }

  const serverLayer = Layer.effect(
    ServerHandle,
    startUIWebSocketServer({
      port: 0,
      perConnectionCapacity: 256,
      pingIntervalMs: 0,
      surveyPollIntervalMs: 0,
      survey,
token: TOKEN
    }),
  ).pipe(Layer.provide(baseLayer))

  const fullLayer = Layer.mergeAll(serverLayer, baseLayer)
  const runtime = ManagedRuntime.make(fullLayer)
  const handle = await runtime.runPromise(ServerHandle)
  return {
    url: `ws://127.0.0.1:${handle.port}/ui`,
    shutdown: () => runtime.dispose(),
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

const validVerdict = {
  itemId: "i1",
  kind: "task_quality",
  ref: "task:1",
  score: 1,
  via: "survey",
} as const

describe("survey-response malformed-frame guard", () => {
  let shutdown: (() => Promise<void>) | undefined
  afterEach(async () => {
    await shutdown?.()
    shutdown = undefined
  })

  it("never routes malformed survey-response frames to submitVerdicts", async () => {
    const calls: Array<{ surveyId: string; issuedAt: number; verdicts: ReadonlyArray<SurveyVerdict> }> = []
    const rig = await startRig(calls)
    shutdown = rig.shutdown

    await sendFrames(rig.url, [
      // Missing everything: verdicts.map would throw a TypeError.
      { type: "survey-response" },
      // verdicts not an array.
      { type: "survey-response", surveyId: "s1", issuedAt: 1234, verdicts: "nope" },
      // issuedAt not a number: verdicts would be pinned to at: undefined,
      // defeating the D-LOCK-5 idempotency keying.
      { type: "survey-response", surveyId: "s1", issuedAt: "not-a-number", verdicts: [validVerdict] },
      // issuedAt NaN: same idempotency defeat (NaN never key-matches).
      { type: "survey-response", surveyId: "s1", issuedAt: NaN, verdicts: [validVerdict] },
      // Empty surveyId.
      { type: "survey-response", surveyId: "", issuedAt: 1234, verdicts: [validVerdict] },
    ])

    expect(calls).toHaveLength(0)
  })

  it("still routes a well-formed survey-response frame", async () => {
    const calls: Array<{ surveyId: string; issuedAt: number; verdicts: ReadonlyArray<SurveyVerdict> }> = []
    const rig = await startRig(calls)
    shutdown = rig.shutdown

    await sendFrames(rig.url, [
      {
        type: "survey-response",
        surveyId: "survey-1234",
        issuedAt: 1234,
        verdicts: [validVerdict],
      },
    ])

    expect(calls).toHaveLength(1)
    expect(calls[0]?.surveyId).toBe("survey-1234")
    expect(calls[0]?.issuedAt).toBe(1234)
    // D-LOCK-5: every verdict's `at` is pinned server-side to issuedAt.
    expect(
      (calls[0]?.verdicts[0] as { at?: unknown } | undefined)?.at,
    ).toBe(1234)
  })
})
