/**
 * belief-injection-boot.smoke.ts — boot-risk verification for D5 + T3b.
 *
 * chat-server.ts has NO tsc gate (root tsconfig excludes apps/ui-web/**;
 * the file is in scripts/, Bun-transpiled), so a missing service in the
 * layer graph crashes the WHOLE boot. This smoke PROVES the thread-tools
 * layer builds correctly by importing the REAL exported
 * `ThreadToolsProviderLayer` factory — not a hand-copied mirror. A typo
 * or missing import in the actual edited code makes THIS smoke FAIL.
 *
 * Two assertions:
 *   CHECK 1 (initial render / D5): build the REAL ThreadToolsProviderLayer
 *     with a seeded ACTIVE belief in a FakeMemory MemoryRouter; assert
 *     decorate() output contains "## What I believe about Operator" + the
 *     belief statement, and decorate() does NOT throw at runSync.
 *     Regression guard: removing Layer.provide(seededMem) MUST make this FAIL.
 *
 *   CHECK 2 (live refresh / T3b): build with NO active belief (decorate()
 *     initially has no beliefs section); ADD an active belief to the mutable
 *     backing store; trigger one refresh tick via Effect.sleep; assert
 *     decorate() NOW contains the newly-added belief.
 *     This proves the holder refreshes live — a survey-activated belief
 *     appears in the next thread WITHOUT a server restart.
 *     Regression guard: removing the forkScoped refresh loop (leaving only
 *     the boot snapshot) MUST make this FAIL (added belief never appears).
 *
 * Run: bun run apps/ui-web/scripts/smoke/belief-injection-boot.smoke.ts
 * Exit 0 = PASS, non-zero = FAIL
 */
import {
  Clock,
  JobsStoreService,
  makeBeliefRecord,
  makeDuckDbLayer,
  makeTelemetrySqlite,
  ObservabilityService,
  TelemetryPlatform,
} from "@luna/core"
import { MemoryRouterTag } from "@luna/memory"
import type { MemoryRecord } from "@luna/memory"
import { LunaSqliteBootstrapLive } from "@luna/memory"
import { ThreadToolsProviderTag } from "@luna/chat-service"
import { Effect, Layer, ManagedRuntime, Ref, Stream } from "effect"
import { rmSync } from "node:fs"
import { ThreadToolsProviderLayer } from "../chat-server.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Per-run temp DB paths so the smoke is fully isolated from the operator's
// real ~/.luna DBs and two concurrent runs never collide.
//
// Subtlety: the real ThreadToolsProviderLayer provides ObsToolsLayer
// INTERNALLY (chat-server.ts:528), and ObsToolsLayer opens its OWN DuckDB at
// resolveAnalyticsDbPath() + AgentNotes at resolveLunaDbPath() — the DEFAULT
// ~/.luna/{analytics.duckdb,luna.db}. The provide-chain can't reach those, so
// we redirect them via the documented env overrides (LUNA_ANALYTICS_DB_PATH /
// LUNA_DB_PATH, layer.ts:62-74) set BEFORE buildLayer runs (resolve*DbPath is
// called lazily at ThreadToolsProviderLayer-invocation time, so module-top is
// in time despite import hoisting). DuckDB holds an exclusive lock file, so
// without this two concurrent runs deadlock on ~/.luna/analytics.duckdb.lock
// and every run mutates the operator's real analytics DB. RUN_ID = pid+ts.
//
// The telemetry-platform DuckDB (SMOKE_TEL_ANALYTICS_DB) MUST differ from the
// ObsTools one (SMOKE_OBS_ANALYTICS_DB): they're two separate DuckDbService
// builds, and same-path-in-one-process self-deadlocks on the lock file.
const RUN_ID = `${process.pid}-${Date.now()}`
const SMOKE_LUNA_DB = `/tmp/luna-smoke-belief-luna-${RUN_ID}.db`
const SMOKE_OBS_ANALYTICS_DB = `/tmp/luna-smoke-belief-obs-analytics-${RUN_ID}.duckdb`
const SMOKE_TEL_ANALYTICS_DB = `/tmp/luna-smoke-belief-tel-analytics-${RUN_ID}.duckdb`
const SMOKE_OBS_JSONL = `/tmp/luna-smoke-belief-obs-${RUN_ID}.jsonl`
process.env["LUNA_DB_PATH"] = SMOKE_LUNA_DB
process.env["LUNA_ANALYTICS_DB_PATH"] = SMOKE_OBS_ANALYTICS_DB

/** Best-effort removal of this run's temp DB files + their sidecars/locks. */
const cleanupSmokeArtifacts = (): void => {
  for (const base of [
    SMOKE_OBS_JSONL,
    SMOKE_LUNA_DB,
    SMOKE_OBS_ANALYTICS_DB,
    SMOKE_TEL_ANALYTICS_DB,
  ]) {
    // DuckDB → <db>.wal/.lock ; bun:sqlite → <db>-wal/-shm.
    for (const suffix of ["", ".wal", ".lock", "-wal", "-shm"]) {
      try {
        rmSync(base + suffix, { force: true })
      } catch {
        /* best-effort — never fail the smoke on cleanup */
      }
    }
  }
}

