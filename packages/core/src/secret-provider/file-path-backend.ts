/**
 * FilePathSecretProvider — resolves `file:<PATH>` and `file-json:<PATH>#<field>`
 * refs from the local filesystem.
 *
 * Refs that don't start with `file:` or `file-json:` are treated as misses
 * (ConfigError) so `firstOf` composition falls through to the next provider.
 *
 * Hardening rules (all violations → ConfigError, never throw, never hang):
 *   - Path must be absolute; rejects empty, relative, or paths containing
 *     `..` after path.normalize.
 *   - Uses lstat (NOT stat) so symlinks are seen as symlinks — rejects
 *     anything that is not a regular file (blocks symlink traversal).
 *   - Hard 64 KiB size cap enforced via openSync + readSync so the cap holds
 *     even if the file grows between stat and read.
 *   - Re-reads on every get() call — no caching (supports secret rotation).
 *   - Strips leading UTF-8 BOM before JSON.parse.
 *   - NEVER logs file contents or embeds them in error messages.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { Effect, Layer, Redacted } from "effect"
import { ConfigError } from "../errors.js"
import { SecretProvider, type SecretProviderApi } from "./secret-provider.js"

export const FILE_PATH_PREFIX = "file:" as const
export const FILE_JSON_PREFIX = "file-json:" as const

/** Hard read cap — 64 KiB. Prevents unbounded reads on large/adversarial files. */
export const FILE_SIZE_CAP_BYTES = 64 * 1024

// ---------------------------------------------------------------------------
// Internal helpers — never export raw file content
// ---------------------------------------------------------------------------

/**
 * Validate that the given path string is safe to read:
 *   - non-empty
 *   - absolute (starts with /)
 *   - no `..` after normalization
 *
 * Returns a ConfigError if any check fails.
 */
const validatePath = (
  rawPath: string,
  module: string,
): ConfigError | null => {
  if (rawPath.length === 0) {
    return new ConfigError({
      module,
      key: rawPath,
      message: "path is empty",
    })
  }
  if (!path.isAbsolute(rawPath)) {
    return new ConfigError({
      module,
      key: rawPath,
      message: `path must be absolute: ${rawPath}`,
    })
  }
  // Check for '..' in the raw path BEFORE normalization.
  // path.normalize resolves '..' segments (e.g. /tmp/../etc → /etc), so we
  // must reject any path that contains '..' as a component in the original
  // string to prevent traversal attacks.
  if (rawPath.split("/").some((seg) => seg === "..")) {
    return new ConfigError({
      module,
      key: rawPath,
      message: `path must not contain '..': ${rawPath}`,
    })
  }
  const normalized = path.normalize(rawPath)
  if (normalized.includes("..")) {
    return new ConfigError({
      module,
      key: rawPath,
      message: `path must not contain '..': ${rawPath}`,
    })
  }
  return null
}

/**
 * Read a file's contents as a string, enforcing:
 *   - lstat must report it as a regular file (no symlinks, no directories)
 *   - size cap via openSync + readSync
 *
 * Returns a ConfigError on any violation, never throws.
 */
const readFileSafe = (
  filePath: string,
  module: string,
): Effect.Effect<string, ConfigError> =>
  Effect.try({
    try: () => {
      // lstat: sees symlinks as symlinks, not as their targets.
      const stat = fs.lstatSync(filePath)
      if (!stat.isFile()) {
        throw new ConfigError({
          module,
          key: filePath,
          message: `path is not a regular file: ${filePath}`,
        })
      }
      if (stat.size > FILE_SIZE_CAP_BYTES) {
        throw new ConfigError({
          module,
          key: filePath,
          message: `file exceeds ${FILE_SIZE_CAP_BYTES}-byte size cap: ${filePath}`,
        })
      }
      // Use openSync + readSync to enforce the cap even if the file grows
      // between stat and read.
      const fd = fs.openSync(filePath, "r")
      try {
        const buf = Buffer.alloc(FILE_SIZE_CAP_BYTES + 1)
        const bytesRead = fs.readSync(fd, buf, 0, FILE_SIZE_CAP_BYTES + 1, 0)
        if (bytesRead > FILE_SIZE_CAP_BYTES) {
          throw new ConfigError({
            module,
            key: filePath,
            message: `file exceeds ${FILE_SIZE_CAP_BYTES}-byte size cap: ${filePath}`,
          })
        }
        return buf.subarray(0, bytesRead).toString("utf8")
      } finally {
        fs.closeSync(fd)
      }
    },
    catch: (e) => {
      if (e instanceof ConfigError) return e
      return new ConfigError({
        module,
        key: filePath,
        message: `failed to read file: ${filePath}`,
      })
    },
  })

