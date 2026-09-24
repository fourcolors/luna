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
export type RoleName = "advisor" | "daily-driver" | "wake" | "dream" | "classifier"

/** One role-to-model binding. A preference-ordered list means index 0 is
 *  tried first; if unavailable, fallback to index 1, etc. */
export interface RoleBinding {
  readonly role: RoleName
  /** Ordered list of (provider, model) pairs to try for this role. */
  readonly preferenceList: ReadonlyArray<{ readonly provider: ProviderKind; readonly model: string }>
}

/** Memory reranker engines (the MemoryReranker Luna's server binds; see
 *  packages/memory/bench/README.md "Choosing the rerank engine"). */
export const MEMORY_RERANKER_ENGINES = ["cross-encoder", "jev"] as const
export type MemoryRerankerEngine = (typeof MEMORY_RERANKER_ENGINES)[number]

/** Classifier engines — which engine serves decision-shaped work on the
 *  classifier lane (see packages/core/src/classifier/types.ts):
 *  - "auto"  (default): Jev when TYPESAFE_API_KEY is set and the classifier
 *    role has no explicit model binding; otherwise the generative lane.
 *  - "jev":  always bind the Jev engine (warn at boot when no key resolves).
 *  - "model": no dedicated engine — decision calls stay on the generative
 *    classifier lane (roleBindings/env model). */
export const CLASSIFIER_ENGINES = ["auto", "model", "jev"] as const
export type ClassifierEngine = (typeof CLASSIFIER_ENGINES)[number]

/** The engine actually bound — the "auto" resolution result and the set
 *  reported as `active` on model-routing-list. */
export const ACTIVE_CLASSIFIER_ENGINES = ["model", "jev"] as const
export type ActiveClassifierEngine = (typeof ACTIVE_CLASSIFIER_ENGINES)[number]

/** The full persisted settings payload stored as a single JSON blob
 *  in provider_settings(key='config', value=<json>). */
export interface ProviderSettingsPayload {
  readonly providers: ReadonlyArray<ProviderConfig>
  readonly roleBindings: ReadonlyArray<RoleBinding>
  /**
   * Operator-chosen memory reranker, applied at boot as LUNA_RERANK_ENGINE
   * (store wins over env, like every setting here). Absent = never chosen in
   * the UI: the environment decides (default cross-encoder). Additive; older
   * payloads simply lack it.
   */
  readonly memoryReranker?: { readonly engine: MemoryRerankerEngine }
  /**
   * Operator-chosen classifier engine, applied at boot as
   * LUNA_CLASSIFIER_ENGINE (store wins over env, like every setting here).
   * Absent = never chosen in the UI: the environment decides (default
   * "auto" — Jev when TYPESAFE_API_KEY resolves and the classifier role has
   * no explicit model binding). Additive; older payloads simply lack it.
   */
  readonly classifierEngine?: { readonly engine: ClassifierEngine }
  /** Schema version for forward compat (always 1 for now). */
  readonly version: 1
}


