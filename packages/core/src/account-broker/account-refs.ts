/**
 * Account kind + secret-ref validation shared by AccountBroker mutations
 * and (conceptually) `luna account add`. Pointer-mover only — never resolves
 * secrets. `file:` refs are rejected (not on the production SecretProvider
 * chain).
 */

const KIND_ALLOWLIST_EXACT = new Set([
  "anthropic",
  "google",
  "openai",
  "ollama-cloud",
  "ollama-local",
])
const KIND_PREFIX_ALLOW = ["tool-", "mcp-"] as const

const ACCOUNT_LABEL_RE = /^[a-z][a-z0-9-]{0,30}$/
const RESERVED_OP_LABELS = new Set(["env", "file", "op"])

export const FILE_SECRET_REF_ERROR =
  "file: refs are not resolvable by the Luna server. " +
  "Use env:NAME (value stored via the Vault) or luna-op://<label>/... for 1Password."

export function validateAccountKind(kind: string): boolean {
  if (KIND_ALLOWLIST_EXACT.has(kind)) return true
  return KIND_PREFIX_ALLOW.some(
    (p) => kind.startsWith(p) && kind.length > p.length,
  )
}

export function validateAccountSecretRef(ref: string): boolean {
  if (ref === "claude-code:login") return true
  if (ref.startsWith("luna-op://")) {
    const rest = ref.slice("luna-op://".length)
    const slash = rest.indexOf("/")
    if (slash <= 0) return false
    const label = rest.slice(0, slash)
    const remainder = rest.slice(slash + 1)
    if (remainder.length === 0) return false
    if (RESERVED_OP_LABELS.has(label)) return false
    return ACCOUNT_LABEL_RE.test(label)
  }
  if (ref.startsWith("op://")) {
    return ref.length > "op://".length
  }
  if (ref.startsWith("env:")) {
    if (ref.startsWith("env://")) return false
    const name = ref.slice("env:".length)
    return name.length > 0 && !name.includes("/")
  }
  return false
}

export function accountSecretRefError(ref: string): string | null {
  if (ref.startsWith("file:")) return FILE_SECRET_REF_ERROR
  if (!validateAccountSecretRef(ref)) {
    return (
      `invalid secret-ref "${ref}". ` +
      `Must be one of: op://<rest>, luna-op://<label>/<rest> ` +
      `(label matches ^[a-z][a-z0-9-]{0,30}$, not in {env, file, op}), ` +
      `env:<VAR> (one colon, no slashes), or claude-code:login.`
    )
  }
  return null
}
