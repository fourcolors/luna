#!/usr/bin/env bash
# PROBE:    SessionStore SQLite — snapshot fidelity across simulated restart
# LESSON:   2026-06-15 — in-memory SessionStore lost ALL message frames on
#           restart; subscribe() replayed only an empty snapshot to the UI.
#           Phase 2 adds a SQLite-backed SessionStore so frames survive restart:
#           N frames in → N frames out via readMessages() snapshot reconstruction.
# SEVERITY: critical
#
# Contract (see ../CONTRACT.md): exit 0 = PASS, 77 = SKIP, anything else = FAIL.
set -uo pipefail

LUNA_REPO="${LUNA_REPO:-}"
[[ -n "$LUNA_REPO" ]] || { echo "SKIP: set LUNA_REPO to your Luna checkout"; exit 77; }

SS_PKG="$LUNA_REPO/packages/core"
[[ -d "$SS_PKG" ]] || { echo "SKIP: packages/core not found under LUNA_REPO=$LUNA_REPO"; exit 77; }

command -v bun >/dev/null 2>&1 || { echo "SKIP: bun absent"; exit 77; }

# Write a focused bun test harness into the core package dir and run it.
# The harness re-uses the SQLite layer directly (no chat-server needed).
tmp="$SS_PKG/.harness-session-snapshot-probe.$$.ts"
trap 'rm -f "$tmp"' EXIT

cat > "$tmp" << 'HARNESS'
/**
 * Session snapshot-fidelity probe.
 *
 * Invariant 1: N frames appended in Session 1 → N frames readable in Session 2
 *   (frame count in == frame count out; subscribe snapshot is complete).
 * Invariant 2: message content is intact (no payload corruption across restart).
 * Invariant 3: seq is monotonic and gap-free in the replayed snapshot.
 */
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LunaSqliteBootstrap } from "./src/db/sqlite-bootstrap.js"
import { makeSessionStoreSqlite } from "./src/session/session-store-sqlite.js"
import { SessionStore } from "./src/session/session-store.js"

const BootstrapStub = Layer.succeed(LunaSqliteBootstrap, {
  ok: false as const,
  reason: "probe stub",
})

const makeLayer = (dbPath: string) =>
  makeSessionStoreSqlite(dbPath).pipe(Layer.provide(BootstrapStub))

describe("session-snapshot-fidelity", () => {
  test("Invariant 1: N frames in → N frames out after restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "luna-probe-snapshot-"))
    const dbPath = join(dir, "luna.db")
    const N = 10 // 5 user + 5 assistant turns

    // Session 1: write N frames
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* SessionStore
          yield* store.create({
            id: "probe_s1",
            options: { model: "claude-sonnet", title: "Probe session" },
            createdAt: 1000,
          })
          for (let i = 0; i < N; i++) {
            const kind = i % 2 === 0 ? ("user" as const) : ("assistant" as const)
            yield* store.appendMessage({
              sessionId: "probe_s1",
              messageId: `probe_msg_${i}`,
              ts: 1000 + i,
              parentId: null,
              kind,
              payload: { type: kind, message: { content: `Frame ${i}` } },
            })
          }
        }).pipe(Effect.provide(makeLayer(dbPath))),
      ),
    )

    // "Restart": fresh layer on the same DB
    const { frameCount, seqs } = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* SessionStore
          const msgs = yield* Stream.runCollect(store.readMessages("probe_s1"))
          const arr = Array.from(msgs)
          return {
            frameCount: arr.length,
            seqs: arr.map((m) => m.seq),
          }
        }).pipe(Effect.provide(makeLayer(dbPath))),
      ),
    )

    if (frameCount !== N) {
      throw new Error(
        `DRIFT: frame count mismatch — expected ${N}, got ${frameCount} (subscribe snapshot is incomplete after restart)`,
      )
    }

    const expectedSeqs = Array.from({ length: N }, (_, i) => i)
    if (JSON.stringify(seqs) !== JSON.stringify(expectedSeqs)) {
      throw new Error(
        `DRIFT: seq mismatch — expected [${expectedSeqs}], got [${seqs}]`,
      )
    }
  })

  test("Invariant 2: message content is faithful after restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "luna-probe-content-"))
    const dbPath = join(dir, "luna.db")
    const SENTINEL = "Luna Phase 2 snapshot fidelity sentinel 🌙"

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* SessionStore
          yield* store.create({
            id: "probe_content",
            options: { model: "claude-sonnet" },
            createdAt: 1000,
          })
          yield* store.appendMessage({
            sessionId: "probe_content",
            messageId: "sentinel_msg",
            ts: 2000,
            parentId: null,
            kind: "user",
            payload: {
              type: "user",
              message: { role: "user", content: SENTINEL },
            },
          })
        }).pipe(Effect.provide(makeLayer(dbPath))),
      ),
    )

    const payload = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* SessionStore
          const msgs = yield* Stream.runCollect(
            store.readMessages("probe_content"),
          )
          return Array.from(msgs)[0]?.payload
        }).pipe(Effect.provide(makeLayer(dbPath))),
      ),
    )

    const got = (payload as { message?: { content?: string } } | undefined)?.message?.content
    if (got !== SENTINEL) {
      throw new Error(
        `DRIFT: payload content mismatch — expected "${SENTINEL}", got "${String(got)}"`,
      )
    }
  })
})
HARNESS

out="$(cd "$SS_PKG" && bun test "$tmp" 2>&1)"; rc=$?

if echo "$out" | grep -q "DRIFT:"; then
  drift="$(echo "$out" | grep "DRIFT:" | head -3 | tr '\n' '; ')"
  echo "DRIFT: session-snapshot-fidelity invariant violated — $drift"
  exit 1
fi

if [[ $rc -eq 0 ]]; then
  echo "OK: session-snapshot-fidelity — both invariants hold (N frames in == N frames out; content faithful)"
  exit 0
else
  # Any non-zero exit from bun test means an assertion or runtime failure —
  # that is a hard FAIL, not a SKIP.  77 (SKIP) is reserved exclusively for
  # unmet preconditions (no bun, no LUNA_REPO, missing packages/core) which
  # are already handled above before bun test is ever invoked.
  last="$(printf '%s\n' "$out" | grep -v '^[[:space:]]*$' | tail -n1)"
  echo "DRIFT: bun test exited $rc — $last"
  exit 1
fi
