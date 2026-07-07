/**
 * luna-vault-file - Luna's own encrypted-at-rest secret store, used when
 * neither 1Password nor an OS keychain is available (notably Linux). It is the
 * "else Luna's own vault keeps access safe" tier of the storage goal.
 *
 * FRAMEWORK-FREE ON PURPOSE. This module imports ONLY node:fs, node:crypto and
 * node:path - no Effect. Two reasons: (1) it is read at boot as a STANDALONE
 * file read, outside the SecretProvider layer graph, so it must not require an
 * Effect runtime; (2) the crypto/locking logic is easier to reason about and
 * test as plain async code. The Effect-facing wrapper is luna-vault-backend.ts.
 *
 * ── Threat model (what this DOES and does NOT protect against) ──────────────
 * PROTECTS against at-rest exposure of secret VALUES:
 *   - a stolen / synced / backed-up copy of secrets.enc (Time Machine, cloud
 *     sync, a leaked disk image) is ciphertext-only and useless without the
 *     key file.
 *   - another OS user reading the files: the key (0600) and dir (0700) are
 *     owner-only, so a different unprivileged user on the same host cannot read
 *     the key and therefore cannot decrypt.
 * Does NOT protect against a same-user adversary or root: the decrypting
 * process runs as the owner and can read both key and ciphertext, so malware
 * running as that user, or root, can trivially recover plaintext. This is
 * envelope-at-rest protection, not a secrets HSM.
 * KEY + CIPHERTEXT TRAVEL TOGETHER: moving Luna to a new machine requires
 * copying BOTH vault.key and secrets.enc. Backups that exclude the key (or
 * exclude ~/.luna/.env, which is why tmutil exclusion is narrowed to the .env
 * file only) render the store unrecoverable by design.
 *
 * ── Layout ─────────────────────────────────────────────────────────────────
 *   <baseDir>/vault/vault.key   base64 of 32 random bytes, 0600, dir 0700.
 *                               Lazily created on first write.
 *   <baseDir>/vault/vault.key.new  crash-safe staging slot during rotateKey.
 *   <baseDir>/vault/secrets.enc Envelope v1 JSON (see below).
 *   <baseDir>/vault/.lock       cross-process advisory lock (pid+timestamp).
 *
 * ── Envelope v1 ────────────────────────────────────────────────────────────
 *   { v: 1, alg: "aes-256-gcm", iv: <b64>, tag: <b64>, data: <b64> }
 * The plaintext is JSON `{ secrets: { [NAME]: value } }`. AAD is the fixed
 * literal Buffer "luna-vault:v1". A FRESH 12-byte CSPRNG IV is generated on
 * EVERY write (never reused), so the same plaintext written twice yields a
 * different iv AND ciphertext. On read, GCM's auth tag is verified by
 * decipher.final() BEFORE any plaintext is parsed or returned - a tampered or
 * truncated ciphertext throws, never yields a partial value.
 *
 * ── Clean miss vs integrity failure (never conflated) ──────────────────────
 *   - No store file at all, OR store present but the name is simply absent
 *     → a CLEAN MISS. readSecret returns undefined; listNames returns [].
 *   - Store present but the key is missing / wrong / the JSON is corrupt / the
 *     auth tag fails → an INTEGRITY FAILURE. Throws LunaVaultIntegrityError so
 *     the caller can refuse to boot loudly instead of silently treating a
 *     locked-out vault as "secret not set".
 *
 * ── Concurrency ────────────────────────────────────────────────────────────
 * Every mutation goes through a read-modify-write serialized two ways:
 *   - IN-PROCESS: a simple promise-chain mutex so concurrent writeSecret calls
 *     on the same instance never interleave (last writer would otherwise clobber
 *     the other's addition).
 *   - CROSS-PROCESS: an O_EXCL lockfile (.lock) holding pid+timestamp. A lock
 *     older than STALE_LOCK_MS is taken over (a crashed writer left it behind);
 *     acquisition retries for ~LOCK_ACQUIRE_TIMEOUT_MS before giving up. The
 *     lock is always released in a finally.
 *
 * ── Atomicity ──────────────────────────────────────────────────────────────
 * Writes go to a tmp file (0600) in the same directory, are fsync'd, then
 * renamed over the target (atomic on the same filesystem). A crash mid-write
 * leaves the previous store intact; a successful write leaves no tmp file.
 *
 * ── Hard rules ─────────────────────────────────────────────────────────────
 * Never log a secret value; never embed a value in an error message or an
 * error's fields. Errors carry names and reasons only.
 */
