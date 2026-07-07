/**
 * luna-vault-file tests - exercise the REAL crypto + filesystem against a fresh
 * per-test temp dir (only the base dir is injected). Covers: envelope roundtrip,
 * IV/ciphertext freshness, tamper detection, clean-miss vs integrity failure,
 * key/dir permissions, atomic-write tmp cleanup, concurrent writes, delete
 * semantics, and rotateKey including the interrupted-rotation recovery path.
 */
import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  LunaVaultFile,
  LunaVaultIntegrityError,
} from "./luna-vault-file.js"

let baseDir: string
let vaultDir: string
let keyPath: string
let storePath: string
let lockPath: string

const makeVault = (): LunaVaultFile =>
  new LunaVaultFile({ _baseDir: baseDir })

type LunaVaultFileLockInternals = {
  acquireLock(): Promise<void>
  releaseLock(): Promise<void>
  tryTakeOverStaleLock(): Promise<boolean>
}

const lockInternals = (v: LunaVaultFile): LunaVaultFileLockInternals =>
  v as unknown as LunaVaultFileLockInternals

beforeEach(async () => {
  baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), "luna-vault-test-"))
  vaultDir = path.join(baseDir, "vault")
  keyPath = path.join(vaultDir, "vault.key")
  storePath = path.join(vaultDir, "secrets.enc")
  lockPath = path.join(vaultDir, ".lock")
})

afterEach(async () => {
  await fsp.rm(baseDir, { recursive: true, force: true })
})

describe("envelope roundtrip", () => {
  it("writes then reads a secret back", async () => {
    const v = makeVault()
    await v.writeSecret("OPENAI_API_KEY", "sk-value")
    expect(await v.readSecret("OPENAI_API_KEY")).toBe("sk-value")
  })

  it("persists across instances (fresh instance, same dir)", async () => {
    await makeVault().writeSecret("A", "one")
    await makeVault().writeSecret("B", "two")
    const reader = makeVault()
    expect(await reader.readSecret("A")).toBe("one")
    expect(await reader.readSecret("B")).toBe("two")
    expect((await reader.listNames()).sort()).toEqual(["A", "B"])
  })
})

describe("IV + ciphertext freshness", () => {
  it("same plaintext written twice → different iv AND ciphertext", async () => {
    const v = makeVault()
    await v.writeSecret("K", "same-value")
    const first = JSON.parse(await fsp.readFile(storePath, "utf8")) as {
      iv: string
      data: string
    }
    // Rewrite the SAME value; a fresh IV must be generated.
    await v.writeSecret("K", "same-value")
    const second = JSON.parse(await fsp.readFile(storePath, "utf8")) as {
      iv: string
      data: string
    }
    expect(second.iv).not.toBe(first.iv)
    expect(second.data).not.toBe(first.data)
    // Value still round-trips.
    expect(await v.readSecret("K")).toBe("same-value")
  })
})

describe("tamper detection", () => {
  it("flipping a ciphertext byte → LunaVaultIntegrityError (auth-failed)", async () => {
    const v = makeVault()
    await v.writeSecret("K", "secret")
    const env = JSON.parse(await fsp.readFile(storePath, "utf8")) as {
      v: number
      alg: string
      iv: string
      tag: string
      data: string
    }
    const data = Buffer.from(env.data, "base64")
    data[0] = data[0] ^ 0xff // flip the first byte
    env.data = data.toString("base64")
    await fsp.writeFile(storePath, JSON.stringify(env))

    await expect(makeVault().readSecret("K")).rejects.toBeInstanceOf(
      LunaVaultIntegrityError,
    )
    const check = await makeVault().checkIntegrity()
    expect(check.ok).toBe(false)
    if (!check.ok) expect(check.reason).toBe("auth-failed")
  })
})

