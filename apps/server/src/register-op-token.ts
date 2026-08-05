/**
 * Orchestration for the Moon secure-entry `register-op-token` handler.
 *
 * The flow is: validate the label → verify the token actually authenticates
 * (so "saved" means "verified", not "wrote a string") → persist it to the
 * platform's preferred store → restart the server so `discoverOpTokens`
 * re-runs and the token goes live. Crucially, a bad label or a token 1Password
 * rejects produces `{ok:false}` with NO persist and NO restart — a typo must
 * never trigger a disruptive restart into broken credentials.
 *
 * The effectful steps (running `op`, writing the keychain/file, triggering the
 * restart) are injected as `deps` so THIS orchestration is unit-tested without
 * spawning processes or exiting — chat-server.ts (which wires the real deps)
 * has no tsc gate and is not unit-tested, so the decision logic lives here.
 *
 * SECURITY: the token is sensitive. It is never logged and never placed in a
 * returned `message`; `deps.log` receives only a label-keyed audit line.
 */

// Account-label grammar — mirrors the FROZEN contract in DESIGN.md §2.2.11 and
// ACCOUNT_LABEL_RE / RESERVED_LABELS in
// packages/core/src/secret-provider/routed-op-provider.ts. Inlined (not
// imported from @luna/core) so this orchestration stays unit-testable without
// pulling the whole core barrel into the test runner. The grammar is frozen,
// so the mirror cannot drift.
const ACCOUNT_LABEL_RE = /^[a-z][a-z0-9-]{0,30}$/
const RESERVED_LABELS: ReadonlySet<string> = new Set(["env", "file", "op"])

export type TokenCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string }

export interface RegisterOpTokenDeps {
  /**
   * Is this label in the server's discovery set (LUNA_OP_ACCOUNTS)? A token
   * stored under a label `discoverOpTokens` never queries is orphaned — it
   * persists and the restart fires, but the token is never used. Rejecting
   * up-front keeps "saved" honest: the label must already be configured.
   */
  readonly isLabelRegistered: (label: string) => boolean
  /** Verify the token authenticates (real impl: `op whoami`). Never logs the token. */
  readonly validateToken: (token: string) => Promise<TokenCheck>
  /** Persist the token to the platform store (keychain on darwin, file on linux). */
  readonly persist: (label: string, token: string) => Promise<void>
  /** Trigger a graceful server restart (real impl: SIGTERM self → dispose → exit 0). */
  readonly scheduleRestart: () => void
  /** Optional non-sensitive audit logger (label only, never the token). */
  readonly log?: (message: string) => void
}

export interface RegisterResult {
  readonly ok: boolean
  readonly message: string
}

/**
 * Build the `register-op-token` handler from injected effectful deps. The
 * returned function never throws — every failure resolves to `{ok:false}`.
 */
export const makeRegisterOpToken =
  (deps: RegisterOpTokenDeps) =>
  async (input: {
    readonly label: string
    readonly token: string
  }): Promise<RegisterResult> => {
    const label = input.label.trim()
    const token = input.token.trim()

    if (RESERVED_LABELS.has(label) || !ACCOUNT_LABEL_RE.test(label)) {
      return { ok: false, message: `Invalid account label "${label}".` }
    }
    if (!deps.isLabelRegistered(label)) {
      return {
        ok: false,
        message: `"${label}" isn't in LUNA_OP_ACCOUNTS — add it to the server config and restart first.`,
      }
    }
    if (token.length === 0) {
      return { ok: false, message: "Token is empty." }
    }

    const check = await deps.validateToken(token)
    if (!check.ok) {
      return { ok: false, message: check.message }
    }

    try {
      await deps.persist(label, token)
    } catch {
      // No token in the message — keep failures opaque.
      return { ok: false, message: "Failed to store the token on the server." }
    }

    deps.log?.(`[op] token for "${label}" verified + stored; restarting to activate`)
    deps.scheduleRestart()
    return { ok: true, message: `Saved "${label}". Restarting to activate…` }
  }
