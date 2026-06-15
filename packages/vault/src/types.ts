/**
 * Vault model — credential REGISTRY (metadata, NEVER values).
 *
 * A VaultItem is one row in the `vault_items` table: a human title, a
 * kind, a ref POINTER into the existing secret-provider chain, and
 * provenance metadata. The credential value lives in the appropriate
 * backend (process.env / ~/.luna/.env for env-secret; OS keychain or
 * ~/.luna/op-tokens/<label> for op-token; 1Password directly for op-item).
 *
 * VaultSyncConfig controls the optional 1Password two-way sync (slice V3).
 * It is stored as a single row in `vault_sync_config` and is null when
 * it has never been configured.
 */

/** The three registry entry kinds. */
export type VaultItemKind = "env-secret" | "op-token" | "op-item"

/**
 * How the item entered the registry.
 *   - `manual`       — operator added it through the Vault UI or settings frame.
 *   - `agent`        — arrived via request_secret / SecretRequestBridge.
 *   - `1password`    — inbound from the 1Password sync poller.
 *   - `apple-import` — imported from an Apple Passwords CSV export.
 */
export type VaultItemSource = "manual" | "agent" | "1password" | "apple-import"

/**
 * One registry entry. `ref` is a POINTER — never a secret value:
 *   - `env:<NAME>`                                 — env-secret
 *   - `luna-op://<label>`                          — op-token
 *   - `luna-op://<label>/<vault>/<itemId>/<field>` — op-item
 */
export interface VaultItem {
  readonly id: string
  /** Human-readable title (unique case-insensitively across the registry). */
  readonly name: string
  readonly kind: VaultItemKind
  /** Secret-provider pointer — NEVER the credential value. */
  readonly ref: string
  readonly source: VaultItemSource
  readonly description: string | null
  /** Unix epoch ms. */
  readonly createdAt: number
  /** Unix epoch ms. */
  readonly updatedAt: number
  /**
   * 1Password item ID (non-null for op-item rows and env-secrets that were
   * also pushed outbound to 1Password during sync).
   */
  readonly opItemId: string | null
}

/**
 * Single-row configuration for the 1Password two-way sync (slice V3).
 * Persisted in `vault_sync_config`; null means never configured.
 */
export interface VaultSyncConfig {
  readonly enabled: boolean
  /** Account label whose service-account token authenticates the op CLI. */
  readonly opLabel: string
  /** 1Password vault name to sync against. */
  readonly opVault: string
  /** How often to poll for inbound items. Floor: 60 s. */
  readonly pollSeconds: number
  /** Epoch ms of the last successful inbound sync pass, or null. */
  readonly lastSyncedAt: number | null
  /** Last error string from the sync poller, or null when last run was clean. */
  readonly lastError: string | null
}
