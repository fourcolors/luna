/**
 * vault-migrate-keychain - operator CLI to move Vault env-secret VALUES out of
 * plaintext `~/.luna/.env` into a platform-appropriate secure store:
 *   - darwin: the macOS keychain (`luna.vault.<NAME>`), unchanged since W1.
 *   - linux (and any other non-darwin platform): Luna's own encrypted vault
 *     (`~/.luna/vault/{vault.key,secrets.enc}`, see `@luna/core`'s
 *     `LunaVaultFile`). This is the same "target" the `auto` storage mode
 *     WRITES new secrets to on non-darwin - this script has no bearing on
 *     which tier `auto` mode picks for NEW secrets; it only relocates values
 *     that are still sitting in `.env` today.
 *
 * Three modes, escalating in destructiveness, identical flag surface on every
 * platform:
 *   --dry-run    read-only; print which names would copy / already exist /
 *                are reserved, and WHICH target platform this run would use.
 *                Writes nothing. Safe on any platform.
 *   --apply      copy each eligible .env value into the platform target
 *                (keychain on darwin, Luna vault elsewhere). Requires
 *                --keep-env in this version (copy-only - never deletes .env).
 *   --prune-env  remove .env lines ONLY for names confirmed readable back
 *                from the platform target right now. The deliberate,
 *                separate, post-canary destructive step, same readability-
 *                check discipline on every platform.
 *
 * Hard rule: secret VALUES are never printed, logged, or put in error
 * messages - every line of output is env-var NAMES only. The planning core
 * (`planVaultKeychainMigration`, `parseEnvFileNames`) is pure and unit-tested;
 * the IO body is exercised by the operator canary (plan Tasks 8–9) plus an
 * injectable `VaultMigrationTargetOps` seam for the Linux path's tests.
 *
 * Reserved-name gate: delegates to `isReservedSecretName` from `@luna/core` -
 * the single canonical definition (see reserved-names.ts) - rather than
 * keeping a local mirror. Previously this file carried its own frozen
 * `isReserved` copy; that mirror is now consolidated into the shared export.
 */
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs"
import { dirname } from "node:path"
import { Effect, Exit } from "effect"
import {
  isReservedSecretName,
  keychainVaultQueryForEnvName,
  LunaVaultFile,
  readKeychainToken,
  writeKeychainSecret,
} from "@luna/core"
import { resolveRuntimePaths } from "./runtime-paths.js"

export interface VaultKeychainMigrationPlanInput {
  readonly envNames: ReadonlyArray<string>
  readonly existingKeychainNames: ReadonlySet<string>
}

export interface VaultKeychainMigrationPlan {
  readonly toCopy: ReadonlyArray<string>
  readonly alreadyCopied: ReadonlyArray<string>
  readonly skippedReserved: ReadonlyArray<string>
}

/** Extract env-var keys from a `.env` body (names only - values ignored). */
export const parseEnvFileNames = (body: string): string[] => {
  const names: string[] = []
  for (const line of body.split("\n")) {
    const t = line.trim()
    if (t === "" || t.startsWith("#")) continue
    const eq = t.indexOf("=")
    if (eq === -1) continue
    const key = t.slice(0, eq).trim()
    if (key) names.push(key)
  }
  return names
}

/**
 * Parse a `.env` body into name→value entries for the apply path (values must
 * never be logged). Mirrors the BOOT LOADER's value semantics exactly
 * (chat-server.ts): trimmed line, split on first `=`, value `.trim()`-ed on
 * both ends, and FIRST occurrence wins on a duplicate key. Matching the loader
 * guarantees apply copies the same value the `.env` read path resolves - so a
 * later prune can never orphan a drifted value.
 */
export const parseEnvFileEntries = (
  body: string,
): ReadonlyArray<{ readonly name: string; readonly value: string }> => {
  const out: Array<{ name: string; value: string }> = []
  const seen = new Set<string>()
  for (const line of body.split("\n")) {
    const t = line.trim()
    if (t === "" || t.startsWith("#")) continue
    const eq = t.indexOf("=")
    if (eq === -1) continue
    const name = t.slice(0, eq).trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push({ name, value: t.slice(eq + 1).trim() })
  }
  return out
}

