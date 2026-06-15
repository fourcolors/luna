/**
 * vault-migrate-keychain — operator CLI to move Vault env-secret VALUES from
 * plaintext `~/.luna/.env` into the macOS keychain (`luna.vault.<NAME>`).
 *
 * Three modes, escalating in destructiveness:
 *   --dry-run    read-only; print which names would copy / already exist /
 *                are reserved. Writes nothing. Safe on any platform.
 *   --apply      copy each eligible .env value into the keychain. Requires
 *                --keep-env in this version (copy-only — never deletes .env).
 *                Darwin only.
 *   --prune-env  remove .env lines ONLY for names confirmed readable from the
 *                keychain. The deliberate, separate, post-canary destructive
 *                step. Darwin only.
 *
 * Hard rule: secret VALUES are never printed, logged, or put in error
 * messages — every line of output is env-var NAMES only. The planning core
 * (`planVaultKeychainMigration`, `parseEnvFileNames`) is pure and unit-tested;
 * the IO body is exercised by the operator canary (plan Tasks 8–9).
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
  keychainVaultQueryForEnvName,
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

/**
 * Reserved-name gate — a FROZEN mirror of `isEnvDenied` in
 * `@luna/vault/src/internal.ts` (and its sibling mirrors in register-secret /
 * chat-server). Reserved names are never migrated: they must stay in `.env`
 * and the case-class is reserved to prevent lookalike evasion. Adding a name
 * here without updating the other mirrors is a bug — see internal.ts.
 */
const isReserved = (name: string): boolean => {
  const upper = name.toUpperCase()
  return upper === "UI_WS_TOKEN" || upper.startsWith("LUNA_")
}

/** Extract env-var keys from a `.env` body (names only — values ignored). */
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
 * guarantees apply copies the same value the `.env` read path resolves — so a
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
    if (isReserved(name)) {
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
 * Probe which of `names` already have a `luna.vault.<NAME>` keychain entry.
 * On non-Darwin every read fails closed, so the set is empty (dry-run then
 * shows everything as toCopy — preview only; apply refuses off Darwin).
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

const runDryRun = async (): Promise<number> => {
  const names = readRuntimeEnvNames()
  if (process.platform !== "darwin") {
    log(
      `(non-darwin platform "${process.platform}": keychain probe skipped — all eligible names show as toCopy)`,
    )
  }
  const existing =
    process.platform === "darwin"
      ? await probeExistingKeychainNames(names)
      : new Set<string>()
  printPlan(planVaultKeychainMigration({ envNames: names, existingKeychainNames: existing }))
  return 0
}

const runApply = async (keepEnv: boolean): Promise<number> => {
  if (!keepEnv) {
    log("refusing --apply without --keep-env (copy-only safety in this version)")
    return 2
  }
  if (process.platform !== "darwin") {
    log(`refusing --apply on non-darwin platform "${process.platform}"`)
    return 2
  }
  const entries = parseEnvFileEntries(readEnvBody())
  const names = entries.map((e) => e.name)
  const existing = await probeExistingKeychainNames(names)
  const plan = planVaultKeychainMigration({ envNames: names, existingKeychainNames: existing })
  const copySet = new Set(plan.toCopy)

  let copied = 0
  let failed = 0
  for (const { name, value } of entries) {
    if (!copySet.has(name)) continue
    const exit = await Effect.runPromiseExit(
      writeKeychainSecret(keychainVaultQueryForEnvName(name), value),
    )
    if (Exit.isSuccess(exit)) {
      copied += 1
      log(`copied: ${name}`)
    } else {
      failed += 1
      log(`FAILED: ${name} (keychain write error — value left in .env)`)
    }
  }
  log(`apply complete: ${copied} copied, ${failed} failed, .env left intact`)
  return failed === 0 ? 0 : 1
}

const runPrune = async (): Promise<number> => {
  if (process.platform !== "darwin") {
    log(`refusing --prune-env on non-darwin platform "${process.platform}"`)
    return 2
  }
  const body = readEnvBody()
  const lines = body.split("\n")
  const names = parseEnvFileNames(body)
  // Only prune a name that is (a) not reserved and (b) confirmed readable
  // from the keychain right now — never remove a value we can't re-resolve.
  const readable = await probeExistingKeychainNames(
    names.filter((n) => !isReserved(n)),
  )
  if (readable.size === 0) {
    log("nothing to prune (no .env names are confirmed readable from keychain)")
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
  log(`prune complete: ${readable.size} removed from .env (still in keychain)`)
  return 0
}

export const runCli = async (argv: ReadonlyArray<string>): Promise<number> => {
  const has = (flag: string): boolean => argv.includes(flag)
  if (has("--dry-run")) return runDryRun()
  if (has("--apply")) return runApply(has("--keep-env"))
  if (has("--prune-env")) return runPrune()
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
