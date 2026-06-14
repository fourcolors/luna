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
  "packages/core/src/db/duckdb-service.test.ts",
  "packages/core/src/analytics/analytics.test.ts",
  "packages/core/src/telemetry/event-sink.test.ts",
  "packages/core/src/telemetry/session-sync.test.ts",
  "packages/core/src/telemetry/metrics-flusher.test.ts",
  "packages/core/src/telemetry/telemetry-platform.test.ts",
  "packages/core/src/wake/wake.test.ts",
  "packages/observability-tools/test/tools.test.ts",
  "packages/observability-tools/test/mcp-structure.test.ts",
]

export default defineConfig({
  test: {
    globals: false,
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", ...BUN_RUNTIME_TESTS],
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
