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

    // Slice C: policy entry must be present with fail-closed defaults.
    expect(result.report.policy["good-server"]).toEqual({
      allowAll: false,
      allowedTools: [],
    })
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

  // (f) Slice C: policy entry reflects fail-closed default for a freshly-registered server.
  it("(f) policy entry for a registered server with no allowedTools and allowAll=false is {allowAll:false, allowedTools:[]}", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* McpServerStore

        yield* store.add({
          slug: "fresh-server",
          url: "https://mcp.example.com/sse",
        })
        yield* store.acceptTrust("fresh-server", 1_000_000)

        return yield* syncMcpMounts()
      }),
    )

    expect(result.registered).toContain("fresh-server")
    expect(result.policy["fresh-server"]).toEqual({
      allowAll: false,
      allowedTools: [],
    })
  })

  // (g) Slice C: after allowTool a re-sync reflects the tool in policy.
  it("(g) policy entry reflects allowedTools after allowTool + re-sync", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* McpServerStore

        yield* store.add({
          slug: "policy-server",
          url: "https://mcp.example.com/sse",
        })
        yield* store.acceptTrust("policy-server", 1_000_000)

        // First sync — empty allowedTools.
        const first = yield* syncMcpMounts()

        // Operator grants a tool.
        yield* store.allowTool("policy-server", "do_something")

        // Second sync — should reflect the updated allowedTools.
        const second = yield* syncMcpMounts()

        return { first, second }
      }),
    )

    expect(result.first.policy["policy-server"]).toEqual({
      allowAll: false,
      allowedTools: [],
    })
    expect(result.second.policy["policy-server"]).toEqual({
      allowAll: false,
      allowedTools: ["do_something"],
    })
  })

  // (h) Slice C: skipped servers have NO policy entry.
  it("(h) skipped servers (unresolvable header) have no policy entry", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* McpServerStore

        yield* store.add({
          slug: "bad-policy",
          url: "https://mcp.example.com/sse",
          headers: { Authorization: "env:MISSING" },
        })
        yield* store.acceptTrust("bad-policy", 1_000_000)

        return yield* syncMcpMounts()
      }),
    )

    expect(result.skipped.map((s) => s.slug)).toContain("bad-policy")
    expect("bad-policy" in result.policy).toBe(false)
  })

  // (i) HOLE 2: a row whose slug collides with a caller-supplied reservedSlugs
  // set (e.g. a live connector mount key) is skipped, not registered, and has
  // no policy entry.  This prevents an operator "github" row from shadowing the
  // connector mount or mis-routing gate policy to connector tool names.
  it("(i) skips a server whose slug collides with a caller-supplied reserved slug (hole 2)", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* McpServerStore
        const registry = yield* MCPRegistry

        yield* store.add({
          slug: "github",
          url: "https://mcp.example.com/sse",
        })
        yield* store.acceptTrust("github", 1_000_000)

        // Pass "github" as a reserved slug (simulating a live connector key).
        const report = yield* syncMcpMounts({
          reservedSlugs: new Set(["github"]),
        })
        const snap = registry.snapshotSync()
        return { report, snap }
      }),
    )

    // Must be skipped, not registered, no policy entry, not in registry.
    expect(result.report.skipped.map((s) => s.slug)).toContain("github")
    expect(result.report.registered).not.toContain("github")
    expect("github" in result.report.policy).toBe(false)
    expect("github" in result.snap).toBe(false)
    // Reason must mention the collision.
    const skip = result.report.skipped.find((s) => s.slug === "github")
    expect(skip?.reason).toContain("collides")
    expect(skip?.reason).toContain("github")
  })

  // (j) HOLE 3: a row with an invalid slug that somehow bypassed store.add()
  // validation (e.g. hand-edited luna.db — uppercase, underscore) is skipped
  // by the loader's re-validation guard, not registered, and has no policy
  // entry.  Defense-in-depth: store.add() also validates, but the loader is
  // the last line of defense before mounting.
  //
  // Because the Memory store's add() itself calls validateSlug (and would
  // reject the row), we exercise the skip branch by constructing a fake
  // store stub that returns an invalid-slug row from listEnabledTrusted().
  it("(j) skips a server with an invalid slug from the DB (hole 3 defense-in-depth)", async () => {
    // Build a stub store that injects an invalid-slug row directly.
    const invalidRow = {
      slug: "GitHub", // uppercase — fails /^[a-z0-9][a-z0-9-]{0,63}$/
      url: "https://mcp.example.com/sse",
      headers: {},
      enabled: true,
      trustAcceptedAt: 1_000_000,
      allowedTools: [],
      allowAll: false,
      createdAt: 1_000_000,
      updatedAt: 1_000_000,
    }
    // Build a stub McpServerStoreApi that returns the bad row.
    const stubStoreLayer = Layer.succeed(McpServerStore, {
      add: () => Effect.die("stub"),
      get: () => Effect.die("stub"),
      list: () => Effect.die("stub"),
      listEnabledTrusted: () => Effect.succeed([invalidRow]),
      acceptTrust: () => Effect.die("stub"),
      allowTool: () => Effect.die("stub"),
      allowAllTools: () => Effect.die("stub"),
      remove: () => Effect.die("stub"),
    } as unknown as import("../src/store.js").McpServerStoreApi)

    const stubLayer = Layer.mergeAll(
      stubStoreLayer,
      fakeSecretProviderLayer,
      MCPRegistry.Default,
    )

    const result = await Effect.runPromise(
      syncMcpMounts().pipe(
        Effect.provide(stubLayer),
      ) as Effect.Effect<import("../src/mount-loader.js").SyncMcpMountsResult, never, never>,
    )

    // Invalid-slug row must be skipped, not registered, no policy entry.
    expect(result.skipped.map((s) => s.slug)).toContain("GitHub")
    expect(result.registered).not.toContain("GitHub")
    expect("GitHub" in result.policy).toBe(false)
    // Reason must mention "invalid slug".
    const skip = result.skipped.find((s) => s.slug === "GitHub")
    expect(skip?.reason).toContain("invalid slug")
    expect(skip?.reason).toContain("GitHub")
  })
})

