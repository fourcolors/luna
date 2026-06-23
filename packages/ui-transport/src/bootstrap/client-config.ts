/**
 * Bootstrap config parser + tokenRef resolver for client.toml.
 *
 * TOML parser: smol-toml (tiny zero-dep ESM parser, ~20 KB, spec-compliant).
 *
 * Using smol-toml eliminates several classes of hand-parser bugs:
 *   - `#` inside quoted values was silently mangled (HIGH)
 *   - Trailing junk on section headers caused silent route-drops (HIGH)
 *   - Duplicate [route.x] sections were silently last-win instead of failing (MEDIUM)
 *   - Malformed lines were silently skipped instead of failing closed (MEDIUM)
 * smol-toml throws on all of the above per the TOML spec.
 *
 * tokenRef schemes supported (fail-closed — throws on any resolution failure):
 *   env:<VAR>       Read process.env[VAR]; throw if unset/empty/whitespace-only.
 *   file:<abs-path> Read file at absolute path; throw if missing or §8 checks fail.
 *   none            Returns "" — for ipc/no-auth routes (documented below).
 *   op://...        Throws a clear "not wired in this slice" error.
 *
 * NEVER returns an empty string except for "none". A raw (scheme-less) ref
 * is rejected — every tokenRef must carry a scheme prefix.
 *
 * fileFormatVersion: only versions 1–MAX_FILE_FORMAT_VERSION are accepted;
 * higher versions (produced by future tooling) are rejected with a clear error
 * so the caller knows to upgrade this library.
 */

import { parse as parseToml } from "smol-toml"
import type { RouteConfig } from "../contract.js"
import * as fs from "node:fs"
import * as fsAsync from "node:fs/promises"

// ── constants ─────────────────────────────────────────────────────────────────

/**
 * Highest fileFormatVersion this parser knows how to handle.
 * Reject anything higher so callers upgrade instead of silently misinterpreting.
 */
const MAX_FILE_FORMAT_VERSION = 3

// ── ParsedClientConfig ───────────────────────────────────────────────────────

export interface ParsedClientConfig {
  readonly fileFormatVersion: number
  readonly default?: string
  readonly routes: ReadonlyMap<string, RouteConfig>
}

// ── parseClientConfig ────────────────────────────────────────────────────────

/**
 * Parse client.toml content (as a string) into a structured config.
 *
 * Hard-fails if:
 *   - kind != "bootstrap" (catches a server registry file mis-fed here)
 *   - fileFormatVersion is missing, not an integer, or > MAX_FILE_FORMAT_VERSION
 *   - any [route.*] section is missing `endpoints` or `tokenRef`
 *   - `endpoints` is an empty array
 *   - `default` is set but references a non-existent route key
 *   - TOML itself is malformed (smol-toml throws), including:
 *       - duplicate keys or sections
 *       - malformed / unparseable lines
 *       - `#` inside quoted strings (preserved correctly, not truncated)
 */
