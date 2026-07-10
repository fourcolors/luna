/**
 * Shared internal utilities for the vault package.
 * NOT part of the public API — imported only by sibling modules.
 */
import { isReservedSecretName } from "@luna/core"

/** Generate a short crypto-random id (24 hex chars). */
export const makeId = (): string => {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

/**
 * Returns true for env var names that are reserved for Luna internals and must
 * never appear in the vault registry or be accepted via vault-put /
 * recordCapture.
 *
 * DELEGATES to the CANONICAL definition, `isReservedSecretName` in
 * packages/core/src/secret-provider/reserved-names.ts. The name and signature
 * are kept stable here so every vault consumer (mutations, reconciler) is
 * untouched. One deliberate inline mirror remains:
 *   - packages/secret-tools/src/register-secret.ts `isEnvReserved`
 *     (inlined so secret-tools stays unit-testable without pulling @luna/core;
 *     an apps/ui-web cross-package drift test pins behavioural equality).
 * The audit's case-insensitivity requirement (a lookalike like `luna_x` or
 * `Ui_Ws_Token` must be rejected exactly like the uppercase form) lives in the
 * canonical module.
 */
export const isEnvDenied = (varName: string): boolean =>
  isReservedSecretName(varName)

/**
 * Pick a deterministic, case-insensitively unique display name without ever
 * taking a slot owned by a different credential ref.
 *
 * The first collision uses the stable origin suffix used throughout Vault;
 * further collisions add `#2`, `#3`, ... . Checking the suffixed candidate is
 * load-bearing: blindly returning it lets `upsertByName` overwrite an existing
 * row that already owns that exact suffix.
 */
export const uniqueVaultName = (
  nameIndex: ReadonlyMap<string, string>,
  candidate: string,
  ref: string,
  rawOrigin: string,
): string => {
  const available = (name: string): boolean => {
    const occupantRef = nameIndex.get(name.toLowerCase())
    return occupantRef === undefined || occupantRef === ref
  }

  if (available(candidate)) return candidate
  const suffixed = `${candidate} (${rawOrigin})`
  if (available(suffixed)) return suffixed
  for (let n = 2; ; n += 1) {
    const numbered = `${suffixed} #${n}`
    if (available(numbered)) return numbered
  }
}
