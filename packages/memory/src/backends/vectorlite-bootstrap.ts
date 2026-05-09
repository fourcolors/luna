/**
 * LunaSqliteBootstrapLive — Live Layer for the `LunaSqliteBootstrap` Tag
 * declared in `@luna/core` (Phase 27a).
 *
 * The Tag itself lives in `@luna/core/db/sqlite-bootstrap.ts`; only the
 * *implementation* — calling `initVectorlite()`, which dynamically
 * requires `vectorlite` and invokes `Database.setCustomSQLite()` — is
 * memory-domain. This split lets every core store declare
 * `LunaSqliteBootstrap` in its `R` channel without `@luna/core` taking a
 * direct dependency on `vectorlite`.
 *
 * `Layer.sync` is correct here because `initVectorlite()` is itself
 * synchronous (createRequire-based) and idempotent (cached via a
 * module-level `let cached`). Calling this Layer multiple times in the
 * same process returns the same `VectorliteInitResult` reference; the
 * Layer system will only build it once per Effect runtime regardless.
 *
 * App entrypoints (`apps/ui-web/scripts/chat-server.ts`) provide
 * this Layer at the bottom of their Layer.provide chain so it runs
 * before any store opens a Database. The agent-cli does NOT wire this
 * (see brief §2.4 — the CLI opens bun:sqlite outside any Layer and
 * doesn't load the memory subsystem; no race to fix).
 */
import { Layer } from "effect"
import { LunaSqliteBootstrap } from "@luna/core"
import { initVectorlite } from "./vectorlite-init.js"

export const LunaSqliteBootstrapLive: Layer.Layer<LunaSqliteBootstrap> =
  Layer.sync(LunaSqliteBootstrap, () => initVectorlite())
