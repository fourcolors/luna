/**
 * Live POST /v1/journal behaviour against a real startUIWebSocketServer on an
 * ephemeral port, with a stub sink recording what it receives.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import * as http from "node:http"
import { EventEmitter } from "node:events"
import { Context, Effect, Layer, ManagedRuntime } from "effect"
import { Clock, ObservabilityService, UIService } from "@luna/core"
import { startUIWebSocketServer } from "../src/server.js"
import { JournalInFlight, JournalRateLimiter, handleJournalRequest } from "../src/journal-route.js"
import type { JournalEntry, JournalSink } from "../src/journal-route.js"

const WS_TOKEN = "test-token-1234567890"
const JOURNAL_TOKEN = "journal-token-abcdefghijklmnopqrstuvwxyz"

const baseLayer = () => {
  const clockL = Clock.Default
  const obsL = ObservabilityService.makeLayer({ logToConsole: false }).pipe(Layer.provide(clockL))
  const uiL = UIService.makeLayer().pipe(Layer.provide(obsL), Layer.provide(clockL))
  return Layer.mergeAll(uiL, obsL, clockL)
}

class ServerHandle extends Context.Service<ServerHandle, { readonly port: number }>()(
  "test/JournalServerHandle",
) {}

interface Rig {
  readonly port: number
  readonly received: JournalEntry[]
  readonly shutdown: () => Promise<void>
}

let rigs: Rig[] = []
afterEach(async () => {
  await Promise.all(rigs.map((r) => r.shutdown()))
  rigs = []
  vi.restoreAllMocks()
})

type SubmitResult = Effect.Success<ReturnType<JournalSink["submit"]>>

const startRig = async (
  opts: {
    sink?: boolean
    journalToken?: string | null
    deadlineMs?: number
    // Replaces the immediate success, e.g. with a write that never finishes.
    write?: () => Effect.Effect<SubmitResult>
  } = {},
): Promise<Rig> => {
  const received: JournalEntry[] = []
  const sink: JournalSink = {
    submit: (entry) => {
      received.push(entry)
      return opts.write?.() ?? Effect.succeed({ ok: true as const, id: "ccj_test", deduped: false })
    },
  }
  const serverLayer = Layer.effect(
    ServerHandle,
    Effect.gen(function* () {
      const handle = yield* startUIWebSocketServer({
        port: 0,
        token: WS_TOKEN,
        pingIntervalMs: 0,
        journalSink: opts.sink === false ? null : sink,
        journalToken: opts.journalToken === undefined ? JOURNAL_TOKEN : opts.journalToken,
        ...(opts.deadlineMs !== undefined ? { journalDeadlineMs: opts.deadlineMs } : {}),
      })
      return { port: handle.port }
    }),
  ).pipe(Layer.provide(baseLayer()))
  const runtime = ManagedRuntime.make(serverLayer)
  const handle = await runtime.runPromise(ServerHandle)
  const rig = { port: handle.port, received, shutdown: () => runtime.dispose().then(() => {}) }
  rigs.push(rig)
  return rig
}

interface Resp {
  readonly status: number
  readonly headers: http.IncomingHttpHeaders
  readonly body: string
}

const request = (
  port: number,
  opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer; chunked?: boolean },
): Promise<Resp> =>
  new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) }
    if (opts.body !== undefined && !opts.chunked) headers["content-length"] = String(Buffer.byteLength(opts.body))
    const req = http.request(
      { host: "127.0.0.1", port, method: opts.method ?? "POST", path: opts.path ?? "/v1/journal", headers, agent: false },
      (res) => {
        const chunks: Buffer[] = []
        res.on("data", (c: Buffer) => chunks.push(c))
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }))
        res.on("error", reject)
      },
    )
    req.on("error", reject)
    if (opts.body !== undefined) req.write(opts.body)
    req.end()
  })

const goodEntry = (): Record<string, unknown> => ({
  v: 1,
  source: "claude-code",
  session_id: "sess-0001",
  entry_id: "entry-0001",
  repo: "luna",
  repo_path: "/Users/op/luna",
  branch: "master",
  started_at: "2026-10-06T10:00:00Z",
  ended_at: "2026-10-06T10:05:00Z",
  summary: "Smoke test.",
  host: "mac",
  client: "claude-code-cli",
  client_version: "2.1.291",
})

const authed = (extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${JOURNAL_TOKEN}`,
  "content-type": "application/json",
  ...extra,
})

const post = (port: number, body: unknown, headers = authed()) =>
  request(port, { headers, body: typeof body === "string" ? body : JSON.stringify(body) })

describe("POST /v1/journal", () => {
  it("GET gives 405 with Allow: POST", async () => {
    const rig = await startRig()
    const r = await request(rig.port, { method: "GET" })
    expect(r.status).toBe(405)
    expect(r.headers["allow"]).toBe("POST")
  })

  it("no sink gives 503", async () => {
    const rig = await startRig({ sink: false })
    const r = await post(rig.port, goodEntry())
    expect(r.status).toBe(503)
    expect(JSON.parse(r.body)).toEqual({ ok: false, error: "journal_disabled" })
  })

  it("no journal token gives 503", async () => {
    const rig = await startRig({ journalToken: null })
    expect((await post(rig.port, goodEntry())).status).toBe(503)
  })

  it("a journal token under 32 chars disables the route", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const rig = await startRig({ journalToken: "short-but-not-32-chars" })
    expect((await post(rig.port, goodEntry(), authed({ authorization: "Bearer short-but-not-32-chars" }))).status).toBe(503)
    expect(warn.mock.calls.flat().join(" ")).not.toContain("short-but-not-32-chars")
  })

  it("missing or wrong bearer gives 401 and never logs the token", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const rig = await startRig()
    expect((await post(rig.port, goodEntry(), { "content-type": "application/json" })).status).toBe(401)
    const wrong = "wrong-token-that-is-long-enough-000000"
    expect((await post(rig.port, goodEntry(), authed({ authorization: `Bearer ${wrong}` }))).status).toBe(401)
    const logged = warn.mock.calls.flat().join(" ")
    expect(logged).toContain("journal auth failed")
    expect(logged).not.toContain(wrong)
    expect(logged).not.toContain(JOURNAL_TOKEN)
    expect(rig.received).toHaveLength(0)
  })

  it("the main ui-ws token is not accepted", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const rig = await startRig()
    expect((await post(rig.port, goodEntry(), authed({ authorization: `Bearer ${WS_TOKEN}` }))).status).toBe(401)
  })

  it("?token= with no header gives 401", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const rig = await startRig()
    const r = await request(rig.port, {
      path: `/v1/journal?token=${JOURNAL_TOKEN}`,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(goodEntry()),
    })
    expect(r.status).toBe(401)
  })

  it("text/plain gives 415", async () => {
    const rig = await startRig()
    expect((await post(rig.port, goodEntry(), authed({ "content-type": "text/plain" }))).status).toBe(415)
  })

  it("70 KiB with Content-Length gives 413 and closes the connection", async () => {
    const rig = await startRig()
    const big = JSON.stringify({ ...goodEntry(), pad: "x".repeat(70 * 1024) })
    const r = await post(rig.port, big)
    expect(r.status).toBe(413)
    expect(r.headers["connection"]).toBe("close")
    expect(rig.received).toHaveLength(0)
  })

  it("70 KiB chunked (no Content-Length) gives 413 or a reset, never a write", async () => {
    const rig = await startRig()
    const big = JSON.stringify({ ...goodEntry(), pad: "x".repeat(70 * 1024) })
    const outcome = await request(rig.port, { headers: authed(), body: big, chunked: true }).then(
      (r) => r.status,
      () => "reset" as const,
    )
    expect([413, "reset"]).toContain(outcome)
    expect(rig.received).toHaveLength(0)
  })

  it("bad JSON gives 400", async () => {
    const rig = await startRig()
    expect((await post(rig.port, "{not json")).status).toBe(400)
  })

  it("missing summary gives 422 naming the field", async () => {
    const rig = await startRig()
    const { summary: _drop, ...rest } = goodEntry()
    const r = await post(rig.port, rest)
    expect(r.status).toBe(422)
    const body = JSON.parse(r.body) as { ok: boolean; errors: string[] }
    expect(body.ok).toBe(false)
    expect(body.errors.join(" ")).toContain("summary")
  })

  it("the 31st request in a minute gives 429 with Retry-After", async () => {
    const rig = await startRig()
    for (let i = 0; i < 30; i++) {
      const r = await post(rig.port, goodEntry())
      expect(r.status).toBe(200)
    }
    const r = await post(rig.port, goodEntry())
    expect(r.status).toBe(429)
    expect(Number(r.headers["retry-after"])).toBeGreaterThan(0)
  })

  it("happy path: 200 and the sink gets the validated entry without unknown keys", async () => {
    const rig = await startRig()
    const r = await post(rig.port, { ...goodEntry(), injected: "ignore me" })
    expect(r.status).toBe(200)
    expect(JSON.parse(r.body)).toEqual({ ok: true, id: "ccj_test", deduped: false })
    expect(rig.received).toHaveLength(1)
    expect(rig.received[0]).not.toHaveProperty("injected")
    expect(rig.received[0]!.summary).toBe("Smoke test.")
  })

  it("other paths still 404 and /healthz is untouched", async () => {
    const rig = await startRig()
    expect((await request(rig.port, { method: "GET", path: "/v1/other" })).status).toBe(404)
    expect((await request(rig.port, { method: "GET", path: "/healthz" })).status).toBe(200)
  })
})

const until = async (cond: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time")
    await new Promise((r) => setTimeout(r, 10))
  }
}

// A never-finishing write that records when it is interrupted.
const hanging = () => {
  const state = { interrupted: false }
  const write = () => Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => void (state.interrupted = true))))
  return { state, write }
}

describe("POST /v1/journal deadlines and in-flight cap", () => {
  it("a drip-fed body that keeps the socket busy is cut off at the absolute deadline", async () => {
    const rig = await startRig({ deadlineMs: 300 })
    const body = Buffer.from(JSON.stringify(goodEntry()))
    const started = Date.now()
    const res = await new Promise<number | "reset">((resolve) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: rig.port,
          method: "POST",
          path: "/v1/journal",
          headers: { ...authed(), "content-length": String(body.length) },
          agent: false,
        },
        (r) => {
          clearInterval(drip)
          r.resume()
          resolve(r.statusCode ?? 0)
        },
      )
      req.on("error", () => {
        clearInterval(drip)
        resolve("reset")
      })
      // One byte every 20 ms: about 4 s for the whole body, never idle.
      let i = 0
      const drip = setInterval(() => {
        if (i < body.length - 1) req.write(body.subarray(i, i + 1))
        i++
      }, 20)
    })
    expect(res).toBe(408)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(rig.received).toHaveLength(0)
  })

  it("a hanging sink is interrupted at the deadline and the client gets 504", async () => {
    const h = hanging()
    const rig = await startRig({ deadlineMs: 300, write: h.write })
    const r = await post(rig.port, goodEntry())
    expect(r.status).toBe(504)
    expect(JSON.parse(r.body)).toEqual({ ok: false, error: "timeout" })
    await until(() => h.state.interrupted)
  })

  // Bun's node:http (the server runtime) does not report a client that drops
  // while the response is pending, so this drives the handler directly with
  // emitters standing in for Node's request, response and socket. Under Bun
  // the absolute deadline above is what bounds such a request.
  for (const target of ["response", "socket"] as const) {
    it(`a client disconnect (${target} close) interrupts its sink write and frees the slot`, async () => {
      const h = hanging()
      const received: JournalEntry[] = []
      const socket = Object.assign(new EventEmitter(), { remoteAddress: "127.0.0.1" })
      const req = Object.assign(new EventEmitter(), {
        method: "POST",
        headers: { ...authed(), "content-length": "10" } as Record<string, string>,
        socket,
        setTimeout: () => {},
        destroy: () => {},
      })
      const res = Object.assign(new EventEmitter(), {
        headersSent: false,
        writableFinished: false,
        writeHead: () => {},
        end: () => {},
      })
      const inFlight = new JournalInFlight(1)
      const done = handleJournalRequest(req as never, res as never, {
        token: JOURNAL_TOKEN,
        sink: { submit: (e) => (received.push(e), h.write()) },
        tokenEq: (a, b) => a === b,
        rateLimiter: new JournalRateLimiter(),
        inFlight,
        deadlineMs: 60_000,
        log: () => {},
      })
      req.emit("data", Buffer.from(JSON.stringify(goodEntry())))
      req.emit("end")
      await until(() => received.length === 1)
      expect(inFlight.count).toBe(1)
      ;(target === "response" ? res : socket).emit("close")
      await done
      expect(h.state.interrupted).toBe(true)
      expect(inFlight.count).toBe(0)
    })
  }

  it("a fifth concurrent request gets 503 busy, and slots free up afterwards", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const rig = await startRig({
      write: () =>
        Effect.promise(() => gate).pipe(Effect.as({ ok: true as const, id: "ccj_test", deduped: false })),
    })
    const first = Array.from({ length: 4 }, () => post(rig.port, goodEntry()))
    await until(() => rig.received.length === 4)
    const fifth = await post(rig.port, goodEntry())
    expect(fifth.status).toBe(503)
    expect(JSON.parse(fifth.body)).toEqual({ ok: false, error: "busy" })
    expect(rig.received).toHaveLength(4)
    release()
    for (const r of await Promise.all(first)) expect(r.status).toBe(200)
    expect((await post(rig.port, goodEntry())).status).toBe(200)
  })
})
