/**
 * Per-connection survey poller.
 *
 * Covers the long-lived-client gap in PR #36: the server originally pushed
 * `survey-request` exactly once, right after `hello`. For a Moon-style
 * client that stays connected for hours, anything the nightly dream-cron
 * proposes mid-session would never reach the operator.
 *
 * These tests pin the poller's contract:
 *   1. If pendingSurvey returns null at connect but non-null on a later
 *      tick, the server pushes survey-request *without a reconnect*.
 *   2. The poller dedupes by issuedAt — repeated non-null returns with
 *      the SAME issuedAt result in exactly one survey-request frame, so
 *      an unanswered panel does not rebuild on every tick.
 *   3. A new issuedAt (e.g. after the operator answered the first survey
 *      and a fresh one became due) DOES produce a new push.
 *   4. surveyPollIntervalMs = 0 disables the poller (connect-time check
 *      still runs).
 */
import { afterEach, describe, expect, it } from "vitest"
import { Context, Effect, Layer, ManagedRuntime } from "effect"
import { WebSocket } from "ws"
import { Clock } from "@luna/core"
import {
  ObservabilityService,
  UIService,
} from "@luna/core"
import type { SurveyItem, SurveyVerdict } from "@luna/core"
import { startUIWebSocketServer, type SurveyWsHandle } from "../src/server.js"
import type { ServerFrame } from "../src/protocol.js"

const TOKEN = "test-token-1234567890" // ≥16 chars

const makeFullLayer = () => {
  const clockL = Clock.Default
  const obsL = ObservabilityService.makeLayer({ logToConsole: false }).pipe(
    Layer.provide(clockL),
  )
  const uiL = UIService.makeLayer().pipe(
    Layer.provide(obsL),
    Layer.provide(clockL),
  )
  return Layer.mergeAll(uiL, obsL, clockL)
}

class ServerHandle extends Context.Service<
  ServerHandle,
  { readonly port: number; readonly host: string }
>()("test/ServerHandle") {}

interface PollerRig {
  url: string
  shutdown: () => Promise<void>
}