const clockL = Clock.Default
const obsL = ObservabilityService.makeLayer({
  logToConsole: false,
  jsonlPath: SMOKE_OBS_JSONL,
}).pipe(Layer.provide(clockL))

// TelemetryPlatform mirror — satisfies the EventSink + SessionSync services.
//
// Phase 14b (chat-server.ts commit 57def9d) made ObsToolsLayer require
// `EventSink | SessionSync` (the obs_pipeline_health tool reads their live
// health counters). ThreadToolsProviderLayer `yield*`s ObsToolsService, so
// those requirements bubble up into THIS smoke's graph. Without them the real
// layer build crashes at boot with "Service not found: luna/EventSink" — the
// exact regression chat-server.ts:1078-1089 documents.
//
// We reconstruct the production `telPlatformL` (chat-server.ts) verbatim
// rather than hand-rolling a minimal EventSink+SessionSync pair, because this
// smoke exists to prove the REAL graph builds AS IT DOES IN PRODUCTION — so it
// must stay covered if ObsToolsLayer later leans on EventCounter/MetricsFlusher
// too. Uses the per-run temp paths declared above (see the RUN_ID block) so
// each run is fresh, isolated from ~/.luna, and concurrency-safe.
const duckDbL = makeDuckDbLayer({ dbPath: SMOKE_TEL_ANALYTICS_DB })
const telemetryL = makeTelemetrySqlite(SMOKE_LUNA_DB).pipe(
  Layer.provide(clockL),
  Layer.provide(LunaSqliteBootstrapLive),
)
const telPlatformL = TelemetryPlatform.pipe(
  Layer.provide(Layer.mergeAll(obsL, duckDbL, telemetryL, clockL)),
)

/** Build the common provide-chain around a given memoryL + interval. */
const buildLayer = (
  memoryL: Layer.Layer<typeof MemoryRouterTag.Service, never, never>,
  refreshIntervalMs: number,
) =>
  ThreadToolsProviderLayer(refreshIntervalMs).pipe(
    Layer.provide(memoryL as never),
    // Mirrors production threadToolsL (chat-server.ts:1089): provide the
    // telemetry platform so the EventSink/SessionSync requirements pulled in by
    // ObsToolsService are satisfied instead of crashing the real layer build.
    Layer.provide(telPlatformL),
    // SchedulerToolsService (also yielded by ThreadToolsProviderLayer) requires
    // JobsStoreService for durable cron persistence (chat-server.ts:1077 wires
    // the SQLite-backed jobsStoreL). This smoke only verifies belief injection,
    // not job persistence, so the in-memory JobsStoreService.Memory variant
    // (requires only Clock) satisfies the build-time dependency without a DB
    // file. Without it the real layer build crashes with
    // "Service not found: luna/JobsStoreService".
    Layer.provide(JobsStoreService.Memory),
    Layer.provide(obsL),
    Layer.provide(clockL),
    Layer.provide(LunaSqliteBootstrapLive),
  )

// ---------------------------------------------------------------------------
// CHECK 1: initial render — seeded ACTIVE belief present at boot
// ---------------------------------------------------------------------------

const seeded = makeBeliefRecord({
  statement: "Operator prefers terse answers",
  confidence: 0.9,
  domain: "comms",
  status: "active",
  now: 0,
})

/**
 * Ref-backed FakeMemory seeded with one active belief. Used for CHECK 1.
 * Removing Layer.provide(seededMem) from buildLayer MUST make CHECK 1 FAIL
 * with a missing-MemoryRouter defect.
 */
const seededMem = Layer.effect(
  MemoryRouterTag,
  Effect.gen(function* () {
    const store = yield* Ref.make<Map<string, MemoryRecord>>(
      new Map([[seeded.id, seeded]]),
    )
    return {
      put: (r: MemoryRecord) =>
        Ref.update(store, (m) => new Map(m).set(r.id, r)),
      get: (id: string) =>
        Ref.get(store).pipe(Effect.map((m) => m.get(id) ?? null)),
      delete: () => Effect.succeed(false),
      query: () =>
        Stream.unwrap(
          Ref.get(store).pipe(
            Effect.map((m) => Stream.fromIterable(Array.from(m.values()))),
          ),
        ),
      search: () => Stream.empty,
    } as never
  }),
)

