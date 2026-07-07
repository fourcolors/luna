/**
 * secret-chain - APP-SIDE composition policy for the SecretProvider read chain,
 * op-token discovery, and the boot-time vault integrity gate.
 *
 * This module is where the SecretProvider *composition* lives, deliberately
 * OUT of chat-server.ts (05-decide §secret-chain): the package (@luna/core)
 * ships the mechanism (each backend layer, the storage-policy resolver, the
 * luna-vault file), and the app decides how to wire them for a given storage
 * mode + platform. Keeping the wiring here - not in the 3500-line chat-server -
 * makes the composition unit-testable (chat-server.ts has no tsc/unit gate).
 *
 * Three responsibilities:
 *   1. `normalizeVaultStorageModeV2` - the mode source of truth (v2 vocabulary).
 *   2. `buildSecretChainLayer` - assemble the firstOf(...) read chain per mode.
 *   3. `discoverOpTokens` - resolve every op service-account token, now with a
 *      luna-vault tier folded into the precedence.
 *   4. `assertVaultBootIntegrity` - refuse to boot on a locked-out vault.
 *   5. `buildStorageStatus` - project the boot capability snapshot to the wire.
 *
 * Hard rules (mirrors the backends): never log a secret value, never embed one
 * in an error/status. Names, labels, tiers and reasons only.
 *
 * POST-BOOT VAULT CORRUPTION FAILS LOUDLY. Every chain is composed with a
 * `stopOn` guard keyed to the integrity-error prefix (`LUNA_VAULT_INTEGRITY_
 * PREFIX`), so a luna-vault integrity failure at RESOLUTION TIME (the store
 * decayed after the one-shot boot gate ran - disk rot, an out-of-band edit, a
 * mid-run key deletion) fails the whole chain immediately instead of silently
 * resolving stale plaintext from the `.env` tail. The guard is harmless in
 * modes without the vault tier (no provider ever emits that prefix there), so
 * every mode uses one code path.
 */
import {
  EnvSecretProvider,
  KeychainEnvSecretProvider,
  LUNA_VAULT_INTEGRITY_PREFIX,
  LunaVaultIntegrityError,
  LunaVaultSecretProvider,
  RoutedOpSecretProvider,
  secretProviderFirstOf,
  SecretProvider,
  type IntegrityResult,
  type OnePasswordProbe,
  type VaultStorageModeV2,
  type WriteTier,
} from "@luna/core"
import type { ConfigError } from "@luna/core"
import { Context, Effect, Layer, Redacted } from "effect"
import {
  envTokenFor,
  fileTokenFor,
  type OpAccountConfig,
} from "./op-accounts.js"

/**
 * Resolve the operator's `LUNA_VAULT_STORAGE` value to the v2 mode vocabulary.
 *
 * `auto` is the NEW DEFAULT (05-decide §Modes): on darwin it writes to the
 * macOS Keychain, elsewhere to the encrypted Luna vault - the "secure by
 * default, no plaintext unless asked" posture.
 *
 * Rules (05-decide §Normalization v2):
 *   - unset / unknown            → "auto" on EVERY platform.
 *   - "env"                      → "env" (the explicit plaintext escape hatch).
 *   - "keychain-preferred" /
 *     "keychain-only" on darwin  → kept as-is (internal migration states).
 *   - any keychain-* on NON-darwin → "auto" (secure intent honored WITHOUT
 *     shelling out to a `security` binary that does not exist there).
 */
export const normalizeVaultStorageModeV2 = (
  raw: string | undefined,
  platform: NodeJS.Platform,
): VaultStorageModeV2 => {
  if (raw === "env") return "env"
  if (raw === "keychain-preferred" || raw === "keychain-only") {
    // Secure intent, but only darwin has a keychain. Elsewhere fold to auto,
    // which resolves to the Luna vault write tier - same secure outcome, no
    // `security` shell-out.
    return platform === "darwin" ? raw : "auto"
  }
  // unset / unknown / "auto" → auto.
  return "auto"
}

/** One discovered op service-account token, keyed by its registered label. */
export interface DiscoveredOpToken {
  readonly label: string
  readonly token: string
}

