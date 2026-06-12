/**
 * Keychain helper — reads, writes, and deletes generic-password entries in
 * the macOS keychain via the `security` CLI. Reads return a plain string
 * (the caller wraps in Redacted if needed); writes/deletes return void.
 *
 * Originally designed for the Phase 25c multi-account 1Password bootstrap
 * (read-only): each service-account token is stored at a distinct keychain
 * entry (e.g. `luna.op.primary`/`primary`) and read at boot to compose one
 * OnePasswordSecretProvider layer per account.
 *
 * The write/delete helpers generalize it for the Vault keychain-storage
 * migration: env-secret values move from plaintext `~/.luna/.env` to
 * `luna.vault.<VARNAME>` keychain entries (Darwin only).
 *
 * Hard rules (§0.2 + §6):
 *   - Never log the token.
 *   - Never include the token in error messages.
 *   - Never mutate `process.env`.
 *   - Errors only via the existing `ConfigError` tag (no new tags).
 *
 * Platform: macOS only. Non-darwin returns ConfigError immediately
 * with no shell-out (Linux/Windows callers should fall through to a
 * different layer in the SecretProvider chain).
 */
import { execFile, type ExecFileException } from "node:child_process"
import { Effect } from "effect"
import { ConfigError } from "../errors.js"

const MODULE = "KeychainHelper"
const DEFAULT_TIMEOUT_MS = 5_000

/** Key into the macOS keychain. Both fields must match the entry exactly. */
export interface KeychainQuery {
  /** -s argument, e.g. "luna.op.primary". */
  readonly service: string
  /** -a argument, e.g. "primary". */
  readonly account: string
}

/**
 * Internal options — used by tests to inject a fake `execFile` and a
 * fake platform string. Not part of the public API.
 */
export interface KeychainHelperInternals {
  readonly _execFile?: typeof execFile
  readonly _platform?: NodeJS.Platform
  readonly _timeoutMs?: number
}

const notFoundConfigError = (q: KeychainQuery): ConfigError =>
  new ConfigError({
    module: MODULE,
    key: `${q.service}/${q.account}`,
    message: `keychain entry not found: ${q.service}/${q.account}`,
  })

const platformConfigError = (platform: string): ConfigError =>
  new ConfigError({
    module: MODULE,
    key: "platform",
    message: `keychain unsupported on platform ${platform}`,
  })

const timeoutConfigError = (q: KeychainQuery): ConfigError =>
  new ConfigError({
    module: MODULE,
    key: q.service,
    message: `keychain read timed out for ${q.service}`,
  })

const spawnFailureConfigError = (stderr: string): ConfigError =>
  new ConfigError({
    module: MODULE,
    key: "security",
    message: `keychain read failed: ${stderr.trim()}`,
  })

/**
 * Read a keychain entry token. Returns the raw string (trimmed).
 *
 * Failure modes (all → ConfigError, no tokens leaked into messages):
 *   - non-darwin platform
 *   - entry not found / `security` non-zero exit
 *   - 5s spawn timeout
 *   - other spawn errors
 */
export const readKeychainToken = (
  q: KeychainQuery,
  internals: KeychainHelperInternals = {},
): Effect.Effect<string, ConfigError> => {
  const platform = internals._platform ?? process.platform
  if (platform !== "darwin") {
    return Effect.fail(platformConfigError(platform))
  }
  const ef = internals._execFile ?? execFile
  const timeoutMs = internals._timeoutMs ?? DEFAULT_TIMEOUT_MS

  return Effect.async<string, ConfigError>((resume) => {
    let settled = false
    const settle = (e: Effect.Effect<string, ConfigError>): void => {
      if (settled) return
      settled = true
      resume(e)
    }

    const child = ef(
      "security",
      ["find-generic-password", "-s", q.service, "-a", q.account, "-w"],
      { timeout: timeoutMs },
      (
        err: ExecFileException | null,
        stdout: string | Buffer,
        stderr: string | Buffer,
      ) => {
        if (err) {
          // Node sets `killed` + signal SIGTERM on timeout.
          if (
            (err as ExecFileException & { killed?: boolean }).killed === true ||
            err.signal === "SIGTERM"
          ) {
            settle(Effect.fail(timeoutConfigError(q)))
            return
          }
          // `security` exits non-zero (e.g. 44) when the entry is missing.
          if (typeof err.code === "number") {
            settle(Effect.fail(notFoundConfigError(q)))
            return
          }
          const stderrStr =
            typeof stderr === "string" ? stderr : stderr.toString("utf8")
          settle(Effect.fail(spawnFailureConfigError(stderrStr)))
          return
        }
        const out =
          typeof stdout === "string" ? stdout : stdout.toString("utf8")
        const trimmed = out.replace(/\n+$/, "")
        if (trimmed.length === 0) {
          settle(Effect.fail(notFoundConfigError(q)))
          return
        }
        settle(Effect.succeed(trimmed))
      },
    )

    // Defensive: if execFile's own timeout misfires, ensure we don't
    // hang forever. (Node's docs say it sends SIGTERM on `timeout`,
    // which the callback handles above — this is a belt-and-braces
    // guard for fake execFiles in tests that ignore the option.)
    const guard = setTimeout(() => {
      if (settled) return
      try {
        child.kill("SIGTERM")
      } catch {
        // best-effort
      }
      settle(Effect.fail(timeoutConfigError(q)))
    }, timeoutMs + 100)
    child.on("close", () => clearTimeout(guard))
    child.on("error", () => clearTimeout(guard))
  })
}

