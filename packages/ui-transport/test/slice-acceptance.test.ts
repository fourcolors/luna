/**
 * Slice acceptance test — Phase-0 criterion from deploy-router-abstraction.md
 *
 * Proves: TWO routes open concurrently, each with its own descriptor origin,
 * the rollback differentiator is correct, and closing one leaves the other live.
 *
 * Does NOT require a browser — runs entirely in Node/Bun via the existing
 * ws-package-based WsFactory pattern used in luna-ws-adapter.test.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import WebSocket from "ws"
import { startLunaStub } from "../src/dev/luna-stub.js"
import { startHermesStub } from "../src/dev/hermes-stub.js"
import { ConnectionManager } from "../src/pool/connection-manager.js"
import { LunaWsAdapter } from "../src/adapters/luna-ws.js"
import { HermesHttpSseAdapter } from "../src/adapters/hermes-http-sse.js"
import type { LunaStubHandle } from "../src/dev/luna-stub.js"
import type { HermesStubHandle } from "../src/dev/hermes-stub.js"
import type { RouteConfig } from "../src/contract.js"

// ── Test fixtures ─────────────────────────────────────────────────────────────

const LUNA_TOKEN = "acceptance-luna-token"
const HERMES_TOKEN = "acceptance-hermes-token"

let lunaStub: LunaStubHandle
let hermesStub: HermesStubHandle
let manager: ConnectionManager

beforeAll(async () => {
  // Start both stubs in parallel
  ;[lunaStub, hermesStub] = await Promise.all([
    startLunaStub({ token: LUNA_TOKEN }),
    startHermesStub({ token: HERMES_TOKEN }),
  ])

  // Build a route map with BOTH routes — this is the 2-route config
  const routes = new Map<string, RouteConfig>([
    [
      "luna-local",
      {
        routeKey: "luna-local",
        endpoints: [lunaStub.url],
        tokenRef: LUNA_TOKEN,
        label: "Luna (local stub)",
      },
    ],
    [
      "hermes-local",
      {
        routeKey: "hermes-local",
        // HermesHttpSseAdapter appends /health and /v1/capabilities itself —
        // provide the root URL without a /v1 suffix.
        endpoints: [hermesStub.url],
        tokenRef: HERMES_TOKEN,
        label: "Hermes (local stub)",
      },
    ],
  ])

  // Node WsFactory — injects ws package WebSocket (supports headers, needed in Node)
  function nodeWsFactory(url: string) {
    return new WebSocket(url) as unknown as globalThis.WebSocket
  }

  // Use a custom adapter factory that wires Node-compatible adapters
  manager = new ConnectionManager(routes, (route) => {
    const firstEndpoint = route.endpoints[0] ?? ""
    const scheme = new URL(firstEndpoint).protocol
    if (scheme === "ws:" || scheme === "wss:") {
      return new LunaWsAdapter(route, nodeWsFactory)
    }
    if (scheme === "http:" || scheme === "https:") {
      return new HermesHttpSseAdapter(route)
    }
    throw new Error(`No adapter for scheme: ${scheme}`)
  })
})

afterAll(async () => {
  await manager.disposeAll()
  await Promise.allSettled([lunaStub.stop(), hermesStub.stop()])
})

// ── Acceptance criteria ────────────────────────────────────────────────────────

describe("Phase-0 acceptance: two panels, two routes, two descriptor origins", () => {
  it("acquires BOTH routes concurrently and both succeed", async () => {
    // Both panels bind simultaneously — proves concurrent multi-route
    const [lunaHandle, hermesHandle] = await Promise.all([
      manager.acquire("luna-local"),
      manager.acquire("hermes-local"),
    ])

    expect(lunaHandle.routeKey).toBe("luna-local")
    expect(hermesHandle.routeKey).toBe("hermes-local")

    // Cleanup for this subtest — but we need handles in subsequent tests,
    // so we release both and re-acquire below in the dedicated tests.
    await Promise.all([lunaHandle.release(), hermesHandle.release()])
  })

  it("Luna descriptor: kind=luna-chat-server, origin=server-emitted, revertible=TRUE", async () => {
    const handle = await manager.acquire("luna-local")
    try {
      const { descriptor, origin } = handle.attachResult

      // Identity
      expect(descriptor.identity.kind).toBe("luna-chat-server")
      expect(descriptor.identity.displayName).toBe("Luna")
      expect(descriptor.identity.version).toBeTruthy()

      // Origin: Luna emits its descriptor inside the hello frame (server-emitted)
      expect(origin).toBe("server-emitted")

      // THE DIFFERENTIATOR: revertible=true → "Rollback" button MUST be rendered
      expect(descriptor.update).toBeDefined()
      expect(descriptor.update?.revertible).toBe(true)

      // Sanity: health + capabilities present
      expect(descriptor.health.status).toBe("normal")
      const interactCap = descriptor.capabilities.find((c) => c.operation === "interact")
      expect(interactCap).toBeDefined()
      expect(interactCap?.available).toBe(true)
    } finally {
      await handle.release()
    }
  })

  it("Hermes descriptor: kind=hermes, origin=client-projected, revertible=FALSE", async () => {
    const handle = await manager.acquire("hermes-local")
    try {
      const { descriptor, origin } = handle.attachResult

      // Identity
      expect(descriptor.identity.kind).toBe("hermes")
      expect(descriptor.identity.displayName).toBe("Hermes (Nous agent)")
      expect(descriptor.identity.version).toBeTruthy()

      // Origin: Hermes has no hello frame → adapter projects descriptor client-side
      expect(origin).toBe("client-projected")

      // THE DIFFERENTIATOR: revertible=false → NO "Rollback" button
      expect(descriptor.update).toBeDefined()
      expect(descriptor.update?.revertible).toBe(false)

      // Sanity: health + capabilities
      expect(descriptor.health.status).toBe("normal")
      const interactCap = descriptor.capabilities.find((c) => c.operation === "interact")
      expect(interactCap).toBeDefined()
    } finally {
      await handle.release()
    }
  })

  it("both handles are live simultaneously (concurrent binding)", async () => {
    const [lunaHandle, hermesHandle] = await Promise.all([
      manager.acquire("luna-local"),
      manager.acquire("hermes-local"),
    ])

    // Both live at the same time
    expect(lunaHandle.attachResult.descriptor.identity.kind).toBe("luna-chat-server")
    expect(hermesHandle.attachResult.descriptor.identity.kind).toBe("hermes")

    // Opposite origins simultaneously
    expect(lunaHandle.attachResult.origin).toBe("server-emitted")
    expect(hermesHandle.attachResult.origin).toBe("client-projected")

    // Opposite revertible values simultaneously — THE DIFFERENTIATOR
    expect(lunaHandle.attachResult.descriptor.update?.revertible).toBe(true)
    expect(hermesHandle.attachResult.descriptor.update?.revertible).toBe(false)

    await Promise.all([lunaHandle.release(), hermesHandle.release()])
  })

  it("releasing Hermes leaves Luna handle still live and usable", async () => {
    const [lunaHandle, hermesHandle] = await Promise.all([
      manager.acquire("luna-local"),
      manager.acquire("hermes-local"),
    ])

    // Close Hermes panel
    await hermesHandle.release()

    // Luna handle must still be usable — descriptor still readable
    expect(lunaHandle.attachResult.descriptor.identity.kind).toBe("luna-chat-server")
    expect(lunaHandle.attachResult.descriptor.update?.revertible).toBe(true)

    // Can still open a session on Luna after Hermes is gone
    const nodeWsFactory = (url: string) => new WebSocket(url) as unknown as globalThis.WebSocket
    const session = await lunaHandle.adapter.openSession({})
    expect(session.threadId).toBeTruthy()

    // Send a message — adapter should stream back delta frames
    const frames: string[] = []
    const collectPromise = (async () => {
      for await (const frame of session.messages) {
        if (frame.t === "delta") frames.push(frame.text)
        if (frame.t === "done") break
      }
    })()

    await session.send({ text: "hello from acceptance test" })
    await collectPromise
    session.close()

    // Luna stub emits 4 deltas — at least one should arrive
    expect(frames.length).toBeGreaterThan(0)
    expect(frames[0]).toContain("hello from acceptance test")

    await lunaHandle.release()
  })

  it("Luna openSession streams delta frames end-to-end", async () => {
    const handle = await manager.acquire("luna-local")
    try {
      const session = await handle.adapter.openSession({})
      expect(session.threadId).toMatch(/^thread-stub-/)

      const deltas: string[] = []
      const donePromise = (async () => {
        for await (const frame of session.messages) {
          if (frame.t === "delta") deltas.push(frame.text)
          if (frame.t === "done") break
        }
      })()

      await session.send({ text: "ping" })
      await donePromise
      session.close()

      expect(deltas.length).toBeGreaterThan(0)
      expect(deltas.join("")).toContain("ping")
    } finally {
      await handle.release()
    }
  })

  it("Hermes openSession streams SSE delta frames end-to-end", async () => {
    const handle = await manager.acquire("hermes-local")
    try {
      const session = await handle.adapter.openSession({})
      expect(session.threadId).toBeTruthy()

      const deltas: string[] = []
      const donePromise = (async () => {
        for await (const frame of session.messages) {
          if (frame.t === "delta") deltas.push(frame.text)
          if (frame.t === "done") break
        }
      })()

      await session.send({ text: "pong" })
      await donePromise
      session.close()

      expect(deltas.length).toBeGreaterThan(0)
      expect(deltas.join("")).toContain("pong")
    } finally {
      await handle.release()
    }
  })
})