/** A single-account 1Password backend layer built inline by the caller. */
export interface RoutedOpAccountLayer {
  readonly label: string
  readonly layer: Layer.Layer<SecretProvider, ConfigError>
}

export interface BuildSecretChainLayerOpts {
  /** Resolved v2 storage mode (see {@link normalizeVaultStorageModeV2}). */
  readonly mode: VaultStorageModeV2
  /** Effective platform (`process.platform` or an injected override). */
  readonly platform: NodeJS.Platform
  /**
   * Per-account 1Password backend layers (already built by the caller), wrapped
   * by RoutedOpSecretProvider so `op://` / `luna-op://` refs never fall through
   * to a later tier. May be empty (no accounts configured).
   */
  readonly opAccounts: ReadonlyArray<RoutedOpAccountLayer>
  /**
   * Standalone luna-vault reader (`LunaVaultFile.readSecret.bind(file)`), used
   * to build the LunaVaultSecretProvider tier. Injected so the layer stays free
   * of node:fs and tests can pass a fake. Only consulted in `auto` mode.
   */
  readonly lunaVaultRead: (name: string) => Promise<string | undefined>
  /**
   * TEST-ONLY: injected keychain read (bypasses the `security` CLI) so the
   * keychain tier can be exercised on any platform. Production omits it and the
   * KeychainEnvSecretProvider shells out to `readKeychainToken` as usual. When
   * provided it is threaded into KeychainEnvSecretProvider.make's `_read`,
   * receiving the keychain query and resolving the value (or failing = a miss).
   */
  readonly _keychainRead?: (
    q: import("@luna/core").KeychainQuery,
  ) => import("effect").Effect.Effect<string, ConfigError>
}

/**
 * Assemble the SecretProvider read chain for a mode + platform.
 *
 * READ chains (05-decide §READ chain by mode) - uniform `env:NAME` grammar:
 *
 *   auto:  firstOf([routedOp, keychainEnv (darwin only), lunaVault, env])
 *   keychain-preferred | keychain-only:
 *          firstOf([routedOp, keychainEnv, env])   ← EXACTLY today's chain
 *   env:   firstOf([routedOp, env])                ← EXACTLY today's chain
 *
 * The two keychain modes and the env mode reproduce the PRE-redesign chain
 * byte-for-byte (pinned by test) so the tiered rollout never changes read
 * behavior for an operator who already picked a mode. `auto` is the only chain
 * that inserts the new lunaVault tier, and it sits BETWEEN keychainEnv and the
 * env tail: keychain (darwin) still wins, the vault covers non-darwin (and any
 * darwin name never mirrored to the keychain), and env remains the final
 * fallback.
 *
 * ── The load-bearing env tail (moved here verbatim from chat-server) ─────────
 * Every chain keeps the `.env` reader as its FINAL fallback. It is load-bearing
 * for names that are NEVER migrated off `.env`: reserved refs (connector OAuth
 * `env:LUNA_CONNECTOR_*`, `UI_WS_TOKEN`) live only in `.env` (the migration
 * planner skips reserved names). Dropping the env reader would strand every
 * connector (review finding).
 *
 * The difference between `keychain-preferred` and `keychain-only` is
 * OPERATIONAL, not in the read chain: `keychain-preferred` is the pre-prune
 * dual-read state where `.env` still holds the migrated values (so
 * `LUNA_VAULT_STORAGE=env` rollback works); `keychain-only` is the post-prune
 * state where the prune step has removed the MIGRATED (non-reserved) values
 * from `.env`, so they resolve from the keychain only - the env tail then
 * serves reserved refs alone and can never resurrect a migrated secret. The
 * same reasoning applies to `auto`'s lunaVault tier on a pruned store.
 */
/**
 * Chain-wide guard: stop resolution the instant a provider fails with an
 * integrity-class error (its message carries {@link LUNA_VAULT_INTEGRITY_
 * PREFIX}). Passed to EVERY mode's firstOf so a corrupt vault never degrades
 * into a fall-through miss that resolves stale plaintext from the env tail. In
 * modes without the vault tier no provider ever emits that prefix, so the guard
 * is a harmless no-op there - one code path for all modes.
 */