describe("clean miss vs integrity failure", () => {
  it("no store → readSecret undefined, listNames [], checkIntegrity ok:0", async () => {
    const v = makeVault()
    expect(await v.readSecret("ANY")).toBeUndefined()
    expect(await v.listNames()).toEqual([])
    expect(await v.checkIntegrity()).toEqual({ ok: true, count: 0 })
  })

  it("present empty store → IntegrityError + checkIntegrity ok:false", async () => {
    await fsp.mkdir(vaultDir, { recursive: true })
    await fsp.writeFile(storePath, "")

    const err = await makeVault()
      .readSecret("ANY")
      .then(
        () => {
          throw new Error("expected an integrity error")
        },
        (e: unknown) => e,
      )
    expect(err).toBeInstanceOf(LunaVaultIntegrityError)
    expect((err as LunaVaultIntegrityError).reason).toBe("bad-envelope")

    const check = await makeVault().checkIntegrity()
    expect(check.ok).toBe(false)
    if (!check.ok) expect(check.reason).toBe("bad-envelope")
  })

  it("present whitespace-only store → IntegrityError + checkIntegrity ok:false", async () => {
    await fsp.mkdir(vaultDir, { recursive: true })
    await fsp.writeFile(storePath, "   \n")

    const err = await makeVault()
      .readSecret("ANY")
      .then(
        () => {
          throw new Error("expected an integrity error")
        },
        (e: unknown) => e,
      )
    expect(err).toBeInstanceOf(LunaVaultIntegrityError)
    expect((err as LunaVaultIntegrityError).reason).toBe("bad-envelope")

    const check = await makeVault().checkIntegrity()
    expect(check.ok).toBe(false)
    if (!check.ok) expect(check.reason).toBe("bad-envelope")
  })

  it("store present but name absent → undefined (not an error)", async () => {
    const v = makeVault()
    await v.writeSecret("PRESENT", "x")
    expect(await v.readSecret("MISSING")).toBeUndefined()
  })

  it("key missing with a non-empty store → IntegrityError + checkIntegrity ok:false", async () => {
    const v = makeVault()
    await v.writeSecret("K", "secret")
    // Remove ONLY the key, leaving the ciphertext store behind.
    await fsp.unlink(keyPath)

    await expect(makeVault().readSecret("K")).rejects.toBeInstanceOf(
      LunaVaultIntegrityError,
    )
    await expect(makeVault().listNames()).rejects.toBeInstanceOf(
      LunaVaultIntegrityError,
    )
    const check = await makeVault().checkIntegrity()
    expect(check.ok).toBe(false)
    if (!check.ok) expect(check.reason).toBe("key-missing")
  })

  it("corrupt JSON store → IntegrityError (corrupt-json)", async () => {
    const v = makeVault()
    await v.writeSecret("K", "secret")
    await fsp.writeFile(storePath, "{ not json ")
    const check = await makeVault().checkIntegrity()
    expect(check.ok).toBe(false)
    if (!check.ok) expect(check.reason).toBe("corrupt-json")
  })

  it("valid key + auth tag verifies but plaintext is NOT valid secrets JSON → reason 'corrupt', NOT 'auth-failed' (F5)", async () => {
    const v = makeVault()
    // First write with the real API so a valid vault.key exists.
    await v.writeSecret("K", "secret")
    const key = Buffer.from(
      (await fsp.readFile(keyPath, "utf8")).trim(),
      "base64",
    )
    // Hand-encrypt a store under the CORRECT key so the GCM tag verifies, but
    // whose plaintext is deliberately NOT `{secrets:{...}}` JSON. This proves
    // the taxonomy split: the key is right (tag passes), the DATA is corrupt.
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv)
    cipher.setAAD(Buffer.from("luna-vault:v1"))
    const badPlaintext = "this is not json at all"
    const data = Buffer.concat([
      cipher.update(Buffer.from(badPlaintext, "utf8")),
      cipher.final(),
    ])
    const tag = cipher.getAuthTag()
    await fsp.writeFile(
      storePath,
      JSON.stringify({
        v: 1,
        alg: "aes-256-gcm",
        iv: iv.toString("base64"),
        tag: tag.toString("base64"),
        data: data.toString("base64"),
      }),
    )

    // readSecret throws with the corrupt reason (not auth-failed).
    const err = await makeVault()
      .readSecret("K")
      .then(
        () => {
          throw new Error("expected an integrity error")
        },
        (e: unknown) => e,
      )
    expect(err).toBeInstanceOf(LunaVaultIntegrityError)
    expect((err as LunaVaultIntegrityError).reason).toBe("corrupt")

    // checkIntegrity reports the same distinct reason.
    const check = await makeVault().checkIntegrity()
    expect(check.ok).toBe(false)
    if (!check.ok) expect(check.reason).toBe("corrupt")
  })
})

