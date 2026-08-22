/**
 * workflow-gallery.server.test.ts — LIVE workflow-gallery behavior against a
 * real startUIWebSocketServer (PRD Part C / W3). Mirrors
 * artifact-frames.server.test.ts: the protocol tests are type-only, so the
 * post-hello send + the runs/refresh ROUTING need runtime coverage to catch a
 * handler-gate omission.
 *
 * Pins:
 *   - a WORKFLOWS-ONLY server (no chat) attaches the handler + advertises
 *     capabilities.workflows
 *   - workflow-list arrives after hello with the gallery tiles
 *   - workflow-runs-request → workflow-runs for that jobId
 *   - workflow-refresh → a fresh workflow-list
 *   - a malformed runs-request (no jobId) is ignored, not crashed
 */
import { afterEach, describe, expect, it } from "vitest"
import { Context, Effect, Layer, ManagedRuntime } from "effect"
import WebSocket from "ws"
import { Clock, ObservabilityService, UIService } from "@luna/core"
import { startUIWebSocketServer } from "../src/server.js"
import type {
  ServerFrame,
  WorkflowGalleryItem,
  WorkflowRunItem,
} from "../src/protocol.js"

const TOKEN = "test-token-1234567890"

const baseLayer = () => {
  const clockL = Clock.Default
  const obsL = ObservabilityService.makeLayer({ logToConsole: false }).pipe(
    Layer.provide(clockL),
  )
  const uiL = UIService.makeLayer().pipe(Layer.provide(obsL), Layer.provide(clockL))
  return Layer.mergeAll(uiL, obsL, clockL)
}

class ServerHandle extends Context.Service<
  ServerHandle,
  { readonly port: number }
>()("test/WorkflowServerHandle") {}

const GALLERY: WorkflowGalleryItem[] = [
  {
    id: "job-cron",
    kind: "cron",
    label: "Nightly Dream",
    source: "scheduler",
    schedule: "0 3 * * *",
    onDemand: false,
    enabled: true,
    nextRunAt: 1000,
    lastRun: 900,
    lastStatus: "success",
    createdAt: 100,
  },
  {
    id: "job-demand",
    kind: "workflow",
    label: "Ad-hoc review",
    source: null,
    schedule: null,
    onDemand: true,
    enabled: true,
    nextRunAt: null,
    lastRun: null,
    lastStatus: null,
    createdAt: 200,
  },
]
const RUNS: Record<string, WorkflowRunItem[]> = {
  "job-cron": [
    { id: 2, startedAt: 900, finishedAt: 950, status: "success", attempt: 1, error: null },
    { id: 1, startedAt: 500, finishedAt: 560, status: "failed", attempt: 1, error: "boom" },
  ],
}

interface Rig {
  readonly url: string
  readonly shutdown: () => Promise<void>
}

const startWorkflowsRig = async (): Promise<Rig> => {
  const serverLayer = Layer.effect(
    ServerHandle,
    Effect.gen(function* () {
      const handle = yield* startUIWebSocketServer({
        port: 0,
        token: TOKEN,
        pingIntervalMs: 0,
        workflowGallery: {
          list: () => Effect.succeed(GALLERY),
          runs: (jobId) => Effect.succeed(RUNS[jobId] ?? []),
        },
      })
      return { port: handle.port }
    }),
  ).pipe(Layer.provide(baseLayer()))

  const runtime = ManagedRuntime.make(serverLayer)
  const handle = await runtime.runPromise(ServerHandle)
  return {
    url: `ws://127.0.0.1:${handle.port}/ui`,
    shutdown: () => runtime.dispose().then(() => {}),
  }
}

interface Client {
  readonly frames: ServerFrame[]
  readonly send: (f: unknown) => void
  readonly waitFor: (pred: (f: ServerFrame) => boolean, timeoutMs?: number) => Promise<ServerFrame>
  readonly close: () => void
}

const openClient = (url: string): Promise<Client> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${TOKEN}` } })
    const frames: ServerFrame[] = []
    const waiters: Array<{ pred: (f: ServerFrame) => boolean; resolve: (f: ServerFrame) => void }> = []
    ws.on("error", reject)
    ws.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as ServerFrame
      frames.push(frame)
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i]!.pred(frame)) {
          waiters[i]!.resolve(frame)
          waiters.splice(i, 1)
        }
      }
    })
    ws.on("open", () =>
      resolve({
        frames,
        send: (f) => ws.send(JSON.stringify(f)),
        waitFor: (pred, timeoutMs = 3000) => {
          const already = frames.find(pred)
          if (already) return Promise.resolve(already)
          return new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error("waitFor timeout")), timeoutMs)
            waiters.push({ pred, resolve: (f) => { clearTimeout(t); res(f) } })
          })
        },
        close: () => ws.close(),
      }),
    )
  })

let activeRig: Rig | null = null
afterEach(async () => {
  await activeRig?.shutdown()
  activeRig = null
})

describe("workflows-only ui-ws server (live)", () => {
  it("advertises workflows + sends the gallery after hello", async () => {
    activeRig = await startWorkflowsRig()
    const client = await openClient(activeRig.url)

    const hello = await client.waitFor((f) => f.type === "hello")
    expect(hello.type === "hello" ? hello.capabilities.workflows : false).toBe(true)

    const list = await client.waitFor((f) => f.type === "workflow-list")
    if (list.type === "workflow-list") {
      expect(list.workflows.map((w) => w.id)).toEqual(["job-cron", "job-demand"])
      expect(list.workflows.find((w) => w.id === "job-demand")?.onDemand).toBe(true)
    }
    client.close()
  })

  it("routes workflow-runs-request → workflow-runs for that job", async () => {
    activeRig = await startWorkflowsRig()
    const client = await openClient(activeRig.url)
    await client.waitFor((f) => f.type === "workflow-list")

    client.send({ type: "workflow-runs-request", jobId: "job-cron" })
    const runs = await client.waitFor(
      (f) => f.type === "workflow-runs" && f.jobId === "job-cron",
    )
    if (runs.type === "workflow-runs") {
      expect(runs.runs.map((r) => r.status)).toEqual(["success", "failed"])
      expect(runs.runs[1]?.error).toBe("boom")
    }
    client.close()
  })

  it("workflow-refresh re-sends the gallery; malformed runs-request is ignored", async () => {
    activeRig = await startWorkflowsRig()
    const client = await openClient(activeRig.url)
    await client.waitFor((f) => f.type === "workflow-list")

    const before = client.frames.filter((f) => f.type === "workflow-list").length
    client.send({ type: "workflow-refresh" })
    await client.waitFor(
      () => client.frames.filter((f) => f.type === "workflow-list").length > before,
    )

    // A jobId-less runs request must NOT crash the connection or reply.
    client.send({ type: "workflow-runs-request" })
    // The connection stays alive — a follow-up refresh still round-trips.
    const before2 = client.frames.filter((f) => f.type === "workflow-list").length
    client.send({ type: "workflow-refresh" })
    await client.waitFor(
      () => client.frames.filter((f) => f.type === "workflow-list").length > before2,
    )
    client.close()
  })
})
