/**
 * Keychain token-reader helper — reads a token from the macOS keychain
 * via `security find-generic-password -w` and returns it as a plain
 * string (the caller is responsible for wrapping in Redacted if needed).
 *
 * Designed for the Phase 25c multi-account 1Password bootstrap: each
 * service-account token is stored at a distinct keychain entry
 * (e.g. `luna.op.antmachine`/`antmachine`) and read at boot to compose
 * one OnePasswordSecretProvider layer per account.
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
  /** -s argument, e.g. "luna.op.antmachine". */
  readonly service: string
  /** -a argument, e.g. "antmachine". */
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
