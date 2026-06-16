/**
 * Provider settings types — the persisted, operator-configured model routing
 * preferences (PR 1: config surface only; cap enforcement is PR 2).
 *
 * These types describe what is STORED in `provider_settings` rows on luna.db.
 * The resolver merges store config over env config and produces shapes the
 * existing broker engine already consumes.
 */

/** Provider kinds Luna knows about. openai/google are gated — present but
 *  shown as "validated when key + gateway present" in the UI. */
export type ProviderKind = "anthropic" | "openai" | "google" | "ollama-cloud" | "ollama-local"

/** One configured provider entry stored in the settings table. */
export interface ProviderConfig {
  /** Provider kind — matches ProviderProfile.kind. */
  readonly kind: ProviderKind
  /** Optional pointer to a stored credential (secret_ref or env-var name).
   *  Never the raw value — same indirection as accounts.secret_ref. */
  readonly credentialRef?: string
  /** Optional monthly spend ceiling in USD. Stored but NOT enforced in PR 1.
   *  Label in UI: "not yet enforced (coming in next update)". */
  readonly monthlyCapUsd?: number
  /** Whether this provider has been explicitly enabled by the operator. */
  readonly enabled: boolean
}

/** Role names Luna routes by. */
export type RoleName = "advisor" | "daily-driver" | "wake" | "dream"

/** One role-to-model binding. A preference-ordered list means index 0 is
 *  tried first; if unavailable, fallback to index 1, etc. */
export interface RoleBinding {
  readonly role: RoleName
  /** Ordered list of (provider, model) pairs to try for this role. */
  readonly preferenceList: ReadonlyArray<{ readonly provider: ProviderKind; readonly model: string }>
}

/** The full persisted settings payload stored as a single JSON blob
 *  in provider_settings(key='config', value=<json>). */
export interface ProviderSettingsPayload {
  readonly providers: ReadonlyArray<ProviderConfig>
  readonly roleBindings: ReadonlyArray<RoleBinding>
  /** Schema version for forward compat (always 1 for now). */
  readonly version: 1
}