/** Strip leading UTF-8 BOM if present (both raw bytes form and JS string form). */
const stripBom = (s: string): string => {
  // charCodeAt(0) === 0xfeff covers the BOM as a single JS string character.
  if (s.charCodeAt(0) === 0xfeff) return s.slice(1)
  // Also handle the case where the BOM bytes (0xEF 0xBB 0xBF) are present as
  // three individual latin-1 characters (U+00EF U+00BB U+00BF) — this happens
  // when a file written with the BOM byte sequence is read back and the bytes
  // are interpreted individually rather than as the single BOM codepoint.
  if (
    s.charCodeAt(0) === 0xef &&
    s.charCodeAt(1) === 0xbb &&
    s.charCodeAt(2) === 0xbf
  ) {
    return s.slice(3)
  }
  return s
}

/** Trim trailing newlines and carriage returns. */
const trimTrailing = (s: string): string => s.replace(/[\r\n]+$/, "")

/**
 * Resolve a dotted field path (e.g. "a.b.c") within a parsed JSON object.
 * Returns the leaf value or undefined if any segment is missing.
 */
const resolveDottedField = (
  obj: unknown,
  dottedKey: string,
): unknown => {
  const parts = dottedKey.split(".")
  let cur: unknown = obj
  for (const part of parts) {
    if (cur === null || typeof cur !== "object" || !(part in (cur as object))) {
      return undefined
    }
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const makeProvider = (): SecretProviderApi => ({
  get: (ref) => {
    // ── file: path ──────────────────────────────────────────────────────────
    if (ref.startsWith(FILE_PATH_PREFIX)) {
      const filePath = ref.slice(FILE_PATH_PREFIX.length)
      const pathErr = validatePath(filePath, "FilePathSecretProvider")
      if (pathErr !== null) return Effect.fail(pathErr)

      return readFileSafe(filePath, "FilePathSecretProvider").pipe(
        Effect.map((raw) => Redacted.make(trimTrailing(stripBom(raw)))),
      )
    }

    // ── file-json: path#field ────────────────────────────────────────────────
    if (ref.startsWith(FILE_JSON_PREFIX)) {
      const rest = ref.slice(FILE_JSON_PREFIX.length)
      const hashIdx = rest.indexOf("#")
      if (hashIdx === -1) {
        return Effect.fail(
          new ConfigError({
            module: "FilePathSecretProvider",
            key: ref,
            message: `file-json: ref must contain '#' field separator: ${ref}`,
          }),
        )
      }
      const filePath = rest.slice(0, hashIdx)
      const field = rest.slice(hashIdx + 1)

      const pathErr = validatePath(filePath, "FilePathSecretProvider")
      if (pathErr !== null) return Effect.fail(pathErr)

      return readFileSafe(filePath, "FilePathSecretProvider").pipe(
        Effect.flatMap((raw) => {
          const cleaned = stripBom(raw)
          let parsed: unknown
          try {
            parsed = JSON.parse(cleaned)
          } catch {
            return Effect.fail(
              new ConfigError({
                module: "FilePathSecretProvider",
                key: ref,
                message: `malformed JSON in file: ${filePath}`,
              }),
            )
          }
          const value = resolveDottedField(parsed, field)
          if (value === undefined) {
            return Effect.fail(
              new ConfigError({
                module: "FilePathSecretProvider",
                key: ref,
                message: `field '${field}' not found in: ${filePath}`,
              }),
            )
          }
          if (typeof value !== "string") {
            return Effect.fail(
              new ConfigError({
                module: "FilePathSecretProvider",
                key: ref,
                message: `field '${field}' is not a string in: ${filePath}`,
              }),
            )
          }
          if (value.length === 0) {
            return Effect.fail(
              new ConfigError({
                module: "FilePathSecretProvider",
                key: ref,
                message: `field '${field}' is an empty string in: ${filePath}`,
              }),
            )
          }
          return Effect.succeed(Redacted.make(value))
        }),
      )
    }

    // ── Not a file: or file-json: ref — ConfigError so firstOf falls through ─
    return Effect.fail(
      new ConfigError({
        module: "FilePathSecretProvider",
        key: ref,
        message: `ref is not a file: or file-json: ref: ${ref}`,
      }),
    )
  },
})

export const FilePathSecretProvider = {
  Default: Layer.effect(
    SecretProvider,
    Effect.sync(makeProvider),
  ),
} as const
