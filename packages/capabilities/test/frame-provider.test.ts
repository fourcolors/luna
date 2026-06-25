import { describe, it, expect, vi } from "vitest"
import { createFrameCapabilityProvider, type FrameTransport, type CatalogSnapshot } from "../src/index.js"
import { describeProviderConformance, type ConformanceHarness, type SeedCapability } from "../src/testing/index.js"

// A controllable fake frame channel: captures sent frames; lets the test push server frames.
function fakeTransport() {
  const sent: Record<string, unknown>[] = []
  let handler: ((f: unknown) => void) | null = null
  const transport: FrameTransport = {
    send: (f) => sent.push(f as Record<string, unknown>),
    onFrame: (h) => {
      handler = h
      return () => {
        handler = null
      }
    },
  }
  return { transport, sent, push: (frame: unknown) => handler?.(frame) }
}

const catalogFrame = (seed: readonly SeedCapability[], generation = 1): unknown => ({
  type: "capability-catalog",
  catalog: {
    generation,
    agreedSchema: 1,
    capabilities: seed.map((s) => ({
      kind: s.kind,
      id: s.id,
      title: s.title ?? s.id,
      executor: s.executor ?? "server",
      schemaVersion: 1,
    })),
  },
})

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

// ───────────────────────── unit tests ─────────────────────────
describe("createFrameCapabilityProvider", () => {
  it("decodes an inbound capability-catalog frame into the snapshot", async () => {
    const ft = fakeTransport()
    const p = createFrameCapabilityProvider(ft.transport, { executeTimeoutMs: 0 })
    ft.push(catalogFrame([{ kind: "command", id: "interrupt", title: "Stop" }]))
    const snap = await p.list()
    expect(snap.ok).toBe(true)
    if (snap.ok) expect(snap.catalog.capabilities[0]?.id).toBe("interrupt")
  })

  it("a malformed inbound catalog yields an {ok:false} snapshot, never throws", async () => {
    const ft = fakeTransport()
    const p = createFrameCapabilityProvider(ft.transport, { executeTimeoutMs: 0 })
    expect(() => ft.push({ type: "capability-catalog", catalog: { capabilities: "nope" } })).not.toThrow()
    expect((await p.list()).ok).toBe(false)
  })

  it("sends a capability-execute frame and resolves on the matching result", async () => {
    const ft = fakeTransport()
    const p = createFrameCapabilityProvider(ft.transport, { executeTimeoutMs: 0, context: () => ({ threadId: "t-1" }) })
    ft.push(catalogFrame([{ kind: "command", id: "interrupt", title: "Stop" }]))
    const promise = p.execute({ kind: "command", id: "interrupt" })
    const sent = ft.sent.find((f) => f.type === "capability-execute") as any
    expect(sent).toBeDefined()
    expect(sent.kind).toBe("command")
    expect(sent.id).toBe("interrupt")
    expect(sent.args).toEqual({ threadId: "t-1" }) // context merged in
    ft.push({ type: "capability-execute-result", requestId: sent.requestId, ok: true })
    expect((await promise).ok).toBe(true)
  })

  it("merges session context AND the typed args string into the execute frame", () => {
    const ft = fakeTransport()
    const p = createFrameCapabilityProvider(ft.transport, { executeTimeoutMs: 0, context: () => ({ threadId: "t-1" }) })
    ft.push(catalogFrame([{ kind: "command", id: "deploy", title: "Deploy" }]))
    void p.execute({ kind: "command", id: "deploy", args: "prod" })
    const sent = ft.sent.find((f) => f.type === "capability-execute") as any
    expect(sent.args).toEqual({ threadId: "t-1", text: "prod" })
  })

  it("resolves {ok:false, reason:'unavailable'} when the transport send throws", async () => {
    let handler: ((f: unknown) => void) | null = null
    const transport: FrameTransport = {
      send: () => {
        throw new Error("socket closed")
      },
      onFrame: (h) => {
        handler = h
        return () => {}
      },
    }
    const p = createFrameCapabilityProvider(transport, { executeTimeoutMs: 0 })
    handler!(catalogFrame([{ kind: "command", id: "interrupt", title: "Stop" }]))
    const r = await p.execute({ kind: "command", id: "interrupt" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe("unavailable")
  })

  it("a failed result resolves {ok:false, reason:'backend-error'} with the message", async () => {
    const ft = fakeTransport()
    const p = createFrameCapabilityProvider(ft.transport, { executeTimeoutMs: 0 })
    ft.push(catalogFrame([{ kind: "command", id: "interrupt", title: "Stop" }]))
    const promise = p.execute({ kind: "command", id: "interrupt" })
    const sent = ft.sent.find((f) => f.type === "capability-execute") as any
    ft.push({ type: "capability-execute-result", requestId: sent.requestId, ok: false, message: "no active turn" })
    const r = await promise
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe("backend-error")
      expect(r.error).toBe("no active turn")
    }
  })

  it("does NOT send a frame for an unknown capability (resolves reason:'unknown')", async () => {
    const ft = fakeTransport()
    const p = createFrameCapabilityProvider(ft.transport, { executeTimeoutMs: 0 })
    ft.push(catalogFrame([{ kind: "command", id: "interrupt", title: "Stop" }]))
    const r = await p.execute({ kind: "command", id: "nope" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe("unknown") // catalog present, but no such (kind,id)
    expect(ft.sent.some((f) => f.type === "capability-execute")).toBe(false)
  })

  it("execute before any catalog resolves reason:'unavailable' and sends nothing", async () => {
    const ft = fakeTransport()
    const p = createFrameCapabilityProvider(ft.transport, { executeTimeoutMs: 0 })
    const r = await p.execute({ kind: "command", id: "interrupt" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe("unavailable")
    expect(ft.sent.length).toBe(0)
  })

  it("execute times out to {ok:false, reason:'unavailable'} when no result arrives", async () => {
    vi.useFakeTimers()
    try {
      const ft = fakeTransport()
      const p = createFrameCapabilityProvider(ft.transport, { executeTimeoutMs: 5000 })
      ft.push(catalogFrame([{ kind: "command", id: "interrupt", title: "Stop" }]))
      const promise = p.execute({ kind: "command", id: "interrupt" })
      vi.advanceTimersByTime(5001)
      const r = await promise
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toBe("unavailable")
    } finally {
      vi.useRealTimers()
    }
  })

  it("subscribe emits the catalog snapshot on change", async () => {
    const ft = fakeTransport()
    const p = createFrameCapabilityProvider(ft.transport, { executeTimeoutMs: 0 })
    const seen: CatalogSnapshot[] = []
    const unsub = p.subscribe((s) => seen.push(s))
    await settle()
    expect(seen[0]?.ok).toBe(false) // initial: no catalog yet
    ft.push(catalogFrame([{ kind: "command", id: "interrupt", title: "Stop" }]))
    expect(seen.length).toBeGreaterThanOrEqual(2)
    expect(seen[seen.length - 1]?.ok).toBe(true)
    unsub()
  })
})

// ───────────────────── conformance suite ─────────────────────
// Proves the frame provider satisfies the reusable CapabilityProvider contract.
const probeMeta = new WeakMap<object, { sent: Record<string, unknown>[]; push: (f: unknown) => void }>()
const harness: ConformanceHarness = {
  makeProvider: (seed) => {
    const ft = fakeTransport()
    // Auto-respond ok to every capability-execute so execute() resolves in the suite.
    const transport: FrameTransport = {
      onFrame: ft.transport.onFrame,
      send: (f) => {
        ft.transport.send(f)
        const ff = f as Record<string, unknown>
        if (ff.type === "capability-execute") ft.push({ type: "capability-execute-result", requestId: ff.requestId, ok: true })
      },
    }
    const provider = createFrameCapabilityProvider(transport, { executeTimeoutMs: 0 })
    ft.push(catalogFrame(seed)) // seed synchronously so the catalog is populated
    probeMeta.set(provider, { sent: ft.sent, push: ft.push })
    return provider
  },
  executionsOf: (p) =>
    (probeMeta.get(p)?.sent ?? [])
      .filter((f) => f.type === "capability-execute")
      .map((f: any) => (f.args?.text !== undefined ? { kind: f.kind, id: f.id, args: f.args.text } : { kind: f.kind, id: f.id })),
  refresh: (p, seed) => probeMeta.get(p)?.push(catalogFrame(seed, 2)),
  makeUnavailable: () => createFrameCapabilityProvider(fakeTransport().transport, { executeTimeoutMs: 0 }),
}
describeProviderConformance("frame-capability-provider", harness)
