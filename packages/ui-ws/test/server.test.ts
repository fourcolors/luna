/**
 * UIWebSocketServer — integration tests.
 *
 * Real http + real ws client; in-process. Coverage:
 *   - 401 on missing/wrong bearer
 *   - hello frame on connect (incl. advertisedKinds)
 *   - one whitelisted ObsEvent kind round-trips end-to-end
 *   - parametrized round-trip across every member of DEFAULT_UI_KINDS
 *     (locks the layer's kind-shape indifference)
 *   - fan-out: two clients each receive every event independently
 *   - path routing (404 on unknown, 404 on /, 200 on /healthz, 426 on
 *     non-upgrade /ui), including the query-string form of /healthz and /ui,
 *     which regression-guards the pathname split at server.ts's http handler
 *   - startup validation: refuses short token
 *
 * Slow-consumer drop and scope-leak shutdown are covered indirectly by
 * the bounded-buffer + Layer.effect finalizer; an explicit drop test is
 * left as a follow-up because reliably stalling a localhost ws send
 * buffer in a unit test is flaky.
 */
import { afterEach, beforeEach, afterAll, describe, expect, it, vi } from "vitest"
import { Context, Effect, Layer, ManagedRuntime } from "effect"
import { WebSocket } from "ws"
import net from "node:net"
import { randomBytes } from "node:crypto"
import { Clock } from "@luna/core"
import {
  DEFAULT_UI_KINDS,
  ObservabilityService,
  UIService,
} from "@luna/core"
import { createLocalShellBridge } from "../src/local-shell-bridge.js"
import type { ObsEvent } from "@luna/core"
import { startUIWebSocketServer } from "../src/server.js"
import type { ClientFrame, ServerFrame } from "../src/protocol.js"

const TOKEN = "test-token-1234567890" // ≥16 chars

const makeFullLayer = (config?: Parameters<typeof UIService.makeLayer>[0]) => {
  const clockL = Clock.Default
  const obsL = ObservabilityService.makeLayer({ logToConsole: false }).pipe(
    Layer.provide(clockL),
  )
  const uiL = UIService.makeLayer(config).pipe(
    Layer.provide(obsL),
    Layer.provide(clockL),
  )
  return Layer.mergeAll(uiL, obsL, clockL)
}

/**
 * Poll `cond` every 10ms until true or `deadlineMs` elapses. Deterministic
 * replacement for fixed-sleep waits on asynchronous server-side steps: the
 * caller's assertion still runs (and fails loudly) if the condition never
 * becomes true within the deadline.
 */
