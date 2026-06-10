/**
 * ArtifactStore tests — the durable backbone of pinned artifacts (PRD W1).
 *
 * Two load-bearing properties:
 *  - A pin SURVIVES a store reopen (two layer builds over the same SQLite
 *    file) — exactly what a chat-server restart does at hydration.
 *  - The version ledger is APPEND-ONLY: an agent edit adds a row, a revert
 *    copies an old version forward as a NEW head version. History is never
 *    rewritten, so a revert is itself revertible.
 *
 * The Memory variant runs everywhere (vitest/node); the SQLite variant is
 * bun-gated like skill-prefs-store.test.ts (`bun:sqlite` dies under node).
 */
import { afterEach, describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Clock } from "../clock.js"
import { LunaSqliteBootstrap } from "../db/sqlite-bootstrap.js"
import { ArtifactStore } from "./artifact-store.js"
import { deriveArtifactKind, type PinInput } from "./types.js"

const pin = (over: Partial<PinInput> & { id: string }): PinInput => ({
  title: "Untitled",
  content: "hello",
  ...over,
})

// ── Memory variant (runs everywhere) ───────────────────────────────────────

const runMem = <A, E>(eff: Effect.Effect<A, E, ArtifactStore>) =>
  Effect.runPromise(
    eff.pipe(
      Effect.provide(ArtifactStore.Memory),
      Effect.provide(Clock.Default),
    ) as Effect.Effect<A, E>,
  )

describe("ArtifactStore.Memory", () => {
  it("pin creates version 1, list + get return it", async () => {
    const result = await runMem(
      Effect.gen(function* () {
        const store = yield* ArtifactStore
        const a = yield* store.pin(
          pin({ id: "m1:0", title: "App", lang: "ts", content: "x" }),
        )
        const list = yield* store.list()
        const got = yield* store.get("m1:0")
        return { a, list, got }
      }),
    )
    expect(result.a.version).toBe(1)
    expect(result.a.kind).toBe("code")
    expect(result.list.map((x) => x.id)).toEqual(["m1:0"])
    expect(result.got?.content).toBe("x")
  })

  it("pin is idempotent on id — a double-click cannot fork history", async () => {
    const { first, second, versions } = await runMem(
      Effect.gen(function* () {
        const store = yield* ArtifactStore
        const first = yield* store.pin(pin({ id: "dup", content: "one" }))
        // Re-pin with different content: must return the ORIGINAL, untouched.
        const second = yield* store.pin(pin({ id: "dup", content: "two" }))
        const versions = yield* store.versions("dup")
        return { first, second, versions }
      }),
    )
    expect(second).toEqual(first)
    expect(second.content).toBe("one")
    expect(versions).toHaveLength(1)
  })

  it("update appends a version and advances the head", async () => {
    const { head, versions } = await runMem(
      Effect.gen(function* () {
        const store = yield* ArtifactStore
        yield* store.pin(pin({ id: "a", content: "v1" }))
        yield* store.update("a", "v2", "agent")
        const head = yield* store.update("a", "v3", "agent")
        const versions = yield* store.versions("a")
        return { head, versions }
      }),
    )
    expect(head?.version).toBe(3)
    expect(head?.content).toBe("v3")
    expect(versions.map((v) => [v.version, v.content, v.editedBy])).toEqual([
      [1, "v1", "user"],
      [2, "v2", "agent"],
      [3, "v3", "agent"],
    ])
  })

  it("revert copies an old version FORWARD as a new head (append-only)", async () => {
    const { head, versions } = await runMem(
      Effect.gen(function* () {
        const store = yield* ArtifactStore
        yield* store.pin(pin({ id: "a", content: "v1" }))
        yield* store.update("a", "v2", "agent")
        // Revert to version 1 → new version 3 with v1's content.
        const head = yield* store.revert("a", 1)
        const versions = yield* store.versions("a")
        return { head, versions }
      }),
    )
    expect(head?.version).toBe(3)
    expect(head?.content).toBe("v1")
    expect(versions).toHaveLength(3)
    expect(versions[2]).toMatchObject({ version: 3, content: "v1", editedBy: "user" })
  })

  it("unpin removes head + ledger; returns false for unknown id", async () => {
    const { removed, missing, list, versions } = await runMem(
      Effect.gen(function* () {
        const store = yield* ArtifactStore
        yield* store.pin(pin({ id: "gone", content: "x" }))
        yield* store.update("gone", "y", "agent")
        const removed = yield* store.unpin("gone")
        const missing = yield* store.unpin("never")
        const list = yield* store.list()
        const versions = yield* store.versions("gone")
        return { removed, missing, list, versions }
      }),
    )
    expect(removed).toBe(true)
    expect(missing).toBe(false)
    expect(list).toEqual([])
    expect(versions).toEqual([])
  })

  it("update + revert on an unknown id return null", async () => {
    const { u, r } = await runMem(
      Effect.gen(function* () {
        const store = yield* ArtifactStore
        const u = yield* store.update("ghost", "x", "agent")
        const r = yield* store.revert("ghost", 1)
        return { u, r }
      }),
    )
    expect(u).toBeNull()
    expect(r).toBeNull()
  })

  it("revert to a non-existent version returns null", async () => {
    const r = await runMem(
      Effect.gen(function* () {
        const store = yield* ArtifactStore
        yield* store.pin(pin({ id: "a", content: "v1" }))
        return yield* store.revert("a", 99)
      }),
    )
    expect(r).toBeNull()
  })

  it("explicit kind + bridgeCaps survive a round-trip (widget shape)", async () => {
    const got = await runMem(
      Effect.gen(function* () {
        const store = yield* ArtifactStore
        yield* store.pin(
          pin({
            id: "w1",
            kind: "widget",
            title: "PR tracker",
            content: "<html></html>",
            bridgeCaps: ["luna.notify", "luna.fetch"],
          }),
        )
        return yield* store.get("w1")
      }),
    )
    expect(got?.kind).toBe("widget")
    expect(got?.bridgeCaps).toEqual(["luna.notify", "luna.fetch"])
  })
})

