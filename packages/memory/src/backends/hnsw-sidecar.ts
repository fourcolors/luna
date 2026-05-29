/**
 * hnsw-sidecar — vectorlite `index_file_path` (sidecar) path policy.
 *
 * Vectorlite supports persisting the HNSW graph to a file via the third
 * `CREATE VIRTUAL TABLE` argument (`index_file_path`). When provided,
 * vectorlite loads the graph from the file on connection open and
 * rewrites it on connection close, so the in-memory index survives
 * process restarts and short-lived diagnostic connections — no per-open
 * backfill cost.
 *
 * This module owns the dbPath → sidecar-path mapping and a couple of
 * filesystem helpers. The actual CREATE-time wiring + corruption
 * recovery lives in `sqlite-vector.ts` so this file stays I/O-free at
 * import time and node/vitest-safe.
 */

import { chmodSync, existsSync, unlinkSync } from "node:fs"

/**
 * Derive the sidecar path from a sqlite DB path. Returns `null` for
 * paths that can't host a sidecar file:
 *   - `":memory:"` and `""` (transient bun:sqlite databases)
 *   - any other path starting with `:` (sqlite URIs / special handlers)
 *
 * For ordinary disk paths the sidecar lives next to the DB:
 *   `/root/.luna/memory.db` → `/root/.luna/memory.db.hnsw.bin`
 *
 * The `.hnsw.bin` suffix keeps the pair globbable (`memory.db*`) for
 * backup/copy operations without an explicit allowlist.
 */
export function deriveHnswSidecarPath(dbPath: string): string | null {
  if (dbPath === "" || dbPath === ":memory:") return null
  if (dbPath.startsWith(":")) return null
  return `${dbPath}.hnsw.bin`
}

/**
 * Tighten sidecar file permissions to `0o600` so the persisted graph
 * inherits the same owner-only access posture as `memory.db` itself
 * (~/.luna/ is `0o700`, but the file vectorlite creates honors the
 * process umask — typically 0644). No-op when the file doesn't exist
 * yet (vectorlite creates it on first close/flush) or when chmod fails
 * (read-only fs, foreign owner — we don't want to crash the backend on
 * a cosmetic concern).
 */
export function secureSidecar(sidecarPath: string): void {
  try {
    if (existsSync(sidecarPath)) chmodSync(sidecarPath, 0o600)
  } catch {
    /* best-effort */
  }
}

/**
 * Remove a corrupt sidecar so the next CREATE can start from a clean
 * empty graph. Returns true when a file was removed, false when it
 * didn't exist or removal failed. Safe to call when the path is null
 * (no-op, returns false).
 */
export function discardSidecar(sidecarPath: string | null): boolean {
  if (sidecarPath === null) return false
  try {
    if (existsSync(sidecarPath)) {
      unlinkSync(sidecarPath)
      return true
    }
  } catch {
    /* best-effort */
  }
  return false
}
