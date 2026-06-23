/**
 * ConnectionManager — process-wide pool of reference-counted ClientTransportAdapters.
 *
 * Constructed with a pre-parsed Map<routeKey, RouteConfig>. No file I/O here;
 * bootstrap parsing lives in ../bootstrap/client-config.ts and the caller
 * injects the resolved route map. This keeps the pool fully testable with
 * fake configs and fake/instrumented adapters.
 *
 * Design: §9.1.1 of deploy-router-abstraction.md
 *   - Pool key = routeKey (NOT resolved URL — see token-scope safety note in §9.1.1)
 *   - First acquire for a route: create + attach() once, cache adapter + AttachResult.
 *   - Concurrent first-acquires for same route share a single in-flight attach promise
 *     (the "attach inflight" dedup), so attach() fires exactly once per route even when
 *     two panels bind simultaneously.
 *   - Subsequent acquires on the same route return the cached adapter and bump refcount.
 *   - release() decrements refcount; at 0 → dispose() + evict. Idempotent (double-release safe).
 *   - Different routes → independent adapters. One route failing does NOT affect another.
 */

import type { AttachResult, ClientTransportAdapter, ConnectionState, RouteConfig } from "../contract.js"
import type { TokenResolver } from "../token-resolver.js"
import { selectAdapter } from "../factory.js"

/** The live state of one managed connection in the pool. */
interface PoolEntry {
  readonly adapter: ClientTransportAdapter
  attachResult: AttachResult
  /** Monotonically increasing reference count. */
  refCount: number
  /** Set once release() has issued dispose() so double-dispose is skipped. */
  disposing: boolean
}

/**
 * A per-caller handle over a pooled connection. Callers receive this from
 * acquire() and must call release() when they are done.
 */
export interface RouteHandle {
  /** The route key this handle was acquired for. */
  readonly routeKey: string
  /** The AttachResult produced when the connection was established. */
  readonly attachResult: AttachResult
  /** The underlying adapter — exposes descriptor, connection state, openSession. */
  readonly adapter: ClientTransportAdapter
  /**
   * Release this handle. Decrements refcount; when the last holder releases,
   * the adapter is disposed and evicted from the pool.
   * Safe to call multiple times (idempotent).
   */
  release(): Promise<void>
}

export class ConnectionManager {
  readonly #routes: ReadonlyMap<string, RouteConfig>
  readonly #pool = new Map<string, PoolEntry>()
  /**
   * In-flight attach promises — dedup concurrent first-acquires for the same
   * route so attach() fires exactly once even when two panels call acquire()
   * simultaneously before the first attach resolves.
   */
  readonly #inflight = new Map<string, Promise<PoolEntry>>()

  #disposed = false

  readonly #adapterFactory: (route: RouteConfig) => ClientTransportAdapter

  /**
   * @param routes - Pre-parsed route map from parseClientConfig(). File I/O
   *                 stays out; the manager works purely with resolved RouteConfigs.
   * @param adapterFactory - Override the adapter factory for tests. When omitted,
   *                 defaults to selectAdapter bound with `tokenResolver` so the
   *                 produced adapters resolve their tokenRef lazily at connect.
   * @param tokenResolver - Optional resolver threaded into the default factory so
   *                 each adapter turns route.tokenRef (env:/file:/op:/none) into a
   *                 concrete token at connect time. Ignored when `adapterFactory`
   *                 is supplied explicitly (the caller's factory owns resolution).
   *                 When omitted, adapters fall back to the literal route.tokenRef.
   */
  constructor(
    routes: ReadonlyMap<string, RouteConfig>,
    adapterFactory?: (route: RouteConfig) => ClientTransportAdapter,
    tokenResolver?: TokenResolver,
  ) {
    this.#routes = routes
    this.#adapterFactory =
      adapterFactory ?? ((route: RouteConfig) => selectAdapter(route, tokenResolver))
  }

  // ── acquire ──────────────────────────────────────────────────────────────────