// ── deriveArtifactKind (pure) ───────────────────────────────────────────────

describe("deriveArtifactKind", () => {
  it("classifies html / markdown / code from lang and path", () => {
    expect(deriveArtifactKind("html", null)).toBe("html")
    expect(deriveArtifactKind(null, "page.HTML")).toBe("html")
    expect(deriveArtifactKind("markdown", null)).toBe("markdown")
    expect(deriveArtifactKind("md", null)).toBe("markdown")
    expect(deriveArtifactKind(null, "README.md")).toBe("markdown")
    expect(deriveArtifactKind("ts", null)).toBe("code")
    expect(deriveArtifactKind(null, null)).toBe("code")
  })

  it("never derives the widget kind (W4 sets it explicitly)", () => {
    expect(deriveArtifactKind("widget", null)).toBe("code")
  })
})

// ── SQLite variant (bun-gated) ──────────────────────────────────────────────

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"
const d = isBun ? describe : describe.skip

const bootstrapStubL = Layer.succeed(LunaSqliteBootstrap, {
  ok: false,
  reason: "test-stub",
})

const dbPath = join(
  tmpdir(),
  `luna-artifacts-test-${process.pid}-${Date.now()}.db`,
)

afterEach(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(dbPath + suffix, { force: true })
    } catch {
      /* best-effort */
    }
  }
})

const storeLayer = () =>
  ArtifactStore.makeLayer(dbPath).pipe(
    Layer.provide(Clock.Default),
    Layer.provide(bootstrapStubL),
  )

const runStore = <A, E>(eff: Effect.Effect<A, E, ArtifactStore>) =>
  Effect.runPromise(
    eff.pipe(Effect.provide(storeLayer())) as Effect.Effect<A, E>,
  )

d("ArtifactStore (sqlite)", () => {
  it("a pin + its edits SURVIVE a reopen (restart-hydration path)", async () => {
    await runStore(
      Effect.gen(function* () {
        const store = yield* ArtifactStore
        yield* store.pin(pin({ id: "keep", title: "Doc", content: "draft" }))
        yield* store.update("keep", "revised", "agent")
      }),
    )
    // Second layer build over the SAME file — what a server restart does.
    const after = await runStore(
      Effect.gen(function* () {
        const store = yield* ArtifactStore
        const head = yield* store.get("keep")
        const versions = yield* store.versions("keep")
        return { head, versions }
      }),
    )
    expect(after.head?.content).toBe("revised")
    expect(after.head?.version).toBe(2)
    expect(after.versions.map((v) => v.content)).toEqual(["draft", "revised"])
  })

  it("full lifecycle: pin → update → revert → unpin over the file", async () => {
    const result = await runStore(
      Effect.gen(function* () {
        const store = yield* ArtifactStore
        yield* store.pin(
          pin({ id: "x", title: "T", lang: "ts", content: "a" }),
        )
        yield* store.update("x", "b", "agent")
        const reverted = yield* store.revert("x", 1)
        const list = yield* store.list()
        const removed = yield* store.unpin("x")
        const afterRemove = yield* store.list()
        return { reverted, list, removed, afterRemove }
      }),
    )
    expect(result.reverted?.content).toBe("a")
    expect(result.reverted?.version).toBe(3)
    expect(result.list).toHaveLength(1)
    expect(result.removed).toBe(true)
    expect(result.afterRemove).toEqual([])
  })

  it("bridgeCaps JSON survives the SQLite round-trip", async () => {
    const got = await runStore(
      Effect.gen(function* () {
        const store = yield* ArtifactStore
        yield* store.pin(
          pin({
            id: "w",
            kind: "widget",
            title: "W",
            content: "<html>",
            bridgeCaps: ["luna.notify"],
          }),
        )
        return yield* store.get("w")
      }),
    )
    expect(got?.bridgeCaps).toEqual(["luna.notify"])
  })
})