import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

/** Envelope algorithm + AAD are fixed constants, versioned by `v`. */
const ENVELOPE_VERSION = 1 as const
const ALGORITHM = "aes-256-gcm" as const
const AAD = Buffer.from("luna-vault:v1")
const IV_BYTES = 12
const KEY_BYTES = 32
const AUTH_TAG_BYTES = 16

/** Lock tuning. */
const STALE_LOCK_MS = 30_000
const LOCK_ACQUIRE_TIMEOUT_MS = 5_000
const LOCK_RETRY_INTERVAL_MS = 50

/** File modes. Owner-only for both the key and the dir. */
const DIR_MODE = 0o700
const FILE_MODE = 0o600

/**
 * Thrown when the store is PRESENT but cannot be decrypted: missing/invalid
 * key, corrupt JSON, or a failed auth tag. NEVER thrown for a clean miss (no
 * store, or name absent). Carries only a machine-readable `reason` and a
 * human message - never a secret value.
 */
export class LunaVaultIntegrityError extends Error {
  override readonly name = "LunaVaultIntegrityError"
  readonly reason: LunaVaultIntegrityReason
  constructor(reason: LunaVaultIntegrityReason, message: string) {
    super(message)
    this.reason = reason
  }
}

/**
 * Discriminates the flavours of integrity failure for callers + status.
 *
 *   - key-missing     no key file at all, but a store is present.
 *   - key-invalid     a key file exists but is not a usable 32-byte key.
 *   - corrupt-json    the ENVELOPE JSON on disk is not parseable.
 *   - bad-envelope    the envelope parsed but is the wrong shape/version, or the
 *                     store file itself was unreadable.
 *   - auth-failed     the GCM auth tag did not verify - a wrong key or a
 *                     tampered/truncated ciphertext (a CRYPTO failure).
 *   - corrupt         the ciphertext decrypted and authenticated fine, but the
 *                     recovered PLAINTEXT is not the expected `{secrets:{...}}`
 *                     JSON. Distinct from auth-failed: the key is correct and
 *                     the tag verified, so this is data corruption at the
 *                     plaintext layer, not an authentication problem.
 */
export type LunaVaultIntegrityReason =
  | "key-missing"
  | "key-invalid"
  | "corrupt-json"
  | "auth-failed"
  | "bad-envelope"
  | "corrupt"

/** Envelope-v1 JSON shape as it lands on disk. */
interface EnvelopeV1 {
  readonly v: 1
  readonly alg: "aes-256-gcm"
  readonly iv: string
  readonly tag: string
  readonly data: string
}

/** Decrypted plaintext shape. */
interface SecretsPlaintext {
  readonly secrets: Record<string, string>
}

/**
 * Outcome of a single-key decrypt attempt. `auth` = the GCM tag did not verify
 * (wrong key / tampered ciphertext); `corrupt` = the tag verified but the
 * recovered plaintext is not the expected shape. The two are kept distinct so
 * the caller can surface a precise integrity reason (auth-failed vs corrupt)
 * rather than conflating a crypto failure with plaintext data corruption.
 */
type DecryptOutcome =
  | { readonly ok: true; readonly value: SecretsPlaintext }
  | { readonly ok: false; readonly kind: "auth" | "corrupt" }

/** Result of {@link LunaVaultFile.checkIntegrity}. */
export type IntegrityResult =
  | { readonly ok: true; readonly count: number }
  | { readonly ok: false; readonly reason: LunaVaultIntegrityReason }

/**
 * Injectable internals - mirrors the KeychainEnvInternals idiom. Only the base
 * directory is overridable; everything else (fs, crypto, clock) stays real so
 * tests exercise the actual crypto and filesystem against a temp dir.
 */
