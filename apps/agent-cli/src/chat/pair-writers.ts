import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"

/**
 * Config writers shared by `luna pair`. These persist a secret WS token to two
 * on-disk client configs, so both writers:
 *   - create ~/.luna with mode 0700 if missing,
 *   - write to a SAME-DIR temp file then rename(2) (atomic on one filesystem),
 *   - create the temp with mode 0600 from the start (never a world-readable
 *     window, even transiently), and chmod the final file 0600 after rename.
 *
 * `upsertEnv` mirrors install.sh's bash `upsert_env`: replace the line that
 * starts with `KEY=`, else append; preserve every OTHER line verbatim; atomic
 * same-dir-temp rename; mode 0600. `writeMoonConnection` writes the EXACT JSON
 * shape (camelCase wsUrl/wsToken) the Moon widget's Rust save_connection writes
 * so Moon reads it on next launch.
 */

const lunaDir = (homeDir: string): string => join(homeDir, ".luna")

/** Ensure ~/.luna exists (mode 0700 — it holds secrets), return its path. */
const ensureLunaDir = (homeDir: string): string => {
  const dir = lunaDir(homeDir)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

/**
 * Atomically write `contents` to `finalPath` with mode 0600, via a same-dir
 * temp file. The temp is created mode 0600 from birth so the secret never has a
 * world-readable window. `dir` must be the directory containing `finalPath`.
 */
const writeAtomic0600 = (dir: string, finalPath: string, contents: string): void => {
  const tmp = join(dir, `.${randomSuffix()}.tmp`)
  // mode in writeFileSync is applied on creation (subject to umask), so chmod
  // immediately after to guarantee 0600 regardless of the process umask.
  writeFileSync(tmp, contents, { mode: 0o600 })
  chmodSync(tmp, 0o600)
  try {
    renameSync(tmp, finalPath)
  } catch (e) {
    // Best-effort cleanup of the temp on a failed rename so we never leave a
    // stray secret-bearing .tmp behind.
    try {
      if (existsSync(tmp)) rmSync(tmp, { force: true })
    } catch {
      // ignore
    }
    throw e
  }
  // rename preserves the source's 0600, but chmod again to be explicit (the
  // safest available pattern; never relies on a write-then-chmod 0644 window).
  chmodSync(finalPath, 0o600)
}

const randomSuffix = (): string =>
  `${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 10)}`

export const lunaEnvPath = (homeDir: string): string => join(lunaDir(homeDir), ".env")

export const moonConnectionPath = (homeDir: string): string =>
  join(lunaDir(homeDir), "moon-connection.json")

/**
 * Replace-or-append a single `KEY=value` line in ~/.luna/.env, preserving all
 * other lines. Mirrors install.sh upsert_env: match is a line whose START is
 * exactly `KEY=` (so `KEY=` but not `OTHERKEY=` nor a comment `#KEY=`). If the
 * key is absent, the line is appended. Atomic + mode 0600.
 */
export const upsertEnv = (homeDir: string, key: string, value: string): void => {
  const dir = ensureLunaDir(homeDir)
  const path = lunaEnvPath(homeDir)
  const existing = existsSync(path) ? readFileSync(path, "utf8") : ""

  // Preserve the file's line structure. We treat content as a list of physical
  // lines; a trailing newline yields a trailing empty element we drop, then we
  // re-join with \n and append a final newline (POSIX text file).
  const hadTrailingNewline = existing.length === 0 || existing.endsWith("\n")
  const rawLines = existing.length === 0 ? [] : existing.replace(/\n$/, "").split("\n")

  const prefix = `${key}=`
  const newLine = `${key}=${value}`
  let replaced = false
  const out = rawLines.map((line) => {
    if (!replaced && line.startsWith(prefix)) {
      replaced = true
      return newLine
    }
    return line
  })
  if (!replaced) out.push(newLine)

  // Always end with a single trailing newline (matches awk's print behavior).
  void hadTrailingNewline
  const contents = `${out.join("\n")}\n`
  writeAtomic0600(dir, path, contents)
}

/**
 * Write ~/.luna/moon-connection.json with the EXACT camelCase shape the Moon
 * widget's Rust save_connection writes. Compact (no trailing newline) to
 * byte-match `serde_json::to_string`. Atomic + 0600.
 *
 * KEY ORDER: Moon's serde_json is built WITHOUT the `preserve_order` feature
 * (confirmed: indexmap is not a serde_json dependency in its Cargo.lock), so
 * its BTreeMap-backed Map serializes keys in SORTED order — "wsToken" before
 * "wsUrl" (T < U). We emit the same sorted order so the file byte-matches the
 * Rust writer. (Functionally, Moon's load_connection uses from_str, which is
 * order-independent — but byte-matching keeps the two writers indistinguishable
 * on disk, which is what the pairing contract asks for.)
 */
export const writeMoonConnection = (
  homeDir: string,
  wsUrl: string,
  wsToken: string,
): void => {
  const dir = ensureLunaDir(homeDir)
  const path = moonConnectionPath(homeDir)
  const contents = JSON.stringify({ wsToken, wsUrl })
  writeAtomic0600(dir, path, contents)
}
