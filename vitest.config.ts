import { defineConfig } from "vitest/config"

// ── Bun-runtime suites — excluded from vitest, run via `bun run test:bun` ────
// These suites exercise bun:sqlite (a Bun BUILT-IN) directly, or transitively
// through DuckDbService (default driver "bun:sqlite"), AnalyticsService, the
// telemetry sinks, or the wake loop. vitest runs on Node/vite and cannot
// resolve `bun:sqlite` ("Failed to load url bun:sqlite"), so under vitest they
// are FALSE failures. They are real, passing tests under the Bun test runner.
// CI runs BOTH runners (see .github/workflows/ci.yml and TESTING.md).
//
// Their sibling suites in the same directories (e.g. db/schema-versions,
// telemetry/noop-tracer, wake/wake-log-store) are pure/in-memory and DO run
// under vitest — which is why this is a file-precise list, not a dir glob.
// Adding a new bun:sqlite-backed suite? Add it here; test:bun already covers it
// via its per-package globs.
const BUN_RUNTIME_TESTS = [
  "packages/core/src/jobs/jobs-store.sqlite.test.ts",
  "packages/core/src/threads/thread-registry.sqlite.test.ts",
  "packages/core/src/threads/thread-registry-archival.sqlite.test.ts",
  "packages/core/src/session/session-store-sqlite.restart.test.ts",
  "packages/core/src/db/duckdb-service.test.ts",
  "packages/core/src/analytics/analytics.test.ts",
  "packages/core/src/telemetry/event-sink.test.ts",
  "packages/core/src/telemetry/session-sync.test.ts",
  "packages/core/src/telemetry/metrics-flusher.test.ts",
  "packages/core/src/telemetry/telemetry-platform.test.ts",
  "packages/core/src/wake/wake.test.ts",
  "packages/core/src/wake/workspace-schema.test.ts",
  "packages/observability-tools/test/tools.test.ts",
  "packages/observability-tools/test/mcp-structure.test.ts",
  "packages/channels/test/dedup-sqlite.test.ts",
]

// ── Host-environment suites — excluded by default, run via `bun run test:hostenv` ──
// These do not test Luna code in isolation; they shell out to the ops scripts,
// which probe the HOST for incus, tailscale, launchd, systemd units and
// profile lock state. Two distinct ways they go red on someone else's machine:
//
//   1. Tooling ABSENT - the script exits 2 and every `result.status === 0`
//      assertion fails. Not a Luna regression, just a host with no container
//      runtime.
//   2. Tooling PRESENT - worse. The self-hosted CI runner (jax-box) is itself
//      a real Luna deployment host, so guardian/update-server read genuine
//      on-disk profile state and fail with things like "already adopted
//      stable". The suite is reading the machine, not a fixture.
//
// Keeping these in the default run is what forced the whole vitest step to
// stay non-blocking, which in turn let real rot accumulate unseen (see ci.yml's
// HISTORY note). They are NOT abandoned: CI runs them in their own surfaced,
// non-blocking step and they still run locally via `bun run test:hostenv`.
//
// The follow-up that would let this list go away: give each one a hermetic
// fixture root (or a probe-gated skipIf for the tool it needs) so it stops
// depending on the machine it happens to run on.
const HOST_ENV_TESTS = [
  "test/deploy-scripts.test.ts",
  "test/guardian.test.ts",
  "test/update-server.test.ts",
]

// `bun run test:hostenv` sets this to opt the list back IN.
const includeHostEnvTests = process.env["LUNA_TEST_HOST_ENV"] === "1"

export default defineConfig({
  test: {
    globals: false,
    include: [
      "packages/**/*.test.ts",
      "apps/**/*.test.ts",
      "test/**/*.test.ts",
      // React-component tests need JSX (see apps/ui-moon-tauri's Astryx
      // panel conversions) - mirrors the .test.ts patterns above.
      "apps/**/*.test.tsx",
      "test/**/*.test.tsx",
    ],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      ...BUN_RUNTIME_TESTS,
      ...(includeHostEnvTests ? [] : HOST_ENV_TESTS),
    ],
    reporters: ["default"],
    testTimeout: 10_000,
    server: {
      deps: {
        // Zod v4 ships a double-exports block with a `.ts` source entry.
        // Without this, vitest's vite pipeline fails to resolve it in
        // packages that use zod (memory-tools, scheduler-tools).
        inline: [/zod/],
      },
    },
  },
})
