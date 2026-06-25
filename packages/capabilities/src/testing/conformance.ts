/**
 * The reusable CapabilityProvider conformance suite — the maintainability backbone.
 * "Add a backend = implement CapabilityProvider + pass this suite."
 *
 * This file imports vitest, so it is reachable ONLY via the "@luna/capabilities/testing"
 * subpath export — never from the main barrel (src/index.ts) — so vitest never enters the
 * browser IIFE bundle. A guard test (test/no-vitest-in-barrel.test.ts) enforces that.
 */

import { describe, it, expect } from "vitest"
import { decodeCapabilityCatalog } from "../descriptor.js"
import type { CapabilityProvider, CatalogSnapshot } from "../provider.js"

/** Minimal capability seed — the suite fills the remaining required descriptor fields. */
export interface SeedCapability {
  readonly kind: string
  readonly id: string
  readonly title?: string
  readonly executor?: "client" | "server"
}

/** A routed execution as the harness reports it, compared structurally to what the suite requested. */
export interface ExecutedCall {
  readonly kind: string
  readonly id: string
  readonly args?: string
}

/**
 * What an adapter's test file supplies. The suite owns vitest; the adapter owns "stand up
 * my provider and tell me what it routed". Kept tiny: add a backend = implement the port +
 * write this harness.
 */
export interface ConformanceHarness {
  /** Build a fresh provider whose catalog contains at least `seed` (decoded). Called per test → isolation. */
  readonly makeProvider: (seed: readonly SeedCapability[]) => CapabilityProvider | Promise<CapabilityProvider>
  /** The executions this provider routed since makeProvider, in call order — the routing oracle. */
  readonly executionsOf: (provider: CapabilityProvider) => readonly ExecutedCall[] | Promise<readonly ExecutedCall[]>
  /** Optional: push a changed catalog so subscribe/unsubscribe-stops behavior can be exercised. */
  readonly refresh?: (provider: CapabilityProvider, seed: readonly SeedCapability[]) => void | Promise<void>
  /** Optional: a provider in its unreachable state, to test {ok:false} snapshots / "unavailable". */
  readonly makeUnavailable?: () => CapabilityProvider | Promise<CapabilityProvider>
  /** Optional teardown run after each test. */
  readonly dispose?: (provider: CapabilityProvider) => void | Promise<void>
}

// Wait for the async initial emit (queueMicrotask) to flush.
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