const startPollerRig = async (
  survey: SurveyWsHandle,
  surveyPollIntervalMs: number,
): Promise<PollerRig> => {
  const baseLayer = makeFullLayer()
  const serverLayer = Layer.effect(
    ServerHandle,
    startUIWebSocketServer({
      port: 0,
      perConnectionCapacity: 256,
      pingIntervalMs: 0,
      surveyPollIntervalMs,
      survey,
      token: TOKEN,
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

/** Collect frames from a connection for `windowMs` milliseconds. */
const collectFor = (
  url: string,
  windowMs: number,
): Promise<ServerFrame[]> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    const out: ServerFrame[] = []
    const stop = setTimeout(() => {
      ws.close()
      resolve(out)
    }, windowMs)
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
  })

/**
 * Stateful fake survey. pendingSurvey returns whatever queue[i] is at the
 * time of the call; calls advance i by one. After the queue runs out, it
 * keeps returning the last value (so dedup logic still has something to
 * de-duplicate against).
 */
const makeStatefulSurvey = (
  queue: ReadonlyArray<{ issuedAt: number; items: ReadonlyArray<SurveyItem> } | null>,
): { handle: SurveyWsHandle; callCount: () => number } => {
  let i = 0
  let calls = 0
  const handle: SurveyWsHandle = {
    pendingSurvey: () =>
      Effect.sync(() => {
        calls += 1
        const v = queue[Math.min(i, queue.length - 1)] ?? null
        if (i < queue.length - 1) i += 1
        return v
      }),
    submitVerdicts: (
      _surveyId: string,
      _issuedAt: number,
      _verdicts: ReadonlyArray<SurveyVerdict>,
    ) => Effect.void,
  }
  return { handle, callCount: () => calls }
}

describe("per-connection survey poller (long-lived-client fix)", () => {
  let rig: PollerRig

  afterEach(async () => {
    if (rig) await rig.shutdown()
  })

  it("pushes survey-request when one becomes due mid-session (no reconnect)", async () => {
    // First tick (connect-time): nothing due.
    // Subsequent ticks: a survey is due. Operator should see survey-request
    // without ever closing/reopening the socket.
    const pending = {
      issuedAt: 1234,
      items: [
        {
          id: "sq-1234",
          kind: "task_quality" as const,
          prompt: "How aligned have I been?",
          ref: "task_quality",
        },
      ],
    }
    const { handle } = makeStatefulSurvey([null, pending])
    rig = await startPollerRig(handle, 50) // poll every 50ms

    // Listen for ~600ms — plenty of time for several poller ticks.
    const frames = await collectFor(rig.url, 600)

    const surveyFrames = frames.filter((f) => f.type === "survey-request")
    expect(surveyFrames.length).toBeGreaterThanOrEqual(1)
    if (surveyFrames[0]?.type === "survey-request") {
      expect(surveyFrames[0].issuedAt).toBe(1234)
      expect(surveyFrames[0].surveyId).toBe("survey-1234")
    }
  })

  it("dedupes by issuedAt — same pending survey is pushed exactly once", async () => {
    // Every pendingSurvey() call returns the SAME survey. The poller must
    // push it once (connect-time) and then suppress every subsequent push
    // until the issuedAt actually changes.
    const pending = {
      issuedAt: 5000,
      items: [
        {
          id: "sq-5000",
          kind: "task_quality" as const,
          prompt: "p",
          ref: "task_quality",
        },
      ],
    }
    const { handle } = makeStatefulSurvey([pending])
    rig = await startPollerRig(handle, 50)

    const frames = await collectFor(rig.url, 500) // 10+ ticks

    const surveyFrames = frames.filter((f) => f.type === "survey-request")
    expect(surveyFrames).toHaveLength(1)
    if (surveyFrames[0]?.type === "survey-request") {
      expect(surveyFrames[0].issuedAt).toBe(5000)
    }
  })

  it("pushes again when issuedAt changes (new survey supersedes old)", async () => {
    // pendingSurvey returns issuedAt=1 forever, then flips to issuedAt=2.
    // The operator must see BOTH — first one at connect, second after the
    // poller sees the change.
    const first = {
      issuedAt: 1,
      items: [
        {
          id: "sq-1",
          kind: "task_quality" as const,
          prompt: "p1",
          ref: "task_quality",
        },
      ],
    }
    const second = {
      issuedAt: 2,
      items: [
        {
          id: "sq-2",
          kind: "task_quality" as const,
          prompt: "p2",
          ref: "task_quality",
        },
      ],
    }
    // a few ticks of `first`, then `second` forever.
    const { handle } = makeStatefulSurvey([first, first, first, second])
    rig = await startPollerRig(handle, 50)

    const frames = await collectFor(rig.url, 600)

    const surveyFrames = frames.filter((f) => f.type === "survey-request")
    const issuedAts = surveyFrames.flatMap((f) =>
      f.type === "survey-request" ? [f.issuedAt] : [],
    )
    expect(issuedAts).toContain(1)
    expect(issuedAts).toContain(2)
    // And we don't see the same issuedAt twice — strict dedup.
    expect(new Set(issuedAts).size).toBe(issuedAts.length)
  })

  it("surveyPollIntervalMs=0 disables the poller (connect-time check still runs)", async () => {
    // pendingSurvey returns null at connect, then non-null. With the poller
    // disabled, the non-null never reaches the client — only the connect-
    // time null is consulted, so zero survey-request frames are pushed.
    const pending = {
      issuedAt: 7777,
      items: [
        {
          id: "sq-7777",
          kind: "task_quality" as const,
          prompt: "p",
          ref: "task_quality",
        },
      ],
    }
    const { handle, callCount } = makeStatefulSurvey([null, pending])
    rig = await startPollerRig(handle, 0) // disabled

    const frames = await collectFor(rig.url, 300)

    const surveyFrames = frames.filter((f) => f.type === "survey-request")
    expect(surveyFrames).toHaveLength(0)
    // pendingSurvey was consulted exactly once (the connect-time check).
    expect(callCount()).toBe(1)
  })
})
