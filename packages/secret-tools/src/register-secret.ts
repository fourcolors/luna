/**
 * makeRegisterSecret — the storage-agnostic orchestration behind the
 * `request_secret` tool. Given a (destination, secret) it validates the
 * destination, stores the secret in the right place, and returns `{ok,message}`
 * — NEVER the secret value, and never logging it.
 *
 * The effectful steps (op whoami, keychain/file writes, DB writes) are injected
 * as `deps` so THIS decision logic is unit-tested without spawning processes.
 * Activation (the deferred restart) is NOT done here — the SecretRequestBridge
 * owns that, firing it at turn-complete so a restart never kills the calling
 * turn. So this function only validates + stores.
 *
 * Slice 1 implements the `op-token` destination (a 1Password service-account
 * token for an account label). `env-secret`, `file-secret`, and `account`
 * destinations are added in later slices; the dispatch is structured for them.
 */

// Account-label grammar — mirrors the FROZEN contract in DESIGN.md §2.2.11 and
// ACCOUNT_LABEL_RE / RESERVED_LABELS in
// packages/core/src/secret-provider/routed-op-provider.ts. Inlined (not imported
// from @luna/core) so this orchestration stays unit-testable without pulling the
// whole core barrel into the test runner. The grammar is frozen, so this mirror
// cannot drift. Identical to apps/ui-web/scripts/register-op-token.ts.
const ACCOUNT_LABEL_RE = /^[a-z][a-z0-9-]{0,30}$/
const RESERVED_LABELS: ReadonlySet<string> = new Set(["env", "file", "op"])

/**
 * Shell/.env identifier grammar for an environment-variable name. Rejecting
 * anything else is a SECURITY guard: a name containing `=` or a newline could
 * inject extra lines into `~/.luna/.env`. Permissive on case (env names are
 * case-sensitive and the account's `env:NAME` ref must match exactly).
 */
const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Reserved env-var names that must never be overwritten by the agent or
 * operator via request_secret (env-secret branch). Mirrors the CANONICAL
 * definition, `isReservedSecretName` in
 * packages/core/src/secret-provider/reserved-names.ts (which
 * packages/vault/src/internal.ts:isEnvDenied now delegates to) - inlined here
 * so secret-tools stays unit-testable without pulling @luna/core. The predicate
 * is CASE-INSENSITIVE (audit finding): an agent calling request_secret with
 * var_name "luna_x" or "ui_ws_token" must be rejected just like the uppercase
 * form. Normalise to uppercase before every comparison. A cross-package drift
 * test (apps/ui-web) pins behavioural equality with the canonical module.
 */
const ENV_RESERVED_DENYLIST: ReadonlySet<string> = new Set(["UI_WS_TOKEN"])
const isEnvReserved = (varName: string): boolean => {
  const upper = varName.toUpperCase()
  return ENV_RESERVED_DENYLIST.has(upper) || upper.startsWith("LUNA_")
}

/**
 * Where a captured secret should be stored. Discriminated by `kind`. The agent
 * chooses this; the secret VALUE is collected separately and never appears
 * here.
 *   - `op-token`   — a 1Password service-account token for an account label.
 *   - `env-secret` — a value stored under the env-var NAME, which an account's
 *                    `env:NAME` ref then resolves. The BACKING STORE is tier-
 *                    dependent (see `resolveWriteTier`): plaintext `~/.luna/.env`
 *                    as `NAME=value`, an OS keychain entry (`luna.vault.<NAME>`
 *                    on Darwin), or Luna's encrypted vault
 *                    (`~/.luna/vault/secrets.enc`). `process.env` is mirrored on
 *                    write either way, so in-process resolution is immediate —
 *                    but an EXTERNAL process that parses `~/.luna/.env` itself
 *                    will not observe a keychain/vault-tier write.
 * (`file-secret` is intentionally absent: FileSecretProvider is not wired into
 * the prod chain, so a `file:` ref would not resolve — see DESIGN/spec.)
 */
export type SecretDestination =
  | {
      readonly kind: "op-token"
      /** The registered account label this 1Password service-account token is for. */
      readonly label: string
    }
  | {
      readonly kind: "env-secret"
      /** Environment-variable name; the account ref is `env:<varName>`. */
      readonly varName: string
    }

export interface RegisterResult {
  readonly ok: boolean
  readonly message: string
}