const pollUntil = async (
  cond: () => boolean,
  deadlineMs: number,
): Promise<void> => {
  const deadline = Date.now() + deadlineMs
  while (!cond() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** Collect takeN frames. Delegates to collectFramesAfterHello (single collector). */
const collectFrames = (
  url: string,
  headers: Record<string, string>,
  takeN: number,
  timeoutMs = 2000,
): Promise<ServerFrame[]> =>
  collectFramesAfterHello(url, headers, takeN, timeoutMs).frames

/**
 * Like collectFrames, but exposes the moment the `hello` frame arrives so a
 * test can sequence an obsEmit strictly AFTER the subscription provably
 * exists. The server takes `ui.subscribe` (eager, queue-backed — see
 * UIService's subscribeEvents contract) BEFORE it sends `hello`, so
 * hello-receipt guarantees any later emit reaches this client. Replaces the
 * fixed-sleep pattern that flaked in CI ("timeout: got 1/2 frames") when the
 * connection took longer than the sleep.
 */
const collectFramesAfterHello = (
  url: string,
  headers: Record<string, string>,
  takeN: number,
  timeoutMs = 2000,
): { hello: Promise<void>; frames: Promise<ServerFrame[]> } => {
  let helloResolve!: () => void
  let helloReject!: (e: Error) => void
  const hello = new Promise<void>((res, rej) => {
    helloResolve = res
    helloReject = rej
  })
  const frames = new Promise<ServerFrame[]>((resolve, reject) => {
    const ws = new WebSocket(url, { headers })
    const out: ServerFrame[] = []
    const fail = (err: Error) => {
      ws.close()
      helloReject(err)
      reject(err)
    }
    const timer = setTimeout(
      () => fail(new Error(`timeout: got ${out.length}/${takeN} frames`)),
      timeoutMs,
    )
    ws.on("error", (err) => {
      clearTimeout(timer)
      fail(err as Error)
    })
    ws.on("unexpected-response", (_req, res) => {
      clearTimeout(timer)
      fail(new Error(`unexpected ${res.statusCode}`))
    })
    ws.on("message", (raw) => {
      try {
        const frame = JSON.parse(raw.toString()) as ServerFrame
        out.push(frame)
        if (out.length === 1) helloResolve()
        if (out.length >= takeN) {
          clearTimeout(timer)
          ws.close()
          resolve(out)
        }
      } catch (e) {
        clearTimeout(timer)
        fail(e as Error)
      }
    })
  })
  // A test that fails before awaiting `frames` must not surface a second,
  // unhandled rejection from the pre-resolved pair.
  hello.catch(() => {})
  frames.catch(() => {})
  return { hello, frames }
}

const exchangeFrames = (
  url: string,
  headers: Record<string, string>,
  sendFrames: ReadonlyArray<ClientFrame>,
  takeN: number,
  timeoutMs = 2000,
): Promise<ServerFrame[]> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers })
    const out: ServerFrame[] = []
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error(`timeout: got ${out.length}/${takeN} frames`))
    }, timeoutMs)
    ws.on("error", (err) => {
      clearTimeout(timer)
      reject(err)
    })
    ws.on("unexpected-response", (_req, res) => {
      clearTimeout(timer)
      reject(new Error(`unexpected ${res.statusCode}`))
    })
    ws.on("open", () => {
      for (const frame of sendFrames) ws.send(JSON.stringify(frame))
    })
    ws.on("message", (raw) => {
      try {
        const frame = JSON.parse(raw.toString()) as ServerFrame
        out.push(frame)
        if (out.length >= takeN) {
          clearTimeout(timer)
          ws.close()
          resolve(out)
        }
      } catch (e) {
        clearTimeout(timer)
        reject(e)
      }
    })
  })

interface TestRig {
  url: string
  obsEmit: (ev: Parameters<UIService extends never ? never : ObservabilityService["emit"]>[0]) => Promise<void>
  shutdown: () => Promise<void>
}

// Service tag for the running server handle, so we can compose it as a
// Layer with the rest of the runtime — that way Layer scope owns the
// server's lifetime, and ManagedRuntime.dispose() shuts it down cleanly.
class ServerHandle extends Context.Service<
  ServerHandle,
  { readonly port: number; readonly host: string }
>()("test/ServerHandle") {}

const startRig = async (
  uiConfig?: Parameters<typeof UIService.makeLayer>[0],
  serverConfig?: Partial<Parameters<typeof startUIWebSocketServer>[0]>,
): Promise<TestRig> => {
  const baseLayer = makeFullLayer(uiConfig)
  const serverLayer = Layer.effect(
    ServerHandle,
    startUIWebSocketServer({
      port: 0,
      perConnectionCapacity: serverConfig?.perConnectionCapacity ?? 256,
      pingIntervalMs: 0,
      ...serverConfig,
      token: TOKEN,
    }),
  ).pipe(Layer.provide(baseLayer))

  const fullLayer = Layer.mergeAll(serverLayer, baseLayer)
  const runtime = ManagedRuntime.make(fullLayer)

  const handle = await runtime.runPromise(ServerHandle)

  return {
    url: `ws://127.0.0.1:${handle.port}/ui`,
    obsEmit: async (ev) => {
      await runtime.runPromise(
        Effect.flatMap(ObservabilityService, (obs) => obs.emit(ev)),
      )
    },
    shutdown: async () => {
      await runtime.dispose()
    },
  }
}

