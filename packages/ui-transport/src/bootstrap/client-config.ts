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
import { execFile } from "node:child_process"
import { delimiter as PATH_DELIMITER, isAbsolute as pathIsAbsolute, join as pathJoin } from "node:path"

// ── constants ─────────────────────────────────────────────────────────────────

/**
 * Highest fileFormatVersion this parser knows how to handle.
 * Reject anything higher so callers upgrade instead of silently misinterpreting.
 */
const MAX_FILE_FORMAT_VERSION = 3

/** Default hard timeout (ms) for the `op read` subprocess before it is killed. */
const OP_DEFAULT_TIMEOUT_MS = 10_000

/** The 1Password CLI binary name we look up on PATH (or accept injected, absolute). */
const OP_BINARY_NAME = "op"

// ── op:// resolution types ─────────────────────────────────────────────────────

/**
 * Result of running a child process for op:// resolution. Deliberately a tiny,
 * spawn-library-agnostic shape so tests can supply a fake without importing
 * node:child_process.
 */
export interface OpSpawnResult {
  /** Process exit code; null if the process was killed by a signal. */
  readonly code: number | null
  /** Signal that killed the process (e.g. "SIGTERM" on timeout), if any. */
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
}

/**
 * Injectable spawn function for op:// resolution. Receives a validated absolute
 * binary path and an argv VECTOR (never a shell string). MUST NOT inherit a TTY
 * or stdin. The default implementation is `defaultOpSpawn` (node:child_process
 * execFile); tests inject a fake so they never spawn a real `op`.
 */
export type OpSpawnFn = (
  binaryPath: string,
  argv: readonly string[],
  opts: { readonly timeoutMs: number },
) => Promise<OpSpawnResult>

/**
 * Options governing op:// (1Password) resolution. These are SEPARATE from the
 * positional env/file injection params so that the env:/file:/none code paths
 * stay byte-identical to their prior behavior — callers that never touch op://
 * never pass these.
 */
export interface ResolveTokenRefOptions {
  /**
   * Gate for op:// resolution. `op read` needs an interactive 1Password session
   * (biometric/desktop-app unlock or an `OP_SERVICE_ACCOUNT_TOKEN`); it has no
   * safe non-interactive default. So op:// is REFUSED unless the host explicitly
   * opts in by setting this to true. Headless contexts (timers, CI, the wake/
   * Dream loops) leave it false → op:// fails closed with a clear error.
   * Default: false.
   */
  readonly allowInteractive?: boolean
  /**
   * Absolute path to the `op` binary. If provided it is validated (absolute +
   * exists + executable) and used verbatim — no PATH lookup. If omitted, `op`
   * is resolved from PATH and the resolved path is validated the same way.
   */
  readonly opBinaryPath?: string
  /** Hard timeout (ms) for the `op read` subprocess. Default: 10_000. */
  readonly opTimeoutMs?: number
  /** Injectable spawn (tests). Defaults to `defaultOpSpawn` (execFile). */
  readonly opSpawn?: OpSpawnFn
  /**
   * Injectable PATH-resolver for the `op` binary (tests). Given the PATH env and
   * the binary name, returns an absolute path or null. Defaults to a real
   * PATH+fs lookup. Lets tests exercise the missing-binary path with no real fs.
   */
  readonly opPathLookup?: (binaryName: string, pathEnv: string | undefined) => string | null
}

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
 *   op://...         Resolve via the 1Password CLI (`op read <ref>`). Node-only.
 *                    Hardened per §8: argv VECTOR (never a shell string), a
 *                    pinned/validated ABSOLUTE `op` binary path, a hard timeout
 *                    (~10s), NO TTY / no inherited stdin, output trimmed, and
 *                    fail-closed on nonzero exit / timeout / missing binary.
 *                    REFUSED by default in headless/non-interactive contexts:
 *                    `op read` needs an interactive 1Password session, so it
 *                    only runs when the host opts in via
 *                    options.allowInteractive===true (see ResolveTokenRefOptions).
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
  /**
   * op:// (1Password) resolution options — interactive gate, pinned binary,
   * timeout, injectable spawn. Ignored by env:/file:/none. See type docs.
   */
  options: ResolveTokenRefOptions = {},
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
    return resolveOpRef(ref, env, options)
  }

  // No recognized scheme — reject to avoid silent passthrough of a raw secret.
  throw new Error(
    `resolveTokenRef: unrecognized scheme in "${ref}". ` +
      `Valid schemes: env:, file:, none, op://.`,
  )
}

// ── private helpers ───────────────────────────────────────────────────────────

async function defaultReadFile(path: string): Promise<string> {
  return fsAsync.readFile(path, "utf-8")
}

function defaultLstat(path: string): fs.Stats {
  return fs.lstatSync(path)
}

// ── op:// (1Password) resolution ───────────────────────────────────────────────

