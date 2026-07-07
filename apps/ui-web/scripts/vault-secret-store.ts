/**
 * VaultSecretStore v2 - a thin write/delete facade the chat-server Vault paths
 * use instead of calling `persistEnvSecret` / `removeEnvSecret` directly.
 *
 * It centralizes the ROUTING of a written value to exactly one storage tier and
 * the SCRUB of a deleted value from EVERY tier. The tier decision itself is
 * made upstream by `resolveWriteTier(mode, probe)` (storage-policy.ts) and
 * handed in as `writeTier`; this facade only executes it. The mode source of
 * truth is `normalizeVaultStorageModeV2` (secret-chain.ts).
 *
 * ── WRITE (persistEnvSecret) - routes by writeTier ──────────────────────────
 *   - "keychain"    → writeKeychain (darwin macOS Keychain), + process.env mirror
 *   - "luna-vault"  → vaultFile.writeSecret (encrypted at rest), + process.env
 *   - "env"         → writeEnv (~/.luna/.env plaintext), + process.env
 * process.env is ALWAYS mirrored so live resolution needs no restart.
 *
 * ── DELETE (removeEnvSecret) - the DELETE CONTRACT (05-decide §DELETE) ───────
 * An explicit operator delete must stay deleted across restarts and mode
 * switches. So it attempts ALL tiers UNCONDITIONALLY - keychain (darwin only),
 * luna vault, AND the `.env` line - even after one tier fails. "Not found" in
 * any tier is SUCCESS (the deleteKeychain wrapper maps `security` exit 44 to
 * success; vaultFile.deleteSecret returns false for an absent name without
 * throwing; removeEnv is a no-op on a missing file/line). Failures are
 * COLLECTED, and if any tier failed the call rejects with an Error listing the
 * failed tiers - never swallowed. This runs in EVERY mode: a value written
 * under a prior mode (e.g. keychain) must still be scrubbed after switching to
 * env, or the env-provider tail would resurrect a secret the operator believed
 * revoked (review finding). Attempting every tier is idempotent and strictly
 * safer than trusting the current mode to know where the value lives.
 *
 * The facade injects every side effect (writeEnv/removeEnv/writeKeychain/
 * deleteKeychain/vaultFile) so it is pure-testable with fakes.
 *
 * Hard rule: never log the value. This module only routes it.
 */
import type { WriteTier } from "@luna/core"

/**
 * Legacy v1 mode vocabulary + normalizer. RETAINED for byte-compat with callers
 * that predate the tiered redesign (e.g. the migrate script, older tests). The
 * v2 mode source of truth is `normalizeVaultStorageModeV2` in secret-chain.ts.
 */
export type VaultStorageMode = "env" | "keychain-preferred" | "keychain-only"

/**
 * Resolve the requested v1 mode against the platform. Unknown values and any
 * non-Darwin platform collapse to `env` so misconfiguration fails safe rather
 * than shelling out to a `security` binary that does not exist.
 */
export const normalizeVaultStorageMode = (
  raw: string | undefined,
  platform: NodeJS.Platform,
): VaultStorageMode => {
  const mode =
    raw === "keychain-preferred" || raw === "keychain-only" || raw === "env"
      ? raw
      : "env"
  if (platform !== "darwin") return "env"
  return mode
}

/** Minimal luna-vault write/delete surface the facade needs (injected). */
export interface VaultFileWriter {
  readonly writeSecret: (name: string, value: string) => Promise<void>
  /** Returns true if a value was removed, false if the name was absent. */
  readonly deleteSecret: (name: string) => Promise<boolean>
}

export interface VaultSecretStoreDeps {
  readonly platform: NodeJS.Platform
  /**
   * The resolved write tier for this boot (from `resolveWriteTier(mode, probe)`
   * upstream). All writes route here; deletes scrub every tier regardless.
   */
  readonly writeTier: WriteTier
  readonly env: NodeJS.ProcessEnv | Record<string, string | undefined>
  readonly writeEnv: (name: string, value: string) => Promise<void>
  readonly removeEnv: (name: string) => Promise<void>
  readonly writeKeychain: (name: string, value: string) => Promise<void>
  /** MUST treat item-not-found as success (see the DELETE contract above). */
  readonly deleteKeychain: (name: string) => Promise<void>
  readonly vaultFile: VaultFileWriter
}

export interface VaultSecretStore {
  readonly writeTier: WriteTier
  readonly persistEnvSecret: (name: string, value: string) => Promise<void>
  readonly removeEnvSecret: (name: string) => Promise<void>
}

export const makeVaultSecretStore = (
  deps: VaultSecretStoreDeps,
): VaultSecretStore => {
  const { writeTier } = deps

  return {
    writeTier,
    persistEnvSecret: async (name, value) => {
      switch (writeTier) {
        case "keychain":
          await deps.writeKeychain(name, value)
          break
        case "luna-vault":
          await deps.vaultFile.writeSecret(name, value)
          break
        case "env":
          await deps.writeEnv(name, value)
          break
      }
      // Mirror into process.env in every tier so live resolution needs no
      // restart (the read chain's env tail also picks it up as a fallback).
      deps.env[name] = value
    },
    removeEnvSecret: async (name) => {
      // Optimistic in-memory scrub first so an immediately-following read never
      // resolves the value via the env-provider tail, even if a disk tier below
      // fails.
      delete deps.env[name]

      // DELETE CONTRACT: attempt EVERY tier unconditionally, collect failures.
      // A per-tier failure does not short-circuit the others - a value could
      // live in any tier after a mode switch, and all copies must be scrubbed.
      const failed: string[] = []

      // keychain (darwin only): on non-darwin there is no keychain to scrub,
      // so skipping it is correct, not a failure.
      if (deps.platform === "darwin") {
        try {
          await deps.deleteKeychain(name)
        } catch {
          failed.push("keychain")
        }
      }

      // luna vault: deleteSecret returns false for an absent name (no throw),
      // which is success. A throw is a real failure (locked-out vault, IO).
      try {
        await deps.vaultFile.deleteSecret(name)
      } catch {
        failed.push("luna-vault")
      }

      // .env line: removeEnv is a no-op on a missing file/line (success).
      try {
        await deps.removeEnv(name)
      } catch {
        failed.push("env")
      }

      if (failed.length > 0) {
        // Never swallow: a partial scrub could resurrect a "revoked" secret on
        // the next boot. Surface which tiers still hold it so the operator can
        // act. The NAME is safe to include (it is not the value).
        throw new Error(
          `failed to remove secret "${name}" from: ${failed.join(", ")}`,
        )
      }
    },
  }
}
