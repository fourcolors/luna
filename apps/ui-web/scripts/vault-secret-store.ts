/**
 * VaultSecretStore — a thin write/delete facade the chat-server Vault paths
 * use instead of calling `persistEnvSecret` / `removeEnvSecret` directly.
 *
 * It centralizes the storage-mode decision (`LUNA_VAULT_STORAGE`) so the
 * env-secret write/delete surface has exactly one place that knows whether a
 * value lands in `~/.luna/.env` or the macOS keychain:
 *
 *   - `env`               → `.env` only (default; current behavior)
 *   - `keychain-preferred`→ keychain write + process.env mirror; `.env`
 *                           untouched (left as the migration rollback copy)
 *   - `keychain-only`     → same write path as keychain-preferred here; the
 *                           read-side chain is what drops `.env` (chat-server)
 *
 * Non-Darwin always normalizes to `env` — Linux/non-Darwin never shells out to
 * `security`. The facade injects every side effect (writeEnv/removeEnv/
 * writeKeychain/deleteKeychain) so it is pure-testable with fakes.
 *
 * Hard rule: never log the value. This module only routes it.
 */
export type VaultStorageMode = "env" | "keychain-preferred" | "keychain-only"

export interface VaultSecretStoreDeps {
  readonly platform: NodeJS.Platform
  readonly mode: VaultStorageMode
  readonly env: NodeJS.ProcessEnv | Record<string, string | undefined>
  readonly writeEnv: (name: string, value: string) => Promise<void>
  readonly removeEnv: (name: string) => Promise<void>
  readonly writeKeychain: (name: string, value: string) => Promise<void>
  readonly deleteKeychain: (name: string) => Promise<void>
}

export interface VaultSecretStore {
  readonly effectiveMode: VaultStorageMode
  readonly persistEnvSecret: (name: string, value: string) => Promise<void>
  readonly removeEnvSecret: (name: string) => Promise<void>
}

/**
 * Resolve the requested mode against the platform. Unknown values and any
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

export const makeVaultSecretStore = (
  deps: VaultSecretStoreDeps,
): VaultSecretStore => {
  const effectiveMode = normalizeVaultStorageMode(deps.mode, deps.platform)

  return {
    effectiveMode,
    persistEnvSecret: async (name, value) => {
      if (effectiveMode === "env") {
        await deps.writeEnv(name, value)
        deps.env[name] = value
        return
      }
      await deps.writeKeychain(name, value)
      deps.env[name] = value
    },
    removeEnvSecret: async (name) => {
      delete deps.env[name]
      if (effectiveMode === "env") {
        await deps.removeEnv(name)
        return
      }
      // Keychain mode: an explicit operator delete must remove the value from
      // BOTH tiers. The ".env rollback copy" rationale belongs to copy-only
      // MIGRATION (apply leaves .env so `LUNA_VAULT_STORAGE=env` can roll
      // back) — NOT to a delete. If the .env line survived a delete, it would
      // reload into process.env on the next boot and the env-provider tail
      // would resurrect a secret the operator believed revoked (review
      // finding). Scrub both so a delete stays deleted across restarts.
      await deps.deleteKeychain(name)
      await deps.removeEnv(name)
    },
  }
}