export const planVaultKeychainMigration = (
  input: VaultKeychainMigrationPlanInput,
): VaultKeychainMigrationPlan => {
  const toCopy: string[] = []
  const alreadyCopied: string[] = []
  const skippedReserved: string[] = []

  for (const name of input.envNames) {
    if (isReservedSecretName(name)) {
      skippedReserved.push(name)
    } else if (input.existingKeychainNames.has(name)) {
      alreadyCopied.push(name)
    } else {
      toCopy.push(name)
    }
  }

  return { toCopy, alreadyCopied, skippedReserved }
}

const envFilePath = (): string => resolveRuntimePaths().envFilePath

const readEnvBody = (): string => {
  try {
    return readFileSync(envFilePath(), "utf8")
  } catch {
    return ""
  }
}

export const readRuntimeEnvNames = (): string[] =>
  parseEnvFileNames(readEnvBody())

/**
 * The migration target this script writes into / reads back from. Exactly
 * one per platform: darwin → keychain (today's behavior, unchanged); every
 * other platform (linux and beyond) → Luna's own encrypted vault. This has NO
 * bearing on which tier `auto` storage mode WRITES new secrets to - it only
 * names where THIS script relocates values that are still in `.env`.
 */
export type MigrationTargetKind = "keychain" | "luna-vault"

/**
 * Injectable seam for the platform target's IO, mirroring the script's
 * existing style (probe-then-write, names only in every log line). Tests
 * supply an in-memory fake; production uses {@link keychainTargetOps} /
 * {@link lunaVaultTargetOps}.
 */
export interface VaultMigrationTargetOps {
  readonly kind: MigrationTargetKind
  /** Human-readable label for dry-run / log output (never a value). */
  readonly label: string
  /** Which of `names` are already readable back from this target right now. */
  readonly probeExisting: (
    names: ReadonlyArray<string>,
  ) => Promise<Set<string>>
  /** Write one secret value to this target. Returns false on failure. */
  readonly write: (name: string, value: string) => Promise<boolean>
}

/**
 * Probe which of `names` already have a `luna.vault.<NAME>` keychain entry.
 */
const probeExistingKeychainNames = async (
  names: ReadonlyArray<string>,
): Promise<Set<string>> => {
  const found = new Set<string>()
  for (const name of names) {
    const exit = await Effect.runPromiseExit(
      readKeychainToken(keychainVaultQueryForEnvName(name)),
    )
    if (Exit.isSuccess(exit)) found.add(name)
  }
  return found
}

/** Darwin target: the macOS keychain, via the existing `security` helpers. */
export const keychainTargetOps = (): VaultMigrationTargetOps => ({
  kind: "keychain",
  label: "macOS keychain",
  probeExisting: probeExistingKeychainNames,
  write: async (name, value) => {
    const exit = await Effect.runPromiseExit(
      writeKeychainSecret(keychainVaultQueryForEnvName(name), value),
    )
    return Exit.isSuccess(exit)
  },
})

/**
 * Non-darwin target: Luna's own encrypted vault (`~/.luna/vault/*`). A single
 * `LunaVaultFile` instance (rooted at the resolved runtime `lunaHome`) backs
 * both the readability probe and the write path, matching the injectable
 * `_baseDir` idiom `LunaVaultFile` already exposes for tests.
 */
export const lunaVaultTargetOps = (
  vault: LunaVaultFile = new LunaVaultFile({
    _baseDir: resolveRuntimePaths().lunaHome,
  }),
): VaultMigrationTargetOps => ({
  kind: "luna-vault",
  label: "Luna encrypted vault",
  probeExisting: async (names) => {
    // One `listNames()` call answers presence for every candidate at once,
    // instead of a per-name `readSecret` that would also decrypt each VALUE
    // just to test presence. Names-only, and a single decrypt of the store.
    let stored: Set<string>
    try {
      stored = new Set(await vault.listNames())
    } catch {
      // Integrity failure or any other read error: treat the whole store as
      // "not confirmed readable" - never crash a probe, never surface a value.
      return new Set<string>()
    }
    return new Set(names.filter((name) => stored.has(name)))
  },
  write: async (name, value) => {
    try {
      await vault.writeSecret(name, value)
      return true
    } catch {
      return false
    }
  },
})

/** Pick the right target ops for the current platform. */
const defaultTargetOps = (): VaultMigrationTargetOps =>
  process.platform === "darwin" ? keychainTargetOps() : lunaVaultTargetOps()

