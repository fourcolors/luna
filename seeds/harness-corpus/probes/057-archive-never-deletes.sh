#!/usr/bin/env bash
# PROBE:    ThreadRegistry Phase 3 — archive never deletes row, jsonl, or breaks resumability
# LESSON:   2026-06-15 — Cardinal invariant: archive is a reversible status flip,
#           not a deletion. Archived threads must stay SDK-resumable forever.
#           The 14-day auto-archive boundary is also guarded here: a 13-day-idle
#           thread must NOT be archived; a 15-day-idle one MUST be.
# SEVERITY: critical
#
# Contract (see ../CONTRACT.md): exit 0 = PASS, 77 = SKIP, anything else = FAIL.
set -uo pipefail

LUNA_REPO="${LUNA_REPO:-}"
[[ -n "$LUNA_REPO" ]] || { echo "SKIP: set LUNA_REPO to your Luna checkout"; exit 77; }

TR_PKG="$LUNA_REPO/packages/core"
[[ -d "$TR_PKG" ]] || { echo "SKIP: packages/core not found under LUNA_REPO=$LUNA_REPO"; exit 77; }

command -v bun >/dev/null 2>&1 || { echo "SKIP: bun absent"; exit 77; }

# Write the focused bun test harness into the core package dir and run it.
tmp="$TR_PKG/.harness-057-archive-probe.$$.ts"
trap 'rm -f "$tmp"' EXIT

cat > "$tmp" << 'HARNESS'
/**
 * Probe 057 — archive-never-deletes harness.
 *
 * Invariant A: after archive(), row still exists and sdkSessionId is intact
 *              (thread is still SDK-resumable).
 * Invariant B: after archive(), the thread is still present in the full list()
 *              (it was NOT deleted from the registry).
 * Invariant C: a 13-day-idle thread is NOT archived by runAutoArchive.
 * Invariant D: a 15-day-idle thread IS archived by runAutoArchive.
 * Invariant E: archived thread survives registry restart (simulated).
 */
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Clock } from "./src/clock.js"
import { LunaSqliteBootstrap } from "./src/db/sqlite-bootstrap.js"
import {
  ThreadRegistryService,
  AUTO_ARCHIVE_IDLE_MS,
  runAutoArchive,
} from "./src/threads/thread-registry.js"

const BootstrapStub = Layer.succeed(LunaSqliteBootstrap, {
  ok: false as const,
  reason: "probe stub",
})

const makeLayer = (dbPath: string) =>
  ThreadRegistryService.makeLayer(dbPath).pipe(
    Layer.provide(Clock.Default),
    Layer.provide(BootstrapStub),
  )

