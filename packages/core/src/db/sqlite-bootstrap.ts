/**
 * LunaSqliteBootstrap — process-wide marker service for the bun:sqlite +
 * Vectorlite swap (Phase 27a).
 *
 * Why this lives in @luna/core (not @luna/memory): the *constraint* — "a
 * Vectorlite/setCustomSQLite swap must have been attempted before any
 * `bun:sqlite` Database is opened" — is a core concern. Every core store
 * that opens a Database (`account-broker-sql`, `session-store-sqlite`,
 * `telemetry-store-sqlite`, `cost-store-sqlite`) declares this Tag in its
 * `R` channel so the type system enforces ordering at composition time.
 * The *implementation* of the swap (which dynamically requires
 * `vectorlite` and calls `Database.setCustomSQLite`) is memory-domain and
 * lives in `@luna/memory` as `LunaSqliteBootstrapLive`. Splitting the Tag
 * from its Live Layer keeps `@luna/core` free of any direct dependency on
 * `vectorlite`.
 *
 * Tag value (`VectorliteInitResult`) is a discriminated union: `{ ok:
 * true, path }` when the swap succeeded, or `{ ok: false, reason }` when
 * the runtime is non-bun, the prebuilt is missing, etc. Consumers don't
 * branch on this — they only need the side effect (setCustomSQLite ran).
 * The result is exposed in case a future consumer wants to surface the
 * fallback reason in a status/telemetry endpoint.
 *
 * App entrypoints (`apps/ui-web/scripts/chat-server.ts`) provide
 * `LunaSqliteBootstrapLive` at the bottom of the Layer.provide chain so
 * it builds first. Stores that yield* `LunaSqliteBootstrap` then run
 * after the swap is in place — single source of truth, no double-init
 * path. The agent-cli intentionally does NOT depend on this Tag (see
 * `apps/agent-cli/src/db.ts` policy header — the CLI opens bun:sqlite
 * outside any Effect Layer and doesn't load the memory subsystem).
 */
import { Context } from "effect"

/**
 * Result of a process-wide bun:sqlite + Vectorlite swap attempt. Mirrors
 * the shape `vectorlite-init.ts` produces so the existing memory-internal
 * helper can re-export this type without changing its surface.
 */
export type VectorliteInitResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: string }

/**
 * Marker service: "process-wide Vectorlite + bun:sqlite swap has been
 * attempted." Any Layer that opens a `bun:sqlite` Database lists this in
 * its `R` channel. The Live Layer (`LunaSqliteBootstrapLive`) lives in
 * `@luna/memory` to avoid a `@luna/core` → `vectorlite` dependency.
 */
export class LunaSqliteBootstrap extends Context.Service<
  LunaSqliteBootstrap,
  VectorliteInitResult
>()("luna/LunaSqliteBootstrap") {}
