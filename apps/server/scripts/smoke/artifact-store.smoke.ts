/**
 * artifact-store.smoke.ts — real-bun:sqlite proof for the pinned-artifact
 * persistence path (PRD Part C, W1 — §19).
 *
 * The vitest suite gates the SQLite ArtifactStore tests behind
 * `typeof Bun !== "undefined"` (vitest workers are node — bun:sqlite is
 * unloadable there). This smoke runs under REAL bun, so the production path
 * executes end to end:
 *
 *   CHECK 1: fresh store — migration ladder runs (artifacts + artifact_versions
 *            via applyMigration); pin → update appends a version + advances the
 *            head; revert copies an old version forward (append-only ledger).
 *   CHECK 2: a SECOND store build over the SAME file sees the persisted pin
 *            AND its full version history — the exact chat-server-restart
 *            hydration path — then unpin clears head + ledger.
 *
 * Run: bun run apps/server/scripts/smoke/artifact-store.smoke.ts
 * Exit 0 = PASS, non-zero = FAIL
 */
import { ArtifactStore, Clock } from "@luna/core"
import { LunaSqliteBootstrapLive } from "@luna/memory"
import { Effect, Layer, ManagedRuntime } from "effect"
import { rmSync } from "node:fs"

const RUN_ID = `${process.pid}-${Date.now()}`
const SMOKE_DB = `/tmp/luna-smoke-artifacts-${RUN_ID}.db`

const cleanup = (): void => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(SMOKE_DB + suffix, { force: true })
    } catch {
      /* best-effort */
    }
  }
}

const storeLayer = () =>
  ArtifactStore.makeLayer(SMOKE_DB).pipe(
    Layer.provide(Clock.Default),
    Layer.provide(LunaSqliteBootstrapLive),
  )

async function main() {
  let exitCode = 0
  try {
    // ── CHECK 1: fresh store — migrate, pin, edit, revert ──────────────────
    const rt1 = ManagedRuntime.make(storeLayer())
    try {
      await rt1.runPromise(
        Effect.gen(function* () {
          const store = yield* ArtifactStore
          const empty = yield* store.list()
          if (empty.length !== 0) {
            throw new Error(`[check 1] expected empty store, got ${empty.length}`)
          }
          const pinned = yield* store.pin({
            id: "msg-1:0",
            title: "deploy.sh",
            lang: "bash",
            content: "echo v1",
            origin: "thread-abc:3",
          })
          if (pinned.version !== 1 || pinned.kind !== "code") {
            throw new Error(`[check 1] bad initial pin: ${JSON.stringify(pinned)}`)
          }
          yield* store.update("msg-1:0", "echo v2", "agent")
          const reverted = yield* store.revert("msg-1:0", 1)
          if (reverted?.version !== 3 || reverted.content !== "echo v1") {
            throw new Error(`[check 1] revert wrong: ${JSON.stringify(reverted)}`)
          }
          const versions = yield* store.versions("msg-1:0")
          const shape = versions.map((v) => `${v.version}:${v.content}:${v.editedBy}`)
          const expected = ["1:echo v1:user", "2:echo v2:agent", "3:echo v1:user"]
          if (JSON.stringify(shape) !== JSON.stringify(expected)) {
            throw new Error(`[check 1] ledger wrong: ${shape.join(" | ")}`)
          }
          console.log("[check 1] migrate + pin + edit + append-only revert ✓")
        }),
      )
    } finally {
      await rt1.dispose()
    }

    // ── CHECK 2: REOPEN (the restart-hydration path) + unpin ────────────────
    const rt2 = ManagedRuntime.make(storeLayer())
    try {
      await rt2.runPromise(
        Effect.gen(function* () {
          const store = yield* ArtifactStore
          const head = yield* store.get("msg-1:0")
          if (head?.content !== "echo v1" || head.version !== 3) {
            throw new Error(`[check 2] pin/history lost across reopen: ${JSON.stringify(head)}`)
          }
          const versions = yield* store.versions("msg-1:0")
          if (versions.length !== 3) {
            throw new Error(`[check 2] version ledger lost: ${versions.length} rows`)
          }
          const removed = yield* store.unpin("msg-1:0")
          const afterList = yield* store.list()
          const afterVersions = yield* store.versions("msg-1:0")
          if (!removed || afterList.length !== 0 || afterVersions.length !== 0) {
            throw new Error("[check 2] unpin did not clear head + ledger")
          }
          console.log("[check 2] reopen-survival + unpin clears head + ledger ✓")
        }),
      )
    } finally {
      await rt2.dispose()
    }

    console.log(
      "\n[smoke] PASS — pinned artifacts + version ledger persist across reopen; unpin is clean ✓",
    )
  } catch (err: unknown) {
    console.error("\n[smoke] FAIL:", err)
    exitCode = 1
  } finally {
    cleanup()
  }
  process.exit(exitCode)
}

void main()