export interface LunaVaultFileInternals {
  /**
   * Base directory whose `vault/` subdir holds the store. Defaults to
   * `~/.luna`. Tests point this at a fresh temp dir.
   */
  readonly _baseDir?: string
}

// ── small pure helpers ───────────────────────────────────────────────────────

const isEnoent = (e: unknown): boolean =>
  typeof e === "object" &&
  e !== null &&
  (e as NodeJS.ErrnoException).code === "ENOENT"

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * LunaVaultFile - one instance manages one store directory. All mutating
 * methods serialize through the in-process mutex; readers take a fresh
 * consistent snapshot each call (no cross-call caching, so an external writer's
 * changes are picked up between calls).
 */
export class LunaVaultFile {
  private readonly vaultDir: string
  private readonly keyPath: string
  private readonly keyNewPath: string
  private readonly storePath: string
  private readonly lockPath: string

  /** In-process mutex: every mutation appends to this promise chain. */
  private mutex: Promise<unknown> = Promise.resolve()

  constructor(internals: LunaVaultFileInternals = {}) {
    const baseDir = internals._baseDir ?? path.join(os.homedir(), ".luna")
    this.vaultDir = path.join(baseDir, "vault")
    this.keyPath = path.join(this.vaultDir, "vault.key")
    this.keyNewPath = path.join(this.vaultDir, "vault.key.new")
    this.storePath = path.join(this.vaultDir, "secrets.enc")
    this.lockPath = path.join(this.vaultDir, ".lock")
  }

  // ── public read API ─────────────────────────────────────────────────────

  /**
   * Resolve a single secret by name.
   *   - store missing OR name absent → undefined (clean miss).
   *   - store present but undecryptable / key missing / corrupt → throws
   *     LunaVaultIntegrityError.
   */
  async readSecret(name: string): Promise<string | undefined> {
    const secrets = await this.loadSecretsOrMiss()
    if (secrets === undefined) return undefined
    const value = secrets[name]
    return value === undefined ? undefined : value
  }

  /**
   * List every stored name.
   *   - store missing → [] (clean miss).
   *   - store present but undecryptable → throws LunaVaultIntegrityError.
   */
  async listNames(): Promise<string[]> {
    const secrets = await this.loadSecretsOrMiss()
    if (secrets === undefined) return []
    return Object.keys(secrets)
  }

  /**
   * Non-throwing health probe.
   *   - store missing or empty       → { ok: true, count: 0 }
   *   - store decrypts               → { ok: true, count: N }
   *   - key missing / tag failure / corrupt → { ok: false, reason }
   *
   * ROTATE-CRASH RECOVERY: checkIntegrity decrypts through the SAME
   * `decryptStore` path as `readSecret`, so it inherits the interrupted-rotate
   * recovery - if only `vault.key.new` can decrypt the store (a crash between
   * the store re-encrypt and the key promote), the probe reports `ok` (and
   * promotes the staged key) instead of a false `key`/`auth` failure. A crash
   * mid-rotate must never brick the boot gate.
   */
  async checkIntegrity(): Promise<IntegrityResult> {
    const rawStore = await this.readStoreRaw()
    if (rawStore === undefined) return { ok: true, count: 0 }
    if (rawStore.trim().length === 0) return { ok: true, count: 0 }
    try {
      const secrets = await this.decryptStore(rawStore)
      return { ok: true, count: Object.keys(secrets).length }
    } catch (e) {
      if (e instanceof LunaVaultIntegrityError) {
        return { ok: false, reason: e.reason }
      }
      // Any unexpected error is still an integrity failure, not a crash.
      return { ok: false, reason: "bad-envelope" }
    }
  }

  // ── public mutation API (all serialized) ────────────────────────────────

  /** Create-or-update a single secret. Serialized + cross-process locked. */
  async writeSecret(name: string, value: string): Promise<void> {
    await this.withMutex(() =>
      this.withLock(async () => {
        const secrets = (await this.loadSecretsForWrite()) ?? {}
        secrets[name] = value
        await this.persistSecrets(secrets)
      }),
    )
  }