const stopOnVaultIntegrity = {
  stopOn: (e: ConfigError) => e.message.startsWith(LUNA_VAULT_INTEGRITY_PREFIX),
} as const

export const buildSecretChainLayer = (
  opts: BuildSecretChainLayerOpts,
): Layer.Layer<SecretProvider, ConfigError> => {
  const routedOpL = RoutedOpSecretProvider.make({
    accounts: opts.opAccounts.map((a) => ({ label: a.label, layer: a.layer })),
  })
  const envProviderL = EnvSecretProvider.Default
  const keychainEnvProviderL = KeychainEnvSecretProvider.make(
    opts._keychainRead === undefined ? {} : { _read: opts._keychainRead },
  )

  if (opts.mode === "env") {
    // env: routedOp → env. EXACTLY today's chain.
    return secretProviderFirstOf([routedOpL, envProviderL], stopOnVaultIntegrity)
  }

  if (opts.mode === "keychain-preferred" || opts.mode === "keychain-only") {
    // keychain modes: routedOp → keychainEnv → env. EXACTLY today's chain.
    return secretProviderFirstOf(
      [routedOpL, keychainEnvProviderL, envProviderL],
      stopOnVaultIntegrity,
    )
  }

  // mode === "auto": routedOp → keychainEnv (darwin only) → lunaVault → env.
  const lunaVaultL = LunaVaultSecretProvider.make({ read: opts.lunaVaultRead })
  const chain: Array<Layer.Layer<SecretProvider, ConfigError>> = [routedOpL]
  if (opts.platform === "darwin") chain.push(keychainEnvProviderL)
  chain.push(lunaVaultL, envProviderL)
  return secretProviderFirstOf(chain, stopOnVaultIntegrity)
}

/**
 * Bound resolver for ad-hoc `env:NAME` lookups outside the main layer graph.
 *
 * Chat-server has a few boot-time seams that live outside the runtime context.
 * They still need the SAME SecretProvider chain as AccountBroker: routed OP,
 * keychain/vault/env by storage mode, and the integrity stopOn guard. Build
 * that chain per call, resolve exactly one `env:` ref, turn a clean full-chain
 * miss into undefined, and let integrity-prefixed ConfigError failures reject
 * so callers fail closed instead of falling through to stale plaintext.
 */
export const makeEnvSecretResolver =
  (opts: BuildSecretChainLayerOpts) =>
  (name: string): Promise<Redacted.Redacted<string> | undefined> => {
    const layer = buildSecretChainLayer(opts)
    const program = Effect.gen(function* () {
      const ctx = yield* Layer.build(layer)
      const provider = Context.get(ctx, SecretProvider)
      const result = yield* Effect.either(provider.get(`env:${name}`))
      if (result._tag === "Right") return result.right
      if (result.left.message.startsWith(LUNA_VAULT_INTEGRITY_PREFIX)) {
        return yield* Effect.fail(result.left)
      }
      return undefined
    })
    return Effect.runPromise(Effect.scoped(program))
  }

/**
 * Reader for a single op token from the Luna vault, keyed by the account's
 * env-var name (`LUNA_OP_TOKEN_<LABEL>`) - the SAME name the operator would set
 * as an env var, so the two tiers are interchangeable and never drift.
 *
 * The boot gate (`assertVaultBootIntegrity`) remains the authority on whether a
 * locked-out vault refuses BOOT. Discovery still must not turn a known-corrupt
 * vault into permission to trust an older plaintext token file for the same
 * label, though: an integrity failure logs loudly and blocks the legacy-file
 * tier for that label. A plain vault MISS is different and keeps falling
 * through for backward compatibility.
 */
type VaultOpTokenResult =
  | { readonly _tag: "hit"; readonly token: string }
  | { readonly _tag: "miss" }
  | { readonly _tag: "integrity-failure" }