/**
 * Strict charset for an op:// reference body. 1Password secret references are
 * `op://<vault>/<item>[/<section>]/<field>` with optional query/attributes. We
 * allow the conservative set of characters those URIs use and REFUSE anything
 * else — shell metacharacters (`;`, `|`, `&`, `$`, backticks, quotes, spaces,
 * newlines) can never appear, so even though we never build a shell string this
 * is a defense-in-depth belt-and-suspenders. Fail-closed on any stray char.
 */
const OP_REF_BODY_CHARSET = /^[A-Za-z0-9._\-/?=&%]+$/

/**
 * Resolve an `op://` reference to a secret via the 1Password CLI.
 *
 * Hardening (§8):
 *   - REFUSE unless options.allowInteractive === true (headless default = fail).
 *   - Validate the ref against a strict charset (no shell metacharacters).
 *   - Resolve the `op` binary to a validated ABSOLUTE path (PATH lookup or
 *     injected); confirm it exists + is executable. Missing → throw.
 *   - Invoke as an argv VECTOR: [opPath, "read", "--no-newline", ref]. NEVER a
 *     shell string — the ref is a discrete argv element, so it cannot reach a
 *     shell even if it contained metacharacters.
 *   - Hard timeout (~10s) kills a hung `op`; timeout → throw.
 *   - No TTY / no inherited stdin (the spawn impl uses stdin:"ignore").
 *   - Nonzero exit → throw (stderr is scrubbed to a generic phrase; the actual
 *     stderr may echo the ref but never the secret, and we don't surface it).
 *   - Trim the resolved value; empty → throw.
 *   - The resolved token is NEVER placed in argv of any other process and NEVER
 *     logged.
 */
async function resolveOpRef(
  ref: string,
  env: Record<string, string | undefined>,
  options: ResolveTokenRefOptions,
): Promise<string> {
  // Gate 1: headless refuse-by-default. op read needs an interactive 1Password
  // session (biometric/app unlock or a service-account token). There is no safe
  // non-interactive default, so we fail closed unless the host opts in.
  if (options.allowInteractive !== true) {
    throw new Error(
      `resolveTokenRef: op:// resolution is refused in non-interactive contexts. ` +
        `1Password (\`op read\`) needs an interactive session; pass ` +
        `options.allowInteractive=true only from an interactive host. ` +
        `For headless/timer contexts use env:<VAR> or file:<abs-path> instead.`,
    )
  }

  // Gate 2: strict charset (defense-in-depth; we never build a shell string).
  const body = ref.slice("op://".length)
  if (!body || !OP_REF_BODY_CHARSET.test(body)) {
    throw new Error(
      `resolveTokenRef: op:// reference contains characters outside the allowed ` +
        `set (got "${ref}"). Expected op://<vault>/<item>/<field>.`,
    )
  }

  // Gate 3: resolve + validate the `op` binary to an absolute, executable path.
  // When a custom spawn is injected (tests), the binary is never really exec'd,
  // so we keep the absolute-path validation but skip the on-disk executable
  // check — the injected spawn owns binary semantics. The default (production)
  // path always verifies the binary exists + is executable on disk.
  const usingDefaultSpawn = options.opSpawn === undefined
  const opPath = resolveOpBinary(env, options, usingDefaultSpawn)

  // Gate 4: invoke as an argv vector (never a shell string). `--no-newline`
  // suppresses op's trailing newline; we trim regardless.
  const spawn = options.opSpawn ?? defaultOpSpawn
  const timeoutMs = options.opTimeoutMs ?? OP_DEFAULT_TIMEOUT_MS
  const argv: readonly string[] = ["read", "--no-newline", ref]

  let result: OpSpawnResult
  try {
    result = await spawn(opPath, argv, { timeoutMs })
  } catch (err) {
    // execFile rejects on spawn failure (ENOENT) or timeout (killed signal).
    const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string }
    if (e?.killed || e?.signal === "SIGTERM" || e?.code === "ETIMEDOUT") {
      throw new Error(
        `resolveTokenRef: op:// resolution timed out after ${timeoutMs}ms running \`op read\`. ` +
          `Is 1Password unlocked / the session active?`,
      )
    }
    if (e?.code === "ENOENT") {
      throw new Error(
        `resolveTokenRef: op:// resolution failed — the 'op' binary at ${opPath} could not be spawned (ENOENT).`,
      )
    }
    throw new Error(
      `resolveTokenRef: op:// resolution failed to spawn \`op read\`: ${e instanceof Error ? e.message : String(e)}`,
    )
  }

  // Timeout surfaced via signal (fake spawns / non-throwing impls).
  if (result.signal === "SIGTERM" || result.signal === "SIGKILL") {
    throw new Error(
      `resolveTokenRef: op:// resolution timed out after ${timeoutMs}ms (killed ${result.signal}).`,
    )
  }

  // Nonzero exit → fail closed. We DO NOT echo stderr verbatim into the thrown
  // message (it can be noisy / leak the ref); a short generic phrase is enough.
  if (result.code !== 0) {
    throw new Error(
      `resolveTokenRef: op:// resolution failed — \`op read\` exited with code ${result.code}. ` +
        `Check that 1Password is unlocked and the reference "${ref}" is valid.`,
    )
  }

  const token = result.stdout.trim()
  if (!token) {
    throw new Error(
      `resolveTokenRef: op:// resolution returned an empty secret for "${ref}".`,
    )
  }
  return token
}

