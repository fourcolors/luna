/**
 * skill-prefs.smoke.ts — real-bun:sqlite proof for the skill_preferences
 * persistence path (PRD Part B, S2).
 *
 * The vitest suite gates the SQLite SkillPrefsStore tests behind
 * `typeof Bun !== "undefined"` (vitest workers are node — bun:sqlite is
 * unloadable there, same as account-broker-sql.test.ts). This smoke runs
 * under REAL bun, so the actual production path executes:
 *
 *   CHECK 1: migration ladder runs (skill_preferences via applyMigration);
 *            toggles upsert; disabledIds reads the delta.
 *   CHECK 2: a SECOND store build over the SAME file sees the persisted
 *            delta — the exact chat-server-restart hydration path — and a
 *            registry hydrated from it excludes the disabled skill's body.
 *
 * Run: bun run apps/server/scripts/smoke/skill-prefs.smoke.ts
 * Exit 0 = PASS, non-zero = FAIL
 */
import {
  BUILTIN_SKILLS,
  Clock,
  SkillPrefsStore,
  SkillRegistry,
} from "@luna/core"
import { LunaSqliteBootstrapLive } from "@luna/memory"
import { Effect, Layer, ManagedRuntime } from "effect"
import { rmSync } from "node:fs"

const RUN_ID = `${process.pid}-${Date.now()}`
const SMOKE_DB = `/tmp/luna-smoke-skill-prefs-${RUN_ID}.db`

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
  SkillPrefsStore.makeLayer(SMOKE_DB).pipe(
    Layer.provide(Clock.Default),
    Layer.provide(LunaSqliteBootstrapLive),
  )

async function main() {
  let exitCode = 0
  try {
    // ── CHECK 1: fresh store — migrate, toggle, read the delta ─────────
    const rt1 = ManagedRuntime.make(storeLayer())
    try {
      await rt1.runPromise(
        Effect.gen(function* () {
          const prefs = yield* SkillPrefsStore
          const before = yield* prefs.disabledIds()
          if (before.length !== 0) {
            throw new Error(`[check 1] expected empty store, got ${before.join(",")}`)
          }
          yield* prefs.setEnabled("clear-writing", false)
          yield* prefs.setEnabled("deep-research-discipline", false)
          yield* prefs.setEnabled("deep-research-discipline", true) // re-enable
          const disabled = yield* prefs.disabledIds()
          if (disabled.length !== 1 || disabled[0] !== "clear-writing") {
            throw new Error(`[check 1] expected [clear-writing], got [${disabled.join(",")}]`)
          }
          console.log("[check 1] migrate + upsert + delta read ✓")
        }),
      )
    } finally {
      await rt1.dispose()
    }

    // ── CHECK 2: REOPEN (the restart-hydration path) ────────────────────
    const rt2 = ManagedRuntime.make(storeLayer())
    try {
      await rt2.runPromise(
        Effect.gen(function* () {
          const prefs = yield* SkillPrefsStore
          const disabled = yield* prefs.disabledIds()
          if (disabled.length !== 1 || disabled[0] !== "clear-writing") {
            throw new Error(
              `[check 2] persisted delta lost across reopen: [${disabled.join(",")}]`,
            )
          }
          // Hydrate a registry exactly the way chat-server boot does.
          yield* Effect.gen(function* () {
            const reg = yield* SkillRegistry
            const snap = reg.promptSnapshotSync()
            if (snap.includes("Clear Writing")) {
              throw new Error("[check 2] disabled skill leaked into the hydrated snapshot")
            }
            if (!snap.includes("Deep Research Discipline")) {
              throw new Error("[check 2] re-enabled skill missing from the hydrated snapshot")
            }
          }).pipe(
            Effect.provide(
              SkillRegistry.layer({
                seeds: BUILTIN_SKILLS,
                initialDisabled: disabled,
                onToggle: (id, enabled) => prefs.setEnabled(id, enabled),
              }),
            ),
          )
          console.log("[check 2] reopen + hydrated-registry exclusion ✓")
        }),
      )
    } finally {
      await rt2.dispose()
    }

    console.log("\n[smoke] PASS — skill_preferences persists across reopen; hydration excludes disabled ✓")
  } catch (err: unknown) {
    console.error("\n[smoke] FAIL:", err)
    exitCode = 1
  } finally {
    cleanup()
  }
  process.exit(exitCode)
}

void main()