  /**
   * Acquire a handle for the given route. Ref-counted: first acquire dials the
   * server and blocks until attach() resolves; subsequent acquires return the
   * same adapter (shared connection) immediately.
   *
   * Concurrent first-acquires share one in-flight attach (dedup): attach() fires
   * exactly once even if N panels bind simultaneously.
   *
   * Throws if the route key is unknown or if attach() fails.
   */
  async acquire(routeKey: string): Promise<RouteHandle> {
    if (this.#disposed) {
      throw new Error(`ConnectionManager: disposed — cannot acquire route "${routeKey}"`)
    }

    const config = this.#routes.get(routeKey)
    if (!config) {
      throw new Error(
        `ConnectionManager: unknown route "${routeKey}". ` +
          `Known routes: ${[...this.#routes.keys()].join(", ") || "(none)"}`,
      )
    }

    const existing = this.#pool.get(routeKey)
    if (existing && !existing.disposing) {
      existing.refCount++
      return this.#makeHandle(routeKey, existing)
    }

    // Check for an in-flight attach (concurrent first-acquire dedup).
    const inflight = this.#inflight.get(routeKey)
    if (inflight) {
      // Join the in-flight promise; it will have bumped refCount for us.
      const entry = await inflight
      entry.refCount++
      return this.#makeHandle(routeKey, entry)
    }

    // No existing entry and no inflight — we are the first. Start attach.
    const attachPromise = this.#startAttach(routeKey, config)
    this.#inflight.set(routeKey, attachPromise)

    let entry: PoolEntry
    try {
      entry = await attachPromise
    } finally {
      this.#inflight.delete(routeKey)
    }

    // We created it; refcount starts at 1.
    return this.#makeHandle(routeKey, entry)
  }

  // ── helpers ──────────────────────────────────────────────────────────────────

  /**
   * Create, attach, cache, and return a new PoolEntry. Called exactly once per
   * route (per-attach-cycle) due to the inflight dedup guard.
   *
   * NOTE (§9.1.1 deferred): The spec calls for a ~5s last-release LINGER before
   * eviction and a cap on ref-zero evictions ("lazy eviction"). This v1 impl
   * disposes immediately when refcount hits 0 — linger and cap are intentionally
   * deferred and are NOT implemented here.
   */
  async #startAttach(routeKey: string, config: RouteConfig): Promise<PoolEntry> {
    const adapter = this.#adapterFactory(config)
    const attachResult = await adapter.attach()

    // Guard: if disposeAll() ran while we were awaiting attach(), the manager is
    // disposed. Dispose the freshly-built adapter immediately instead of leaking it.
    if (this.#disposed) {
      try {
        await adapter.dispose()
      } catch {
        // Swallow — we're tearing down anyway.
      }
      throw new Error(
        `ConnectionManager: disposed during attach for route "${routeKey}" — adapter discarded.`,
      )
    }

    const entry: PoolEntry = {
      adapter,
      attachResult,
      refCount: 1,
      disposing: false,
    }
    this.#pool.set(routeKey, entry)
    return entry
  }

  #makeHandle(routeKey: string, entry: PoolEntry): RouteHandle {
    let released = false

    return {
      routeKey,
      attachResult: entry.attachResult,
      adapter: entry.adapter,
      release: async () => {
        // Idempotent: second release is a no-op.
        if (released) return
        released = true
        await this.#release(routeKey, entry)
      },
    }
  }

  async #release(routeKey: string, entry: PoolEntry): Promise<void> {
    if (entry.disposing) return

    entry.refCount--
    if (entry.refCount > 0) return

    // Last reference dropped — dispose + evict.
    entry.disposing = true
    this.#pool.delete(routeKey)

    try {
      await entry.adapter.dispose()
    } catch {
      // Swallow dispose errors; the pool entry is already evicted.
    }
  }

  // ── informational helpers (for the route switcher, Chunk 5) ─────────────────

  /**
   * Return the routeKey → RouteConfig map for all configured routes.
   * Used by the switcher to enumerate available routes before any are acquired.
   */
  listRoutes(): ReadonlyMap<string, RouteConfig> {
    return this.#routes
  }

  /**
   * Return the RouteConfig for a specific route key, or undefined if unknown.
   * Used by the switcher to render the pre-connect label before attach.
   */
  descriptorFor(routeKey: string): RouteConfig | undefined {
    return this.#routes.get(routeKey)
  }

  /**
   * Return the live AttachResult for a route if it is currently connected,
   * or undefined if the route is not in the pool (never connected or evicted).
   */
  liveDescriptorFor(routeKey: string): AttachResult | undefined {
    return this.#pool.get(routeKey)?.attachResult
  }

  /**
   * Return the live connection state stream for a connected route, or undefined
   * if the route is not currently pooled. Delegates to adapter.connection.
   */
  connectionFor(routeKey: string): AsyncIterable<ConnectionState> | undefined {
    const entry = this.#pool.get(routeKey)
    return entry?.adapter.connection
  }

  /**
   * Dispose all live connections and mark the manager as disposed.
   * Called on process teardown or logout.
   */
  async disposeAll(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true

    const entries = [...this.#pool.entries()]
    this.#pool.clear()

    await Promise.allSettled(
      entries.map(async ([, entry]) => {
        if (!entry.disposing) {
          entry.disposing = true
          await entry.adapter.dispose()
        }
      }),
    )
  }
}
