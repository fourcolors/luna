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
 * recordCapture. Single source of truth shared by mutations + reconciler.
 */
export const isEnvDenied = (varName: string): boolean =>
  ENV_DENYLIST.has(varName) || varName.startsWith("LUNA_")
