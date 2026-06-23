/**
 * Tests for ConnectionManager (Chunk 4-A).
 *
 * Uses instrumented/fake adapters (no real network) to verify:
 *   - Same route → shared adapter (attach called once), same refcount
 *   - Different routes → independent adapters
 *   - Concurrent first-acquire → deduped attach (fires once)
 *   - release() at refcount 0 → dispose() called
 *   - Double-release is safe (idempotent)
 */

import { describe, expect, it, vi } from "vitest"
import { ConnectionManager } from "../src/pool/connection-manager.js"
import type { RouteHandle } from "../src/pool/connection-manager.js"
import type {
  AttachResult,
  ClientTransportAdapter,
  ConnectionState,
  RouteConfig,
} from "../src/contract.js"
import type { ServerDescriptor } from "../src/contract.js"

// ── fake adapter factory ─────────────────────────────────────────────────────

function makeDescriptor(name: string): ServerDescriptor {
  return {
    descriptorSchema: 1,
    generation: 1,
    issuedAt: new Date().toISOString(),
    negotiation: { agreed: 2 },
    identity: {
      name,
      kind: "luna-chat-server",
      version: "0.0.1-test",
    },
    runtimeSummary: { category: "host-process", live: true },
    capabilities: [{ operation: "interact", available: true, authz: { allowed: true } }],
    health: { status: "normal" },
  }
}

/** A minimal fake adapter that records attach/dispose calls. */
class FakeAdapter implements ClientTransportAdapter {
  readonly routeKey: string
  readonly transportKind = "fake" as const

  readonly attachCalls: number[] = []
  readonly disposeCalls: number[] = []

  private _callCount = 0

  // Allow simulating a slow attach for concurrency tests.
  private _attachDelay: number

  constructor(route: RouteConfig, attachDelay = 0) {
    this.routeKey = route.routeKey
    this._attachDelay = attachDelay
  }

  async attach(): Promise<AttachResult> {
    if (this._attachDelay > 0) {
      await new Promise((r) => setTimeout(r, this._attachDelay))
    }
    this.attachCalls.push(++this._callCount)
    return {
      descriptor: makeDescriptor(this.routeKey),
      origin: "server-emitted",
    }
  }

  async describe(): Promise<AttachResult> {
    return this.attach()
  }

  get descriptorChanges(): AsyncIterable<AttachResult> {
    return { [Symbol.asyncIterator]: () => ({ next: async () => ({ value: undefined as unknown as AttachResult, done: true }) }) }
  }

  get connection(): AsyncIterable<ConnectionState> {
    return { [Symbol.asyncIterator]: () => ({ next: async () => ({ value: undefined as unknown as ConnectionState, done: true }) }) }
  }

  async openSession() {
    throw new Error("not implemented in FakeAdapter")
  }

  async dispose(): Promise<void> {
    this.disposeCalls.push(1)
  }
}

/** Build a factory that creates FakeAdapters and tracks them by routeKey. */
function makeFakeFactory(opts: { attachDelay?: number } = {}) {
  const created = new Map<string, FakeAdapter>()

  function factory(route: RouteConfig): ClientTransportAdapter {
    const adapter = new FakeAdapter(route, opts.attachDelay)
    created.set(route.routeKey, adapter)
    return adapter
  }

  return { factory, created }
}

function routeConfig(routeKey: string): RouteConfig {
  return {
    routeKey,
    endpoints: [`ws://fake-${routeKey}:4753/ui`],
    tokenRef: "env:FAKE_TOKEN",
  }
}