  /**
   * Delete a secret. Returns true if a value was removed, false if the name was
   * absent (a successful no-op). NEVER throws for absence.
   */
  async deleteSecret(name: string): Promise<boolean> {
    return this.withMutex(() =>
      this.withLock(async () => {
        const secrets = await this.loadSecretsForWrite()
        if (secrets === undefined || !(name in secrets)) return false
        delete secrets[name]
        await this.persistSecrets(secrets)
        return true
      }),
    )
  }

  /**
   * Rotate the encryption key. Crash-safe ordering:
   *   1. write the NEW key to vault.key.new (staging).
   *   2. re-encrypt the store under the new key and atomically rename it over
   *      secrets.enc.
   *   3. promote vault.key.new over vault.key.
   * If a crash happens between (2) and (3) the store is already ciphertext
   * under the new key while vault.key still holds the OLD key; the read path
   * recovers by trying vault.key.new when the primary key fails to decrypt,
   * then promoting it. If there is no store yet, rotate simply installs a fresh
   * primary key.
   */
  async rotateKey(): Promise<void> {
    await this.withMutex(() =>
      this.withLock(async () => {
        await this.ensureDir()
        const secrets = await this.loadSecretsForWrite()
        const newKey = crypto.randomBytes(KEY_BYTES)

        if (secrets === undefined) {
          // No store to re-encrypt: just install/replace the primary key.
          await this.atomicWriteFile(
            this.keyPath,
            newKey.toString("base64"),
          )
          await this.removeIfPresent(this.keyNewPath)
          return
        }

        // 1. stage new key.
        await this.atomicWriteFile(this.keyNewPath, newKey.toString("base64"))
        // 2. re-encrypt store under new key, atomic rename over secrets.enc.
        const envelope = this.encrypt(newKey, { secrets })
        await this.atomicWriteFile(
          this.storePath,
          JSON.stringify(envelope),
        )
        // 3. promote new key over primary.
        await this.promoteNewKey()
      }),
    )
  }

  // ── load helpers ────────────────────────────────────────────────────────

  /**
   * Load the decrypted secrets map, or undefined for a CLEAN MISS (no store /
   * empty store). Throws LunaVaultIntegrityError for a present-but-broken store.
   * Recovers a partial rotateKey via vault.key.new.
   */
  private async loadSecretsOrMiss(): Promise<
    Record<string, string> | undefined
  > {
    const rawStore = await this.readStoreRaw()
    if (rawStore === undefined) return undefined
    if (rawStore.trim().length === 0) return undefined
    return this.decryptStore(rawStore)
  }

  /**
   * Same as {@link loadSecretsOrMiss} but returns a mutable copy suitable for a
   * read-modify-write. Returns undefined only when there is no store at all.
   */
  private async loadSecretsForWrite(): Promise<
    Record<string, string> | undefined
  > {
    const secrets = await this.loadSecretsOrMiss()
    if (secrets === undefined) return undefined
    return { ...secrets }
  }

  /** Read the raw store file, or undefined if it does not exist. */
  private async readStoreRaw(): Promise<string | undefined> {
    try {
      return await fsp.readFile(this.storePath, "utf8")
    } catch (e) {
      if (isEnoent(e)) return undefined
      throw new LunaVaultIntegrityError(
        "bad-envelope",
        `luna vault store unreadable: ${(e as Error).message}`,
      )
    }
  }