/** Atomically rewrite `.env` to the given lines (0600), mirroring removeEnvSecret. */
const rewriteEnvFile = (keptLines: ReadonlyArray<string>): void => {
  const path = envFilePath()
  while (keptLines.length > 0 && keptLines[keptLines.length - 1]!.trim() === "") {
    keptLines = keptLines.slice(0, -1)
  }
  const content = keptLines.length > 0 ? `${keptLines.join("\n")}\n` : ""
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, content, { mode: 0o600 })
  renameSync(tmp, path)
  chmodSync(path, 0o600)
}

const log = (msg: string): void => {
  process.stdout.write(`${msg}\n`)
}

const printPlan = (plan: VaultKeychainMigrationPlan): void => {
  log(`toCopy: [${plan.toCopy.join(", ")}]`)
  log(`alreadyCopied: [${plan.alreadyCopied.join(", ")}]`)
  log(`skippedReserved: [${plan.skippedReserved.join(", ")}]`)
}

const runDryRun = async (target: VaultMigrationTargetOps): Promise<number> => {
  const names = readRuntimeEnvNames()
  log(`target: ${target.label}`)
  const existing = await target.probeExisting(names)
  printPlan(planVaultKeychainMigration({ envNames: names, existingKeychainNames: existing }))
  return 0
}

const runApply = async (
  keepEnv: boolean,
  target: VaultMigrationTargetOps,
): Promise<number> => {
  if (!keepEnv) {
    log("refusing --apply without --keep-env (copy-only safety in this version)")
    return 2
  }
  const entries = parseEnvFileEntries(readEnvBody())
  const names = entries.map((e) => e.name)
  const existing = await target.probeExisting(names)
  const plan = planVaultKeychainMigration({ envNames: names, existingKeychainNames: existing })
  const copySet = new Set(plan.toCopy)

  log(`target: ${target.label}`)
  let copied = 0
  let failed = 0
  for (const { name, value } of entries) {
    if (!copySet.has(name)) continue
    const ok = await target.write(name, value)
    if (ok) {
      copied += 1
      log(`copied: ${name}`)
    } else {
      failed += 1
      log(`FAILED: ${name} (${target.label} write error - value left in .env)`)
    }
  }
  log(`apply complete: ${copied} copied, ${failed} failed, .env left intact`)
  return failed === 0 ? 0 : 1
}

const runPrune = async (target: VaultMigrationTargetOps): Promise<number> => {
  const body = readEnvBody()
  const lines = body.split("\n")
  const names = parseEnvFileNames(body)
  // Only prune a name that is (a) not reserved and (b) confirmed readable
  // from the target right now - never remove a value we can't re-resolve.
  log(`target: ${target.label}`)
  const readable = await target.probeExisting(
    names.filter((n) => !isReservedSecretName(n)),
  )
  if (readable.size === 0) {
    log(`nothing to prune (no .env names are confirmed readable from ${target.label})`)
    return 0
  }
  const kept = lines.filter((line) => {
    const t = line.trim()
    if (t === "" || t.startsWith("#")) return true
    const eq = t.indexOf("=")
    if (eq === -1) return true
    const key = t.slice(0, eq).trim()
    return !readable.has(key)
  })
  rewriteEnvFile(kept)
  for (const n of readable) log(`pruned from .env: ${n}`)
  log(`prune complete: ${readable.size} removed from .env (still in ${target.label})`)
  return 0
}

export const runCli = async (
  argv: ReadonlyArray<string>,
  target: VaultMigrationTargetOps = defaultTargetOps(),
): Promise<number> => {
  const has = (flag: string): boolean => argv.includes(flag)
  if (has("--dry-run")) return runDryRun(target)
  if (has("--apply")) return runApply(has("--keep-env"), target)
  if (has("--prune-env")) return runPrune(target)
  log("usage: vault-migrate-keychain.ts [--dry-run | --apply --keep-env | --prune-env]")
  return 2
}

// Run only when invoked directly (`bun .../vault-migrate-keychain.ts`), not
// when imported by the test. Mirrors chat-server's import.meta.main guard.
if (import.meta.main) {
  runCli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e: unknown) => {
      // Never surface a value: only the error class/message of a control-flow
      // failure (keychain helpers already redact; this is belt-and-braces).
      process.stdout.write(`migration error: ${e instanceof Error ? e.message : "unknown"}\n`)
      process.exit(1)
    })
}