describe("permissions", () => {
  it("key file is 0600 and vault dir is 0700 after first write", async () => {
    const v = makeVault()
    await v.writeSecret("K", "v")
    const keyStat = await fsp.stat(keyPath)
    const dirStat = await fsp.stat(vaultDir)
    // Mask to permission bits.
    expect(keyStat.mode & 0o777).toBe(0o600)
    expect(dirStat.mode & 0o777).toBe(0o700)
  })

  it("tightens widened key and vault-dir permissions on read", async () => {
    if (process.platform === "win32") return
    const v = makeVault()
    await v.writeSecret("K", "v")
    await fsp.chmod(keyPath, 0o644)
    await fsp.chmod(vaultDir, 0o755)

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      expect(await makeVault().readSecret("K")).toBe("v")
      expect(warnSpy).toHaveBeenCalledTimes(2)
    } finally {
      warnSpy.mockRestore()
    }

    expect((await fsp.stat(keyPath)).mode & 0o777).toBe(0o600)
    expect((await fsp.stat(vaultDir)).mode & 0o777).toBe(0o700)
  })

  it("rejects a symlinked key file instead of reading through it", async () => {
    if (process.platform === "win32") return
    const v = makeVault()
    await v.writeSecret("K", "v")
    const realKeyPath = path.join(vaultDir, "vault.key.real")
    await fsp.rename(keyPath, realKeyPath)
    await fsp.symlink(realKeyPath, keyPath)

    await expect(makeVault().readSecret("K")).rejects.toBeInstanceOf(
      LunaVaultIntegrityError,
    )
  })
})

describe("atomic write", () => {
  it("leaves no .tmp file on success", async () => {
    const v = makeVault()
    await v.writeSecret("K", "v")
    const entries = await fsp.readdir(vaultDir)
    expect(entries.some((e) => e.endsWith(".tmp"))).toBe(false)
  })
})

describe("concurrency", () => {
  it("concurrent writeSecret A ∥ B (same instance) → BOTH survive", async () => {
    const v = makeVault()
    await Promise.all([v.writeSecret("A", "1"), v.writeSecret("B", "2")])
    expect(await v.readSecret("A")).toBe("1")
    expect(await v.readSecret("B")).toBe("2")
    expect((await v.listNames()).sort()).toEqual(["A", "B"])
  })

  it("many concurrent writes all land", async () => {
    const v = makeVault()
    const names = Array.from({ length: 10 }, (_, i) => `N${i}`)
    await Promise.all(names.map((n) => v.writeSecret(n, `val-${n}`)))
    for (const n of names) expect(await v.readSecret(n)).toBe(`val-${n}`)
    expect((await v.listNames()).length).toBe(10)
  })
})

describe("deleteSecret", () => {
  it("returns true when a value existed and removes it", async () => {
    const v = makeVault()
    await v.writeSecret("K", "v")
    expect(await v.deleteSecret("K")).toBe(true)
    expect(await v.readSecret("K")).toBeUndefined()
  })

  it("returns false (no-op, no throw) when the name is absent", async () => {
    const v = makeVault()
    await v.writeSecret("OTHER", "v")
    expect(await v.deleteSecret("ABSENT")).toBe(false)
  })

  it("returns false when there is no store at all", async () => {
    expect(await makeVault().deleteSecret("ANY")).toBe(false)
  })
})

