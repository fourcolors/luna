/**
 * vectorlite-init — process-wide one-shot initializer for the Vectorlite
 * SQLite extension (Phase 27).
 *
 * Why this exists:
 *   - bun:sqlite's `Database.setCustomSQLite(path)` MUST be called BEFORE
 *     the very first `new Database()` in the process. It is process-global
 *     and one-shot — calling it after any Database has been opened throws.
 *   - macOS ships a stock libsqlite3 with `SQLITE_OMIT_LOAD_EXTENSION`, so
 *     to use Vectorlite we MUST point bun:sqlite at Homebrew's libsqlite3
 *     (which is built with extension loading enabled).
 *   - Vectorlite ships a darwin-arm64 prebuilt as an optional dependency;
 *     `vectorlitePath()` returns the absolute path to the loadable .dylib
 *     (without the file extension; `loadExtension()` resolves it).
 *
 * Contract:
 *   - `initVectorlite()` is idempotent. The first call attempts to wire up
 *     bun:sqlite + vectorlite; subsequent calls return the cached result.
 *   - On macOS, the Homebrew sqlite path defaults to
 *     `/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib`. Override via the
 *     `LUNA_BREW_SQLITE_PATH` env var if needed (Linux/CI/etc.).
 *   - Returns `{ ok: true, path }` on success or `{ ok: false, reason }` on
 *     any failure (bun runtime missing, brew sqlite missing, vectorlite
 *     prebuilt missing, setCustomSQLite called too late, etc.). Callers
 *     should fall back to the naive in-process cosine path on `ok: false`.
 *
 * This helper does NOT import vectorlite at module-eval time — it does so
 * lazily inside `initVectorlite()` so that node-only environments (vitest)
 * can import this module without exploding.
 */

import { createRequire } from "node:module"
import type { VectorliteInitResult } from "@luna/core"

// Re-export the canonical type from @luna/core for back-compat with
// existing memory-internal consumers (Phase 27a — see brief §2.1).
export type { VectorliteInitResult }

let cached: VectorliteInitResult | null = null

const DEFAULT_BREW_SQLITE = "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib"

function isBunRuntime(): boolean {
  return typeof (process.versions as { bun?: string }).bun === "string"
}

/**
 * Idempotent process-wide init. Safe to call from multiple Layer builds —
 * the first call wins, the rest return the cached result.
 *
 * Test-only knob: set `LUNA_DISABLE_VECTORLITE=1` to force the naive path
 * (used by `HNSW #2` graceful-fallback test).
 */
export function initVectorlite(): VectorliteInitResult {
  if (cached !== null) return cached

  if (process.env.LUNA_DISABLE_VECTORLITE === "1") {
    cached = { ok: false, reason: "disabled by LUNA_DISABLE_VECTORLITE=1" }
    return cached
  }

  if (!isBunRuntime()) {
    cached = { ok: false, reason: "vectorlite requires bun runtime" }
    return cached
  }

  // bun:sqlite + vectorlite are both lazy-required so importing this
  // module under node (vitest) does not explode.
  const req = createRequire(import.meta.url)

  let DatabaseCtor: { setCustomSQLite: (p: string) => void }
  try {
    const mod = req("bun:sqlite") as
      | { Database?: { setCustomSQLite: (p: string) => void } }
      | undefined
    if (!mod || !mod.Database) {
      cached = { ok: false, reason: "bun:sqlite not available" }
      return cached
    }
    DatabaseCtor = mod.Database
  } catch (err) {
    cached = { ok: false, reason: `bun:sqlite import failed: ${String(err)}` }
    return cached
  }

  const brewPath = process.env.LUNA_BREW_SQLITE_PATH ?? DEFAULT_BREW_SQLITE
  try {
    DatabaseCtor.setCustomSQLite(brewPath)
  } catch (err) {
    cached = {
      ok: false,
      reason: `setCustomSQLite(${brewPath}) failed: ${String(err)}`,
    }
    return cached
  }

  let path: string
  try {
    const vl = req("vectorlite") as
      | { vectorlitePath?: () => string }
      | undefined
    if (!vl || typeof vl.vectorlitePath !== "function") {
      cached = { ok: false, reason: "vectorlite package missing or malformed" }
      return cached
    }
    path = vl.vectorlitePath()
  } catch (err) {
    cached = { ok: false, reason: `vectorlite import failed: ${String(err)}` }
    return cached
  }

  cached = { ok: true, path }
  return cached
}

/** Test-only: clear the cached init result. Not exported from package index. */
export function _resetVectorliteInitForTests(): void {
  cached = null
}
