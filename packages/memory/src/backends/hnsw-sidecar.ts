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

import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"

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
  // A discarded sidecar can no longer be vouched for; drop its provenance
  // record with it so a later file at the same path starts untrusted.
  removeHnswMeta(sidecarPath)
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

// --- Sidecar provenance ("meta") ---------------------------------------
//
// Vectorlite rewrites the sidecar from EVERY connection's in-memory graph
// when that connection closes, even one that only read (a `luna memory
// status` connection that closes after the server replaces the server's
// graph with its own older snapshot). The file itself therefore cannot say
// whether it matches memory_vectors, and no probe of the graph can either:
// an edit is DELETE + INSERT, so the row count stays the same and, because
// memory_vectors has no AUTOINCREMENT, the newest row's rowid is reused
// with a different embedding.
//
// So the backend records WHO wrote the file it trusts. When it closes, it
// stores a signature of the sidecar file it just flushed (size, mtime, inode)
// next to a fingerprint of the memory_vectors rows that graph was built
// from. On open the sidecar is trusted only if both still match: a
// different file signature means another connection rewrote it, a different
// source fingerprint means memory_vectors changed behind the graph. Any
// doubt (no meta, unreadable meta, stat error) means untrusted and the
// graph is rebuilt from memory_vectors, the canonical source of truth.

const META_VERSION = 1

export interface HnswSidecarMeta {
  readonly v: number
  readonly dimension: number
  /** `statHnswSidecar` signature of the sidecar the backend flushed. */
  readonly sidecar: string
  /** `fingerprintHnswSource` of the rows the flushed graph was built from. */
  readonly source: string
}

export function deriveHnswMetaPath(sidecarPath: string): string {
  return `${sidecarPath}.meta.json`
}

/**
 * Identity of the sidecar file as it is on disk right now, or null when it
 * is missing or cannot be stat-ed. Nanosecond mtime plus size and inode: a
 * rewrite by another connection changes at least one of them. ctime is
 * deliberately left out - our own chmod to 0o600 bumps it without any
 * change to the content.
 */
export function statHnswSidecar(sidecarPath: string): string | null {
  try {
    const st = statSync(sidecarPath, { bigint: true })
    return `${st.size}:${st.mtimeNs}:${st.ino}`
  } catch {
    return null
  }
}

export function readHnswMeta(sidecarPath: string): HnswSidecarMeta | null {
  try {
    const parsed = JSON.parse(
      readFileSync(deriveHnswMetaPath(sidecarPath), "utf8"),
    ) as Partial<HnswSidecarMeta> | null
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      parsed.v === META_VERSION &&
      typeof parsed.dimension === "number" &&
      typeof parsed.sidecar === "string" &&
      typeof parsed.source === "string"
    ) {
      return parsed as HnswSidecarMeta
    }
  } catch {
    /* missing or corrupt: untrusted */
  }
  return null
}

/** Atomic (tmp + rename), owner-only. Best-effort: a failed write only
 *  costs a rebuild on the next open. */
export function writeHnswMeta(
  sidecarPath: string,
  meta: Omit<HnswSidecarMeta, "v">,
): void {
  const metaPath = deriveHnswMetaPath(sidecarPath)
  const tmpPath = `${metaPath}.${process.pid}.tmp`
  try {
    writeFileSync(tmpPath, JSON.stringify({ v: META_VERSION, ...meta }), {
      mode: 0o600,
    })
    renameSync(tmpPath, metaPath)
  } catch {
    try {
      unlinkSync(tmpPath)
    } catch {
      /* best-effort */
    }
  }
}

export function removeHnswMeta(sidecarPath: string): void {
  try {
    unlinkSync(deriveHnswMetaPath(sidecarPath))
  } catch {
    /* already gone */
  }
}

/**
 * True only when the sidecar on disk is the exact file the backend last
 * flushed AND memory_vectors still holds the rows that graph was built
 * from. Every failure mode answers false (untrusted).
 */
export function isHnswSidecarTrusted(
  sidecarPath: string,
  dimension: number,
  sourceFingerprint: string,
): boolean {
  const meta = readHnswMeta(sidecarPath)
  if (meta === null) return false
  const current = statHnswSidecar(sidecarPath)
  return (
    current !== null &&
    meta.dimension === dimension &&
    meta.sidecar === current &&
    meta.source === sourceFingerprint
  )
}