describe("rotateKey", () => {
  it("replaces the key file and all values remain readable", async () => {
    const v = makeVault()
    await v.writeSecret("A", "one")
    await v.writeSecret("B", "two")
    const oldKey = await fsp.readFile(keyPath, "utf8")

    await v.rotateKey()

    const newKey = await fsp.readFile(keyPath, "utf8")
    expect(newKey).not.toBe(oldKey)
    // No staging file left behind.
    await expect(
      fsp.stat(path.join(vaultDir, "vault.key.new")),
    ).rejects.toMatchObject({ code: "ENOENT" })
    // Values still decrypt under the rotated key.
    const reader = makeVault()
    expect(await reader.readSecret("A")).toBe("one")
    expect(await reader.readSecret("B")).toBe("two")
  })

  it("rotate on an empty store just installs a key", async () => {
    const v = makeVault()
    await v.rotateKey()
    // A key now exists; a subsequent write/read works.
    await v.writeSecret("K", "v")
    expect(await makeVault().readSecret("K")).toBe("v")
  })

  it("recovers an interrupted rotation via vault.key.new", async () => {
    // Simulate a crash BETWEEN step 2 (store re-encrypted under new key,
    // renamed over secrets.enc) and step 3 (promote key.new over key): the
    // store is ciphertext under the NEW key, vault.key still holds the OLD key,
    // and vault.key.new holds the new key staged.
    const v = makeVault()
    await v.writeSecret("A", "one")
    await v.writeSecret("B", "two")

    const oldKeyB64 = await fsp.readFile(keyPath, "utf8")
    const oldKey = Buffer.from(oldKeyB64.trim(), "base64")
    const newKey = crypto.randomBytes(32)

    // Re-encrypt the store under the NEW key by hand (mirrors what rotateKey
    // does at step 2), leaving vault.key as the OLD key and staging key.new.
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv("aes-256-gcm", newKey, iv)
    cipher.setAAD(Buffer.from("luna-vault:v1"))
    const plaintext = JSON.stringify({ secrets: { A: "one", B: "two" } })
    const encData = Buffer.concat([
      cipher.update(Buffer.from(plaintext, "utf8")),
      cipher.final(),
    ])
    const tag = cipher.getAuthTag()
    const envelope = {
      v: 1,
      alg: "aes-256-gcm",
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      data: encData.toString("base64"),
    }
    await fsp.writeFile(storePath, JSON.stringify(envelope))
    await fsp.writeFile(
      path.join(vaultDir, "vault.key.new"),
      newKey.toString("base64"),
      { mode: 0o600 },
    )
    // Sanity: vault.key is still the OLD key (which no longer decrypts the store).
    expect(await fsp.readFile(keyPath, "utf8")).toBe(oldKeyB64)

    // The read path must recover via key.new and promote it.
    const reader = makeVault()
    expect(await reader.readSecret("A")).toBe("one")
    expect(await reader.readSecret("B")).toBe("two")

    // After recovery, vault.key is now the NEW key and the staging slot is gone.
    expect(await fsp.readFile(keyPath, "utf8")).toBe(newKey.toString("base64"))
    await expect(
      fsp.stat(path.join(vaultDir, "vault.key.new")),
    ).rejects.toMatchObject({ code: "ENOENT" })

    // oldKey no longer decrypts the store - proves the rotation took effect.
    const stored = JSON.parse(await fsp.readFile(storePath, "utf8")) as {
      iv: string
      tag: string
      data: string
    }
    const badDecipher = crypto.createDecipheriv(
      "aes-256-gcm",
      oldKey,
      Buffer.from(stored.iv, "base64"),
    )
    badDecipher.setAAD(Buffer.from("luna-vault:v1"))
    badDecipher.setAuthTag(Buffer.from(stored.tag, "base64"))
    expect(() => {
      badDecipher.update(Buffer.from(stored.data, "base64"))
      badDecipher.final()
    }).toThrow()
  })

  it("checkIntegrity PASSES when only vault.key.new can decrypt (rotate-crash recovery, F12)", async () => {
    // Same interrupted-rotate setup as above: the store is ciphertext under the
    // NEW key, vault.key still holds the OLD key, vault.key.new holds the new
    // key staged. The boot integrity gate calls checkIntegrity - a crash
    // mid-rotate must NOT report a false integrity failure and brick boot.
    const v = makeVault()
    await v.writeSecret("A", "one")

    const newKey = crypto.randomBytes(32)
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv("aes-256-gcm", newKey, iv)
    cipher.setAAD(Buffer.from("luna-vault:v1"))
    const plaintext = JSON.stringify({ secrets: { A: "one" } })
    const encData = Buffer.concat([
      cipher.update(Buffer.from(plaintext, "utf8")),
      cipher.final(),
    ])
    const tag = cipher.getAuthTag()
    await fsp.writeFile(
      storePath,
      JSON.stringify({
        v: 1,
        alg: "aes-256-gcm",
        iv: iv.toString("base64"),
        tag: tag.toString("base64"),
        data: encData.toString("base64"),
      }),
    )
    await fsp.writeFile(
      path.join(vaultDir, "vault.key.new"),
      newKey.toString("base64"),
      { mode: 0o600 },
    )

    // The gate's probe must recover via key.new and report ok, NOT ok:false.
    const check = await makeVault().checkIntegrity()
    expect(check.ok).toBe(true)
    if (check.ok) expect(check.count).toBe(1)
  })
})