export interface RegisterSecretDeps {
  /** Is this label in the server's discovery set (LUNA_OP_ACCOUNTS)? */
  readonly isLabelRegistered: (label: string) => boolean
  /** Verify a 1Password service-account token authenticates (real impl: `op whoami`). */
  readonly validateOpToken: (token: string) => Promise<RegisterResult>
  /** Persist a 1Password service-account token for a label (keychain/file). */
  readonly persistOpToken: (label: string, token: string) => Promise<void>
  /** Persist an env-var secret (real impl: upsert `~/.luna/.env` + set process.env). */
  readonly persistEnvSecret: (varName: string, value: string) => Promise<void>
  /** Optional non-sensitive audit logger (never the secret). */
  readonly log?: (message: string) => void
}

/**
 * Human-readable rendering of a destination — shown in the Moon secure panel
 * for operator CONSENT (so they see where the secret lands). Never includes a
 * secret value.
 */
export const describeDestination = (d: SecretDestination): string => {
  switch (d.kind) {
    case "op-token":
      return `1Password service-account token for account "${d.label}"`
    case "env-secret":
      return `environment variable env:${d.varName}`
    default:
      // Defensive: `destination` reaches makeRegisterSecret through an
      // `unknown` cast (bridge), so an out-of-union kind is structurally
      // possible. Never return undefined (it would flow onto the wire).
      return "an unsupported destination"
  }
}

/**
 * Build the secret-store handler from injected effectful deps. The returned
 * function never throws — every failure resolves to `{ok:false}`. It never
 * logs or returns the secret value.
 */
export const makeRegisterSecret =
  (deps: RegisterSecretDeps) =>
  async (
    destination: SecretDestination,
    secret: string,
  ): Promise<RegisterResult> => {
    const value = secret.trim()
    if (value.length === 0) {
      return { ok: false, message: "The secret was empty." }
    }

    switch (destination.kind) {
      case "op-token": {
        const label = destination.label.trim()
        if (RESERVED_LABELS.has(label) || !ACCOUNT_LABEL_RE.test(label)) {
          return { ok: false, message: `Invalid account label "${label}".` }
        }
        if (!deps.isLabelRegistered(label)) {
          return {
            ok: false,
            message: `"${label}" isn't in LUNA_OP_ACCOUNTS — add it to the server config and restart first.`,
          }
        }
        let check: RegisterResult
        try {
          check = await deps.validateOpToken(value)
        } catch {
          // Honor the "never throws" contract even if a dep rejects.
          return { ok: false, message: "Could not verify the token on the server." }
        }
        if (!check.ok) {
          return { ok: false, message: check.message }
        }
        try {
          await deps.persistOpToken(label, value)
        } catch {
          return { ok: false, message: "Failed to store the token on the server." }
        }
        deps.log?.(
          `[secret] op-token for "${label}" verified + stored; activation deferred to turn end`,
        )
        return {
          ok: true,
          message: `Stored the 1Password token for "${label}". It activates after a brief restart at the end of this turn.`,
        }
      }

      case "env-secret": {
        const varName = destination.varName.trim()
        if (!ENV_VAR_NAME_RE.test(varName)) {
          return {
            ok: false,
            message: `Invalid environment-variable name "${varName}".`,
          }
        }
        // SECURITY (audit finding): reject reserved names BEFORE calling
        // persistEnvSecret. UI_WS_TOKEN and LUNA_* are live Luna internals —
        // an injected agent overwriting them could hijack auth or config.
        // Check is CASE-INSENSITIVE (mirrors isEnvDenied in @luna/vault).
        if (isEnvReserved(varName)) {
          return {
            ok: false,
            message: "That name is reserved for Luna internals.",
          }
        }
        // SECURITY: a value with a newline would corrupt `~/.luna/.env` (and
        // could inject extra vars). A pasted secret almost never contains one;
        // reject it loudly rather than mangle the file.
        if (/[\r\n]/.test(value)) {
          return {
            ok: false,
            message: "The secret contains a line break and can't be stored as an env var.",
          }
        }
        try {
          await deps.persistEnvSecret(varName, value)
        } catch {
          return { ok: false, message: "Failed to store the secret on the server." }
        }
        deps.log?.(
          `[secret] env-secret "${varName}" stored; activation deferred to turn end`,
        )
        return {
          ok: true,
          message: `Stored env:${varName}. Point an account's secret_ref at "env:${varName}" to use it; it activates after a brief restart at the end of this turn.`,
        }
      }

      default:
        // Exhaustiveness backstop: `destination` arrives through an `unknown`
        // cast at the chat-server seam, so a kind outside the union is
        // structurally reachable (e.g. a future destination wired before this
        // switch is extended). Returning here keeps the contract "never returns
        // undefined" — an undefined would make the bridge's status `.then` throw
        // and hang the awaiting turn.
        return { ok: false, message: "Unsupported secret destination." }
    }
  }
