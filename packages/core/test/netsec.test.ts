/**
 * NetSecClient — tests (Phase 16).
 *
 * Tests allowlist enforcement, strict mode, wildcard patterns,
 * runtime allow() mutation, and isAllowed checks.
 * NOTE: Does NOT make real HTTP requests (no network dependency).
 * Uses a mocked fetch to test policy enforcement.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Effect, Layer } from "effect"
import {
  EgressBlockedError,
  NetSecClient,
} from "../src/netsec/index.js"

// Mock globalThis.fetch for all tests
const mockFetch = vi.fn()
const originalFetch = globalThis.fetch

const setFetch = (fetchImpl: typeof globalThis.fetch) => {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: fetchImpl,
  })
}

const restoreFetch = () => {
  if (originalFetch === undefined) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete (globalThis as { fetch?: typeof globalThis.fetch }).fetch
  } else {
    setFetch(originalFetch)
  }
}

const run = <A, E>(
  prog: Effect.Effect<A, E, NetSecClient>,
  layer: Layer.Layer<NetSecClient> = NetSecClient.Default,
) =>
  Effect.runPromise(
    Effect.scoped(prog.pipe(Effect.provide(layer))),
  )

describe("NetSecClient", () => {
  beforeEach(() => {
    setFetch(mockFetch as unknown as typeof globalThis.fetch)
    mockFetch.mockResolvedValue({
      status: 200,
      statusText: "OK",
      text: () => Promise.resolve("ok"),
      headers: { forEach: vi.fn() },
    })
  })

  afterEach(() => {
    restoreFetch()
    mockFetch.mockReset()
  })

  it("(1) strict=false: all requests pass through", async () => {
    const result = await run(
      Effect.gen(function* () {
        const client = yield* NetSecClient
        const allowed = yield* client.isAllowed("https://anywhere.com/api", "GET")
        return allowed
      }),
      NetSecClient.makeLayer({ strictMode: false }),
    )
    expect(result).toBe(true)
  })

  it("(2) strict=true: request to unlisted host is blocked", async () => {
    const result = await run(
      Effect.gen(function* () {
        const client = yield* NetSecClient
        const err = yield* client.fetch("https://evil.com/steal", { method: "POST" }).pipe(
          Effect.flip,
        )
        return err
      }),
      NetSecClient.makeLayer({
        strictMode: true,
        allowlist: [{ host: "api.example.com" }],
      }),
    )
    expect(result).toBeInstanceOf(EgressBlockedError)
    expect(result._tag).toBe("EgressBlockedError")
    expect((result as EgressBlockedError).url).toBe("https://evil.com/steal")
  })

  it("(3) strict=true: allowlisted host passes through", async () => {
    const result = await run(
      Effect.gen(function* () {
        const client = yield* NetSecClient
        const resp = yield* client.fetch("https://api.example.com/data", { method: "GET" })
        return resp.status
      }),
      NetSecClient.makeLayer({
        strictMode: true,
        allowlist: [{ host: "api.example.com", methods: ["GET"] }],
      }),
    )
    expect(result).toBe(200)
    expect(mockFetch).toHaveBeenCalledOnce()
  })

  it("(4) wildcard host pattern: *.anthropic.com matches subdomain", async () => {
    const allowed1 = await run(
      Effect.gen(function* () {
        const client = yield* NetSecClient
        return yield* client.isAllowed("https://api.anthropic.com/v1/messages")
      }),
      NetSecClient.makeLayer({
        strictMode: true,
        allowlist: [{ host: "*.anthropic.com" }],
      }),
    )
    const allowed2 = await run(
      Effect.gen(function* () {
        const client = yield* NetSecClient
        return yield* client.isAllowed("https://evil.com")
      }),
      NetSecClient.makeLayer({
        strictMode: true,
        allowlist: [{ host: "*.anthropic.com" }],
      }),
    )
    expect(allowed1).toBe(true)
    expect(allowed2).toBe(false)
  })

  it("(5) method restriction: wrong method is blocked", async () => {
    const result = await run(
      Effect.gen(function* () {
        const client = yield* NetSecClient
        const err = yield* client.fetch("https://api.example.com/data", { method: "DELETE" }).pipe(
          Effect.flip,
        )
        return err
      }),
      NetSecClient.makeLayer({
        strictMode: true,
        allowlist: [{ host: "api.example.com", methods: ["GET", "POST"] }],
      }),
    )
    expect(result).toBeInstanceOf(EgressBlockedError)
  })

  it("(6) allow() adds runtime entry", async () => {
    const result = await run(
      Effect.gen(function* () {
        const client = yield* NetSecClient
        // Not allowed initially
        const before = yield* client.isAllowed("https://new-host.com")
        // Add it
        yield* client.allow({ host: "new-host.com" })
        // Now allowed
        const after = yield* client.isAllowed("https://new-host.com")
        return { before, after }
      }),
      NetSecClient.makeLayer({ strictMode: true }),
    )
    expect(result.before).toBe(false)
    expect(result.after).toBe(true)
  })

  it("(7) Default layer: strict=false, all requests allowed", async () => {
    const result = await run(
      Effect.gen(function* () {
        const client = yield* NetSecClient
        return yield* client.isAllowed("https://anywhere.example.com")
      }),
    )
    expect(result).toBe(true)
  })
})