describe("UIWebSocketServer", () => {
  let rig: TestRig

  afterEach(async () => {
    if (rig) await rig.shutdown()
  })

  it("rejects upgrade without bearer (401)", async () => {
    rig = await startRig()
    await expect(
      collectFrames(rig.url, {}, 1, 1000),
    ).rejects.toThrow(/401|unexpected|unexpected-response|Connection ended/i)
  })

  it("accepts ?token= query-string auth (browser-compatible path)", async () => {
    rig = await startRig()
    // Browsers can't set Authorization on WS upgrades; the query-string
    // form is the only way for them to authenticate. Verify it works
    // end-to-end (no headers passed; ws lib will send no Authorization).
    const url = `${rig.url}?token=${encodeURIComponent(TOKEN)}`
    const frames = await collectFrames(url, {}, 1)
    expect(frames[0]?.type).toBe("hello")
  })

  it("rejects ?token= with wrong value (401)", async () => {
    rig = await startRig()
    const url = `${rig.url}?token=wrongtoken1234567`
    await expect(collectFrames(url, {}, 1, 1000)).rejects.toThrow(
      /401|unexpected|Connection ended/i,
    )
  })

  it("rejects upgrade with wrong bearer (401)", async () => {
    rig = await startRig()
    await expect(
      collectFrames(rig.url, { authorization: "Bearer wrongtoken1234567" }, 1, 1000),
    ).rejects.toThrow(/401|unexpected|Connection ended/i)
  })

  it("reaps a half-open connection (no pong) but spares a live one", async () => {
    // Small ping interval so the liveness check runs fast in-test — but not
    // so small that an event-loop stall on a loaded CI box delays the live
    // client's pong past a full interval and falsely reaps it (seen at 40ms).
    rig = await startRig(undefined, { pingIntervalMs: 200 })
    const headers = { authorization: `Bearer ${TOKEN}` }

    // Live client: a normal ws client auto-pongs (browser-like), so the
    // heartbeat must NOT reap it — guards against false-positive disconnects.
    const live = new WebSocket(rig.url, { headers })
    let liveClosed = false
    live.on("close", () => {
      liveClosed = true
    })
    await new Promise<void>((resolve, reject) => {
      live.on("open", () => resolve())
      live.on("error", reject)
    })

    // Half-open connection: a raw TCP socket that completes the WS upgrade then
    // goes SILENT — it never answers protocol pings (simulating a slept laptop
    // / dropped link with no TCP FIN). Without the heartbeat its subscriber
    // queues + buffers would linger indefinitely — a primary source of the
    // chat-server's slow growth toward OOM. (A `ws` client can't simulate this
    // under Bun, which auto-answers pings natively regardless of autoPong.)
    const target = new URL(rig.url)
    const host = target.hostname
    const port = Number(target.port)
    const reaped = await new Promise<boolean>((resolve) => {
      let upgraded = false
      const sock = net.connect(port, host, () => {
        const key = randomBytes(16).toString("base64")
        sock.write(
          `GET /ui?token=${TOKEN} HTTP/1.1\r\n` +
            `Host: ${host}:${port}\r\n` +
            `Upgrade: websocket\r\n` +
            `Connection: Upgrade\r\n` +
            `Sec-WebSocket-Key: ${key}\r\n` +
            `Sec-WebSocket-Version: 13\r\n\r\n`,
        )
      })
      sock.on("data", (buf) => {
        // Note the 101 handshake; ignore all frames (pings) — never pong.
        if (!upgraded && buf.toString("latin1").includes(" 101 ")) upgraded = true
      })
      const timer = setTimeout(() => {
        sock.destroy()
        resolve(false)
      }, 4000)
      sock.on("close", () => {
        clearTimeout(timer)
        resolve(upgraded) // upgraded then closed by the server = reaped
      })
      sock.on("error", () => {
        clearTimeout(timer)
        resolve(false)
      })
    })

    expect(reaped).toBe(true) // server terminated the silent half-open socket
    expect(liveClosed).toBe(false) // live (ponging) client untouched
    expect(live.readyState).toBe(WebSocket.OPEN)
    live.close()
  })

  // Audit finding: auth failures must produce a console.warn (IP only — no
  // token material). Good-token connects must NOT trigger a warn.
  it("emits console.warn on failed-auth upgrade, not on good-token upgrade", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    try {
      rig = await startRig()
      // Bad-token attempt: expect a warn to fire.
      await collectFrames(rig.url, { authorization: "Bearer bad-token-value" }, 1, 1000).catch(
        () => {},
      )
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/\[ui-ws\].*auth failed/),
      )
      // Good-token connect: warn must NOT fire again; log fires (first-connect).
      const warnCallsBefore = warnSpy.mock.calls.length
      await collectFrames(rig.url, { authorization: `Bearer ${TOKEN}` }, 1)
      expect(warnSpy.mock.calls.length).toBe(warnCallsBefore)
    } finally {
      warnSpy.mockRestore()
      logSpy.mockRestore()
    }
  })

  it("sends hello frame on connect with correct bearer", async () => {
    rig = await startRig()
    const frames = await collectFrames(
      rig.url,
      { authorization: `Bearer ${TOKEN}` },
      1,
    )
    expect(frames[0]?.type).toBe("hello")
    if (frames[0]?.type === "hello") {
      expect(frames[0].protocolVersion).toBe(2)
      // v2 added capability flags; base server (no chat router bound)
      // advertises chat: false. Commit 2b will flip this for the
      // chat-enabled startup path.
      expect(frames[0].capabilities.chat).toBe(false)
      expect(frames[0].capabilities.streamingDeltas).toBe(false)
      expect(frames[0].capabilities.localShell).toBe(false)
      // setup-mode = started WITHOUT a chat service (chat === null).
      expect(frames[0].capabilities.setup).toBe(true)
      // No chat service → server never emits turn-complete.
      expect(frames[0].capabilities.turnComplete).toBe(false)
    }
  })

  it("advertises and accepts local shell capability when bridge is configured", async () => {
    const bridge = createLocalShellBridge()
    rig = await startRig(undefined, { localShellBridge: bridge })
    const frames = await exchangeFrames(
      rig.url,
      { authorization: `Bearer ${TOKEN}` },
      [
        {
          type: "local-shell-capability",
          threadId: "thr_1",
          enabled: true,
          clientId: "cli_1",
          platform: "darwin",
          cwd: "/work",
        },
      ],
      2,
    )

    expect(frames[0]?.type).toBe("hello")
    if (frames[0]?.type === "hello") {
      expect(frames[0].capabilities.localShell).toBe(true)
    }
    expect(frames[1]).toMatchObject({
      type: "local-shell-status",
      threadId: "thr_1",
      enabled: true,
      accepted: true,
    })
  })

  it("keeps accepted local shell client tracked when another client disables same thread", async () => {
    const bridge = createLocalShellBridge()
    rig = await startRig(undefined, { localShellBridge: bridge })
    await exchangeFrames(
      rig.url,
      { authorization: `Bearer ${TOKEN}` },
      [
        {
          type: "local-shell-capability",
          threadId: "thr_1",
          enabled: true,
          clientId: "cli_1",
          platform: "darwin",
          cwd: "/work",
        },
        {
          type: "local-shell-capability",
          threadId: "thr_1",
          enabled: false,
          clientId: "cli_2",
          platform: "darwin",
          cwd: "/work",
        },
      ],
      3,
    )

    await rig.shutdown()

    expect(bridge.getCapability("thr_1")).toBeNull()
  })

  it("fires onLocalShellRelease when a client disables its local shell", async () => {
    const bridge = createLocalShellBridge()
    const released: Array<string> = []
    rig = await startRig(undefined, {
      localShellBridge: bridge,
      onLocalShellRelease: (threadId) => {
        released.push(threadId)
      },
    })
    await exchangeFrames(
      rig.url,
      { authorization: `Bearer ${TOKEN}` },
      [
        {
          type: "local-shell-capability",
          threadId: "thr_release",
          enabled: true,
          clientId: "cli_release",
          platform: "darwin",
          cwd: "/work",
        },
        {
          type: "local-shell-capability",
          threadId: "thr_release",
          enabled: false,
          clientId: "cli_release",
          platform: "darwin",
          cwd: "/work",
        },
      ],
      3,
    )
    expect(released).toContain("thr_release")
  })

  it("fires onLocalShellRelease for active threads when the client disconnects", async () => {
    const bridge = createLocalShellBridge()
    const released: Array<string> = []
    rig = await startRig(undefined, {
      localShellBridge: bridge,
      onLocalShellRelease: (threadId) => {
        released.push(threadId)
      },
    })
    await exchangeFrames(
      rig.url,
      { authorization: `Bearer ${TOKEN}` },
      [
        {
          type: "local-shell-capability",
          threadId: "thr_disco_a",
          enabled: true,
          clientId: "cli_disco",
          platform: "darwin",
          cwd: "/work",
        },
        {
          type: "local-shell-capability",
          threadId: "thr_disco_b",
          enabled: true,
          clientId: "cli_disco",
          platform: "darwin",
          cwd: "/work",
        },
      ],
      3,
    )
    // exchangeFrames closes the socket once it has all requested frames.
    // The server's close finalizer drains asynchronously - poll until it
    // has (deadline-bounded), instead of guessing with a fixed sleep (the
    // same race family the hello-gate fix in this file eliminates).
    await pollUntil(
      () => released.includes("thr_disco_a") && released.includes("thr_disco_b"),
      2000,
    )
    expect(released).toEqual(expect.arrayContaining(["thr_disco_a", "thr_disco_b"]))
  })

  it("keeps multi-thread local shell client tracked after disabling one thread", async () => {
    const bridge = createLocalShellBridge()
    rig = await startRig(undefined, { localShellBridge: bridge })
    await exchangeFrames(
      rig.url,
      { authorization: `Bearer ${TOKEN}` },
      [
        {
          type: "local-shell-capability",
          threadId: "thr_1",
          enabled: true,
          clientId: "cli_1",
          platform: "darwin",
          cwd: "/work",
        },
        {
          type: "local-shell-capability",
          threadId: "thr_2",
          enabled: true,
          clientId: "cli_1",
          platform: "darwin",
          cwd: "/work",
        },
        {
          type: "local-shell-capability",
          threadId: "thr_1",
          enabled: false,
          clientId: "cli_1",
          platform: "darwin",
          cwd: "/work",
        },
      ],
      4,
    )

    expect(bridge.getCapability("thr_1")).toBeNull()
    expect(bridge.getCapability("thr_2")?.clientId).toBe("cli_1")

    await rig.shutdown()

    expect(bridge.getCapability("thr_2")).toBeNull()
  })

  it("hello frame advertises configured kinds", async () => {
    rig = await startRig(undefined, {
      advertisedKinds: ["SessionStart", "Error"],
    })
    const frames = await collectFrames(
      rig.url,
      { authorization: `Bearer ${TOKEN}` },
      1,
    )
    if (frames[0]?.type === "hello") {
      expect([...frames[0].kinds]).toEqual(["SessionStart", "Error"])
    } else {
      throw new Error("expected hello frame")
    }
  })

  it("forwards a whitelisted event after subscribe", async () => {
    rig = await startRig()
    const url = rig.url
    // Subscribe first; emit only once the hello frame proves the
    // subscription exists (deterministic — no timing assumption).
    const collector = collectFramesAfterHello(
      url,
      { authorization: `Bearer ${TOKEN}` },
      2,
      3000,
    )
    await collector.hello
    await rig.obsEmit({
      kind: "SessionStart",
      ts: new Date().toISOString(),
      level: "info",
      sessionId: "s1",
      model: "x",
      optionsDigest: "y",
    })
    const frames = await collector.frames
    expect(frames.map((f) => f.type)).toEqual(["hello", "event"])
    if (frames[1]?.type === "event") {
      expect(frames[1].event.kind).toBe("SessionStart")
    }
  })

  // Locks the WS layer's indifference to event shape: every kind in
  // DEFAULT_UI_KINDS round-trips end-to-end. Auditor follow-up.
  const minimalEventFor = (kind: (typeof DEFAULT_UI_KINDS)[number]): ObsEvent => {
    const ts = new Date().toISOString()
    switch (kind) {
      case "SessionStart":
        return { ts, kind, level: "info", sessionId: "s", model: "m" }
      case "SessionEnd":
        return { ts, kind, level: "info", sessionId: "s", durationMs: 1 }
      case "ToolCall":
        return {
          ts, kind, level: "info", sessionId: "s",
          toolName: "bash", durationMs: 1, status: "success",
        }
      case "TeammateStart":
        return { ts, kind, level: "info", team: "t", teammate: "tm" }
      case "TeammateIdle":
        return { ts, kind, level: "info", team: "t", teammate: "tm", idleMs: 100 }
      case "TeammateStop":
        return { ts, kind, level: "info", team: "t", teammate: "tm", reason: "done" }
      case "WorkflowTransition":
        return { ts, kind, level: "info", workflowId: "w", from: "a", to: "b" }
      case "CostAccrued":
        return {
          ts, kind, level: "info",
          tokensIn: 1, tokensOut: 1, cacheRead: 0, cacheWrite: 0, estimatedUsd: 0.001,
        }
      case "Error":
        return { ts, kind, level: "error", errorTag: "X", message: "y" }
      default: {
        const _exhaust: never = kind
        throw new Error(`unhandled kind: ${String(_exhaust)}`)
      }
    }
  }

  for (const kind of DEFAULT_UI_KINDS) {
    it(`round-trips ${kind} events`, async () => {
      rig = await startRig()
      const collector = collectFramesAfterHello(
        rig.url,
        { authorization: `Bearer ${TOKEN}` },
        2,
        3000,
      )
      await collector.hello
      await rig.obsEmit(minimalEventFor(kind))
      const frames = await collector.frames
      expect(frames[1]?.type).toBe("event")
      if (frames[1]?.type === "event") {
        expect(frames[1].event.kind).toBe(kind)
      }
    })
  }

  it("fan-out: two clients each receive the same event", async () => {
    rig = await startRig()
    const headers = { authorization: `Bearer ${TOKEN}` }
    const aC = collectFramesAfterHello(rig.url, headers, 2, 3000)
    const bC = collectFramesAfterHello(rig.url, headers, 2, 3000)
    await Promise.all([aC.hello, bC.hello])
    await rig.obsEmit({
      kind: "SessionStart",
      ts: new Date().toISOString(),
      level: "info",
      sessionId: "s2",
      model: "m",
    })
    const [a, b] = await Promise.all([aC.frames, bC.frames])
    expect(a[1]?.type).toBe("event")
    expect(b[1]?.type).toBe("event")
  })

  it("rejects /unknown path with 404", async () => {
    rig = await startRig()
    const res = await fetch(rig.url.replace("ws://", "http://").replace("/ui", "/unknown"))
    expect(res.status).toBe(404)
  })

  it("GET / returns 404 (no static serving)", async () => {
    rig = await startRig()
    const res = await fetch(rig.url.replace("ws://", "http://").replace("/ui", "/"))
    expect(res.status).toBe(404)
  })

  it("GET /ui (non-upgrade) returns 426", async () => {
    rig = await startRig()
    const res = await fetch(rig.url.replace("ws://", "http://"))
    expect(res.status).toBe(426)
  })

  it("GET /ui?foo=bar (non-upgrade) still returns 426 despite the query string", async () => {
    rig = await startRig()
    const res = await fetch(`${rig.url.replace("ws://", "http://")}?foo=bar`)
    expect(res.status).toBe(426)
  })

  it("/healthz returns 200", async () => {
    rig = await startRig()
    const res = await fetch(rig.url.replace("ws://", "http://").replace("/ui", "/healthz"))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("ok")
  })

  it("/healthz?format=json still hits the health endpoint despite the query string", async () => {
    rig = await startRig()
    const res = await fetch(
      rig.url.replace("ws://", "http://").replace("/ui", "/healthz?format=json"),
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("ok")
  })

  it("/readyz reports normal mode (no setupPty) — the update-server readiness signal", async () => {
    rig = await startRig()
    const res = await fetch(rig.url.replace("ws://", "http://").replace("/ui", "/readyz"))
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("application/json")
    expect(await res.json()).toEqual({ status: "ok", mode: "normal", credentialOk: true })
  })

  it("/readyz includes additive scheduler block when getSchedulerHealth is threaded", async () => {
    const scheduler = {
      status: "ok" as const,
      lastTickAt: 1_700_000_000_000,
      lastTickAgeMs: 1_200,
      inFlight: 0,
      tickIntervalMs: 60_000,
      lastTick: {
        considered: 0,
        claimed: 0,
        forked: 0,
        skippedInFlight: 0,
        skippedNoCapacity: 0,
        failedInline: 0,
      },
    }
    rig = await startRig(undefined, { getSchedulerHealth: () => scheduler })
    const res = await fetch(rig.url.replace("ws://", "http://").replace("/ui", "/readyz"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      status: "ok",
      mode: "normal",
      credentialOk: true,
      scheduler,
    })
  })

  it("/readyz top-level stays ok when scheduler is degraded unless strictSchedulerReady", async () => {
    const degraded = {
      status: "degraded" as const,
      lastTickAt: 1,
      lastTickAgeMs: 999_999,
      inFlight: 2,
      tickIntervalMs: 60_000,
      lastTick: {
        considered: 1,
        claimed: 1,
        forked: 1,
        skippedInFlight: 0,
        skippedNoCapacity: 0,
        failedInline: 0,
      },
    }
    rig = await startRig(undefined, { getSchedulerHealth: () => degraded })
    const soft = await fetch(rig.url.replace("ws://", "http://").replace("/ui", "/readyz"))
    expect(await soft.json()).toMatchObject({ status: "ok", scheduler: { status: "degraded" } })

    // Restart with strict flag
    await rig.shutdown()
    rig = await startRig(undefined, {
      getSchedulerHealth: () => degraded,
      strictSchedulerReady: true,
    })
    const hard = await fetch(rig.url.replace("ws://", "http://").replace("/ui", "/readyz"))
    expect(await hard.json()).toMatchObject({
      status: "degraded",
      scheduler: { status: "degraded" },
    })
  })

  it("/readyz reports setup mode when setupPty is set (credential gate not passed)", async () => {
    const setupPty = {
      onConnect: () => ({ write: () => {}, resize: () => {}, close: () => {} }),
    }
    rig = await startRig(undefined, { setupPty })
    const res = await fetch(rig.url.replace("ws://", "http://").replace("/ui", "/readyz"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: "ok", mode: "setup", credentialOk: false })
  })

  it("surfaces buildSha in /readyz and the hello frame when threaded in (build identity, additive)", async () => {
    // Presence path for both ui-ws surfaces — the absence path is already
    // covered by the two /readyz tests above (which omit buildSha and pin the
    // exact {status,mode,credentialOk} shape). Here we thread it and assert it
    // lands in BOTH /readyz JSON and the connect-time hello frame.
    rig = await startRig(undefined, { buildSha: "testsha" })

    const res = await fetch(rig.url.replace("ws://", "http://").replace("/ui", "/readyz"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      status: "ok",
      mode: "normal",
      credentialOk: true,
      buildSha: "testsha",
    })

    const frames = await collectFrames(
      rig.url,
      { authorization: `Bearer ${TOKEN}` },
      1,
    )
    if (frames[0]?.type === "hello") {
      expect(frames[0].buildSha).toBe("testsha")
    } else {
      throw new Error("expected hello frame")
    }
  })

  it("surfaces serverVersion in /readyz and the hello frame when threaded in (release identity, additive)", async () => {
    // Mirrors the buildSha reach test above: thread serverVersion and assert it
    // lands in BOTH /readyz JSON and the connect-time hello frame.
    rig = await startRig(undefined, { serverVersion: "0.1.0" })

    const res = await fetch(rig.url.replace("ws://", "http://").replace("/ui", "/readyz"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      status: "ok",
      mode: "normal",
      credentialOk: true,
      serverVersion: "0.1.0",
    })

    const frames = await collectFrames(
      rig.url,
      { authorization: `Bearer ${TOKEN}` },
      1,
    )
    if (frames[0]?.type === "hello") {
      expect(frames[0].serverVersion).toBe("0.1.0")
    } else {
      throw new Error("expected hello frame")
    }
  })

  it("omits serverVersion from /readyz and the hello frame when not configured (back-compat)", async () => {
    // Absence path: a server started without serverVersion must NOT emit the
    // field on the wire (not present, not undefined/null) so older consumers
    // and the existing {status,mode,credentialOk} shape are unaffected.
    rig = await startRig()

    const res = await fetch(rig.url.replace("ws://", "http://").replace("/ui", "/readyz"))
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(Object.prototype.hasOwnProperty.call(body, "serverVersion")).toBe(false)

    const frames = await collectFrames(
      rig.url,
      { authorization: `Bearer ${TOKEN}` },
      1,
    )
    if (frames[0]?.type === "hello") {
      expect(Object.prototype.hasOwnProperty.call(frames[0], "serverVersion")).toBe(false)
    } else {
      throw new Error("expected hello frame")
    }
  })

  it("refuses to start with token shorter than 16 chars", async () => {
    const baseLayer = makeFullLayer()
    const badLayer = Layer.effect(
      ServerHandle,
      startUIWebSocketServer({ port: 0, token: "short" }),
    ).pipe(Layer.provide(baseLayer))
    const runtime = ManagedRuntime.make(Layer.mergeAll(badLayer, baseLayer))
    await expect(runtime.runPromise(ServerHandle)).rejects.toThrow(
      /token must be set/,
    )
    await runtime.dispose()
  })

  // ── availableModels in hello frame ──────────────────────────────────────
  // Same additive pattern as buildSha: present when threaded in, absent otherwise.

  it("hello frame includes availableModels when configured", async () => {
    const models = [
      { id: "claude-sonnet-4-6", label: "Sonnet 4.6 — balanced" },
      { id: "claude-haiku-4-5",  label: "Haiku 4.5 — fastest" },
    ]
    rig = await startRig(undefined, { availableModels: models })
    const frames = await collectFrames(
      rig.url,
      { authorization: `Bearer ${TOKEN}` },
      1,
    )
    if (frames[0]?.type === "hello") {
      expect(frames[0].availableModels).toEqual(models)
    } else {
      throw new Error("expected hello frame")
    }
  })

  it("hello frame omits availableModels when not configured", async () => {
    // Server started without availableModels → the field must be absent from
    // the wire (not present as undefined or null). Older clients rely on
    // strict absence to detect old servers and fall back to their own list.
    rig = await startRig()
    const frames = await collectFrames(
      rig.url,
      { authorization: `Bearer ${TOKEN}` },
      1,
    )
    if (frames[0]?.type === "hello") {
      expect(Object.prototype.hasOwnProperty.call(frames[0], "availableModels")).toBe(false)
    } else {
      throw new Error("expected hello frame")
    }
  })

  // ── efforts in hello frame ────────────────────────────────────────────────
  // The server populates the `efforts` field per model entry so clients never
  // compute the matrix themselves. Haiku → [], Fable/Opus-4.8 → all 5 levels.

  it("hello frame: haiku model entry has empty efforts array", async () => {
    const models = [
      { id: "claude-haiku-4-5", label: "Haiku 4.5", efforts: [] as readonly string[] },
    ]
    rig = await startRig(undefined, { availableModels: models })
    const frames = await collectFrames(rig.url, { authorization: `Bearer ${TOKEN}` }, 1)
    if (frames[0]?.type === "hello") {
      const haiku = frames[0].availableModels?.find((m) => m.id === "claude-haiku-4-5")
      expect(haiku?.efforts).toEqual([])
    } else {
      throw new Error("expected hello frame")
    }
  })

  it("hello frame: fable model entry has all 5 effort levels", async () => {
    const allEfforts = ["low", "medium", "high", "xhigh", "max"] as const
    const models = [
      { id: "claude-fable-5", label: "Fable 5", efforts: allEfforts as readonly string[] },
    ]
    rig = await startRig(undefined, { availableModels: models })
    const frames = await collectFrames(rig.url, { authorization: `Bearer ${TOKEN}` }, 1)
    if (frames[0]?.type === "hello") {
      const fable = frames[0].availableModels?.find((m) => m.id === "claude-fable-5")
      expect(fable?.efforts).toEqual(["low", "medium", "high", "xhigh", "max"])
    } else {
      throw new Error("expected hello frame")
    }
  })

  it("hello frame: effortSelection capability is present when chat is wired in", async () => {
    // The effortSelection capability is set to `chat !== null` in server.ts — it's
    // only absent when no chat service is attached (the non-chat rig used here).
    // In the basic server.test.ts rig, chat IS null → effortSelection must be false.
    rig = await startRig()
    const frames = await collectFrames(rig.url, { authorization: `Bearer ${TOKEN}` }, 1)
    if (frames[0]?.type === "hello") {
      // Capability is present (even if false for no-chat rig).
      expect(Object.prototype.hasOwnProperty.call(frames[0].capabilities, "effortSelection")).toBe(true)
      // No chat attached → false.
      expect(frames[0].capabilities?.effortSelection).toBe(false)
    } else {
      throw new Error("expected hello frame")
    }
  })
})