describe("no secret values leaked in errors", () => {
  it("integrity error message never contains the plaintext", async () => {
    const v = makeVault()
    await v.writeSecret("K", "TOP-SECRET-PLAINTEXT")
    await fsp.unlink(keyPath) // force key-missing integrity failure
    try {
      await makeVault().readSecret("K")
      throw new Error("expected an integrity error")
    } catch (e) {
      expect(e).toBeInstanceOf(LunaVaultIntegrityError)
      expect(JSON.stringify(e)).not.toContain("TOP-SECRET-PLAINTEXT")
      expect((e as Error).message).not.toContain("TOP-SECRET-PLAINTEXT")
    }
  })

  it("store on disk never contains plaintext (ciphertext only)", async () => {
    const v = makeVault()
    await v.writeSecret("K", "TOP-SECRET-PLAINTEXT")
    const raw = await fsp.readFile(storePath, "utf8")
    expect(raw).not.toContain("TOP-SECRET-PLAINTEXT")
  })
})

// Guard: ensure the concurrency lock is actually a file-level lock (a lockfile
// is created and removed around a write), not just the in-process mutex.
describe("lockfile lifecycle", () => {
  it("no .lock remains after a completed write", async () => {
    const v = makeVault()
    await v.writeSecret("K", "v")
    expect(fs.existsSync(lockPath)).toBe(false)
  })

  it("acquire → release removes this instance's own lock", async () => {
    await fsp.mkdir(vaultDir, { recursive: true })
    const v = makeVault()
    await lockInternals(v).acquireLock()
    expect(fs.existsSync(lockPath)).toBe(true)

    await lockInternals(v).releaseLock()

    expect(fs.existsSync(lockPath)).toBe(false)
  })

  it("releaseLock does not unlink a foreign lock that replaced our lock", async () => {
    await fsp.mkdir(vaultDir, { recursive: true })
    const v = makeVault()
    await lockInternals(v).acquireLock()
    await fsp.writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, ts: Date.now(), nonce: "foreign" }),
    )

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      await lockInternals(v).releaseLock()
      expect(warnSpy).toHaveBeenCalledTimes(1)
    } finally {
      warnSpy.mockRestore()
    }

    expect(fs.existsSync(lockPath)).toBe(true)
    const raw = await fsp.readFile(lockPath, "utf8")
    expect(JSON.parse(raw)).toMatchObject({ nonce: "foreign" })
  })

  it("stale takeover is skipped when the recorded holder pid is still alive", async () => {
    await fsp.mkdir(vaultDir, { recursive: true })
    await fsp.writeFile(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        ts: Date.now() - 31_000,
        nonce: "alive-holder",
      }),
    )

    expect(await lockInternals(makeVault()).tryTakeOverStaleLock()).toBe(false)

    const raw = await fsp.readFile(lockPath, "utf8")
    expect(JSON.parse(raw)).toMatchObject({ nonce: "alive-holder" })
  })
})
