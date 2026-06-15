# Testing

Luna's test suite runs under **two runners**. This is deliberate, and CI runs both as hard gates. If you only run one, you will get a misleading picture.

| Command | Runner | What it covers |
|---|---|---|
| `bun run test` | **vitest** (Node/vite) | The large majority of suites. Default `bun run test`. |
| `bun run test:bun` | **`bun test`** (Bun runtime) | The `bun:sqlite`-backed suites (see list below). |
| `bun run test:all` | both | `bun run test && bun run test:bun` — full local coverage in one shot. |
| `bun run test:watch` | vitest | Watch mode for the vitest suites. |

> **TL;DR:** before pushing, run `bun run test:all`. Running only `bun run test` will silently skip the database/telemetry/wake coverage.

## Why two runners?

`DuckDbService` (`packages/core/src/db/duckdb-service.ts`) defaults to the
`bun:sqlite` driver — a **Bun built-in module**. vitest executes on Node via
vite, which cannot resolve `bun:sqlite`:

```
Error: Failed to load url bun:sqlite (resolved id: bun:sqlite) ... Does the file exist?
```

So any suite that touches a SQLite-backed store — directly, or transitively via
`AnalyticsService`, the telemetry sinks, the wake loop, or `AgentNotesService`'s
SQLite layer — must run under `bun test`, not vitest. These suites are **real,
passing tests** under Bun; they are not skipped or second-class.

Two patterns keep the runners from tripping over each other:

1. **Excluded from vitest.** Suites that *statically* `import { Database } from "bun:sqlite"` cannot even be loaded by vitest, so they are listed in `BUN_RUNTIME_TESTS` in [`vitest.config.ts`](vitest.config.ts) and excluded.
2. **Self-skipping under vitest.** Some suites (e.g. `packages/memory`, `packages/vault`) guard with `describe.skipIf(!hasBunSqlite)` and import `bun:sqlite` only transitively, so they *skip* cleanly under vitest and *run* under Bun.

Either way, `bun run test:bun` is what actually exercises them.

## The bun-runtime suites

Excluded from vitest, run under `bun test` (kept in sync with `BUN_RUNTIME_TESTS` in `vitest.config.ts`):

- `packages/core/src/db/duckdb-service.test.ts`
- `packages/core/src/analytics/analytics.test.ts`
- `packages/core/src/telemetry/event-sink.test.ts`
- `packages/core/src/telemetry/session-sync.test.ts`
- `packages/core/src/telemetry/metrics-flusher.test.ts`
- `packages/core/src/telemetry/telemetry-platform.test.ts`
- `packages/core/src/wake/wake.test.ts`
- `packages/observability-tools/test/tools.test.ts`
- `packages/observability-tools/test/mcp-structure.test.ts`

Plus the `skipIf`-guarded suites in `packages/memory` and `packages/vault`.

`bun run test:bun` runs the **packages** that contain these suites
(`core`, `observability-tools`, `memory`, `vault`) under Bun. Running whole
packages is intentional: their non-SQLite tests are runner-agnostic and pass
under Bun too, which gives a small amount of free cross-runner validation and
means new bun:sqlite suites in those packages are covered automatically.

## Adding a new bun:sqlite-backed suite

1. Write the test as usual (`*.test.ts`).
2. If it lives in a package **not** already covered by `test:bun`
   (`core` / `observability-tools` / `memory` / `vault`), add that package to
   the root `test:bun` script in [`package.json`](package.json).
3. If the suite **statically** imports `bun:sqlite` (so vitest can't even load
   the module), add its path to `BUN_RUNTIME_TESTS` in
   [`vitest.config.ts`](vitest.config.ts). If it only imports `bun:sqlite`
   transitively, prefer the `describe.skipIf(!hasBunSqlite)` guard instead.
4. Run `bun run test:all` and confirm both runners are green.

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs **both** runners
(`bun run test` and `bun run test:bun`). Before this split the bun:sqlite suites
were never executed in CI at all (vitest skipped or failed to load them, and
there was no Bun step), so their coverage was silently dropped — that gap is now
closed.

Both test steps are currently **non-blocking** (`continue-on-error`). The
bun:sqlite false failures are gone, but a separate **macOS-only baseline** is
still red when run on the Linux CI runner:

- `packages/core/src/secret-provider/keychain-helper.test.ts` — macOS Keychain
- `test/deploy-scripts.test.ts` (launchd-plist case) — `plutil` / launchd
- `apps/ui-web/scripts/__tests__/ui-models.test.ts`

These genuinely can't run on Linux. Promoting either runner to a hard gate is
deferred until those suites are guarded for non-Darwin (e.g.
`describe.skipIf(process.platform !== "darwin")`) — a separate follow-up. On
macOS, where most development happens, `bun run test:all` is fully green.