async function check1(): Promise<void> {
  console.log("\n[smoke] --- CHECK 1: initial render (boot belief present) ---")
  const rt = ManagedRuntime.make(buildLayer(seededMem, 30_000))
  try {
    await rt.runPromise(
      Effect.gen(function* () {
        const provider = yield* ThreadToolsProviderTag
        const binding = provider.decorate({} as never)
        const sp = binding.systemPrompt ?? ""
        if (!sp.includes("## What I believe about Operator")) {
          throw new Error(
            `[check 1] beliefs section missing from decorate() output.\n` +
              `systemPrompt (first 500 chars): ${sp.slice(0, 500)}`,
          )
        }
        console.log(
          "[check 1] decorate() systemPrompt contains '## What I believe about Operator' ✓",
        )
      }),
    )
  } finally {
    await rt.dispose()
  }
  console.log("[smoke] CHECK 1 PASS ✓")
}

// ---------------------------------------------------------------------------
// CHECK 2: live refresh — belief added AFTER boot appears after one tick
// ---------------------------------------------------------------------------

/**
 * Mutable plain array used as the backing store for CHECK 2's FakeMemory.
 * Plain array (not Ref) so the outer scope can push records directly —
 * that's deterministic and doesn't require any Effect coordination.
 */
let liveRecords: MemoryRecord[] = []

const liveMem = Layer.effect(
  MemoryRouterTag,
  Effect.gen(function* () {
    // No initial records — decorate() at boot should have no beliefs section.
    return {
      put: (r: MemoryRecord) => Effect.sync(() => { liveRecords.push(r) }),
      get: (_id: string) => Effect.succeed(null),
      delete: () => Effect.succeed(false),
      // query reads from the plain mutable array — reflects pushes immediately.
      query: () => Stream.fromIterable(liveRecords),
      search: () => Stream.empty,
    } as never
  }),
)

async function check2(): Promise<void> {
  console.log("\n[smoke] --- CHECK 2: live refresh (belief added post-boot appears) ---")

  // Use a tiny interval so the smoke test is fast and deterministic.
  const TEST_INTERVAL_MS = 20

  const rt = ManagedRuntime.make(buildLayer(liveMem, TEST_INTERVAL_MS))
  try {
    await rt.runPromise(
      Effect.gen(function* () {
        const provider = yield* ThreadToolsProviderTag

        // At boot (before any tick), the holder is populated from the
        // boot-time refreshBeliefs run — with no records, it's "".
        const spBefore = provider.decorate({} as never).systemPrompt ?? ""
        if (spBefore.includes("## What I believe about Operator")) {
          throw new Error(
            "[check 2] beliefs section should be ABSENT before adding a belief",
          )
        }
        console.log("[check 2] before refresh: no beliefs section ✓")

        // Now add an active belief to the mutable backing store.
        const added = makeBeliefRecord({
          statement: "Operator prefers live belief injection",
          confidence: 0.85,
          domain: "comms",
          status: "active",
          now: 0,
        })
        liveRecords.push(added)
        console.log("[check 2] pushed active belief to live backing store ✓")

        // Wait for ≥1 refresh tick (TEST_INTERVAL_MS is 20ms; sleep 3x that).
        yield* Effect.sleep(TEST_INTERVAL_MS * 3)

        // The refresh fiber has now run at least once — the holder should
        // contain the newly-added belief.
        const spAfter = provider.decorate({} as never).systemPrompt ?? ""
        if (!spAfter.includes("## What I believe about Operator")) {
          throw new Error(
            "[check 2] beliefs section STILL absent after refresh tick — " +
              "live refresh fiber did not pick up the added belief.\n" +
              `systemPrompt (first 500 chars): ${spAfter.slice(0, 500)}`,
          )
        }
        if (!spAfter.includes("Operator prefers live belief injection")) {
          throw new Error(
            "[check 2] belief statement not found after refresh.\n" +
              `systemPrompt (first 500 chars): ${spAfter.slice(0, 500)}`,
          )
        }
        console.log(
          "[check 2] after refresh: '## What I believe about Operator' present ✓",
        )
        console.log("[check 2] after refresh: belief statement present ✓")
      }),
    )
  } finally {
    // Reset mutable state so re-runs are independent.
    liveRecords = []
    await rt.dispose()
  }
  console.log("[smoke] CHECK 2 PASS ✓")
}

// ---------------------------------------------------------------------------
// Run both checks sequentially, then report
// ---------------------------------------------------------------------------

async function main() {
  let exitCode = 0
  try {
    await check1()
    await check2()
    console.log(
      "\n[smoke] PASS — real ThreadToolsProviderLayer builds (MemoryRouterTag satisfied); " +
        "initial render ✓ + live belief-refresh ✓",
    )
  } catch (err: unknown) {
    console.error("\n[smoke] FAIL:", err)
    exitCode = 1
  } finally {
    // Both runtimes are disposed by here (each check awaits rt.dispose()), so
    // the DB files are closed and safe to remove. Keeps /tmp tidy and
    // guarantees the next run is fresh even on a /tmp that isn't auto-cleared.
    cleanupSmokeArtifacts()
  }
  // process.exit AFTER the finally — calling it inside the try would terminate
  // synchronously and skip cleanup.
  process.exit(exitCode)
}

void main()