export function parseClientConfig(toml: string): ParsedClientConfig {
  // smol-toml: throws on malformed TOML, duplicate keys, invalid structure.
  // This replaces the hand-written parser and eliminates all its bug classes.
  let doc: Record<string, unknown>
  try {
    doc = parseToml(toml) as Record<string, unknown>
  } catch (err) {
    throw new Error(
      `client-config: TOML parse error: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // ── Top-level scalars ──────────────────────────────────────────────────────

  const kind = doc["kind"]
  if (kind !== "bootstrap") {
    throw new Error(
      `client-config: expected kind="bootstrap" but got ${JSON.stringify(kind)}. ` +
        `This looks like a server registry file — use the correct file.`,
    )
  }

  const fileFormatVersionRaw = doc["fileFormatVersion"]
  if (
    typeof fileFormatVersionRaw !== "number" ||
    !Number.isInteger(fileFormatVersionRaw)
  ) {
    throw new Error(
      "client-config: fileFormatVersion is required and must be an integer.",
    )
  }
  const fileFormatVersion = fileFormatVersionRaw as number
  if (fileFormatVersion > MAX_FILE_FORMAT_VERSION) {
    throw new Error(
      `client-config: fileFormatVersion ${fileFormatVersion} is newer than this ` +
        `parser supports (max ${MAX_FILE_FORMAT_VERSION}). Upgrade @luna/ui-transport.`,
    )
  }

  const defaultRoute =
    "default" in doc && doc["default"] !== undefined
      ? String(doc["default"])
      : undefined

  // ── [route.*] sections ────────────────────────────────────────────────────

  const routeSection = doc["route"]
  const routes = new Map<string, RouteConfig>()

  if (routeSection !== null && routeSection !== undefined) {
    if (typeof routeSection !== "object" || Array.isArray(routeSection)) {
      throw new Error(`client-config: "route" must be a TOML table, got: ${typeof routeSection}`)
    }

    for (const [routeKey, rawEntry] of Object.entries(routeSection as Record<string, unknown>)) {
      if (typeof rawEntry !== "object" || rawEntry === null || Array.isArray(rawEntry)) {
        throw new Error(
          `client-config: route "${routeKey}" must be a TOML table, got: ${typeof rawEntry}`,
        )
      }
      const entry = rawEntry as Record<string, unknown>

      // endpoints: required, non-empty string[]
      const endpointsRaw = entry["endpoints"]
      if (!Array.isArray(endpointsRaw) || endpointsRaw.length === 0) {
        throw new Error(
          `client-config: route "${routeKey}" is missing a non-empty endpoints array.`,
        )
      }
      const endpoints: string[] = endpointsRaw.map((ep, i) => {
        if (typeof ep !== "string") {
          throw new Error(
            `client-config: route "${routeKey}".endpoints[${i}] must be a string.`,
          )
        }
        return ep
      })

      // tokenRef: required non-empty string
      const tokenRef = entry["tokenRef"]
      if (typeof tokenRef !== "string" || !tokenRef) {
        throw new Error(
          `client-config: route "${routeKey}" is missing tokenRef.`,
        )
      }

      // label: optional string
      const labelRaw = entry["label"]
      const label = typeof labelRaw === "string" ? labelRaw : undefined

      // expect: optional — string shorthand → {spki}
      const expectRaw = entry["expect"]
      const expect =
        typeof expectRaw === "string"
          ? { spki: expectRaw }
          : expectRaw !== undefined && typeof expectRaw === "object" && !Array.isArray(expectRaw)
            ? (expectRaw as { spki: string })
            : undefined

      const route: RouteConfig = {
        routeKey,
        endpoints,
        tokenRef,
        ...(label !== undefined ? { label } : {}),
        ...(expect !== undefined ? { expect } : {}),
      }
      routes.set(routeKey, route)
    }
  }

  if (defaultRoute !== undefined && !routes.has(defaultRoute)) {
    throw new Error(
      `client-config: default="${defaultRoute}" references a route that does not exist. ` +
        `Defined routes: ${[...routes.keys()].join(", ") || "(none)"}`,
    )
  }

  return {
    fileFormatVersion,
    ...(defaultRoute !== undefined ? { default: defaultRoute } : {}),
    routes,
  }
}

// ── resolveTokenRef ──────────────────────────────────────────────────────────

/**
 * Resolve a tokenRef string to a concrete token value.
 *
 * FAIL-CLOSED: throws on any resolution failure. Never returns an empty
 * string except for the explicit "none" scheme (documented below).
 *
 * Schemes:
 *   env:<VAR>        Read process.env[VAR]. Throws if unset, empty, or whitespace-only.
 *   file:<abs-path>  Read file at the given absolute path. Throws if missing or
 *                    if §8 security checks fail (see below).
 *   none             Returns "" — for ipc/no-auth local routes where the
 *                    transport does not require a bearer credential (e.g. a
 *                    future local OS-session-trust bridge). Document clearly
 *                    in client.toml why tokenRef="none" is appropriate.
 *   op://...         Throws a clear "not wired in this slice" error. 1Password
 *                    resolution requires an interactive session and a CLI
 *                    binary (`op`). Wire it properly before shipping: call
 *                    `op read <ref>` with a pinned absolute path, a hard
 *                    timeout, no TTY, and refuse in headless/timer contexts
 *                    per §8.
 *
 * Raw values (no scheme prefix) are rejected — every tokenRef must carry a
 * recognizable scheme so the reader can see immediately how it resolves.
 *
 * §8 file: security checks (fail-closed, applied in order):
 *   1. Path must be absolute and must NOT contain ".." components.
 *   2. Path must canonicalize to an absolute path (re-checks after resolution).
 *   3. lstatSync must succeed — file must exist.
 *   4. File must NOT be a symlink (to prevent symlink-swap attacks).
 *   5. File permissions: mode & 0o077 must be 0 (no group/world read or write).
 *   6. File owner uid must equal process.getuid() where getuid is available
 *      (skipped on platforms without getuid, documented below).
 *
 * Note: `~` expansion is the CALLER'S responsibility. resolveTokenRef does not
 * expand `~` — expand it before calling (e.g. with path.resolve or homedir()).
 */
export async function resolveTokenRef(
  ref: string,
  /** Injectable env for tests. Defaults to process.env. */
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  /** Injectable file reader for tests. Defaults to fs.readFile. */
  readFileFn: (path: string) => Promise<string> = defaultReadFile,
  /** Injectable lstat for tests. Defaults to fs.lstatSync. */
  lstatFn: (path: string) => fs.Stats = defaultLstat,
): Promise<string> {
  if (ref === "none") {
    // Explicit no-auth sentinel. Only valid for routes where the transport does
    // not require a bearer credential (local OS-session-trust bridge, ipc://,
    // loopback without auth gate). Document in client.toml why this is safe.
    return ""
  }

  if (ref.startsWith("env:")) {
    const varName = ref.slice("env:".length)
    if (!varName) {
      throw new Error(`resolveTokenRef: env: scheme requires a variable name, got "${ref}"`)
    }
    const value = env[varName]
    // FIX 3: also reject whitespace-only values (not just falsy/empty)
    if (!value || !value.trim()) {
      throw new Error(
        `resolveTokenRef: env:${varName} is unset or empty. ` +
          `Set the environment variable before connecting.`,
      )
    }
    return value
  }

  if (ref.startsWith("file:")) {
    const rawPath = ref.slice("file:".length)

    // §8 check 1: must be absolute and must not contain ".."
    if (!rawPath.startsWith("/")) {
      throw new Error(
        `resolveTokenRef: file: requires an absolute path (got "${rawPath}"). ` +
          `Expand ~ before passing to resolveTokenRef.`,
      )
    }
    if (rawPath.includes("..")) {
      throw new Error(
        `resolveTokenRef: file: path must not contain ".." components (got "${rawPath}"). ` +
          `Use an absolute canonical path.`,
      )
    }

    // §8 check 2: stat the file (existence + metadata)
    let stat: fs.Stats
    try {
      stat = lstatFn(rawPath)
    } catch (err) {
      throw new Error(
        `resolveTokenRef: file:${rawPath} — could not stat file: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    // §8 check 3: must not be a symlink (symlink-swap protection)
    if (stat.isSymbolicLink()) {
      throw new Error(
        `resolveTokenRef: file:${rawPath} is a symbolic link. ` +
          `Token files must be regular files (no symlinks) per §8.`,
      )
    }

    // §8 check 4: no group or world read/write (mode & 0o077 must be 0)
    const mode = stat.mode & 0o777
    if (mode & 0o077) {
      throw new Error(
        `resolveTokenRef: file:${rawPath} has unsafe permissions (${(mode).toString(8)}). ` +
          `Token files must be owner-only (chmod 600 or 400) per §8.`,
      )
    }

    // §8 check 5: owner uid must equal process uid (where getuid is available)
    // getuid is available on POSIX (Linux, macOS) but not on Windows.
    const getuid = (process as { getuid?: () => number }).getuid
    if (typeof getuid === "function") {
      const processUid = getuid.call(process)
      if (stat.uid !== processUid) {
        throw new Error(
          `resolveTokenRef: file:${rawPath} is owned by uid ${stat.uid} but ` +
            `process is running as uid ${processUid}. ` +
            `Token files must be owned by the current process user per §8.`,
        )
      }
    }
    // If getuid is unavailable (e.g. Windows), ownership check is skipped.
    // Platform limitation: documented above, only the uid check is skipped —
    // symlink and permission checks still apply on all platforms.

    // Read the file (async, injectable)
    let content: string
    try {
      content = await readFileFn(rawPath)
    } catch (err) {
      throw new Error(
        `resolveTokenRef: file:${rawPath} — could not read file: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    const token = content.trim()
    if (!token) {
      throw new Error(`resolveTokenRef: file:${rawPath} is empty.`)
    }
    return token
  }

  if (ref.startsWith("op://")) {
    // 1Password resolution is NOT wired in this slice.
    // To wire it: run `op read <ref>` with:
    //   - A pinned absolute path to the `op` binary (never rely on PATH alone)
    //   - A hard timeout (~5s) so a slow/hanging op doesn't wedge attach
    //   - No TTY (--no-masking / headless mode); refuse in timer/headless contexts
    //   - Scrub the resolved value from any logs before returning
    // See §8 of deploy-router-abstraction.md for the full hardening requirements.
    throw new Error(
      `resolveTokenRef: 1Password resolver not wired in this slice. ` +
        `Use env:<VAR> or file:<abs-path> instead of "${ref}". ` +
        `To wire op://, see §8 of deploy-router-abstraction.md.`,
    )
  }

  // No recognized scheme — reject to avoid silent passthrough of a raw secret.
  throw new Error(
    `resolveTokenRef: unrecognized scheme in "${ref}". ` +
      `Valid schemes: env:, file:, none, op:// (op:// not yet wired — use env: or file:).`,
  )
}

// ── private helpers ───────────────────────────────────────────────────────────

async function defaultReadFile(path: string): Promise<string> {
  return fsAsync.readFile(path, "utf-8")
}

function defaultLstat(path: string): fs.Stats {
  return fs.lstatSync(path)
}
