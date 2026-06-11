/**
 * reconcileVaultItems — pure reconciler (no I/O).
 *
 * At boot, and after every successful mutation or sync cycle, the caller
 * enumerates:
 *   - `envVarNames`   — var NAMES from ~/.luna/.env (values never read)
 *   - `opTokenLabels` — labels from LUNA_OP_ACCOUNTS that have a live token
 *
 * Any credential that exists on the server but has no registry row is an
 * "orphan". The reconciler adopts orphans — it returns the VaultItems that
 * should be upserted to bring the registry in sync with reality.
 *
 * Denylist (never adopted):
 *   - `UI_WS_TOKEN` (the client connection token — internal transport secret)
 *   - Any name matching /^LUNA_/ (internal Luna server config vars)
 *
 * Second run is idempotent: once an item is in the registry (any source)
 * it is NOT re-adopted.
 */

import type { VaultItem } from "./types.js"
import { humanizeName } from "./mutations.js"
import { makeId, isEnvDenied } from "./internal.js"

// Re-export so the reconciler's denylist predicate is accessible from the
// public barrel without breaking the single-source-of-truth in internal.ts.
export { isEnvDenied }

// ---------------------------------------------------------------------------
// Denylist
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ReconcileInput {
  /** Env var names from ~/.luna/.env. Values must NOT be included. */
  readonly envVarNames: ReadonlyArray<string>
  /** Op-token labels from LUNA_OP_ACCOUNTS that have a live token present. */
  readonly opTokenLabels: ReadonlyArray<string>
  /** The current vault registry contents. */
  readonly existing: ReadonlyArray<VaultItem>
  /** Current epoch ms (used for createdAt/updatedAt on adopted rows). */
  readonly now: number
}

export interface ReconcileResult {
  /** Items that should be upserted into the registry (orphan adoptions). */
  readonly toAdopt: ReadonlyArray<VaultItem>
}

/**
 * Pure reconciler. Computes which orphan credentials need to be adopted
 * into the registry. No I/O; safe to call from any context.
 */
export const reconcileVaultItems = ({
  envVarNames,
  opTokenLabels,
  existing,
  now,
}: ReconcileInput): ReconcileResult => {
  // Index existing items by their ref AND by lowercased name for O(1) lookups.
  const existingRefs = new Set(existing.map((i) => i.ref))
  // Maps lowerName → ref of the item that owns that name slot.
  const existingNameLower = new Map<string, string>(
    existing.map((i) => [i.name.toLowerCase(), i.ref]),
  )

  const toAdopt: VaultItem[] = []

  /**
   * Resolve the display name for an adopted item, uniquifying on name
   * collision with a DIFFERENT ref (deterministic: appends the raw origin
   * in parentheses so reruns are idempotent).
   */
  const resolveName = (candidate: string, ref: string, rawOrigin: string): string => {
    const lower = candidate.toLowerCase()
    const occupantRef = existingNameLower.get(lower)
    if (occupantRef === undefined || occupantRef === ref) {
      // Slot is free (or belongs to the same ref — shouldn't happen, but safe).
      return candidate
    }
    // Collision: a DIFFERENT ref owns this name → uniquify deterministically.
    return `${candidate} (${rawOrigin})`
  }

  /** Register a name slot in the working index so in-flight adoptions don't collide. */
  const claimName = (name: string, ref: string): void => {
    existingNameLower.set(name.toLowerCase(), ref)
  }

  // ------------------------------------------------------------------
  // Adopt orphan env-secrets.
  // ------------------------------------------------------------------
  for (const varName of envVarNames) {
    if (isEnvDenied(varName)) continue
    const ref = `env:${varName}`
    if (existingRefs.has(ref)) continue
    const baseName = humanizeName(varName)
    const name = resolveName(baseName, ref, varName)
    toAdopt.push({
      id: makeId(),
      name,
      kind: "env-secret",
      ref,
      source: "manual",
      description: null,
      createdAt: now,
      updatedAt: now,
      opItemId: null,
    })
    // Track the new ref and name so duplicates in input don't produce two rows.
    existingRefs.add(ref)
    claimName(name, ref)
  }

  // ------------------------------------------------------------------
  // Adopt orphan op-tokens.
  // ------------------------------------------------------------------
  for (const label of opTokenLabels) {
    const ref = `luna-op://${label}`
    if (existingRefs.has(ref)) continue
    const baseName = label
    const name = resolveName(baseName, ref, label)
    toAdopt.push({
      id: makeId(),
      name,
      kind: "op-token",
      ref,
      source: "manual",
      description: null,
      createdAt: now,
      updatedAt: now,
      opItemId: null,
    })
    existingRefs.add(ref)
    claimName(name, ref)
  }

  return { toAdopt }
}
