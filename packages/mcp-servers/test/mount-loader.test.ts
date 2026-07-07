/**
 * syncMcpMounts tests — Slice B1 mount loader.
 *
 * Coverage:
 *   (a) enabled+trusted server with resolvable header → registered; snapshotSync has correct config
 *   (b) server with unresolvable header ref → skipped (fail-closed), not in registry
 *   (c) enabled-but-untrusted server → not returned by listEnabledTrusted → not registered
 *   (d) reconciliation: slug registered on first sync, removed from store, second sync unregisters it
 *   (e) durable store holds only the REF; registry config holds the resolved value
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer, Redacted } from "effect"
import { Clock, MCPRegistry, SecretProvider } from "@luna/core"
import type { SecretProviderApi } from "@luna/core"
import { ConfigError } from "@luna/core"
import { McpServerStore } from "../src/store.js"
import { syncMcpMounts } from "../src/mount-loader.js"

// ---------------------------------------------------------------------------
// Fake SecretProvider layer
// ---------------------------------------------------------------------------
//
// Resolves "env:GOOD" → "Bearer good-token".
// Fails with ConfigError for "env:MISSING".
// All other refs also fail.

const fakeSecretProviderLayer = Layer.succeed(SecretProvider, {
  get: (ref) => {
    if (ref === "env:GOOD") {
      return Effect.succeed(Redacted.make("Bearer good-token"))
    }
    return Effect.fail(
      new ConfigError({
        module: "FakeSecretProvider",
        key: ref,
        message: `no secret for ref: ${ref}`,
      }),
    )
  },
} satisfies SecretProviderApi)

// ---------------------------------------------------------------------------
// Layer + run helpers
// ---------------------------------------------------------------------------

const memoryStoreLayer = McpServerStore.Memory.pipe(Layer.provide(Clock.Default))

const fullLayer = Layer.mergeAll(
  memoryStoreLayer,
  fakeSecretProviderLayer,
  MCPRegistry.Default,
)

type Deps = McpServerStore | SecretProvider | MCPRegistry

const run = <A, E>(prog: Effect.Effect<A, E, Deps>) =>
  Effect.runPromise(
    prog.pipe(Effect.provide(fullLayer)) as Effect.Effect<A, E, never>,
  )

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("syncMcpMounts", () => {
  // (a) enabled+trusted server with resolvable header → registered
  it("(a) registers an enabled+trusted server with resolved headers", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* McpServerStore
        const registry = yield* MCPRegistry

        yield* store.add({
          slug: "good-server",
          url: "https://mcp.example.com/sse",
          headers: { Authorization: "env:GOOD" },
        })
        yield* store.acceptTrust("good-server", 1_000_000)

        const report = yield* syncMcpMounts()

        const snap = registry.snapshotSync()
        return { report, snap }
      }),
    )

    expect(result.report.registered).toContain("good-server")
    expect(result.report.skipped).toHaveLength(0)

    const config = result.snap["good-server"]
    expect(config).toBeDefined()
    expect((config as { type: string }).type).toBe("http")
    expect((config as { url: string }).url).toBe("https://mcp.example.com/sse")
    expect(
      (config as { headers: Record<string, string> }).headers["Authorization"],
    ).toBe("Bearer good-token")
  })

  // (b) server with unresolvable header → skipped, not in registry
  it("(b) skips a server whose header ref cannot be resolved (fail-closed)", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* McpServerStore
        const registry = yield* MCPRegistry

        yield* store.add({
          slug: "bad-header",
          url: "https://mcp.example.com/sse",
          headers: { Authorization: "env:MISSING" },
        })
        yield* store.acceptTrust("bad-header", 1_000_000)

        const report = yield* syncMcpMounts()
        const snap = registry.snapshotSync()
        return { report, snap }
      }),
    )

    expect(result.report.registered).not.toContain("bad-header")
    expect(result.report.skipped).toHaveLength(1)
    expect(result.report.skipped[0]?.slug).toBe("bad-header")
    expect(result.report.skipped[0]?.reason).toContain("env:MISSING")
    expect(result.report.skipped[0]?.reason).toContain("Authorization")

    // Must NOT be in the registry.
    expect("bad-header" in result.snap).toBe(false)
  })

  // (c) enabled-but-untrusted server → not returned by listEnabledTrusted → not registered
  it("(c) does not register a server that is enabled but not yet trusted", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* McpServerStore
        const registry = yield* MCPRegistry

        // acceptTrust never called — trustAcceptedAt stays null.
        yield* store.add({
          slug: "untrusted-server",
          url: "https://mcp.example.com/sse",
          headers: { Authorization: "env:GOOD" },
        })

        const report = yield* syncMcpMounts()
        const snap = registry.snapshotSync()
        return { report, snap }
      }),
    )

    expect(result.report.registered).not.toContain("untrusted-server")
    expect(result.report.skipped).toHaveLength(0)
    expect("untrusted-server" in result.snap).toBe(false)
  })

  // (d) reconciliation: slug registered, then removed, second sync unregisters it
  it("(d) unregisters a previously-mounted server when removed from the store", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* McpServerStore
        const registry = yield* MCPRegistry

        yield* store.add({
          slug: "to-remove",
          url: "https://mcp.example.com/sse",
        })
        yield* store.acceptTrust("to-remove", 1_000_000)

        // First sync — should register "to-remove".
        const first = yield* syncMcpMounts()
        const snapAfterFirst = registry.snapshotSync()

        // Remove from store and sync again.
        yield* store.remove("to-remove")
        const second = yield* syncMcpMounts()
        const snapAfterSecond = registry.snapshotSync()

        return { first, snapAfterFirst, second, snapAfterSecond }
      }),
    )

    expect(result.first.registered).toContain("to-remove")
    expect("to-remove" in result.snapAfterFirst).toBe(true)

    expect(result.second.registered).not.toContain("to-remove")
    expect("to-remove" in result.snapAfterSecond).toBe(false)
  })

  // (e) durable store holds only the ref; registry holds the resolved value
  it("(e) store retains secret REFs; registry config contains resolved secret VALUE", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* McpServerStore
        const registry = yield* MCPRegistry

        yield* store.add({
          slug: "ref-check",
          url: "https://mcp.example.com/sse",
          headers: { Authorization: "env:GOOD" },
        })
        yield* store.acceptTrust("ref-check", 1_000_000)

        yield* syncMcpMounts()

        const storeRow = yield* store.get("ref-check")
        const snap = registry.snapshotSync()

        return { storeRow, snap }
      }),
    )

    // Store must still hold the ref, not the resolved value.
    expect(result.storeRow?.headers["Authorization"]).toBe("env:GOOD")

    // Registry config must hold the resolved bearer token.
    const config = result.snap["ref-check"] as {
      headers: Record<string, string>
    }
    expect(config.headers["Authorization"]).toBe("Bearer good-token")
  })
})
