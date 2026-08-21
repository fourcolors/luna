/**
 * op-token-scrub - the ANTI-RESURRECTION delete contract for a runtime-written
 * op service-account token, factored out of chat-server.ts so the decision
 * logic is unit-testable (chat-server.ts has no tsc/unit gate).
 *
 * Op-token discovery (secret-chain.ts `discoverOpTokens`) falls through
 * keychain (darwin) → `LUNA_OP_TOKEN_<LABEL>` env var → luna vault entry →
 * legacy plaintext file. A delete must therefore scrub EVERY PERSISTED tier on
 * EVERY platform, not just the one this platform WRITES to: a darwin delete
 * that only cleared the keychain would leave a vault or legacy-file copy that
 * discovery re-adopts on the next boot. This mirrors the env-secret DELETE
 * contract in vault-secret-store.ts: attempt every applicable tier
 * unconditionally, treat "not found" as success, collect the tiers that
 * genuinely FAILED, and if any failed throw an Error naming them (never the
 * token value) so a partial scrub is never silently swallowed.
 *
 * It cannot scrub the `LUNA_OP_TOKEN_<LABEL>` PROCESS-ENV / env-file tier by
 * design - that tier is operator-provisioned (the supervisor owns that env), so
 * discovery may still find an env-var token after a delete. That is
 * intentional: the operator owns the env, and discovery re-adopting it after
 * restart is honest, not a resurrection bug.
 *
 * MODE-INDEPENDENT ON PURPOSE: like op-token WRITES, this scrub is NOT driven by
 * `LUNA_VAULT_STORAGE` / `resolveWriteTier`. Op tokens authenticate the `op` CLI
 * itself and must be available in every mode, so both the write split and this
 * scrub ignore the storage-mode policy.
 *
 * Every side effect is injected so this is pure-testable with fakes. Hard rule:
 * never log or embed the token value; the LABEL is safe (it is not the value).
 */

export interface ScrubOpTokenDeps {
  /** Effective platform (`process.platform` or an injected override). */
  readonly platform: NodeJS.Platform
  /**
   * Delete the keychain op-token entry for a label (darwin only). MUST treat a
   * missing entry as success (the real impl maps `security` exit 44 to
   * resolve). Only called on darwin.
   */
  readonly deleteKeychain: (label: string) => Promise<void>
  /**
   * Delete the luna vault entry `LUNA_OP_TOKEN_<LABEL>`. Returns true if a value
   * was removed, false for an absent name (a clean miss = success). A throw is a
   * real failure (locked-out vault, IO).
   */
  readonly deleteVault: (label: string) => Promise<boolean>
  /**
   * Remove the legacy plaintext token file. MUST treat a missing file as
   * success (the real impl swallows ENOENT).
   */
  readonly deleteLegacyFile: (label: string) => Promise<void>
}

/**
 * Build the op-token scrub from injected effectful deps. The returned function
 * attempts every applicable tier, collects failures, and rejects listing the
 * failed tiers if any failed (never the token value).
 */
export const makeScrubOpToken =
  (deps: ScrubOpTokenDeps) =>
  async (label: string): Promise<void> => {
    const failed: string[] = []

    // keychain (darwin only): no keychain to scrub off darwin, so skipping it
    // there is correct, not a failure.
    if (deps.platform === "darwin") {
      try {
        await deps.deleteKeychain(label)
      } catch {
        failed.push("keychain")
      }
    }

    // luna vault entry: deleteVault returns false for an absent name (success);
    // a throw is a real failure.
    try {
      await deps.deleteVault(label)
    } catch {
      failed.push("luna-vault")
    }

    // legacy plaintext file: a missing file is success (the dep swallows ENOENT).
    try {
      await deps.deleteLegacyFile(label)
    } catch {
      failed.push("file")
    }

    if (failed.length > 0) {
      // Never swallow: a partial scrub could resurrect a "revoked" op token on
      // the next boot. The LABEL is safe to include (it is not the token value).
      throw new Error(
        `failed to remove op token "${label}" from: ${failed.join(", ")}`,
      )
    }
  }