export function describeProviderConformance(name: string, harness: ConformanceHarness): void {
  describe(`CapabilityProvider conformance: ${name}`, () => {
    const SEED: SeedCapability[] = [
      { kind: "command", id: "clear" },
      { kind: "command", id: "model" },
      { kind: "skill", id: "search" },
    ]
    const build = (): CapabilityProvider | Promise<CapabilityProvider> => harness.makeProvider(SEED)

    it("list() resolves a snapshot (never rejects)", async () => {
      const p = await build()
      await expect(p.list()).resolves.toBeDefined()
      const snap = await p.list()
      expect(snap.ok).toBe(true)
      await harness.dispose?.(p)
    })

    it("list() returns an already-decoded catalog containing every seeded capability", async () => {
      const p = await build()
      const snap = await p.list()
      expect(snap.ok).toBe(true)
      if (!snap.ok) return
      // re-decoding is idempotent → proves the provider already decoded at the boundary
      expect(decodeCapabilityCatalog(snap.catalog).ok).toBe(true)
      const ids = snap.catalog.capabilities.map((c) => `${c.kind}/${c.id}`)
      for (const s of SEED) expect(ids).toContain(`${s.kind}/${s.id}`)
      expect(Number.isInteger(snap.catalog.generation)).toBe(true)
      expect(snap.catalog.generation).toBeGreaterThanOrEqual(0)
      expect(snap.catalog.agreedSchema).toBeGreaterThanOrEqual(1)
      await harness.dispose?.(p)
    })

    it("subscribe emits the current snapshot once, asynchronously (not during subscribe())", async () => {
      const p = await build()
      const seen: CatalogSnapshot[] = []
      const unsub = p.subscribe((s) => seen.push(s))
      expect(seen).toHaveLength(0) // no synchronous emit
      await settle()
      expect(seen).toHaveLength(1)
      expect(seen[0]?.ok).toBe(true)
      unsub()
      await harness.dispose?.(p)
    })

    it("unsubscribe before the initial emit flushes cancels it (no emit at all)", async () => {
      const p = await build()
      const seen: CatalogSnapshot[] = []
      const unsub = p.subscribe((s) => seen.push(s))
      unsub() // before the microtask flushes
      await settle()
      expect(seen).toHaveLength(0)
      await harness.dispose?.(p)
    })

    it("unsubscribe is idempotent and stops delivery of later changes", async () => {
      if (!harness.refresh) return
      const p = await build()
      const seen: CatalogSnapshot[] = []
      const unsub = p.subscribe((s) => seen.push(s))
      await settle()
      expect(seen).toHaveLength(1)
      unsub()
      unsub() // idempotent — must not throw
      await harness.refresh(p, [...SEED, { kind: "command", id: "new" }])
      await settle()
      expect(seen).toHaveLength(1) // nothing delivered after unsubscribe
      await harness.dispose?.(p)
    })

    it("delivers a fresh snapshot on a subsequent change", async () => {
      if (!harness.refresh) return
      const p = await build()
      const seen: CatalogSnapshot[] = []
      const unsub = p.subscribe((s) => seen.push(s))
      await settle()
      await harness.refresh(p, [...SEED, { kind: "command", id: "added" }])
      await settle()
      expect(seen.length).toBeGreaterThanOrEqual(2)
      unsub()
      await harness.dispose?.(p)
    })

    it("supports multiple subscribers; one unsubscribe does not affect the other", async () => {
      const p = await build()
      const a: CatalogSnapshot[] = []
      const b: CatalogSnapshot[] = []
      const ua = p.subscribe((s) => a.push(s))
      const ub = p.subscribe((s) => b.push(s))
      await settle()
      expect(a).toHaveLength(1)
      expect(b).toHaveLength(1)
      ua()
      if (harness.refresh) {
        await harness.refresh(p, [...SEED, { kind: "command", id: "x2" }])
        await settle()
        expect(a).toHaveLength(1)
        expect(b.length).toBeGreaterThanOrEqual(2)
      }
      ub()
      await harness.dispose?.(p)
    })

    it("execute routes a seeded capability and records it (args forwarded verbatim)", async () => {
      const p = await build()
      const res = await p.execute({ kind: "command", id: "clear", args: "all" })
      expect(res.ok).toBe(true)
      const calls = await harness.executionsOf(p)
      expect(calls).toContainEqual({ kind: "command", id: "clear", args: "all" })
      await harness.dispose?.(p)
    })

    it("execute on an unknown capability resolves {ok:false, reason:'unknown'} and records nothing", async () => {
      const p = await build()
      const res = await p.execute({ kind: "command", id: "does-not-exist" })
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.reason).toBe("unknown")
      const calls = await harness.executionsOf(p)
      expect(calls.some((c) => c.id === "does-not-exist")).toBe(false)
      await harness.dispose?.(p)
    })

    it("execute never rejects", async () => {
      const p = await build()
      await expect(p.execute({ kind: "command", id: "clear" })).resolves.toBeDefined()
      await expect(p.execute({ kind: "nope", id: "nope" })).resolves.toBeDefined()
      await harness.dispose?.(p)
    })

    it("two providers from the same harness share no state", async () => {
      const p1 = await build()
      const p2 = await build()
      await p1.execute({ kind: "command", id: "clear" })
      expect((await harness.executionsOf(p1)).length).toBeGreaterThanOrEqual(1)
      expect((await harness.executionsOf(p2)).length).toBe(0)
      await harness.dispose?.(p1)
      await harness.dispose?.(p2)
    })

    if (harness.makeUnavailable) {
      const makeUnavailable = harness.makeUnavailable
      it("an unavailable provider surfaces {ok:false} from list and 'unavailable' from execute", async () => {
        const p = await makeUnavailable()
        const snap = await p.list()
        expect(snap.ok).toBe(false)
        const res = await p.execute({ kind: "command", id: "clear" })
        expect(res.ok).toBe(false)
        if (!res.ok) expect(res.reason).toBe("unavailable")
        await harness.dispose?.(p)
      })
    }
  })
}