const vaultOpTokenFor = async (
  acct: OpAccountConfig,
  vaultRead: (name: string) => Promise<string | undefined>,
): Promise<VaultOpTokenResult> => {
  try {
    const value = await vaultRead(acct.tokenEnvVar)
    if (value === undefined) return { _tag: "miss" }
    const trimmed = value.trim()
    return trimmed.length > 0
      ? { _tag: "hit", token: trimmed }
      : { _tag: "miss" }
  } catch (e) {
    if (e instanceof LunaVaultIntegrityError) {
      console.error(
        `luna vault integrity failure while discovering op token for label "${acct.label}" (${e.reason}): ${e.message}; skipping legacy file fallback for this label`,
      )
      return { _tag: "integrity-failure" }
    }
    return { _tag: "miss" }
  }
}

export interface DiscoverOpTokensOpts {
  readonly accounts: ReadonlyArray<OpAccountConfig>
  /**
   * Reads a keychain token (darwin only). Resolves to the token or undefined on
   * a miss / non-darwin. In production this wraps `readKeychainToken`.
   */
  readonly keychainRead: (acct: OpAccountConfig) => Promise<string | undefined>
  /** Standalone luna-vault reader (`LunaVaultFile.readSecret.bind(file)`). */
  readonly vaultRead: (name: string) => Promise<string | undefined>
  /** Injected `process.env` (defaults to the real one). */
  readonly env?: Record<string, string | undefined>
  /** Injected file reader (defaults to `readFileSync`). */
  readonly readFile?: (path: string) => string
}

/**
 * Resolve every op service-account token we can find, in precedence order:
 *
 *   keychain (darwin) → `LUNA_OP_TOKEN_<LABEL>` env var → luna vault entry
 *   named `LUNA_OP_TOKEN_<LABEL>` → legacy file `~/.luna/op-tokens/<label>`.
 *
 * Precedence rationale (05-decide §secret-chain):
 *   - keychain/env are OPERATOR-PROVISIONED and beat anything runtime-written.
 *   - the vault entry beats the legacy plaintext file (vault is the new secure
 *     runtime store; the file stays READABLE FOREVER for backward compat but is
 *     never the winner when a vault copy exists).
 *   - the legacy file is LAST so a runtime-set token never shadows an
 *     operator-provisioned keychain/env token.
 *   - a vault INTEGRITY failure is not a miss: it is logged with label/reason
 *     and skips the legacy-file tier for that label, so discovery never
 *     fail-opens from a known-corrupt vault into an older plaintext token.
 *
 * Missing on all four → the account is skipped (non-fatal): the SecretProvider
 * chain simply has no op backend for that label.
 *
 * Moved here from chat-server (05-decide §secret-chain: composition out of the
 * server) and extended with the vault tier. `keychainRead`/`vaultRead`/`env`/
 * `readFile` are all injected so the precedence matrix is unit-tested without a
 * keychain, a vault file, or disk.
 */
export const discoverOpTokens = async (
  opts: DiscoverOpTokensOpts,
): Promise<ReadonlyArray<DiscoveredOpToken>> => {
  const found: Array<DiscoveredOpToken> = []
  for (const acct of opts.accounts) {
    const keychain = await opts.keychainRead(acct)
    if (keychain !== undefined) {
      found.push({ label: acct.label, token: keychain })
      continue
    }

    const env = envTokenFor(acct, opts.env)
    if (env !== undefined) {
      found.push({ label: acct.label, token: env })
      continue
    }

    const vault = await vaultOpTokenFor(acct, opts.vaultRead)
    if (vault._tag === "hit") {
      found.push({ label: acct.label, token: vault.token })
      continue
    }
    if (vault._tag === "integrity-failure") continue

    const file = fileTokenFor(acct, opts.readFile)
    if (file !== undefined) found.push({ label: acct.label, token: file })
  }
  return found
}

