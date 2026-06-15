/**
 * Provider settings resolver — merges the operator's persisted store config
 * over the env-derived config and produces the shapes the existing broker
 * engine already consumes (ProviderEnv / OverflowConfig).
 *
 * Precedence: STORE OVERRIDES ENV. Env is the bootstrap seed/default.
 * Engine code stays untouched — we feed it via the same readProviderEnv /
 * readOverflowConfig shapes.
 *
 * Validation: before any write we call validateOverflowConfig /
 * auditOverflowEnv. Never persist a chain that audits dirty.
 */

import {
  type ProviderEnv,
  readProviderEnv,
  ANTHROPIC_KIND,
} from "../provider-profile.js"
import {
  type OverflowConfig,
  type ChainStep,
  readOverflowConfig,
  validateOverflowConfig,
} from "../overflow-chain.js"
import type { ProviderSettingsPayload, RoleName } from "./types.js"

// ── Default role→model mapping (PR 1 defaults) ──────────────────────────────

/**
 * v1 default model per role when the store has no binding for it.
 *
 * advisor      → claude-opus-4-8    (most capable)
 * daily-driver → claude-sonnet-4-6  (balanced)
 * wake         → claude-sonnet-4-6  (cheapest capable)
 * dream        → claude-haiku-4-5   (cheapest)
 */
const DEFAULT_ROLE_MODELS: Record<RoleName, string> = {
  advisor: "claude-opus-4-8",
  "daily-driver": "claude-sonnet-4-6",
  wake: "claude-sonnet-4-6",
  dream: "claude-haiku-4-5",
}

/**
 * Derive the effective ProviderEnv by merging store config over the env-derived
 * base. If no store config exists, returns the env-derived base unchanged.
 *
 * Merges only the modelKindMap: role bindings in the store map role names to
 * (provider,model) pairs; those pairs produce model=kind entries in the
 * modelKindMap so the broker's resolveKind picks them up.
 */
export const resolveProviderEnv = (
  storeConfig: ProviderSettingsPayload | null,
  env: Record<string, string | undefined> = process.env,
): ProviderEnv => {
  const base = readProviderEnv(env)
  if (storeConfig === null) return base

  // Build model→kind overrides from role bindings preference lists.
  const storeOverrides: Record<string, string> = {}
  for (const binding of storeConfig.roleBindings ?? []) {
    for (const pref of binding.preferenceList ?? []) {
      if (pref.model && pref.provider) {
        storeOverrides[pref.model] = pref.provider
      }
    }
  }

  // STORE OVERRIDES ENV: env entries first, then store entries win.
  const merged: Record<string, string> = { ...base.modelKindMap, ...storeOverrides }

  return {
    gatewayBaseUrl: base.gatewayBaseUrl,
    ollamaCloudBaseUrl: base.ollamaCloudBaseUrl,
    ollamaLocalBaseUrl: base.ollamaLocalBaseUrl,
    modelKindMap: merged,
  }
}

/**
 * Derive the effective OverflowConfig by merging store role bindings over the
 * env-derived base. Roles that have store bindings get new chains; roles
 * without store bindings keep their env-derived chains (or no chain if absent).
 *
 * STORE OVERRIDES ENV: a stored role binding REPLACES any env chain for that
 * lane (advisor/daily-driver/wake/dream). Non-role lanes from env are preserved
 * unchanged so existing overflow configs keep working.
 */
export const resolveOverflowConfig = (
  storeConfig: ProviderSettingsPayload | null,
  env: Record<string, string | undefined> = process.env,
): OverflowConfig => {
  const base = readOverflowConfig(env)
  if (storeConfig === null) return base

  // Start from a mutable copy of the env chains.
  const chains: Record<string, ReadonlyArray<ChainStep>> = { ...base.chains }

  for (const binding of storeConfig.roleBindings ?? []) {
    if (!binding.preferenceList || binding.preferenceList.length === 0) continue
    const steps: ChainStep[] = binding.preferenceList.map((pref) => ({
      model: pref.model,
      kind: pref.provider,
    }))
    chains[binding.role] = steps
  }

  return { chains }
}

/**
 * Derive the model to advertise for a role: first entry in the preference list
 * from store, or the v1 default. Used by chat-server to prime per-role
 * defaults without touching engine routing.
 */
export const resolveRoleModel = (
  role: RoleName,
  storeConfig: ProviderSettingsPayload | null,
): string => {
  if (storeConfig !== null) {
    const binding = storeConfig.roleBindings?.find((b) => b.role === role)
    const firstPref = binding?.preferenceList?.[0]
    if (firstPref?.model) return firstPref.model
  }
  return DEFAULT_ROLE_MODELS[role] ?? "claude-sonnet-4-6"
}

/** Validation error thrown when the store config would produce a dirty audit. */
export class ProviderSettingsValidationError extends Error {
  readonly findings: ReadonlyArray<string>
  constructor(findings: ReadonlyArray<string>) {
    super(`Provider settings validation failed:\n${findings.join("\n")}`)
    this.name = "ProviderSettingsValidationError"
    this.findings = findings
  }
}

/**
 * Validate a candidate store payload before persisting it. Rejects configs that
 * produce a dirty overflow audit (structured-output mismatches, empty lanes,
 * etc.). Returns the validated payload on success; throws ProviderSettingsValidationError
 * with findings on failure.
 *
 * This is the write-time gate: call it BEFORE writing to the store.
 */
export const validateAndPrepare = (
  candidate: ProviderSettingsPayload,
  env: Record<string, string | undefined> = process.env,
): ProviderSettingsPayload => {
  // Resolve what the effective config would look like.
  const effectiveProviderEnv = resolveProviderEnv(candidate, env)
  const effectiveOverflow = resolveOverflowConfig(candidate, env)

  // Run the existing overflow audit against the effective resolved config.
  const findings = validateOverflowConfig(effectiveOverflow, effectiveProviderEnv)
  if (findings.length > 0) {
    throw new ProviderSettingsValidationError(findings)
  }

  // Basic payload shape validation.
  const payloadFindings: string[] = []
  for (const binding of candidate.roleBindings ?? []) {
    if (!binding.role) {
      payloadFindings.push("A role binding is missing the role field.")
    }
    for (const pref of binding.preferenceList ?? []) {
      if (!pref.model || pref.model.trim() === "") {
        payloadFindings.push(
          `Role "${binding.role}": preference list entry has an empty model string.`,
        )
      }
    }
  }
  if (payloadFindings.length > 0) {
    throw new ProviderSettingsValidationError(payloadFindings)
  }

  return candidate
}

/**
 * Convenience: build the complete resolved ProviderEnv + OverflowConfig pair
 * from a store config (or null), merging over env. Feed both to the engine.
 */
export const resolveAll = (
  storeConfig: ProviderSettingsPayload | null,
  env: Record<string, string | undefined> = process.env,
): { providerEnv: ProviderEnv; overflowConfig: OverflowConfig } => ({
  providerEnv: resolveProviderEnv(storeConfig, env),
  overflowConfig: resolveOverflowConfig(storeConfig, env),
})