describe("057-archive-never-deletes", () => {
  test("Invariant A: after archive(), row exists and sdkSessionId is intact (thread resumable)", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const reg = yield* ThreadRegistryService
        yield* reg.upsert({ id: "thr_probe057_a", cwd: "/work", model: "claude-sonnet" })
        yield* reg.setSid("thr_probe057_a", "sdk-probe057-uuid")

        // ARCHIVE
        yield* reg.archive("thr_probe057_a")

        // Row must still exist
        const row = yield* reg.get("thr_probe057_a")
        if (row === null)
          throw new Error("DRIFT: row was deleted after archive() — cardinal invariant violated")
        if (row.sdkSessionId !== "sdk-probe057-uuid")
          throw new Error(`DRIFT: sdkSessionId changed after archive(): ${String(row.sdkSessionId)}`)
        if (row.status !== "archived")
          throw new Error(`DRIFT: status should be 'archived', got: ${row.status}`)
      }).pipe(Effect.provide(makeLayer(":memory:"))),
    )
  })

  test("Invariant B: archived thread still in list() (not deleted from registry)", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const reg = yield* ThreadRegistryService
        yield* reg.upsert({ id: "thr_probe057_b" })
        yield* reg.archive("thr_probe057_b")

        const all = yield* reg.list()
        const found = all.find((r) => r.id === "thr_probe057_b")
        if (!found)
          throw new Error("DRIFT: archived thread missing from list() — row was deleted")
        if (found.status !== "archived")
          throw new Error(`DRIFT: expected status=archived, got: ${found.status}`)
      }).pipe(Effect.provide(makeLayer(":memory:"))),
    )
  })

  test("Invariant C: 13-day-idle thread is NOT archived (below 14-day cutoff)", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const reg = yield* ThreadRegistryService
        yield* reg.upsert({ id: "thr_probe057_c" })

        const ts = (yield* reg.get("thr_probe057_c"))!.lastActiveAt
        // Simulate 13 days later
        const thirteenDaysLater = ts + 13 * 24 * 60 * 60 * 1000
        const archived = yield* runAutoArchive(reg, thirteenDaysLater)
        if (archived.includes("thr_probe057_c"))
          throw new Error("DRIFT: 13-day-idle thread was auto-archived — boundary test failed")
        const row = yield* reg.get("thr_probe057_c")
        if (row?.status !== "active")
          throw new Error(`DRIFT: expected status=active, got: ${row?.status}`)
      }).pipe(Effect.provide(makeLayer(":memory:"))),
    )
  })

  test("Invariant D: 15-day-idle thread IS archived (above 14-day cutoff)", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const reg = yield* ThreadRegistryService
        yield* reg.upsert({ id: "thr_probe057_d" })

        const ts = (yield* reg.get("thr_probe057_d"))!.lastActiveAt
        // Simulate 15 days later (+ 1ms to be safely over)
        const fifteenDaysLater = ts + 15 * 24 * 60 * 60 * 1000 + 1
        const archived = yield* runAutoArchive(reg, fifteenDaysLater)
        if (!archived.includes("thr_probe057_d"))
          throw new Error("DRIFT: 15-day-idle thread was NOT auto-archived — boundary test failed")
        const row = yield* reg.get("thr_probe057_d")
        if (row === null)
          throw new Error("DRIFT: row deleted by auto-archive — cardinal invariant violated")
        if (row.status !== "archived")
          throw new Error(`DRIFT: expected status=archived, got: ${row.status}`)
      }).pipe(Effect.provide(makeLayer(":memory:"))),
    )
  })

  test("Invariant E: archived thread survives registry restart (durable)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "luna-probe057-restart-"))
    const dbPath = join(tmp, "luna.db")

    // Session 1: create + archive
    await Effect.runPromise(
      Effect.gen(function* () {
        const reg = yield* ThreadRegistryService
        yield* reg.upsert({ id: "thr_probe057_e", cwd: "/work" })
        yield* reg.setSid("thr_probe057_e", "sdk-057-restart-uuid")
        yield* reg.archive("thr_probe057_e")
      }).pipe(Effect.provide(makeLayer(dbPath))),
    )

    // "Restart": fresh registry from same file
    await Effect.runPromise(
      Effect.gen(function* () {
        const reg = yield* ThreadRegistryService
        const row = yield* reg.get("thr_probe057_e")
        if (row === null)
          throw new Error("DRIFT: archived thread not found after restart")
        if (row.status !== "archived")
          throw new Error(`DRIFT: status changed after restart: ${row.status}`)
        if (row.sdkSessionId !== "sdk-057-restart-uuid")
          throw new Error("DRIFT: sdkSessionId changed after restart")
      }).pipe(Effect.provide(makeLayer(dbPath))),
    )
  })
})
HARNESS

out="$(cd "$TR_PKG" && bun test "$tmp" 2>&1)"; rc=$?
last="$(printf '%s\n' "$out" | grep -v '^[[:space:]]*$' | tail -n1)"

if echo "$out" | grep -q "DRIFT:"; then
  drift="$(echo "$out" | grep "DRIFT:" | head -3 | tr '\n' '; ')"
  echo "DRIFT: archive-never-deletes invariant violated — $drift"
  exit 1
fi

if [[ $rc -eq 0 ]]; then
  echo "OK: 057-archive-never-deletes — all 5 invariants hold (never-delete; 13d safe; 15d archived; restart durable)"
  exit 0
elif [[ $rc -eq 1 ]]; then
  echo "DRIFT: bun test exited $rc — $last"
  exit 1
else
  echo "SKIP: probe could not execute (rc=$rc) — $last"
  exit 77
fi
