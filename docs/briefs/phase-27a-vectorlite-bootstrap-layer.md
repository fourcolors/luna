# Phase 27a — Vectorlite bootstrap Layer (fix HNSW init race)

> Phase 27 ships HNSW search via Vectorlite, but in `dev:server:chat` the speedup
> is silently bypassed. AccountBroker / SessionStore open `bun:sqlite` Databases
> before `SqliteVectorBackend.fromPath` runs `initVectorlite()`, so
> `Database.setCustomSQLite()` throws "SQLite already loaded" and the backend
> falls back to naive in-process cosine ranking. No test catches this.

## §0. Repro

Boot log from `bun run --filter '@luna/ui-web' dev:server:chat`:

```
[op] 3 providers active: antmachine, mrbot, flow
[luna/sqlite-vector] Vectorlite HNSW unavailable (setCustomSQLite(...) failed:
  Error: SQLite already loaded
This function can only be called before SQLite has been loaded and exactly
once. SQLite auto-loads when the first time you open a Database.); falling
back to naive in-process cosine ranking.
[accounts] 1 hydrated: anthropic×1
```

The fallback works (DESIGN.md §6.1 graceful degradation), but Phase 27's measured
~1000× p95 win at N=1k is gone in dev. Every dev run is a perf regression.

## §1. Citations (researcher-confirmed)

- `packages/memory/src/backends/vectorlite-init.ts:53` — `initVectorlite()`,
  already idempotent (caches result via module-level `let cached`).
- `packages/memory/src/backends/vectorlite-init.ts:87` — `setCustomSQLite()` call
  that throws when racing.
- `packages/memory/src/backends/sqlite-vector.ts:220` — current call site,
  inside `Layer.scoped` for `SqliteVectorBackend`. Too late.
