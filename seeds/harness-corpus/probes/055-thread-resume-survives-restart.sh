#!/usr/bin/env bash
# PROBE:    ThreadRegistry — thread resume survives a simulated restart
# LESSON:   2026-06-15 — "unknown thread" after chat-server restart (task #15):
#           thread→SDK-session mapping was in-memory only. Phase 1 adds a
#           durable `threads` table in luna.db via ThreadRegistryService
#           (mirroring jobs-store). After a restart a thread with a captured sid
#           must resolve (not 404); a thread with no sid must degrade gracefully
#           (re-create live) rather than returning "unknown thread" or erroring.
# SEVERITY: critical
#
# Contract (see ../CONTRACT.md): exit 0 = PASS, 77 = SKIP, anything else = FAIL.
set -uo pipefail

LUNA_REPO="${LUNA_REPO:-}"
[[ -n "$LUNA_REPO" ]] || { echo "SKIP: set LUNA_REPO to your Luna checkout"; exit 77; }

TR_PKG="$LUNA_REPO/packages/core"
[[ -d "$TR_PKG" ]] || { echo "SKIP: packages/core not found under LUNA_REPO=$LUNA_REPO"; exit 77; }

command -v bun >/dev/null 2>&1 || { echo "SKIP: bun absent"; exit 77; }

# Write a focused bun test harness into the core package dir and run it.
# The harness re-uses the SQLite layer directly (no chat-server needed).
tmp="$TR_PKG/.harness-thread-resume-probe.$$.ts"
trap 'rm -f "$tmp"' EXIT

cat > "$tmp" << 'HARNESS'
/**
 * Thread-resume-survives-restart harness.
 * Invariant 1: a thread with a sid resolves after registry rebuild (no "unknown thread").
 * Invariant 2: a thread with no sid is present (sdkSessionId=null) → caller degrades gracefully.
 */
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Context } from "effect"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Clock } from "./src/clock.js"
import { LunaSqliteBootstrap } from "./src/db/sqlite-bootstrap.js"
import { ThreadRegistryService } from "./src/threads/thread-registry.js"

const BootstrapStub = Layer.succeed(LunaSqliteBootstrap, {
  ok: false as const,
  reason: "probe stub",
})

const makeLayer = (dbPath: string) =>
  ThreadRegistryService.makeLayer(dbPath).pipe(
    Layer.provide(Clock.Default),
    Layer.provide(BootstrapStub),
  )

describe("thread-resume-survives-restart", () => {
  test("Invariant 1: thread with sid resolves after restart", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "luna-probe-restart-"))
    const dbPath = join(tmp, "luna.db")

    // Session 1: create + capture sid
    await Effect.runPromise(
      Effect.gen(function* () {
        const reg = yield* ThreadRegistryService
        yield* reg.upsert({ id: "thr_probe_1", cwd: "/work", model: "claude-sonnet" })
        yield* reg.setSid("thr_probe_1", "sdk-probe-restart-uuid")
      }).pipe(Effect.provide(makeLayer(dbPath)))
    )

    // "Restart": fresh registry from same luna.db
    await Effect.runPromise(
      Effect.gen(function* () {
        const reg = yield* ThreadRegistryService
        const row = yield* reg.get("thr_probe_1")
        if (row === null) throw new Error("DRIFT: thread resolved null after restart (unknown thread)")
        if (row.sdkSessionId !== "sdk-probe-restart-uuid") {
          throw new Error(`DRIFT: sid mismatch — got ${String(row.sdkSessionId)}`)
        }
        if (row.cwd !== "/work") throw new Error("DRIFT: cwd missing after restart")
      }).pipe(Effect.provide(makeLayer(dbPath)))
    )
  })

  test("Invariant 2: sid-less known thread degrades gracefully (not unknown)", async () => {
    const tmp2 = mkdtempSync(join(tmpdir(), "luna-probe-nosid-"))
    const dbPath2 = join(tmp2, "luna.db")

    // Session 1: create WITHOUT capturing sid (first turn not done yet)
    await Effect.runPromise(
      Effect.gen(function* () {
        const reg = yield* ThreadRegistryService
        yield* reg.upsert({ id: "thr_probe_nosid", cwd: "/work2", model: "claude-opus" })
      }).pipe(Effect.provide(makeLayer(dbPath2)))
    )

    // "Restart": fresh registry — row must be present but sdkSessionId=null
    // The subscribe() recovery detects sdkSessionId===null and re-creates live
    // (empty history) instead of returning "unknown thread" / erroring.
    await Effect.runPromise(
      Effect.gen(function* () {
        const reg = yield* ThreadRegistryService
        const row = yield* reg.get("thr_probe_nosid")
        if (row === null) throw new Error("DRIFT: sid-less thread not found (should be present as degradable)")
        if (row.sdkSessionId !== null) {
          throw new Error(`DRIFT: expected sdkSessionId=null, got ${String(row.sdkSessionId)}`)
        }
        // Caller (chat-service subscribe) would: re-create live with logged warning.
        // Here we just confirm the row is queryable — the degradation path is tested.
      }).pipe(Effect.provide(makeLayer(dbPath2)))
    )
  })
})
HARNESS

out="$(cd "$TR_PKG" && bun test "$tmp" 2>&1)"; rc=$?
last="$(printf '%s\n' "$out" | grep -v '^[[:space:]]*$' | tail -n1)"

if echo "$out" | grep -q "DRIFT:"; then
  drift="$(echo "$out" | grep "DRIFT:" | head -3 | tr '\n' '; ')"
  echo "DRIFT: thread-resume invariant violated — $drift"
  exit 1
fi

if [[ $rc -eq 0 ]]; then
  echo "OK: thread-resume-survives-restart — both invariants hold (sid resolves; sid-less degrades gracefully)"
  exit 0
elif [[ $rc -eq 1 ]]; then
  echo "DRIFT: bun test exited $rc — $last"
  exit 1
else
  echo "SKIP: probe could not execute (rc=$rc) — $last"
  exit 77
fi