/**
 * Write (create-or-update) a keychain entry.
 *
 * `security add-generic-password -U` upserts: it creates the entry or, with
 * `-U`, overwrites the password of an existing entry matching `-s`/`-a`.
 * The value travels as an execFile argv element (no shell), never via
 * stdout/stderr/logs.
 *
 * Failure modes (all → ConfigError, no value leaked):
 *   - non-darwin platform (fails closed, no shell-out)
 *   - `security` non-zero exit
 *   - 5s spawn timeout
 */
export const writeKeychainSecret = (
  q: KeychainQuery,
  value: string,
  internals: KeychainHelperInternals = {},
): Effect.Effect<void, ConfigError> => {
  const platform = internals._platform ?? process.platform
  if (platform !== "darwin") {
    return Effect.fail(platformConfigError(platform))
  }
  const ef = internals._execFile ?? execFile
  const timeoutMs = internals._timeoutMs ?? DEFAULT_TIMEOUT_MS

  return Effect.async<void, ConfigError>((resume) => {
    let settled = false
    const settle = (e: Effect.Effect<void, ConfigError>): void => {
      if (settled) return
      settled = true
      resume(e)
    }

    const child = ef(
      "security",
      [
        "add-generic-password",
        "-U",
        "-s",
        q.service,
        "-a",
        q.account,
        "-w",
        value,
      ],
      { timeout: timeoutMs },
      (
        err: ExecFileException | null,
        _stdout: string | Buffer,
        stderr: string | Buffer,
      ) => {
        if (err) {
          if (
            (err as ExecFileException & { killed?: boolean }).killed === true ||
            err.signal === "SIGTERM"
          ) {
            settle(Effect.fail(timeoutConfigError(q)))
            return
          }
          const stderrStr =
            typeof stderr === "string" ? stderr : stderr.toString("utf8")
          settle(Effect.fail(spawnFailureConfigError(stderrStr)))
          return
        }
        settle(Effect.succeed(undefined))
      },
    )

    const guard = setTimeout(() => {
      if (settled) return
      try {
        child.kill("SIGTERM")
      } catch {
        // best-effort
      }
      settle(Effect.fail(timeoutConfigError(q)))
    }, timeoutMs + 100)
    child.on("close", () => clearTimeout(guard))
    child.on("error", () => clearTimeout(guard))
  })
}

/**
 * Delete a keychain entry. Idempotent: a missing entry (security exit 44)
 * resolves successfully so callers can delete without a prior existence
 * check.
 *
 * Failure modes (all → ConfigError):
 *   - non-darwin platform (fails closed, no shell-out)
 *   - `security` non-zero exit other than 44 (not-found)
 *   - 5s spawn timeout
 */
export const deleteKeychainSecret = (
  q: KeychainQuery,
  internals: KeychainHelperInternals = {},
): Effect.Effect<void, ConfigError> => {
  const platform = internals._platform ?? process.platform
  if (platform !== "darwin") {
    return Effect.fail(platformConfigError(platform))
  }
  const ef = internals._execFile ?? execFile
  const timeoutMs = internals._timeoutMs ?? DEFAULT_TIMEOUT_MS

  return Effect.async<void, ConfigError>((resume) => {
    let settled = false
    const settle = (e: Effect.Effect<void, ConfigError>): void => {
      if (settled) return
      settled = true
      resume(e)
    }

    const child = ef(
      "security",
      ["delete-generic-password", "-s", q.service, "-a", q.account],
      { timeout: timeoutMs },
      (
        err: ExecFileException | null,
        _stdout: string | Buffer,
        stderr: string | Buffer,
      ) => {
        if (err) {
          if (
            (err as ExecFileException & { killed?: boolean }).killed === true ||
            err.signal === "SIGTERM"
          ) {
            settle(Effect.fail(timeoutConfigError(q)))
            return
          }
          // `security` exits 44 when the entry is already absent — a no-op.
          if (err.code === 44) {
            settle(Effect.succeed(undefined))
            return
          }
          const stderrStr =
            typeof stderr === "string" ? stderr : stderr.toString("utf8")
          settle(Effect.fail(spawnFailureConfigError(stderrStr)))
          return
        }
        settle(Effect.succeed(undefined))
      },
    )

    const guard = setTimeout(() => {
      if (settled) return
      try {
        child.kill("SIGTERM")
      } catch {
        // best-effort
      }
      settle(Effect.fail(timeoutConfigError(q)))
    }, timeoutMs + 100)
    child.on("close", () => clearTimeout(guard))
    child.on("error", () => clearTimeout(guard))
  })
}
