/**
 * Shared internal utilities for the vault package.
 * NOT part of the public API — imported only by sibling modules.
 */

/** Generate a short crypto-random id (24 hex chars). */
export const makeId = (): string => {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

/** Env var names that must never appear in the vault registry (A5). */
const ENV_DENYLIST: ReadonlySet<string> = new Set(["UI_WS_TOKEN"])

/**
 * Returns true for env var names that are reserved for Luna internals and must
 * never appear in the vault registry or be accepted via vault-put /
 * recordCapture.
 *
 * CANONICAL COPY — two FROZEN mirrors exist and must change in lockstep
 * (process.env is case-sensitive, so the mirrors are inlined by the same
 * no-cross-package-import convention as ACCOUNT_LABEL_RE):
 *   - packages/secret-tools/src/register-secret.ts `isEnvReserved`
 *     (the agent request_secret path)
 *   - apps/ui-web/scripts/chat-server.ts `_isEnvReservedLocal`
 *     (persistEnvSecret defense-in-depth)
 * Adding a name here WITHOUT updating both mirrors reopens the audit's
 * agent-path bypass for that name.
 *
 * SECURITY (audit finding): the check is CASE-INSENSITIVE. Not because env
 * vars case-fold (they don't — process.env is case-sensitive everywhere) but
 * because a lookalike name like `luna_x` or `Ui_Ws_Token` serves no purpose
 * EXCEPT to evade this policy or confuse the operator in the Vault list, so
 * the whole case-class is reserved. Normalise to uppercase before comparing.
 */
export const isEnvDenied = (varName: string): boolean => {
  const upper = varName.toUpperCase()
  return ENV_DENYLIST.has(upper) || upper.startsWith("LUNA_")
}