function makeRoutes(...keys: string[]): Map<string, RouteConfig> {
  return new Map(keys.map((k) => [k, routeConfig(k)]))
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("ConnectionManager", () => {
  // ── same route → shared adapter ────────────────────────────────────────────

  describe("same route — shared adapter, attach called once", () => {
    it("two acquires of the same route return the same adapter", async () => {
      const { factory, created } = makeFakeFactory()
      const mgr = new ConnectionManager(makeRoutes("route-a"), factory)

      const h1 = await mgr.acquire("route-a")
      const h2 = await mgr.acquire("route-a")

      expect(h1.adapter).toBe(h2.adapter)
      expect(created.get("route-a")!.attachCalls).toHaveLength(1)

      await h1.release()
      await h2.release()
      await mgr.disposeAll()
    })

    it("two acquires use the same underlying connection (same AttachResult reference)", async () => {
      const { factory } = makeFakeFactory()
      const mgr = new ConnectionManager(makeRoutes("route-a"), factory)

      const h1 = await mgr.acquire("route-a")
      const h2 = await mgr.acquire("route-a")

      expect(h1.attachResult).toBe(h2.attachResult)

      await h1.release()
      await h2.release()
      await mgr.disposeAll()
    })
  })

  // ── different routes → independent adapters ────────────────────────────────

  describe("different routes → independent adapters", () => {
    it("each route gets its own adapter", async () => {
      const { factory, created } = makeFakeFactory()
      const mgr = new ConnectionManager(makeRoutes("route-a", "route-b"), factory)

      const hA = await mgr.acquire("route-a")
      const hB = await mgr.acquire("route-b")

      expect(hA.adapter).not.toBe(hB.adapter)
      expect(created.get("route-a")).toBeDefined()
      expect(created.get("route-b")).toBeDefined()
      expect(created.get("route-a")).not.toBe(created.get("route-b"))

      await hA.release()
      await hB.release()
      await mgr.disposeAll()
    })

    it("disposing one route leaves the other alive", async () => {
      const { factory, created } = makeFakeFactory()
      const mgr = new ConnectionManager(makeRoutes("route-a", "route-b"), factory)

      const hA = await mgr.acquire("route-a")
      const hB = await mgr.acquire("route-b")

      // Release route-a (refcount → 0 → dispose)
      await hA.release()

      const adapterA = created.get("route-a")!
      const adapterB = created.get("route-b")!

      // route-a was disposed
      expect(adapterA.disposeCalls).toHaveLength(1)
      // route-b is still live
      expect(adapterB.disposeCalls).toHaveLength(0)

      await hB.release()
      await mgr.disposeAll()
    })
  })

  // ── refcount: release disposes only at 0 ───────────────────────────────────

  describe("refcount — dispose only when last holder releases", () => {
    it("adapter is NOT disposed when a second holder still holds a ref", async () => {
      const { factory, created } = makeFakeFactory()
      const mgr = new ConnectionManager(makeRoutes("route-a"), factory)

      const h1 = await mgr.acquire("route-a")
      const h2 = await mgr.acquire("route-a")

      await h1.release()
      // h2 still holds — should not have disposed
      expect(created.get("route-a")!.disposeCalls).toHaveLength(0)

      await h2.release()
      // Now both released — should be disposed
      expect(created.get("route-a")!.disposeCalls).toHaveLength(1)

      await mgr.disposeAll()
    })

    it("three holders: dispose fires only when all three release", async () => {
      const { factory, created } = makeFakeFactory()
      const mgr = new ConnectionManager(makeRoutes("route-a"), factory)

      const [h1, h2, h3] = await Promise.all([
        mgr.acquire("route-a"),
        mgr.acquire("route-a"),
        mgr.acquire("route-a"),
      ])

      await h1.release()
      expect(created.get("route-a")!.disposeCalls).toHaveLength(0)

      await h2.release()
      expect(created.get("route-a")!.disposeCalls).toHaveLength(0)

      await h3.release()
      expect(created.get("route-a")!.disposeCalls).toHaveLength(1)

      await mgr.disposeAll()
    })
  })

  // ── concurrent first-acquire → deduped attach ─────────────────────────────

  describe("concurrent first-acquire deduplication", () => {
    it("two simultaneous acquires call attach exactly once", async () => {
      // Use a small attachDelay so both acquires start before the first resolves.
      const { factory, created } = makeFakeFactory({ attachDelay: 20 })
      const mgr = new ConnectionManager(makeRoutes("route-a"), factory)

      // Fire both simultaneously — neither has resolved before the other starts.
      const [h1, h2] = await Promise.all([
        mgr.acquire("route-a"),
        mgr.acquire("route-a"),
      ])

      const adapter = created.get("route-a")!
      // attach must have fired exactly once despite concurrent callers.
      expect(adapter.attachCalls).toHaveLength(1)
      // Both handles point at the same adapter.
      expect(h1.adapter).toBe(h2.adapter)

      await h1.release()
      await h2.release()
      await mgr.disposeAll()
    })

    it("five concurrent acquires: attach fires once, all get same adapter", async () => {
      const { factory, created } = makeFakeFactory({ attachDelay: 15 })
      const mgr = new ConnectionManager(makeRoutes("route-a"), factory)

      const handles = await Promise.all(
        Array.from({ length: 5 }, () => mgr.acquire("route-a")),
      )

      expect(created.get("route-a")!.attachCalls).toHaveLength(1)
      // All five handles share the same adapter instance.
      const first = handles[0]!.adapter
      for (const h of handles) expect(h.adapter).toBe(first)

      await Promise.all(handles.map((h) => h.release()))
      await mgr.disposeAll()
    })
  })

  // ── double-release safety ──────────────────────────────────────────────────

  describe("double-release — idempotent", () => {
    it("calling release() twice on the same handle is safe", async () => {
      const { factory, created } = makeFakeFactory()
      const mgr = new ConnectionManager(makeRoutes("route-a"), factory)

      const h = await mgr.acquire("route-a")
      await h.release()
      await h.release() // second release must not throw or double-dispose

      // dispose should have been called exactly once.
      expect(created.get("route-a")!.disposeCalls).toHaveLength(1)

      await mgr.disposeAll()
    })

    it("double-release does NOT dispose a live shared connection", async () => {
      const { factory, created } = makeFakeFactory()
      const mgr = new ConnectionManager(makeRoutes("route-a"), factory)

      const h1 = await mgr.acquire("route-a")
      const h2 = await mgr.acquire("route-a")

      // Double-release h1 — h2 still holds, so dispose must NOT fire.
      await h1.release()
      await h1.release()

      expect(created.get("route-a")!.disposeCalls).toHaveLength(0)

      await h2.release()
      expect(created.get("route-a")!.disposeCalls).toHaveLength(1)

      await mgr.disposeAll()
    })
  })

  // ── unknown route ──────────────────────────────────────────────────────────

  describe("unknown route", () => {
    it("throws on acquire for an unconfigured route", async () => {
      const mgr = new ConnectionManager(makeRoutes("route-a"))
      await expect(mgr.acquire("missing-route")).rejects.toThrow("unknown route")
    })
  })

  // ── informational helpers ──────────────────────────────────────────────────

  describe("listRoutes / descriptorFor", () => {
    it("listRoutes returns all configured routes", () => {
      const mgr = new ConnectionManager(makeRoutes("route-a", "route-b", "route-c"))
      const listed = mgr.listRoutes()
      expect([...listed.keys()].sort()).toEqual(["route-a", "route-b", "route-c"])
    })

    it("descriptorFor returns config for known route, undefined for unknown", () => {
      const mgr = new ConnectionManager(makeRoutes("route-a"))
      expect(mgr.descriptorFor("route-a")).toBeDefined()
      expect(mgr.descriptorFor("unknown")).toBeUndefined()
    })
  })

  // ── disposeAll ─────────────────────────────────────────────────────────────

  describe("disposeAll", () => {
    it("disposes all live connections", async () => {
      const { factory, created } = makeFakeFactory()
      const mgr = new ConnectionManager(makeRoutes("route-a", "route-b"), factory)

      await mgr.acquire("route-a")
      await mgr.acquire("route-b")

      await mgr.disposeAll()

      expect(created.get("route-a")!.disposeCalls).toHaveLength(1)
      expect(created.get("route-b")!.disposeCalls).toHaveLength(1)
    })

    it("throws after disposeAll", async () => {
      const mgr = new ConnectionManager(makeRoutes("route-a"))
      await mgr.disposeAll()
      await expect(mgr.acquire("route-a")).rejects.toThrow("disposed")
    })
  })

  // ── failure-path regression tests (FIX 4 + reviewer gaps) ─────────────────

  describe("failure-path regression tests", () => {
    /**
     * Injectable FakeAdapter that can be told to reject attach().
     * Subsequent instances created by the factory start fresh (no shared state).
     */
    class FailableAdapter implements ClientTransportAdapter {
      readonly routeKey: string
      readonly transportKind = "failable" as const
      readonly attachCalls: number[] = []
      readonly disposeCalls: number[] = []
      private _callCount = 0
      private _attachDelay: number

      constructor(
        route: RouteConfig,
        private readonly shouldFail: () => boolean,
        attachDelay = 0,
      ) {
        this.routeKey = route.routeKey
        this._attachDelay = attachDelay
      }

      async attach(): Promise<AttachResult> {
        if (this._attachDelay > 0) {
          await new Promise((r) => setTimeout(r, this._attachDelay))
        }
        this.attachCalls.push(++this._callCount)
        if (this.shouldFail()) {
          throw new Error(`attach() rejected for ${this.routeKey}`)
        }
        return { descriptor: makeDescriptor(this.routeKey), origin: "server-emitted" }
      }

      async describe(): Promise<AttachResult> { return this.attach() }

      get descriptorChanges(): AsyncIterable<AttachResult> {
        return { [Symbol.asyncIterator]: () => ({ next: async () => ({ value: undefined as unknown as AttachResult, done: true as const }) }) }
      }

      get connection(): AsyncIterable<ConnectionState> {
        return { [Symbol.asyncIterator]: () => ({ next: async () => ({ value: undefined as unknown as ConnectionState, done: true as const }) }) }
      }

      async openSession() { throw new Error("not implemented") }
      async dispose(): Promise<void> { this.disposeCalls.push(1) }
    }

    it("adapter whose attach() rejects → acquire rejects, no pool poisoning, later acquire retries and succeeds", async () => {
      let failCount = 0
      let adapterInstances: FailableAdapter[] = []

      // First call: fail. Second call: succeed.
      const factory = (route: RouteConfig) => {
        const adapter = new FailableAdapter(route, () => {
          failCount++
          return failCount === 1  // only first attach fails
        })
        adapterInstances.push(adapter)
        return adapter
      }

      const mgr = new ConnectionManager(makeRoutes("route-a"), factory)

      // First acquire — should fail
      await expect(mgr.acquire("route-a")).rejects.toThrow(/attach\(\) rejected/)

      // Pool must NOT be poisoned: second acquire should retry and succeed
      const h = await mgr.acquire("route-a")
      expect(h.routeKey).toBe("route-a")

      // The second adapter's attach must have been called
      expect(adapterInstances).toHaveLength(2)
      expect(adapterInstances[0]!.attachCalls).toHaveLength(1)
      expect(adapterInstances[1]!.attachCalls).toHaveLength(1)

      await h.release()
      await mgr.disposeAll()
    })

    it("concurrent first-acquires that both reject, then a later one succeeds", async () => {
      let adapterCount = 0

      // First adapter (count=1) fails; second adapter (count=2) succeeds.
      // Two concurrent acquires share one in-flight → both see the first adapter fail.
      // The retry creates a second adapter which succeeds.
      const factory = (route: RouteConfig) => {
        const thisCount = ++adapterCount
        return new FailableAdapter(route, () => thisCount === 1 /* only first fails */, 20)
      }

      const mgr = new ConnectionManager(makeRoutes("route-a"), factory)

      // Two concurrent acquires that both fail (they share the same in-flight promise)
      const [r1, r2] = await Promise.allSettled([
        mgr.acquire("route-a"),
        mgr.acquire("route-a"),
      ])
      expect(r1.status).toBe("rejected")
      expect(r2.status).toBe("rejected")

      // Both join the same in-flight — only ONE adapter created so far (dedup)
      expect(adapterCount).toBe(1)

      // A later acquire should work (creates a new adapter, adapter #2 succeeds)
      const h = await mgr.acquire("route-a")
      expect(h.routeKey).toBe("route-a")
      expect(adapterCount).toBe(2)

      await h.release()
      await mgr.disposeAll()
    })

    it("release after disposeAll is a safe no-op", async () => {
      const { factory } = makeFakeFactory()
      const mgr = new ConnectionManager(makeRoutes("route-a"), factory)

      const h = await mgr.acquire("route-a")
      await mgr.disposeAll()

      // release() after disposeAll must not throw
      await expect(h.release()).resolves.toBeUndefined()
    })

    it("acquire racing release-to-zero does not resurrect a disposed adapter", async () => {
      // Strategy: acquire h1, release it (drops to 0, disposes), then immediately
      // acquire again — a NEW adapter must be created (not the disposed one).
      const created: FailableAdapter[] = []
      const factory = (route: RouteConfig) => {
        const a = new FailableAdapter(route, () => false)
        created.push(a)
        return a
      }

      const mgr = new ConnectionManager(makeRoutes("route-a"), factory)

      const h1 = await mgr.acquire("route-a")
      await h1.release()

      // First adapter was disposed at refcount 0
      expect(created[0]!.disposeCalls).toHaveLength(1)

      // Acquire again — must create a NEW adapter
      const h2 = await mgr.acquire("route-a")
      expect(created).toHaveLength(2)
      expect(h2.adapter).not.toBe(created[0])

      // The new adapter is NOT disposed
      expect(created[1]!.disposeCalls).toHaveLength(0)

      await h2.release()
      await mgr.disposeAll()
    })

    it("disposeAll races attach-in-flight → freshly-built adapter is disposed, not leaked", async () => {
      // Start an acquire with a slow attach, then call disposeAll before it resolves.
      // The #startAttach guard must detect #disposed=true after attach resolves
      // and immediately dispose the adapter.
      let attachedAdapter: FailableAdapter | null = null
      const factory = (route: RouteConfig) => {
        const a = new FailableAdapter(route, () => false, 50 /* ms */)
        attachedAdapter = a
        return a
      }

      const mgr = new ConnectionManager(makeRoutes("route-a"), factory)

      // Start acquire (will take ~50ms to attach)
      const acquirePromise = mgr.acquire("route-a")

      // Immediately dispose all — races with the slow attach
      await mgr.disposeAll()

      // The acquire should reject because the manager was disposed mid-attach
      await expect(acquirePromise).rejects.toThrow(/disposed/)

      // The adapter that was created must have been disposed (not leaked)
      expect(attachedAdapter).not.toBeNull()
      expect(attachedAdapter!.disposeCalls).toHaveLength(1)
    })
  })
})