/**
 * Boot-time vault integrity gate. Runs `checkIntegrity()` once at boot BEFORE
 * any layer graph is built. Semantics (05-decide §secret-chain):
 *
 *   - missing / empty store            → fine, return (a fresh install).
 *   - store present + decrypts         → fine, return.
 *   - store present but key missing /
 *     wrong / tampered ({ok:false})    → depends on MODE (see below).
 *
 * MODE-GATED ENFORCEMENT. The gate only DENIES boot in `auto` mode - the only
 * mode whose read chain actually consults the luna-vault tier. An orphaned or
 * corrupt vault must NOT deny boot to an operator whose mode never reads it
 * (e.g. `env` or a darwin `keychain-*` operator with a stale leftover vault
 * dir): that would be a self-inflicted outage over a store they don't use. In
 * any non-auto mode the gate instead logs a LOUD warning - stating the reason
 * and that switching to `auto` will refuse boot until the vault is fixed - and
 * CONTINUES.
 *
 *   - auto + {ok:false}     → log the restore instruction and `exit(1)`.
 *   - non-auto + {ok:false} → log a loud warning and return (continue boot).
 *
 * In `auto`, a locked-out vault must NOT boot silently and treat every vaulted
 * secret as "not set" (which would fall through to plaintext or leave the
 * operator's secrets invisible). Failing loud with a restore instruction is the
 * safe outcome. `exit` is injectable so the gate is unit-testable; production
 * passes `process.exit`.
 */
export const assertVaultBootIntegrity = async (
  vaultFile: { checkIntegrity: () => Promise<IntegrityResult> },
  mode: VaultStorageModeV2,
  log: (msg: string) => void,
  exit: (code: number) => never = process.exit,
): Promise<void> => {
  let result: IntegrityResult
  try {
    result = await vaultFile.checkIntegrity()
  } catch {
    // checkIntegrity is designed never to throw, but be defensive: an
    // unexpected error here is itself an integrity problem.
    if (mode === "auto") {
      log(
        "luna vault integrity check errored unexpectedly - refusing to boot; see docs",
      )
      exit(1)
      return
    }
    log(
      "luna vault integrity check errored unexpectedly, but this mode does not read the vault tier - continuing; switch to auto only after fixing the vault; see docs",
    )
    return
  }
  if (result.ok) return
  if (mode === "auto") {
    log(
      `luna vault integrity failure (${result.reason}): vault.key missing or unreadable but secrets.enc present - restore the key or delete both; see docs`,
    )
    exit(1)
    return
  }
  // Non-auto mode: the vault tier is NOT in this mode's read chain, so a broken
  // vault is not fatal here. Warn loudly and continue - switching to auto will
  // refuse boot until the vault is fixed.
  log(
    `luna vault integrity failure (${result.reason}), but mode "${mode}" does not read the vault tier - continuing boot; restore vault.key or delete both files, and note that switching to auto will refuse boot until this is fixed; see docs`,
  )
}

/** Boot capability snapshot handed to {@link buildStorageStatus}. */
export interface StorageStatusProbe {
  readonly onePassword: OnePasswordProbe
  readonly osKeychain: boolean
}

/** The wire `vault-list.storage` object (mirror of the wire shape). */
export interface StorageStatusWire {
  readonly mode: string
  readonly writeTier: string
  readonly onePassword: OnePasswordProbe
  readonly osKeychain: boolean
  readonly lunaVault: true
  readonly envResidue: number
}

export interface BuildStorageStatusOpts {
  readonly mode: VaultStorageModeV2
  readonly writeTier: WriteTier
  readonly probe: StorageStatusProbe
  /** Count of NON-reserved names present in `.env` (names only, never values). */
  readonly envResidue: number
}

/**
 * Project the boot capability snapshot to the wire `storage` object the
 * vault-list frame carries. Pure and value-free: `envResidue` is a COUNT (the
 * caller parses `.env` names and filters reserved ones); no name or value is
 * ever included. `lunaVault` is always true - the encrypted Luna vault tier is
 * always available as a write/read target on every platform.
 */
export const buildStorageStatus = (
  opts: BuildStorageStatusOpts,
): StorageStatusWire => ({
  mode: opts.mode,
  writeTier: opts.writeTier,
  onePassword: opts.probe.onePassword,
  osKeychain: opts.probe.osKeychain,
  lunaVault: true,
  envResidue: opts.envResidue,
})
