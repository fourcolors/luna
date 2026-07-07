/**
 * McpServerStore tests — Memory + SQLite (:memory:) backends.
 *
 * The SQLite block is bun-only (bun:sqlite dies under stock vitest/node);
 * that block is skipped on non-bun runners via `describe.skip`.
 *
 * Coverage:
 *   (a) add + get round-trips
 *   (b) list returns all rows ordered by createdAt
 *   (c) add rejects RESERVED_SLUGS slug with McpSlugReserved
 *   (d) add rejects an invalid slug with McpSlugInvalid
 *   (e) add rejects duplicate slug with McpSlugExists
 *   (f) headers stored/retrieved as secret-ref MAP — no raw secrets
 *   (g) listEnabledTrusted — excludes untrusted and disabled, includes enabled+trusted
 *   (h) allowTool deduplicated
 *   (i) fail-closed default: fresh row has allowedTools [] and allowAll false
 *   (j) add rejects non-HTTPS or invalid urls with McpUrlInvalid
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer, Scope } from "effect"
import { Clock, LunaSqliteBootstrap } from "@luna/core"
import { McpServerStore } from "../src/store.js"
import {
  McpSlugExists,
  McpSlugInvalid,
  McpSlugReserved,
  McpUrlInvalid,
} from "../src/types.js"

// ---------------------------------------------------------------------------
// Runtime guard + layer helpers
// ---------------------------------------------------------------------------

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"
const dSqlite = isBun ? describe : describe.skip

const bootstrapStubL = Layer.succeed(LunaSqliteBootstrap, {
  ok: false,
  reason: "mcp-registry test — bootstrap stub",
} as const)

const makeFullLayer = (dbPath: string) =>
  McpServerStore.makeLayer(dbPath).pipe(
    Layer.provide(Clock.Default),
    Layer.provide(bootstrapStubL),
  )

const runSqlite = <A, E>(
  prog: Effect.Effect<A, E, McpServerStore | Scope.Scope>,
  dbPath = ":memory:",
) =>
  Effect.runPromise(
    Effect.scoped(prog).pipe(
      Effect.provide(makeFullLayer(dbPath)),
    ) as Effect.Effect<A, E, never>,
  )

const memoryLayer = McpServerStore.Memory.pipe(Layer.provide(Clock.Default))

const runMemory = <A, E>(prog: Effect.Effect<A, E, McpServerStore>) =>
  Effect.runPromise(
    prog.pipe(Effect.provide(memoryLayer)) as Effect.Effect<A, E, never>,
  )

// runFail: flips the error channel into the success channel so we can assert
// on the typed error without hitting FiberFailure wrapper semantics.
const runSqliteFail = <A, E>(
  prog: Effect.Effect<A, E, McpServerStore | Scope.Scope>,
  dbPath = ":memory:",
) =>
  Effect.runPromise(
    Effect.scoped(Effect.flip(prog)).pipe(
      Effect.provide(makeFullLayer(dbPath)),
    ) as Effect.Effect<E, A, never>,
  )

const runMemoryFail = <A, E>(prog: Effect.Effect<A, E, McpServerStore>) =>
  Effect.runPromise(
    Effect.flip(prog).pipe(
      Effect.provide(memoryLayer),
    ) as Effect.Effect<E, A, never>,
  )

// ---------------------------------------------------------------------------
// Shared contract tests — run against both backends
// ---------------------------------------------------------------------------

const contract = (
  run: <A, E>(
    prog: Effect.Effect<A, E, McpServerStore | Scope.Scope>,
  ) => Promise<A>,
  runFail: <A, E>(
    prog: Effect.Effect<A, E, McpServerStore | Scope.Scope>,
  ) => Promise<E>,
) => {
  // (a) add + get round-trip
  it("(a) add inserts a row and get retrieves it by slug", async () => {
    const row = await run(
      Effect.gen(function* () {
        const store = yield* McpServerStore
        const added = yield* store.add({
          slug: "my-server",
          url: "https://mcp.example.com/sse",
          headers: { Authorization: "env:MY_TOKEN" },
        })
        const fetched = yield* store.get("my-server")
        return { added, fetched }
      }),
    )
    expect(row.added.slug).toBe("my-server")
    expect(row.added.url).toBe("https://mcp.example.com/sse")
    expect(row.fetched).not.toBeNull()
    expect(row.fetched?.slug).toBe("my-server")
  })

  it("(a) get returns null for unknown slug", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* McpServerStore
        return yield* store.get("does-not-exist")
      }),
    )
    expect(result).toBeNull()
  })

  // (b) list
  it("(b) list returns all rows ordered by createdAt ascending", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* McpServerStore
        yield* store.add({ slug: "bravo", url: "https://b.example.com" })
        yield* store.add({ slug: "alpha", url: "https://a.example.com" })
        yield* store.add({ slug: "charlie", url: "https://c.example.com" })
        return yield* store.list()
      }),
    )
    // All three servers must be present.
    expect(result).toHaveLength(3)
    const slugs = result.map((r) => r.slug)
    expect(slugs).toContain("alpha")
    expect(slugs).toContain("bravo")
    expect(slugs).toContain("charlie")
    // createdAt values must be non-decreasing (ascending sort invariant).
    const timestamps = result.map((r) => r.createdAt)
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i - 1]!)
    }
    // Insertion order is preserved when each add gets a >= timestamp.
    // The list is sorted by createdAt ASC, so insertion order === list order.
    expect(slugs[0]).toBe("bravo")
    expect(slugs[1]).toBe("alpha")
    expect(slugs[2]).toBe("charlie")
  })

  it("(b) list returns empty when no servers registered", async () => {
    const rows = await run(
      Effect.gen(function* () {
        const store = yield* McpServerStore
        return yield* store.list()
      }),
    )
    expect(rows).toHaveLength(0)
  })

  // (c) reserved slug rejected
  it("(c) add rejects built-in slug 'memory' with McpSlugReserved", async () => {
    const err = await runFail(
      Effect.gen(function* () {
        const store = yield* McpServerStore
        return yield* store.add({ slug: "memory", url: "https://x.example.com" })
      }),
    )
    expect((err as { _tag: string })._tag).toBe("McpSlugReserved")
    expect((err as McpSlugReserved).slug).toBe("memory")
  })

  it("(c) add rejects all 8 built-in slugs", async () => {
    const reserved = [
      "memory",
      "scheduler",
      "observability",
      "local_shell",
      "secret_tools",
      "skill_tools",
      "widget_tools",
      "suggested_actions",
    ]
    for (const slug of reserved) {
      const err = await runFail(
        Effect.gen(function* () {
          const store = yield* McpServerStore
          return yield* store.add({ slug, url: "https://x.example.com" })
        }),
      )
      expect((err as { _tag: string })._tag).toBe("McpSlugReserved")
      expect((err as McpSlugReserved).slug).toBe(slug)
    }
  })

  // (d) invalid slug rejected
  it("(d) add rejects invalid slug 'Bad_Slug' (uppercase + underscore) with McpSlugInvalid", async () => {
    const err = await runFail(
      Effect.gen(function* () {
        const store = yield* McpServerStore
        return yield* store.add({ slug: "Bad_Slug", url: "https://x.example.com" })
      }),
    )
    expect((err as { _tag: string })._tag).toBe("McpSlugInvalid")
    expect((err as McpSlugInvalid).slug).toBe("Bad_Slug")
  })

  it("(d) add rejects slug with underscore only", async () => {
    const err = await runFail(
      Effect.gen(function* () {
        const store = yield* McpServerStore
        return yield* store.add({ slug: "bad_slug", url: "https://x.example.com" })
      }),
    )
    expect((err as { _tag: string })._tag).toBe("McpSlugInvalid")
  })

  it("(d) add rejects slug starting with a hyphen", async () => {
    const err = await runFail(
      Effect.gen(function* () {
        const store = yield* McpServerStore
        return yield* store.add({ slug: "-badstart", url: "https://x.example.com" })
      }),
    )
    expect((err as { _tag: string })._tag).toBe("McpSlugInvalid")
  })

  it("(d) add rejects empty slug", async () => {
    const err = await runFail(
      Effect.gen(function* () {
        const store = yield* McpServerStore
        return yield* store.add({ slug: "", url: "https://x.example.com" })
      }),
    )
    expect((err as { _tag: string })._tag).toBe("McpSlugInvalid")
  })

  // (e) duplicate slug rejected
  it("(e) add rejects duplicate slug with McpSlugExists", async () => {
    const err = await runFail(
      Effect.gen(function* () {
        const store = yield* McpServerStore
        yield* store.add({ slug: "dup-server", url: "https://first.example.com" })
        return yield* store.add({ slug: "dup-server", url: "https://second.example.com" })
      }),
    )
    expect((err as { _tag: string })._tag).toBe("McpSlugExists")
    expect((err as McpSlugExists).slug).toBe("dup-server")
  })

  // (f) headers stored / retrieved as secret-ref MAP, no raw secret leakage
  it("(f) headers round-trip as secret-ref map, not resolved values", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* McpServerStore
        const input = {
          slug: "header-test",
          url: "https://secure.example.com",
          headers: {
            Authorization: "env:EXAMPLE_TOKEN",
            "X-Custom": "env:CUSTOM_SECRET",
          },
        }
        yield* store.add(input)
        return yield* store.get("header-test")
      }),
    )
    expect(result).not.toBeNull()
    // Headers are the raw ref strings — NOT resolved token values.
    expect(result?.headers["Authorization"]).toBe("env:EXAMPLE_TOKEN")
    expect(result?.headers["X-Custom"]).toBe("env:CUSTOM_SECRET")
    // Confirm the value is literally the ref, not a resolved bearer token.
    expect(result?.headers["Authorization"]).not.toMatch(/^Bearer\s/)
  })

  it("(f) headers default to empty object when omitted", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* McpServerStore
        yield* store.add({ slug: "no-headers", url: "https://x.example.com" })
        return yield* store.get("no-headers")
      }),
    )
    expect(result?.headers).toEqual({})
  })

  // (g) listEnabledTrusted
  it("(g) listEnabledTrusted excludes untrusted rows (trustAcceptedAt null)", async () => {
    const rows = await run(
      Effect.gen(function* () {
        const store = yield* McpServerStore
        yield* store.add({ slug: "untrusted", url: "https://x.example.com" })
        return yield* store.listEnabledTrusted()
      }),
    )
    expect(rows).toHaveLength(0)
  })

  it("(g) listEnabledTrusted excludes disabled rows even when trusted", async () => {
    const rows = await run(
      Effect.gen(function* () {
        const store = yield* McpServerStore
        yield* store.add({ slug: "disabled-trusted", url: "https://x.example.com" })
        yield* store.acceptTrust("disabled-trusted", 1_000_000)
        yield* store.setEnabled("disabled-trusted", false)
        return yield* store.listEnabledTrusted()
      }),
    )
    expect(rows).toHaveLength(0)
  })

  it("(g) listEnabledTrusted includes enabled + trusted row after acceptTrust", async () => {
    const rows = await run(
      Effect.gen(function* () {
        const store = yield* McpServerStore
        yield* store.add({ slug: "trusted-ok", url: "https://x.example.com" })
        yield* store.acceptTrust("trusted-ok", 1_000_000)
        return yield* store.listEnabledTrusted()
      }),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.slug).toBe("trusted-ok")
    expect(rows[0]?.trustAcceptedAt).toBe(1_000_000)
  })

  it("(g) listEnabledTrusted returns only the trusted+enabled subset when mixed", async () => {
    const slugs = await run(
      Effect.gen(function* () {
        const store = yield* McpServerStore
        // untrusted
        yield* store.add({ slug: "a-untrusted", url: "https://a.example.com" })
        // trusted + enabled
        yield* store.add({ slug: "b-trusted", url: "https://b.example.com" })
        yield* store.acceptTrust("b-trusted", 2_000_000)
        // trusted + disabled
        yield* store.add({ slug: "c-disabled", url: "https://c.example.com" })
        yield* store.acceptTrust("c-disabled", 2_000_000)
        yield* store.setEnabled("c-disabled", false)
        return (yield* store.listEnabledTrusted()).map((r) => r.slug)
      }),
    )
    expect(slugs).toEqual(["b-trusted"])
  })

  // (h) allowTool deduplication
  it("(h) allowTool appends a tool name and deduplicates on repeat calls", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* McpServerStore
        yield* store.add({ slug: "tool-server", url: "https://x.example.com" })
        yield* store.allowTool("tool-server", "search")
        yield* store.allowTool("tool-server", "search") // duplicate — should deduplicate
        yield* store.allowTool("tool-server", "index")
        return yield* store.get("tool-server")
      }),
    )
    expect(result?.allowedTools).toHaveLength(2)
    expect(result?.allowedTools).toContain("search")
    expect(result?.allowedTools).toContain("index")
  })

  // (i) fail-closed defaults
  it("(i) freshly added row has allowedTools [] and allowAll false (fail-closed)", async () => {
    const row = await run(
      Effect.gen(function* () {
        const store = yield* McpServerStore
        return yield* store.add({ slug: "fresh-server", url: "https://x.example.com" })
      }),
    )
    expect(row.allowedTools).toEqual([])
    expect(row.allowAll).toBe(false)
    expect(row.trustAcceptedAt).toBeNull()
  })

  it("(i) freshly added row is enabled but not trusted and exposes no tools via listEnabledTrusted", async () => {
    const rows = await run(
      Effect.gen(function* () {
        const store = yield* McpServerStore
        yield* store.add({ slug: "closed-default", url: "https://x.example.com" })
        return yield* store.listEnabledTrusted()
      }),
    )
    expect(rows).toHaveLength(0)
  })

  // (j) URL validation — HTTPS enforcement
  it("(j) add rejects http:// url with McpUrlInvalid", async () => {
    const err = await runFail(
      Effect.gen(function* () {
        const store = yield* McpServerStore
        return yield* store.add({ slug: "http-server", url: "http://insecure.example.com" })
      }),
    )
    expect((err as { _tag: string })._tag).toBe("McpUrlInvalid")
    expect((err as McpUrlInvalid).url).toBe("http://insecure.example.com")
  })

  it("(j) add rejects a garbage non-URL with McpUrlInvalid", async () => {
    const err = await runFail(
      Effect.gen(function* () {
        const store = yield* McpServerStore
        return yield* store.add({ slug: "bad-url-server", url: "not-a-url-at-all" })
      }),
    )
    expect((err as { _tag: string })._tag).toBe("McpUrlInvalid")
    expect((err as McpUrlInvalid).url).toBe("not-a-url-at-all")
  })

  it("(j) add accepts a valid https:// url", async () => {
    const row = await run(
      Effect.gen(function* () {
        const store = yield* McpServerStore
        return yield* store.add({ slug: "https-server", url: "https://secure.example.com/mcp" })
      }),
    )
    expect(row.url).toBe("https://secure.example.com/mcp")
  })

  // remove
  it("remove deletes a row and list no longer returns it", async () => {
    const count = await run(
      Effect.gen(function* () {
        const store = yield* McpServerStore
        yield* store.add({ slug: "to-remove", url: "https://x.example.com" })
        yield* store.remove("to-remove")
        return (yield* store.list()).length
      }),
    )
    expect(count).toBe(0)
  })

  // setEnabled
  it("setEnabled flips enabled flag", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* McpServerStore
        yield* store.add({ slug: "toggle", url: "https://x.example.com" })
        yield* store.setEnabled("toggle", false)
        const disabled = yield* store.get("toggle")
        yield* store.setEnabled("toggle", true)
        const enabled = yield* store.get("toggle")
        return { disabled: disabled?.enabled, enabled: enabled?.enabled }
      }),
    )
    expect(result.disabled).toBe(false)
    expect(result.enabled).toBe(true)
  })

  // allowAllTools
  it("allowAllTools sets and clears the allowAll flag", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* McpServerStore
        yield* store.add({ slug: "allow-all-test", url: "https://x.example.com" })
        yield* store.allowAllTools("allow-all-test", true)
        const on = yield* store.get("allow-all-test")
        yield* store.allowAllTools("allow-all-test", false)
        const off = yield* store.get("allow-all-test")
        return { on: on?.allowAll, off: off?.allowAll }
      }),
    )
    expect(result.on).toBe(true)
    expect(result.off).toBe(false)
  })
}

// ---------------------------------------------------------------------------
// Apply contract to both backends
// ---------------------------------------------------------------------------

describe("McpServerStore.Memory", () => {
  contract(
    (prog) => runMemory(prog as Effect.Effect<never, never, McpServerStore>),
    (prog) => runMemoryFail(prog as Effect.Effect<never, never, McpServerStore>),
  )
})

dSqlite("McpServerStore.makeLayer (SQLite :memory:)", () => {
  contract(runSqlite, runSqliteFail)
})
