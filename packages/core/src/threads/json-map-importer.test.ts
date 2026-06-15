/**
 * JSON map importer tests — covers the one-shot boot migration.
 *
 * Runs under vitest (no bun:sqlite required — uses Memory layer).
 *
 * Validates:
 *  - sid-less entries are skipped
 *  - claude-test rows are dropped
 *  - valid rows are inserted with cwd backfill
 *  - cwd backfill is logged as a warning
 *  - import is idempotent
 *  - doubles-path resolution matches the real server path
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { writeFileSync, mkdtempSync, rmSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Clock } from "../clock.js"
import { ThreadRegistryService } from "./thread-registry.js"
import {
  importJsonMap,
  parseJsonMap,
  resolveJsonMapPath,
  type ImportResult,
} from "./json-map-importer.js"

const TestLayer = ThreadRegistryService.Memory.pipe(Layer.provide(Clock.Default))

/** Write a JSON map to a temp dir mirroring the doubled-path layout. */
const makeTempMap = (content: string): { lunaHome: string; cleanup: () => void } => {
  const tmp = mkdtempSync(join(tmpdir(), "luna-import-test-"))
  mkdirSync(join(tmp, ".luna"), { recursive: true })
  writeFileSync(join(tmp, ".luna", "thread-session-map.json"), content, "utf8")
  return {
    lunaHome: tmp,
    cleanup: () => { try { rmSync(tmp, { recursive: true, force: true }) } catch { /* best-effort */ } },
  }
}