- `packages/core/src/account-broker/account-broker-sql.ts:143` — opens
  `bun:sqlite` Database (race winner #1).
- `packages/core/src/session/session-store-sqlite.ts:196` — opens Database
  (race winner #2).
- `packages/core/src/telemetry/telemetry-store-sqlite.ts:165` — opens Database.
- `packages/core/src/cost-accounting/cost-store-sqlite.ts` — opens Database.
- `apps/ui-web/scripts/dev-server-chat.ts:307–310` — `Layer.provide` chain that
  doesn't enforce ordering.
- DESIGN.md §10.5 (Phase 27 forward-pointer, line 762) — "loads the Vectorlite
  SQLite extension at Layer build (process-wide one-shot via
  `Database.setCustomSQLite`)". Bootstrap Layer matches the contract; no
  amendment required.

## §2. Design (advisor-locked)

Advisor verdict: **⚠️ MODIFY** — drop the module-side-effect approach (option A
from researcher). Use an Effect-native bootstrap Layer with explicit dependency.

### 2.1 Two artifacts, two packages (advisor v2 — circular-dep fix)

The Tag must be importable by core stores; the Live Layer must call
`initVectorlite()` which lives in memory. Split accordingly:

**(a) `packages/core/src/db/sqlite-bootstrap.ts`** — types + Tag only, no
vectorlite import:

```ts
import { Context } from "effect"

/**
 * Result of a process-wide bun:sqlite + Vectorlite swap attempt. The type
 * lives in @luna/core because the constraint ("a bootstrap was built before
 * any Database opened") is a core concern — only the *implementation* of the
 * swap is memory-domain.
 */
export type VectorliteInitResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: string }

/**
 * Marker service: "process-wide Vectorlite + bun:sqlite swap has been
 * attempted". Any Layer that opens a `bun:sqlite` Database declares this in
 * its `R` so the type system enforces ordering. The Live Layer that satisfies
 * this Tag lives in @luna/memory (`LunaSqliteBootstrapLive`).
 */
export class LunaSqliteBootstrap extends Context.Tag(
  "luna/LunaSqliteBootstrap",
)<LunaSqliteBootstrap, VectorliteInitResult>() {}
```

Re-export from `packages/core/src/index.ts` (and `db/index.ts` if pattern).

**(b) `packages/memory/src/backends/vectorlite-bootstrap.ts`** — Live Layer
only:

```ts
import { LunaSqliteBootstrap } from "@luna/core"
import { Layer } from "effect"
import { initVectorlite } from "./vectorlite-init.js"

export const LunaSqliteBootstrapLive: Layer.Layer<LunaSqliteBootstrap> =
  Layer.sync(LunaSqliteBootstrap, () => initVectorlite())
```

`vectorlite-init.ts` continues to own `initVectorlite()` and the cached
result. Its existing local `VectorliteInitResult` type is replaced by a
re-export from `@luna/core` (zero-cost — same shape).

### 2.2 sqlite-vector consumes the Tag too

`packages/memory/src/backends/sqlite-vector.ts:220` currently calls
`initVectorlite()` directly. Switch to `yield* LunaSqliteBootstrap` —
single source of truth, no double init path.

### 2.3 Wire it as a dependency on every Database-opening Layer

For each of:
- `account-broker-sql.ts`
- `session-store-sqlite.ts`
- `telemetry-store-sqlite.ts`
- `cost-store-sqlite.ts`
- `sqlite-vector.ts`

Add `LunaSqliteBootstrap` to the `R` channel of each Layer. Pulling the tag
inside `Effect.gen` (`yield* LunaSqliteBootstrap`) BEFORE the dynamic
`import("bun:sqlite")` guarantees the bootstrap Layer has been built first.

### 2.4 App entrypoints provide the bootstrap

`apps/ui-web/scripts/dev-server-chat.ts` adds
`Layer.provide(LunaSqliteBootstrapLive)` at the end of its composition chain
(`Layer.provide` is bottom-up — what's listed last gets built first).

**`apps/agent-cli/` is intentionally NOT wired** — it opens `bun:sqlite` via
`createRequire` outside any Layer (see `apps/agent-cli/src/db.ts:1-18` header
"the CLI does NOT depend on the broker package"). The CLI doesn't load the
memory subsystem at all, so there's no race to fix there. Leave it alone.

### 2.5 Out of scope

- DESIGN.md text changes (§10.5 already covers the bootstrap shape).
- Touching `initVectorlite()` itself — it's idempotent and correct.
- Frozen artifacts (errors.ts, messages.ts, adapter-sdk/adapter.ts).

## §3. Commit plan (TDD order)

### 27a/1: regression test (red)

`packages/memory/test/integration-boot.test.ts` (vitest, gated to bun runtime via
`describe.skipIf(!process.versions.bun)`).

Builds a Layer.merge of `AccountBroker.fromSql(:memory:)` +
`SessionStore.fromPath(:memory:)` + `SqliteVectorBackend.fromPath(:memory:)` —
mimicking dev-server-chat's wiring. Asserts:

1. `SqliteVectorBackendApi.hnswEnabled === true` after boot (requires exposing
   this on the API — small additive change).
2. The boot log does NOT contain the "Vectorlite HNSW unavailable" warning.

This commit lands the test RED — proves the bug is real.

### 27a/2: feat(memory) — `LunaSqliteBootstrap` Layer + unit tests

- New `packages/memory/src/backends/vectorlite-bootstrap.ts` (helper above).
- Export from `packages/memory/src/index.ts`.
- Unit tests:
  - `LunaSqliteBootstrapLive` builds without error under bun.
  - Tag value matches `initVectorlite()` return.
  - Idempotent across multiple Layer.build calls.
- Regression test from 27a/1 still RED (no consumers yet).

### 27a/3: refactor(core stores) — depend on `LunaSqliteBootstrap`

Add `LunaSqliteBootstrap` to the `R` of:
- `account-broker-sql.ts`
- `session-store-sqlite.ts`
- `telemetry-store-sqlite.ts`
- `cost-store-sqlite.ts`
- `sqlite-vector.ts`

Each gen-block does `yield* LunaSqliteBootstrap` BEFORE the Database open.

After this commit:
- Each store's existing tests still pass (they get `LunaSqliteBootstrapLive`
  provided in their test harness — small fixture update).
- Regression test from 27a/1 GOES GREEN.

### 27a/4: refactor(apps) — provide the bootstrap at entrypoints

- `apps/ui-web/scripts/dev-server-chat.ts` adds `LunaSqliteBootstrapLive` to
  the Layer.provide chain.
- `apps/agent-cli/src/main.ts` (or equivalent CLI entrypoint) same.

After this commit:
- Manual smoke: boot dev:server:chat, log shows NO "Vectorlite HNSW unavailable"
  warning. (No automated test — that's what 27a/1 is for.)

## §4. Test discipline

- Vitest tail with numeric pass/fail in EVERY commit body.
- 27a/1 must be RED at land, GREEN after 27a/3.
- `bun run typecheck` clean across all 4 commits.
- Manual boot smoke after 27a/4 — paste the boot log into the commit body
  showing no HNSW warning.

## §5. Verification ladder (must run before declaring done)

1. `bun run typecheck` — clean
2. `bun run test` — all green, regression test included
3. Manual: `bun run --filter '@luna/ui-web' dev:server:chat`, look for
   absence of "Vectorlite HNSW unavailable" line.
4. (Optional) Vectorlite p95 sanity: hit `memory-search` with N≥500 records
   and confirm sub-ms latency.

## §6. Final report shape

When done, return:

1. Commit hashes for 27a/1 → 27a/4
2. `bun run typecheck` tail
3. `bun run test` tail (numeric)
4. Boot log from dev-server-chat showing no warning
5. Confirmation: regression test was red at 27a/1, green at 27a/3
6. Any deviations + why