  /**
   * Decrypt a raw store string into the secrets map. Tries the primary key
   * first; if that fails AND a staged vault.key.new exists (interrupted
   * rotateKey), tries the new key and, on success, promotes it. Any terminal
   * failure is a LunaVaultIntegrityError.
   */
  private async decryptStore(
    rawStore: string,
  ): Promise<Record<string, string>> {
    const envelope = this.parseEnvelope(rawStore)

    // Track whether ANY key authenticated the ciphertext. A key that verifies
    // the GCM tag but yields non-JSON plaintext is a "corrupt" outcome, NOT an
    // auth failure - the key is correct, the data is not.
    let sawCorruptPlaintext = false

    const primaryKey = await this.readKey(this.keyPath)
    if (primaryKey !== undefined) {
      const viaPrimary = this.tryDecrypt(primaryKey, envelope)
      if (viaPrimary.ok) return viaPrimary.value.secrets
      if (viaPrimary.kind === "corrupt") sawCorruptPlaintext = true
    }

    // Recovery: an interrupted rotateKey may have re-encrypted the store under
    // the staged new key before it was promoted. Try it, and promote on success.
    const newKey = await this.readKey(this.keyNewPath)
    if (newKey !== undefined) {
      const viaNew = this.tryDecrypt(newKey, envelope)
      if (viaNew.ok) {
        await this.promoteNewKey()
        return viaNew.value.secrets
      }
      if (viaNew.kind === "corrupt") sawCorruptPlaintext = true
    }

    // A key authenticated the ciphertext but the decrypted plaintext was not
    // valid `{secrets:{...}}` JSON: post-decryption data corruption, distinct
    // from an auth/tag failure.
    if (sawCorruptPlaintext) {
      throw new LunaVaultIntegrityError(
        "corrupt",
        "luna vault decrypted but its contents are corrupt (plaintext is not valid secrets JSON)",
      )
    }

    // Distinguish "no key at all" from "key present but wrong / tag failed".
    if (primaryKey === undefined && newKey === undefined) {
      throw new LunaVaultIntegrityError(
        "key-missing",
        "luna vault key missing but store present (restore vault.key or delete both files)",
      )
    }
    throw new LunaVaultIntegrityError(
      "auth-failed",
      "luna vault authentication failed (key does not match store, or store tampered)",
    )
  }

  /** Parse + shape-validate the envelope JSON. */
  private parseEnvelope(rawStore: string): EnvelopeV1 {
    let parsed: unknown
    try {
      parsed = JSON.parse(rawStore)
    } catch {
      throw new LunaVaultIntegrityError(
        "corrupt-json",
        "luna vault store is not valid JSON",
      )
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      throw new LunaVaultIntegrityError(
        "bad-envelope",
        "luna vault envelope is not an object",
      )
    }
    const e = parsed as Record<string, unknown>
    if (
      e.v !== ENVELOPE_VERSION ||
      e.alg !== ALGORITHM ||
      typeof e.iv !== "string" ||
      typeof e.tag !== "string" ||
      typeof e.data !== "string"
    ) {
      throw new LunaVaultIntegrityError(
        "bad-envelope",
        "luna vault envelope is malformed or an unsupported version",
      )
    }
    return { v: 1, alg: ALGORITHM, iv: e.iv, tag: e.tag, data: e.data }
  }