// ---------------------------------------------------------------------------
// Templating tests — header values with ${ref} embedded placeholders
// ---------------------------------------------------------------------------

// A fake SecretProvider that handles specific refs used in the templating tests.
// Using fakes avoids real file I/O in the MCP-layer tests.
const fakeSecretProviderLayerWithTemplate = Layer.succeed(SecretProvider, {
  get: (ref) => {
    if (ref === "env:GOOD") return Effect.succeed(Redacted.make("Bearer good-token"))
    if (ref === "file-json:/tmp/test-creds.json#api_token")
      return Effect.succeed(Redacted.make("tok_example123"))
    if (ref === "file:/tmp/test-a.txt") return Effect.succeed(Redacted.make("valueA"))
    if (ref === "file:/tmp/test-b.txt") return Effect.succeed(Redacted.make("valueB"))
    return Effect.fail(
      new ConfigError({
        module: "FakeSecretProvider",
        key: ref,
        message: `no secret for ref: ${ref}`,
      }),
    )
  },
} satisfies SecretProviderApi)

const fullLayerWithTemplate = Layer.mergeAll(
  memoryStoreLayer,
  fakeSecretProviderLayerWithTemplate,
  MCPRegistry.Default,
)

const runTemplate = <A, E>(prog: Effect.Effect<A, E, Deps>) =>
  Effect.runPromise(
    prog.pipe(Effect.provide(fullLayerWithTemplate)) as Effect.Effect<A, E, never>,
  )