describe("importJsonMap", () => {
  it("skips entries with no sid", async () => {
    const { lunaHome, cleanup } = makeTempMap(JSON.stringify({
      "thr_1_aaaaaa": { model: "claude-sonnet" }, // no sid
      "thr_2_bbbbbb": {}, // empty object
    }))
    try {
      const program = Effect.gen(function* () {
        const reg = yield* ThreadRegistryService
        const result: ImportResult = yield* Effect.promise(() =>
          importJsonMap(reg, lunaHome, "/cwd", Date.now()),
        )
        expect(result.total).toBe(2)
        expect(result.skippedNoSid).toBe(2)
        expect(result.inserted).toBe(0)
      })
      await Effect.runPromise(program.pipe(Effect.provide(TestLayer)))
    } finally { cleanup() }
  })

  it("drops claude-test rows — legacy shape (id contains marker)", async () => {
    // This covers the LEGACY test shape (marker in the id) — these are ids
    // that were used in earlier test fixtures but never appear in real data.
    // They should still be dropped if model is claude-test.
    const { lunaHome, cleanup } = makeTempMap(JSON.stringify({
      // Normal ids (no marker in id) whose VALUE has model=claude-test — the
      // REAL production shape (the one the original filter MISSED).
      "thr_1_aabbcc": { sid: "thr-tc", model: "claude-test" },
      "thr_2_ddeeff": { sid: "thr-tr", model: "claude-test" },
    }))
    try {
      const program = Effect.gen(function* () {
        const reg = yield* ThreadRegistryService
        const result: ImportResult = yield* Effect.promise(() =>
          importJsonMap(reg, lunaHome, "/cwd", Date.now()),
        )
        expect(result.skippedClaudeTest).toBe(2)
        expect(result.inserted).toBe(0)
      })
      await Effect.runPromise(program.pipe(Effect.provide(TestLayer)))
    } finally { cleanup() }
  })

  it("drops claude-test rows — real production shape (model field, normal id)", async () => {
    // Regression for audit finding #1: the original code matched CLAUDE_TEST_PAT
    // against the thread ID. In real data the simulator rows have NORMAL IDs
    // like `thr_loyw3v28_cf84mr` but `"model": "claude-test"` in their value.
    // This fixture verifies the corrected filter drops those rows.
    const { lunaHome, cleanup } = makeTempMap(JSON.stringify({
      // Real production shape: normal thr_<base36>_<rand> id, fake sid, model=claude-test.
      "thr_loyw3v28_cf84mr": { model: "claude-test" },            // no sid (common — ~395 rows)
      "thr_loyw3v28_strpvj": { sid: "thr-tc", model: "claude-test" }, // fake sid (~109 rows)
      // A real row that must NOT be dropped.
      "thr_loyw3v28_1p5x9i": { sid: "sdk-real-uuid-abc123", model: "claude-sonnet-4-6" },
    }))
    try {
      const program = Effect.gen(function* () {
        const reg = yield* ThreadRegistryService
        const result: ImportResult = yield* Effect.promise(() =>
          importJsonMap(reg, lunaHome, "/cwd", Date.now()),
        )
        // Two claude-test rows (one no-sid, one fake-sid) must be dropped.
        expect(result.skippedClaudeTest).toBe(2)
        // The no-sid claude-test row skips via the claude-test path, NOT the
        // skippedNoSid path — the model check must fire first.
        expect(result.skippedNoSid).toBe(0)
        // One real row inserted.
        expect(result.inserted).toBe(1)
        const rows = yield* reg.list()
        expect(rows).toHaveLength(1)
        expect(rows[0]?.id).toBe("thr_loyw3v28_1p5x9i")
      })
      await Effect.runPromise(program.pipe(Effect.provide(TestLayer)))
    } finally { cleanup() }
  })

  it("imports valid rows with sid and backfills cwd", async () => {
    const { lunaHome, cleanup } = makeTempMap(JSON.stringify({
      "thr_3_valid01": { sid: "sdk-session-valid-abc", model: "claude-opus", effort: "max" },
      "thr_4_valid02": "sdk-bare-string-sid-xyz",
    }))
    try {
      const program = Effect.gen(function* () {
        const reg = yield* ThreadRegistryService
        const result: ImportResult = yield* Effect.promise(() =>
          importJsonMap(reg, lunaHome, "/myworkdir", Date.now()),
        )
        expect(result.inserted).toBe(2)
        expect(result.cwdGuessed).toBe(2)
        const rows = yield* reg.list()
        const r3 = rows.find((r) => r.id === "thr_3_valid01")
        const r4 = rows.find((r) => r.id === "thr_4_valid02")
        expect(r3?.cwd).toBe("/myworkdir")
        expect(r3?.sdkSessionId).toBe("sdk-session-valid-abc")
        expect(r3?.model).toBe("claude-opus")
        expect(r4?.cwd).toBe("/myworkdir")
        expect(r4?.sdkSessionId).toBe("sdk-bare-string-sid-xyz")
      })
      await Effect.runPromise(program.pipe(Effect.provide(TestLayer)))
    } finally { cleanup() }
  })

  it("is idempotent — second import skips already-present rows", async () => {
    const { lunaHome, cleanup } = makeTempMap(JSON.stringify({
      "thr_5_idem01": { sid: "sdk-idem-session-abc" },
    }))
    try {
      let resultFirst: ImportResult | null = null
      let resultSecond: ImportResult | null = null

      const program = Effect.gen(function* () {
        const reg = yield* ThreadRegistryService
        resultFirst = yield* Effect.promise(() =>
          importJsonMap(reg, lunaHome, "/cwd", Date.now()),
        )
        resultSecond = yield* Effect.promise(() =>
          importJsonMap(reg, lunaHome, "/cwd", Date.now()),
        )
      })
      await Effect.runPromise(program.pipe(Effect.provide(TestLayer)))
      expect(resultFirst?.inserted).toBe(1)
      expect(resultSecond?.inserted).toBe(0)
      expect(resultSecond?.skippedAlreadyPresent).toBe(1)
    } finally { cleanup() }
  })

  it("logs a warning for every cwd-guessed row", async () => {
    const { lunaHome, cleanup } = makeTempMap(JSON.stringify({
      "thr_6_logtest": { sid: "sdk-logtest-session" },
    }))
    try {
      const warns: string[] = []
      const program = Effect.gen(function* () {
        const reg = yield* ThreadRegistryService
        yield* Effect.promise(() =>
          importJsonMap(reg, lunaHome, "/mydir", Date.now(), {
            log: (level, msg) => { if (level === "warn") warns.push(msg) },
          }),
        )
      })
      await Effect.runPromise(program.pipe(Effect.provide(TestLayer)))
      expect(warns.some((w) => w.includes("backfilling cwd"))).toBe(true)
    } finally { cleanup() }
  })

  it("mixed: valid + sid-less + claude-test (real production shape)", async () => {
    // Uses the real production shape: claude-test rows have NORMAL ids
    // and model="claude-test" in the value object.
    const { lunaHome, cleanup } = makeTempMap(JSON.stringify({
      "thr_7_good01": { sid: "sdk-good-001" },
      "thr_8_nosid": { model: "some-model" },
      // Real simulator shape: normal id, model=claude-test (no marker in id).
      "thr_9_simrow01": { sid: "thr-tc", model: "claude-test" },
    }))
    try {
      const program = Effect.gen(function* () {
        const reg = yield* ThreadRegistryService
        const result: ImportResult = yield* Effect.promise(() =>
          importJsonMap(reg, lunaHome, "/cwd", Date.now()),
        )
        expect(result.total).toBe(3)
        expect(result.inserted).toBe(1)
        expect(result.skippedNoSid).toBe(1)
        expect(result.skippedClaudeTest).toBe(1)
        const rows = yield* reg.list()
        expect(rows).toHaveLength(1)
        expect(rows[0]?.id).toBe("thr_7_good01")
      })
      await Effect.runPromise(program.pipe(Effect.provide(TestLayer)))
    } finally { cleanup() }
  })
})

describe("resolveJsonMapPath", () => {
  it("produces the doubled path ($LUNA_HOME/.luna/thread-session-map.json)", () => {
    const path = resolveJsonMapPath("/root/.luna")
    expect(path).toBe("/root/.luna/.luna/thread-session-map.json")
  })

  it("handles arbitrary lunaHome", () => {
    const path = resolveJsonMapPath("/tmp/myhome")
    expect(path).toBe("/tmp/myhome/.luna/thread-session-map.json")
  })
})

describe("parseJsonMap", () => {
  it("returns empty on missing file", () => {
    const result = parseJsonMap("/nonexistent/path/to/file.json")
    expect(result).toEqual({})
  })

  it("returns empty on invalid JSON", () => {
    const tmp = mkdtempSync(join(tmpdir(), "luna-parse-test-"))
    const jsonPath = join(tmp, "map.json")
    writeFileSync(jsonPath, "not json at all!")
    const result = parseJsonMap(jsonPath)
    try { rmSync(tmp, { recursive: true, force: true }) } catch { /* best-effort */ }
    expect(result).toEqual({})
  })
})