  /**
   * Attempt to decrypt one envelope with one key. Returns:
   *   - `{ ok: true, value }` on a full success.
   *   - `{ ok: false, kind: "auth" }` if the GCM tag does not verify (wrong key
   *     / tampered / truncated ciphertext) - a CRYPTO failure.
   *   - `{ ok: false, kind: "corrupt" }` if the tag verified but the recovered
   *     plaintext is not the expected `{secrets:{...}}` JSON - data corruption
   *     AFTER a successful, authenticated decryption.
   * Never throws - the caller decides whether a failure across all keys is
   * terminal and which precise integrity reason to surface.
   */
  private tryDecrypt(key: Buffer, envelope: EnvelopeV1): DecryptOutcome {
    // Phase 1: authenticated decryption. A failure here (bad tag, wrong key,
    // malformed iv/tag lengths) is an AUTH failure - never a corrupt-plaintext.
    let plaintext: string
    try {
      const iv = Buffer.from(envelope.iv, "base64")
      const tag = Buffer.from(envelope.tag, "base64")
      const data = Buffer.from(envelope.data, "base64")
      if (iv.length !== IV_BYTES || tag.length !== AUTH_TAG_BYTES) {
        return { ok: false, kind: "auth" }
      }
      const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
      decipher.setAAD(AAD)
      decipher.setAuthTag(tag)
      // final() throws if the auth tag does not verify - the tag is checked
      // BEFORE we trust `plaintext`.
      plaintext = Buffer.concat([
        decipher.update(data),
        decipher.final(),
      ]).toString("utf8")
    } catch {
      return { ok: false, kind: "auth" }
    }

    // Phase 2: the ciphertext authenticated, so the KEY is correct. Any failure
    // parsing/validating the recovered plaintext is data corruption, not auth.
    try {
      const parsed = JSON.parse(plaintext) as unknown
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        typeof (parsed as { secrets?: unknown }).secrets !== "object" ||
        (parsed as { secrets?: unknown }).secrets === null ||
        Array.isArray((parsed as { secrets?: unknown }).secrets)
      ) {
        return { ok: false, kind: "corrupt" }
      }
      // Coerce to string map; drop any non-string values defensively.
      const rawSecrets = (parsed as { secrets: Record<string, unknown> })
        .secrets
      const secrets: Record<string, string> = {}
      for (const [k, v] of Object.entries(rawSecrets)) {
        if (typeof v === "string") secrets[k] = v
      }
      return { ok: true, value: { secrets } }
    } catch {
      return { ok: false, kind: "corrupt" }
    }
  }

  // ── encrypt + persist ─────────────────────────────────────────────────────

  /** Encrypt a plaintext object into an envelope with a FRESH random IV. */
  private encrypt(key: Buffer, plaintext: SecretsPlaintext): EnvelopeV1 {
    const iv = crypto.randomBytes(IV_BYTES)
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
    cipher.setAAD(AAD)
    const data = Buffer.concat([
      cipher.update(Buffer.from(JSON.stringify(plaintext), "utf8")),
      cipher.final(),
    ])
    const tag = cipher.getAuthTag()
    return {
      v: ENVELOPE_VERSION,
      alg: ALGORITHM,
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      data: data.toString("base64"),
    }
  }

  /**
   * Encrypt the given secrets under the current (lazily created) primary key
   * and atomically write the store. Called only from inside the lock.
   */
  private async persistSecrets(
    secrets: Record<string, string>,
  ): Promise<void> {
    await this.ensureDir()
    const key = await this.ensureKey()
    const envelope = this.encrypt(key, { secrets })
    await this.atomicWriteFile(this.storePath, JSON.stringify(envelope))
  }

  // ── key handling ──────────────────────────────────────────────────────────

  /** Read a key file into a 32-byte Buffer, or undefined if absent/invalid. */
  private async readKey(keyPath: string): Promise<Buffer | undefined> {
    let raw: string
    try {
      raw = await fsp.readFile(keyPath, "utf8")
    } catch (e) {
      if (isEnoent(e)) return undefined
      throw e
    }
    try {
      const key = Buffer.from(raw.trim(), "base64")
      if (key.length !== KEY_BYTES) return undefined
      return key
    } catch {
      return undefined
    }
  }

  /**
   * Return the primary key, creating a fresh 32-byte key (0600) on first use.
   * The directory must already exist (ensureDir). Enforces 0600 even if the
   * file predated a stricter umask.
   */
  private async ensureKey(): Promise<Buffer> {
    const existing = await this.readKey(this.keyPath)
    if (existing !== undefined) {
      await this.enforceMode(this.keyPath, FILE_MODE)
      return existing
    }
    const key = crypto.randomBytes(KEY_BYTES)
    await this.atomicWriteFile(this.keyPath, key.toString("base64"))
    return key
  }

  /** Promote vault.key.new over vault.key, then remove the staging slot. */
  private async promoteNewKey(): Promise<void> {
    try {
      await fsp.rename(this.keyNewPath, this.keyPath)
    } catch (e) {
      if (isEnoent(e)) return // already promoted / nothing staged
      throw e
    }
    await this.enforceMode(this.keyPath, FILE_MODE)
  }

  // ── filesystem primitives ─────────────────────────────────────────────────

  /** Create the vault dir 0700 (idempotent) and enforce the mode. */
  private async ensureDir(): Promise<void> {
    await fsp.mkdir(this.vaultDir, { recursive: true, mode: DIR_MODE })
    await this.enforceMode(this.vaultDir, DIR_MODE)
  }

  /**
   * Atomic write: tmp file (0600) in the same dir → fsync → rename over target.
   * The tmp name is unique per call so concurrent processes never collide.
   * On success no tmp file remains; on failure the previous target is intact.
   */
  private async atomicWriteFile(
    targetPath: string,
    contents: string,
  ): Promise<void> {
    const dir = path.dirname(targetPath)
    const tmpPath = path.join(
      dir,
      `.${path.basename(targetPath)}.${process.pid}.${crypto
        .randomBytes(6)
        .toString("hex")}.tmp`,
    )
    let fh: fsp.FileHandle | undefined
    try {
      fh = await fsp.open(tmpPath, "wx", FILE_MODE)
      await fh.writeFile(contents, "utf8")
      await fh.sync()
    } finally {
      await fh?.close()
    }
    try {
      await fsp.rename(tmpPath, targetPath)
    } catch (e) {
      await this.removeIfPresent(tmpPath)
      throw e
    }
    // rename preserves the tmp file's 0600 mode; enforce defensively.
    await this.enforceMode(targetPath, FILE_MODE)
  }

  /** chmod, swallowing ENOENT (best-effort hardening). */
  private async enforceMode(p: string, mode: number): Promise<void> {
    try {
      await fsp.chmod(p, mode)
    } catch (e) {
      if (!isEnoent(e)) throw e
    }
  }

  private async removeIfPresent(p: string): Promise<void> {
    try {
      await fsp.unlink(p)
    } catch (e) {
      if (!isEnoent(e)) throw e
    }
  }

  // ── in-process mutex ──────────────────────────────────────────────────────

  /**
   * Serialize `fn` after every previously-queued mutation. The chain never
   * rejects (a failed op still lets the next op run); the caller still sees the
   * original rejection through the returned promise.
   */
  private withMutex<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutex.then(fn, fn)
    // Keep the chain alive regardless of this op's outcome.
    this.mutex = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  // ── cross-process lockfile ────────────────────────────────────────────────

  /**
   * Acquire the cross-process lock, run `fn`, release in finally. Retries for
   * ~LOCK_ACQUIRE_TIMEOUT_MS; a lock older than STALE_LOCK_MS is taken over
   * (its holder is assumed crashed).
   */
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.ensureDir()
    await this.acquireLock()
    try {
      return await fn()
    } finally {
      await this.releaseLock()
    }
  }

  private async acquireLock(): Promise<void> {
    const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS
    for (;;) {
      try {
        const fh = await fsp.open(this.lockPath, "wx", FILE_MODE)
        try {
          await fh.writeFile(
            JSON.stringify({ pid: process.pid, ts: Date.now() }),
            "utf8",
          )
        } finally {
          await fh.close()
        }
        return
      } catch (e) {
        if (!isLockExists(e)) throw e
        // Lock held. Take over if stale, else wait and retry.
        if (await this.tryTakeOverStaleLock()) continue
        if (Date.now() >= deadline) {
          throw new Error(
            "luna vault lock busy: another process holds the vault lock",
          )
        }
        await sleep(LOCK_RETRY_INTERVAL_MS)
      }
    }
  }

  /**
   * If the current lock is older than STALE_LOCK_MS (or unparseable/empty),
   * remove it so the next acquire attempt can take it. Returns true if it
   * removed a stale lock.
   */
  private async tryTakeOverStaleLock(): Promise<boolean> {
    let raw: string
    let stat: fs.Stats
    try {
      raw = await fsp.readFile(this.lockPath, "utf8")
      stat = await fsp.stat(this.lockPath)
    } catch (e) {
      // Lock vanished between EEXIST and read - let the caller retry.
      return isEnoent(e)
    }
    let ts: number | undefined
    try {
      const parsed = JSON.parse(raw) as { ts?: unknown }
      if (typeof parsed.ts === "number") ts = parsed.ts
    } catch {
      ts = undefined
    }
    // Fall back to mtime if the payload lacks a usable timestamp.
    const age = Date.now() - (ts ?? stat.mtimeMs)
    if (age > STALE_LOCK_MS) {
      await this.removeIfPresent(this.lockPath)
      return true
    }
    return false
  }

  private async releaseLock(): Promise<void> {
    await this.removeIfPresent(this.lockPath)
  }
}

/** A lockfile O_EXCL collision surfaces as EEXIST. */
const isLockExists = (e: unknown): boolean =>
  typeof e === "object" &&
  e !== null &&
  (e as NodeJS.ErrnoException).code === "EEXIST"