describe("syncMcpMounts — header templating", () => {
  // (k) Bearer ${file-json:...#field} resolves to "Bearer <token>"
  it("(k) template header 'Bearer ${file-json:/tmp/test-creds.json#api_token}' resolves to 'Bearer tok_example123'", async () => {
    const result = await runTemplate(
      Effect.gen(function* () {
        const store = yield* McpServerStore
        const registry = yield* MCPRegistry

        yield* store.add({
          slug: "template-server",
          url: "https://mcp.example.com/sse",
          headers: {
            Authorization:
              "Bearer ${file-json:/tmp/test-creds.json#api_token}",
          },
        })
        yield* store.acceptTrust("template-server", 1_000_000)

        const report = yield* syncMcpMounts()
        const snap = registry.snapshotSync()
        return { report, snap }
      }),
    )

    expect(result.report.registered).toContain("template-server")
    expect(result.report.skipped).toHaveLength(0)
    const config = result.snap["template-server"] as {
      headers: Record<string, string>
    }
    expect(config.headers["Authorization"]).toBe("Bearer tok_example123")
  })

  // (l) plain env:GOOD still works (regression: backward-compat, no template syntax)
  it("(l) plain env:GOOD ref (no template syntax) still resolves correctly", async () => {
    const result = await runTemplate(
      Effect.gen(function* () {
        const store = yield* McpServerStore
        const registry = yield* MCPRegistry

        yield* store.add({
          slug: "plain-env-server",
          url: "https://mcp.example.com/sse",
          headers: { Authorization: "env:GOOD" },
        })
        yield* store.acceptTrust("plain-env-server", 1_000_000)

        const report = yield* syncMcpMounts()
        const snap = registry.snapshotSync()
        return { report, snap }
      }),
    )

    expect(result.report.registered).toContain("plain-env-server")
    const config = result.snap["plain-env-server"] as {
      headers: Record<string, string>
    }
    expect(config.headers["Authorization"]).toBe("Bearer good-token")
  })

  // (m) one failing embedded ref → whole server skipped (fail-closed)
  it("(m) a failing embedded ref causes the server to be skipped (fail-closed)", async () => {
    const result = await runTemplate(
      Effect.gen(function* () {
        const store = yield* McpServerStore
        const registry = yield* MCPRegistry

        yield* store.add({
          slug: "fail-template-server",
          url: "https://mcp.example.com/sse",
          headers: {
            Authorization: "Bearer ${file-json:/nonexistent/path.json#field}",
          },
        })
        yield* store.acceptTrust("fail-template-server", 1_000_000)

        const report = yield* syncMcpMounts()
        const snap = registry.snapshotSync()
        return { report, snap }
      }),
    )

    expect(result.report.registered).not.toContain("fail-template-server")
    expect(result.report.skipped).toHaveLength(1)
    const skip = result.report.skipped[0]!
    expect(skip.slug).toBe("fail-template-server")
    expect(skip.reason).toContain("file-json:/nonexistent/path.json#field")
    expect(skip.reason).toContain("Authorization")
    expect("fail-template-server" in result.snap).toBe(false)
  })

  // (o) malformed "${" with no closing brace → skipped (fail-closed, no literal mount)
  it("(o) a malformed ${ template (no closing brace) skips the server (fail-closed)", async () => {
    const result = await runTemplate(
      Effect.gen(function* () {
        const store = yield* McpServerStore
        const registry = yield* MCPRegistry

        yield* store.add({
          slug: "malformed-template-server",
          url: "https://mcp.example.com/sse",
          headers: { Authorization: "Bearer ${env:GOOD" },
        })
        yield* store.acceptTrust("malformed-template-server", 1_000_000)

        const report = yield* syncMcpMounts()
        const snap = registry.snapshotSync()
        return { report, snap }
      }),
    )

    expect(result.report.registered).not.toContain("malformed-template-server")
    expect(result.report.skipped).toHaveLength(1)
    expect(result.report.skipped[0]!.reason).toContain(
      "malformed secret-ref template",
    )
    expect("malformed-template-server" in result.snap).toBe(false)
  })

  // (n) multiple embedded refs in one value, all resolve
  it("(n) multiple embedded refs in one header value, all resolve", async () => {
    const result = await runTemplate(
      Effect.gen(function* () {
        const store = yield* McpServerStore
        const registry = yield* MCPRegistry

        yield* store.add({
          slug: "multi-ref-server",
          url: "https://mcp.example.com/sse",
          headers: {
            "X-Combined":
              "${file:/tmp/test-a.txt} ${file:/tmp/test-b.txt}",
          },
        })
        yield* store.acceptTrust("multi-ref-server", 1_000_000)

        const report = yield* syncMcpMounts()
        const snap = registry.snapshotSync()
        return { report, snap }
      }),
    )

    expect(result.report.registered).toContain("multi-ref-server")
    expect(result.report.skipped).toHaveLength(0)
    const config = result.snap["multi-ref-server"] as {
      headers: Record<string, string>
    }
    expect(config.headers["X-Combined"]).toBe("valueA valueB")
  })
})
