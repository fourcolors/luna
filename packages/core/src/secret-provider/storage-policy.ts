/**
 * storage-policy - pure MECHANISM for deciding where a written secret lands,
 * plus a bounded, non-blocking `op` CLI probe. No Effect, no I/O beyond the
 * single injectable execFile the probe drives; every capability is injected so
 * the policy stays trivially testable and boot-safe.
 *
 * Two responsibilities:
 *   1. `resolveWriteTier(mode, probe)` - a total, pure function mapping the
 *      operator's storage mode plus a capability snapshot to exactly one write
 *      tier. Reads (the SecretProvider chain) are decided elsewhere; this only
 *      governs WHERE a newly-written value is persisted.
 *   2. `probeOnePassword(...)` - a best-effort capability check for the `op`
 *      CLI. It has a hard deadline and kills a hung child; ANY error, timeout,
 *      or missing binary degrades to "absent". It NEVER throws and NEVER blocks
 *      boot beyond its own short deadline.
 *
 * Design intent (05-decide §storage-policy): mode `auto` is the new default.
 * On darwin `auto` writes to the macOS Keychain; everywhere else it writes to
 * the encrypted Luna vault. The `keychain-*` modes are internal migration
 * states; on non-darwin they normalise to `auto` upstream, but this function
 * still resolves them defensively. `env` is the explicit plaintext escape
 * hatch. Reserved names (UI_WS_TOKEN / LUNA_*) are handled by the caller before
 * this ever runs and always stay in `.env`.
 */
import { execFile } from "node:child_process"

/** Operator-selected storage mode (v2 vocabulary). */
export type VaultStorageModeV2 =
  | "auto"
  | "env"
  | "keychain-preferred"
  | "keychain-only"

/** The concrete destination a write resolves to. */
export type WriteTier = "keychain" | "luna-vault" | "env"

/** The result of probing for the 1Password `op` CLI. */
export type OnePasswordProbe = "absent" | "detected" | "active"

/**
 * Capability snapshot handed to `resolveWriteTier`. Produced by the caller from
 * platform detection plus the probes below.
 */
export interface StorageProbe {
  /** Effective platform (`process.platform` or an injected override). */
  readonly platform: NodeJS.Platform
  /**
   * 1Password availability:
   *   - "absent"   - no `op` CLI / no accounts configured.
   *   - "detected" - `op` CLI present but no service accounts wired.
   *   - "active"   - service accounts configured; op is the live secret source.
   */
  readonly onePassword: OnePasswordProbe
  /** Whether an OS keychain is usable on this platform (darwin `security`). */
  readonly osKeychain: boolean
}

/**
 * Resolve the single write tier for a mode + capability snapshot. Pure and
 * total.
 *
 * Rules:
 *   - `env`  → always plaintext `.env` (explicit escape hatch).
 *   - `keychain-preferred` / `keychain-only` → keychain when the OS keychain is
 *     usable, else the encrypted Luna vault. (These modes normalise to `auto`
 *     on non-darwin upstream; the vault fallback here is defence-in-depth so a
 *     stray keychain-mode on a keychain-less host never lands plaintext.)
 *   - `auto` → keychain when the OS keychain is usable (darwin), else the
 *     encrypted Luna vault.
 *
 * NOTE: 1Password is a READ source, never a write target - Luna does not push
 * secrets into a user's 1Password vault. So `probe.onePassword` does not change
 * the write tier; it is carried in the snapshot only for status reporting.
 */
export const resolveWriteTier = (
  mode: VaultStorageModeV2,
  probe: StorageProbe,
): WriteTier => {
  if (mode === "env") return "env"
  if (mode === "keychain-preferred" || mode === "keychain-only") {
    return probe.osKeychain ? "keychain" : "luna-vault"
  }
  // mode === "auto"
  return probe.osKeychain ? "keychain" : "luna-vault"
}

/** execFile shape used by the probe; injectable for tests. */
type ExecFileImpl = typeof execFile

/** Options for {@link probeOnePassword}. Every capability is injectable. */
export interface ProbeOnePasswordOptions {
  /** Injected execFile (tests supply a fake). Defaults to node:child_process. */
  readonly execFileImpl?: ExecFileImpl
  /** Path to the `op` binary. Defaults to bare "op" (resolved via PATH). */
  readonly opPath?: string
  /** Hard deadline in ms before the child is killed and we degrade. */
  readonly timeoutMs?: number
  /**
   * Whether service accounts are already configured. When true the probe
   * short-circuits to "active" WITHOUT shelling out - op is already the live
   * secret source, so a `--version` check is redundant and only risks a hang.
   */
  readonly accountsConfigured: boolean
}

const DEFAULT_PROBE_TIMEOUT_MS = 2_500

/**
 * Best-effort probe for the 1Password `op` CLI.
 *
 *   - `accountsConfigured` → "active" immediately, no exec.
 *   - else run `<opPath> --version` with a hard deadline:
 *       - exit 0                              → "detected"
 *       - ANY error / non-zero / ENOENT / timeout → "absent"
 *
 * NEVER throws, NEVER blocks past `timeoutMs`. On overrun the child is sent
 * SIGKILL directly (a `--version` call has nothing to flush, so we skip the
 * SIGTERM grace and guarantee the process dies) and we resolve "absent".
 */
export const probeOnePassword = (
  opts: ProbeOnePasswordOptions,
): Promise<OnePasswordProbe> => {
  if (opts.accountsConfigured) return Promise.resolve<OnePasswordProbe>("active")

  const ef = opts.execFileImpl ?? execFile
  const opPath = opts.opPath ?? "op"
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS

  return new Promise<OnePasswordProbe>((resolve) => {
    let settled = false
    let guard: ReturnType<typeof setTimeout> | undefined
    const settle = (result: OnePasswordProbe): void => {
      if (settled) return
      settled = true
      if (guard !== undefined) clearTimeout(guard)
      resolve(result)
    }

    let child: ReturnType<ExecFileImpl>
    try {
      child = ef(opPath, ["--version"], { timeout: timeoutMs }, (err) => {
        // Any error at all (ENOENT, non-zero exit, kill signal) → absent.
        settle(err ? "absent" : "detected")
      })
    } catch {
      // Synchronous spawn failure (e.g. bad executable) → absent.
      settle("absent")
      return
    }

    // Hard deadline independent of execFile's own timeout option (a fake
    // execFileImpl in tests may ignore it). SIGKILL: a `--version` probe has
    // no work worth a graceful shutdown, so kill hard and degrade.
    guard = setTimeout(() => {
      if (settled) return
      try {
        child.kill("SIGKILL")
      } catch {
        // best-effort
      }
      settle("absent")
    }, timeoutMs)
    // Do not let the deadline timer keep the event loop alive.
    if (typeof guard.unref === "function") guard.unref()
  })
}
