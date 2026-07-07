/**
 * reserved-names - the CANONICAL definition of which env-secret names are
 * reserved for Luna internals and must never be stored in the vault registry,
 * accepted via vault-put / recordCapture, or written by the agent
 * `request_secret` path.
 *
 * Reserved set: the literal `UI_WS_TOKEN`, plus every name beginning `LUNA_`.
 * These are live Luna internals (the UI websocket bearer token; the whole
 * `LUNA_*` config surface) whose values are managed by the server, not the
 * operator - letting them into the vault would either shadow the real value or
 * confuse the operator in the Vault list.
 *
 * SECURITY (audit finding): the check is CASE-INSENSITIVE. Env vars do NOT
 * case-fold (process.env is case-sensitive on every platform), so a lookalike
 * like `luna_x` or `Ui_Ws_Token` can only exist to EVADE this policy or to
 * confuse the operator reading the Vault list. The entire case-class is
 * therefore reserved: normalise to uppercase before comparing.
 *
 * DRIFT: this module is the single source of truth. Two deliberate inline
 * mirrors exist and must stay behaviourally identical (they inline the copy to
 * avoid a cross-package import, by the same convention as ACCOUNT_LABEL_RE):
 *   - packages/vault/src/internal.ts `isEnvDenied` - now DELEGATES here.
 *   - packages/secret-tools/src/register-secret.ts `isEnvReserved` - keeps its
 *     documented inline copy (unit-testable without pulling @luna/core); an
 *     apps/ui-web cross-package drift test pins behavioural equality.
 */

/** The single non-prefix reserved name. */
const RESERVED_LITERALS: ReadonlySet<string> = new Set(["UI_WS_TOKEN"])

/** The reserved prefix; any name starting with this (case-insensitive) is reserved. */
const RESERVED_PREFIX = "LUNA_"

/**
 * Returns true for env-secret names reserved for Luna internals.
 *
 * Case-insensitive: the name is normalised to uppercase before comparison so
 * lookalikes (`luna_x`, `Ui_Ws_Token`) are rejected exactly like the canonical
 * uppercase form.
 */
export const isReservedSecretName = (name: string): boolean => {
  const upper = name.toUpperCase()
  return RESERVED_LITERALS.has(upper) || upper.startsWith(RESERVED_PREFIX)
}