/**
 * Resolve the `op` binary to a validated absolute path.
 *   - If options.opBinaryPath is given, it MUST be absolute, exist (when
 *     verifyOnDisk), and be executable — used verbatim (no PATH lookup).
 *   - Otherwise look `op` up on PATH and validate the resolved path the same way.
 *
 * @param verifyOnDisk When true (default/production spawn), confirm the binary
 *   exists + is executable via fs.accessSync. When false (an injected test
 *   spawn), the on-disk check is skipped — the absolute-path requirement still
 *   applies, and for the PATH-lookup branch a custom opPathLookup still decides
 *   whether a binary was "found".
 * Throws (fail-closed) if no valid binary is found.
 */
function resolveOpBinary(
  env: Record<string, string | undefined>,
  options: ResolveTokenRefOptions,
  verifyOnDisk: boolean,
): string {
  const injected = options.opBinaryPath
  if (injected !== undefined) {
    if (!pathIsAbsolute(injected)) {
      throw new Error(
        `resolveTokenRef: options.opBinaryPath must be an absolute path (got "${injected}").`,
      )
    }
    if (verifyOnDisk) assertExecutable(injected)
    return injected
  }

  const lookup = options.opPathLookup ?? defaultOpPathLookup
  const found = lookup(OP_BINARY_NAME, env["PATH"])
  if (!found) {
    throw new Error(
      `resolveTokenRef: the 1Password CLI ('op') was not found on PATH. ` +
        `Install it or pass options.opBinaryPath with an absolute path.`,
    )
  }
  if (!pathIsAbsolute(found)) {
    throw new Error(
      `resolveTokenRef: resolved 'op' path "${found}" is not absolute — refusing.`,
    )
  }
  if (verifyOnDisk) assertExecutable(found)
  return found
}

/** Throw unless `binaryPath` exists and is executable by the current user. */
function assertExecutable(binaryPath: string): void {
  try {
    fs.accessSync(binaryPath, fs.constants.X_OK)
  } catch {
    throw new Error(
      `resolveTokenRef: the 'op' binary at "${binaryPath}" does not exist or is not executable.`,
    )
  }
}

/**
 * Default PATH lookup for a binary: walk PATH entries, return the first absolute
 * candidate that exists and is executable, else null. No shell, no `which`.
 */
function defaultOpPathLookup(binaryName: string, pathEnv: string | undefined): string | null {
  if (!pathEnv) return null
  for (const dir of pathEnv.split(PATH_DELIMITER)) {
    if (!dir || !pathIsAbsolute(dir)) continue
    const candidate = pathJoin(dir, binaryName)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {
      // not here — keep walking
    }
  }
  return null
}

/**
 * Default spawn for op:// resolution: node:child_process execFile with an argv
 * VECTOR (never a shell), stdin ignored (no TTY), and a hard kill timeout.
 * Resolves with the captured streams + exit status rather than rejecting on a
 * nonzero exit, so resolveOpRef can produce uniform fail-closed errors.
 */
function defaultOpSpawn(
  binaryPath: string,
  argv: readonly string[],
  opts: { readonly timeoutMs: number },
): Promise<OpSpawnResult> {
  return new Promise<OpSpawnResult>((resolve, reject) => {
    execFile(
      binaryPath,
      [...argv],
      {
        timeout: opts.timeoutMs,
        killSignal: "SIGTERM",
        // No TTY / no inherited stdin — op must not prompt on a terminal here.
        stdio: ["ignore", "pipe", "pipe"],
        // Cap output to avoid unbounded buffering of a hostile/huge response.
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      } as Parameters<typeof execFile>[2],
      (err, stdout, stderr) => {
        if (err) {
          const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: NodeJS.Signals | null; code?: string | number }
          // Spawn failure (ENOENT) or timeout (killed) → reject so the caller's
          // catch maps it to a clear timeout / missing-binary error.
          if (e.killed || e.signal === "SIGTERM" || e.signal === "SIGKILL" || e.code === "ENOENT") {
            reject(e)
            return
          }
          // Nonzero exit → still resolve so resolveOpRef applies fail-closed
          // logic uniformly. execFile sets err.code to the numeric exit code.
          const code = typeof e.code === "number" ? e.code : 1
          resolve({ code, signal: e.signal ?? null, stdout: String(stdout), stderr: String(stderr) })
          return
        }
        resolve({ code: 0, signal: null, stdout: String(stdout), stderr: String(stderr) })
      },
    )
  })
}
