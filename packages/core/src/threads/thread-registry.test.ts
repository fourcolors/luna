/**
 * ThreadRegistry tests — covers Memory layer (deterministic, no SQLite).
 * SQLite-layer coverage: thread-registry.sqlite.test.ts (bun test runner).
 *
 * Mirror style: jobs-store.test.ts
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { Clock } from "../clock.js"
import { ThreadRegistryService } from "./thread-registry.js"

const TestLayer = ThreadRegistryService.Memory.pipe(Layer.provide(Clock.Default))

describe("ThreadRegistryService (Memory layer)", () => {
  it("upsert creates a new thread row", async () => {
    const program = Effect.gen(function* () {
      const reg = yield* ThreadRegistryService
      const row = yield* reg.upsert({ id: "thr_1_abc123" })
      expect(row.id).toBe("thr_1_abc123")
      expect(row.sdkSessionId).toBeNull()
      expect(row.cwd).toBeNull()
      expect(row.model).toBeNull()
      expect(row.effort).toBeNull()
      expect(row.createdAt).toBeGreaterThan(0)
      expect(row.lastActiveAt).toBeGreaterThan(0)
    })
    await Effect.runPromise(program.pipe(Effect.provide(TestLayer)))
  })

  it("upsert merges into an existing row", async () => {
    const program = Effect.gen(function* () {
      const reg = yield* ThreadRegistryService
      yield* reg.upsert({ id: "thr_2_abc123", model: "claude-3-7" })
      const updated = yield* reg.upsert({ id: "thr_2_abc123", effort: "max" })
      expect(updated.id).toBe("thr_2_abc123")
      expect(updated.model).toBe("claude-3-7") // preserved
      expect(updated.effort).toBe("max") // merged
    })
    await Effect.runPromise(program.pipe(Effect.provide(TestLayer)))
  })

  it("get returns null for missing ids", async () => {
    const program = Effect.gen(function* () {
      const reg = yield* ThreadRegistryService
      const missing = yield* reg.get("thr_99_nope")
      expect(missing).toBeNull()
    })
    await Effect.runPromise(program.pipe(Effect.provide(TestLayer)))
  })

  it("get returns the inserted row", async () => {
    const program = Effect.gen(function* () {
      const reg = yield* ThreadRegistryService
      yield* reg.upsert({
        id: "thr_3_getme",
        sdkSessionId: "sdk-abc",
        cwd: "/some/dir",
        model: "claude-opus",
      })
      const row = yield* reg.get("thr_3_getme")
      expect(row).not.toBeNull()
      expect(row?.sdkSessionId).toBe("sdk-abc")
      expect(row?.cwd).toBe("/some/dir")
      expect(row?.model).toBe("claude-opus")
    })
    await Effect.runPromise(program.pipe(Effect.provide(TestLayer)))
  })

  it("setSid persists the sdk session id and returns true", async () => {
    const program = Effect.gen(function* () {
      const reg = yield* ThreadRegistryService
      yield* reg.upsert({ id: "thr_4_setsid" })
      const ok = yield* reg.setSid("thr_4_setsid", "sdk-session-uuid-1")
      expect(ok).toBe(true)
      const row = yield* reg.get("thr_4_setsid")
      expect(row?.sdkSessionId).toBe("sdk-session-uuid-1")
    })
    await Effect.runPromise(program.pipe(Effect.provide(TestLayer)))
  })

  it("setSid returns false for missing thread", async () => {
    const program = Effect.gen(function* () {
      const reg = yield* ThreadRegistryService
      const ok = yield* reg.setSid("thr_999_ghost", "sdk-uuid")
      expect(ok).toBe(false)
    })
    await Effect.runPromise(program.pipe(Effect.provide(TestLayer)))
  })

  // REGRESSION: upsert must never clear a live sdk session id.
  // chat-service reuses createThread() to RESUME a thread, and it used to pass
  // `sdkSessionId: null`. Because `null !== undefined`, the update guard fired
  // and wiped the column — so resuming a thread destroyed the pointer it had
  // just resumed from. The type is now `string | undefined` so null cannot be
  // passed at all; this test pins the omitted-key behaviour it relies on.
  it("upsert preserves an existing sdk session id when the key is omitted", async () => {
    const program = Effect.gen(function* () {
      const reg = yield* ThreadRegistryService
      yield* reg.upsert({ id: "thr_sid_keep", sdkSessionId: "sdk-keep-me" })
      // A later upsert touching OTHER fields must leave the sid intact.
      yield* reg.upsert({ id: "thr_sid_keep", cwd: "/elsewhere", model: "claude-x" })
      const row = yield* reg.get("thr_sid_keep")
      expect(row?.sdkSessionId).toBe("sdk-keep-me")
      expect(row?.cwd).toBe("/elsewhere")
      expect(row?.model).toBe("claude-x")
    })
    await Effect.runPromise(program.pipe(Effect.provide(TestLayer)))
  })

  it("setConfig updates model and effort independently", async () => {
    const program = Effect.gen(function* () {
      const reg = yield* ThreadRegistryService
      yield* reg.upsert({ id: "thr_5_cfg", model: "claude-3-5" })
      const ok = yield* reg.setConfig("thr_5_cfg", { effort: "high" })
      expect(ok).toBe(true)
      const row = yield* reg.get("thr_5_cfg")
      expect(row?.model).toBe("claude-3-5") // unchanged
      expect(row?.effort).toBe("high") // set
    })
    await Effect.runPromise(program.pipe(Effect.provide(TestLayer)))
  })

  it("setConfig returns false for missing thread", async () => {
    const program = Effect.gen(function* () {
      const reg = yield* ThreadRegistryService
      const ok = yield* reg.setConfig("thr_999_ghost", { model: "x" })
      expect(ok).toBe(false)
    })
    await Effect.runPromise(program.pipe(Effect.provide(TestLayer)))
  })

  it("setTitleIfNull writes the title when null and never bumps lastActiveAt", async () => {
    const program = Effect.gen(function* () {
      const reg = yield* ThreadRegistryService
      const row0 = yield* reg.upsert({ id: "thr_9_title", nowMs: 1_000 })
      expect(row0.title).toBeNull()
      expect(row0.lastActiveAt).toBe(1_000)
      const wrote = yield* reg.setTitleIfNull("thr_9_title", "First message")
      expect(wrote).toBe(true)
      const row1 = yield* reg.get("thr_9_title")
      expect(row1?.title).toBe("First message")
      expect(row1?.lastActiveAt).toBe(1_000) // clock-neutral: no bump
    })
    await Effect.runPromise(program.pipe(Effect.provide(TestLayer)))
  })

  it("setTitleIfNull no-ops when the thread already has a title", async () => {
    const program = Effect.gen(function* () {
      const reg = yield* ThreadRegistryService
      yield* reg.upsert({ id: "thr_10_titled", title: "Existing", nowMs: 1_000 })
      const wrote = yield* reg.setTitleIfNull("thr_10_titled", "Other")
      expect(wrote).toBe(false)
      const row = yield* reg.get("thr_10_titled")
      expect(row?.title).toBe("Existing")
      expect(row?.lastActiveAt).toBe(1_000)
    })
    await Effect.runPromise(program.pipe(Effect.provide(TestLayer)))
  })

  it("upsert normalizes a blank/whitespace title to null (never stores '')", async () => {
    const program = Effect.gen(function* () {
      const reg = yield* ThreadRegistryService
      const row = yield* reg.upsert({ id: "thr_blank", title: "   " })
      expect(row.title).toBeNull()
    })
    await Effect.runPromise(program.pipe(Effect.provide(TestLayer)))
  })

  it("setTitleIfNull backfills a legacy blank-title row and rejects a blank input", async () => {
    const program = Effect.gen(function* () {
      const reg = yield* ThreadRegistryService
      // Simulate a legacy row that already holds "" (pre-normalization).
      yield* reg.upsert({ id: "thr_legacy_blank", nowMs: 1_000 })
      // A blank derived title is never persisted.
      expect(yield* reg.setTitleIfNull("thr_legacy_blank", "   ")).toBe(false)
      // A real title backfills the untitled row.
      expect(yield* reg.setTitleIfNull("thr_legacy_blank", "Real title")).toBe(true)
      const row = yield* reg.get("thr_legacy_blank")
      expect(row?.title).toBe("Real title")
      expect(row?.lastActiveAt).toBe(1_000) // still clock-neutral
    })
    await Effect.runPromise(program.pipe(Effect.provide(TestLayer)))
  })

  it("setTitleIfNull no-ops for a missing thread and never inserts", async () => {
    const program = Effect.gen(function* () {
      const reg = yield* ThreadRegistryService
      const wrote = yield* reg.setTitleIfNull("thr_999_ghost", "Nope")
      expect(wrote).toBe(false)
      const row = yield* reg.get("thr_999_ghost")
      expect(row).toBeNull()
    })
    await Effect.runPromise(program.pipe(Effect.provide(TestLayer)))
  })

  it("touch updates lastActiveAt and returns true", async () => {
    const program = Effect.gen(function* () {
      const reg = yield* ThreadRegistryService
      const row0 = yield* reg.upsert({ id: "thr_6_touch" })
      const ok = yield* reg.touch("thr_6_touch")
      expect(ok).toBe(true)
      const row1 = yield* reg.get("thr_6_touch")
      // lastActiveAt must be >= createdAt (real clock; at least equal)
      expect((row1?.lastActiveAt ?? 0) >= row0.createdAt).toBe(true)
    })
    await Effect.runPromise(program.pipe(Effect.provide(TestLayer)))
  })

  it("touch returns false for missing thread", async () => {
    const program = Effect.gen(function* () {
      const reg = yield* ThreadRegistryService
      const ok = yield* reg.touch("thr_999_ghost")
      expect(ok).toBe(false)
    })
    await Effect.runPromise(program.pipe(Effect.provide(TestLayer)))
  })

  it("list returns all rows", async () => {
    const program = Effect.gen(function* () {
      const reg = yield* ThreadRegistryService
      yield* reg.upsert({ id: "thr_7_a", model: "a" })
      yield* reg.upsert({ id: "thr_7_b", model: "b" })
      yield* reg.upsert({ id: "thr_7_c", model: "c" })
      const all = yield* reg.list()
      expect(all.length).toBe(3)
      const ids = all.map((r) => r.id).sort()
      expect(ids).toEqual(["thr_7_a", "thr_7_b", "thr_7_c"])
    })
    await Effect.runPromise(program.pipe(Effect.provide(TestLayer)))
  })

  it("full CRUD round-trip", async () => {
    const program = Effect.gen(function* () {
      const reg = yield* ThreadRegistryService

      // 1. Create
      const row = yield* reg.upsert({
        id: "thr_8_full",
        cwd: "/work/dir",
        model: "claude-3-7-sonnet",
      })
      expect(row.id).toBe("thr_8_full")
      expect(row.sdkSessionId).toBeNull()

      // 2. Capture sid
      yield* reg.setSid("thr_8_full", "sdk-abc-123")
      const afterSid = yield* reg.get("thr_8_full")
      expect(afterSid?.sdkSessionId).toBe("sdk-abc-123")

      // 3. Update config
      yield* reg.setConfig("thr_8_full", { effort: "max" })
      const afterConfig = yield* reg.get("thr_8_full")
      expect(afterConfig?.effort).toBe("max")
      expect(afterConfig?.model).toBe("claude-3-7-sonnet") // preserved

      // 4. Touch
      yield* reg.touch("thr_8_full")

      // 5. List
      const all = yield* reg.list()
      const found = all.find((r) => r.id === "thr_8_full")
      expect(found).toBeDefined()
      expect(found?.sdkSessionId).toBe("sdk-abc-123")
    })
    await Effect.runPromise(program.pipe(Effect.provide(TestLayer)))
  })
})
