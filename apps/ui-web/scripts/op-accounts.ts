/**
 * 1Password service-account registry, keyed entirely by `label`.
 *
 * `LUNA_OP_ACCOUNTS` is a comma-separated list of labels. The label is
 * the single source of truth: it deterministically derives every token
 * backend, so they never drift —
 *
 *   keychain (macOS, preferred):  service `luna.op.<label>`, account `<label>`
 *   env var  (Linux / fallback):  `LUNA_OP_TOKEN_<LABEL>`
 *   file     (runtime-written):   `~/.luna/op-tokens/<label>` (mode 0600)
 *
 * `discoverOpTokens` (chat-server.ts) resolves keychain → env → file. The
 * file is the last fallback: it exists only when a token was set at
 * runtime (e.g. via the Moon secure-entry form on a Linux server where no
 * keychain exists), so existing keychain/env setups are never shadowed.
 */
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface OpAccountConfig {
  readonly label: string
  /** macOS keychain `-s` argument: `luna.op.<label>`. */
  readonly keychainService: string
  /** macOS keychain `-a` argument: `<label>`. */
  readonly keychainAccount: string
  /** Linux/fallback env var holding the `ops_…` service-account token. */
  readonly tokenEnvVar: string
}

const LABEL_PATTERN = /^[a-z][a-z0-9_-]*$/

/** Keychain coordinates for a label: `luna.op.<label>` / `<label>`. */
const keychainServiceFor = (label: string): string => `luna.op.${label}`

/**
 * Fallback env-var name for a label's service-account token. Env var
 * names cannot contain `-`, so hyphens collapse to underscores.
 * e.g. `primary` → `LUNA_OP_TOKEN_PRIMARY`, `ops-flow` → `LUNA_OP_TOKEN_OPS_FLOW`.
 *
 * Exported (W2) because it is ALSO the luna-vault ENTRY NAME for a runtime-
 * written op token on non-darwin - persist/delete/discover must all agree on
 * one name, so they share this single derivation.
 */
export const tokenEnvVarFor = (label: string): string =>
  `LUNA_OP_TOKEN_${label.toUpperCase().replace(/-/g, "_")}`

const parseLabel = (label: string): OpAccountConfig => {
  if (!LABEL_PATTERN.test(label)) {
    throw new Error(
      "LUNA_OP_ACCOUNTS labels must start with a lowercase letter and " +
        "contain only lowercase letters, numbers, '_' or '-' " +
        `(got "${label}")`,
    )
  }
  return {
    label,
    keychainService: keychainServiceFor(label),
    keychainAccount: label,
    tokenEnvVar: tokenEnvVarFor(label),
  }
}

export const resolveOpAccounts = (
  env: Record<string, string | undefined> = process.env,
): ReadonlyArray<OpAccountConfig> => {
  const raw = env["LUNA_OP_ACCOUNTS"]?.trim()
  if (raw === undefined || raw.length === 0) return []
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map(parseLabel)
}

/**
 * Read an account's service-account token from its fallback env var.
 * Returns the trimmed value, or `undefined` when the var is unset or
 * blank. This is the Linux/fallback half of `discoverOpTokens` —
 * factored out so the read path is unit-tested (chat-server.ts has no
 * tsc gate and is not unit-tested).
 */
export const envTokenFor = (
  acct: OpAccountConfig,
  env: Record<string, string | undefined> = process.env,
): string | undefined => {
  const value = env[acct.tokenEnvVar]?.trim()
  return value !== undefined && value.length > 0 ? value : undefined
}

/**
 * Path of the runtime-written token file for a label:
 * `~/.luna/op-tokens/<label>`. This is the only writable token store on a
 * Linux server (no keychain); the Moon secure-entry form writes it there.
 */
export const tokenFilePathFor = (label: string): string =>
  join(homedir(), ".luna", "op-tokens", label)

/**
 * Read an account's service-account token from its runtime token file.
 * Returns the trimmed value, or `undefined` when the file is absent,
 * unreadable, or blank. The last fallback in `discoverOpTokens`. `readFile`
 * is injectable so the read path is unit-tested without touching disk
 * (chat-server.ts has no tsc gate and is not unit-tested).
 */
export const fileTokenFor = (
  acct: OpAccountConfig,
  readFile: (path: string) => string = (p) => readFileSync(p, "utf8"),
): string | undefined => {
  let raw: string
  try {
    raw = readFile(tokenFilePathFor(acct.label))
  } catch {
    return undefined
  }
  const value = raw.trim()
  return value.length > 0 ? value : undefined
}
