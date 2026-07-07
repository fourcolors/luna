/**
 * storage-policy tests.
 *
 *  - resolveWriteTier: the full mode × platform × probe matrix (pure).
 *  - probeOnePassword: accountsConfigured short-circuit, exit-0 → detected,
 *    ENOENT → absent, and a HANG → absent within the deadline (fake execFile
 *    that never calls back), all with an injected fake execFile so nothing
 *    real is spawned.
 */
import type { execFile } from "node:child_process"
import { describe, expect, it, vi } from "vitest"
import {
  probeOnePassword,
  resolveWriteTier,
  type OnePasswordProbe,
  type StorageProbe,
  type VaultStorageModeV2,
  type WriteTier,
} from "./storage-policy.js"

const probe = (
  platform: NodeJS.Platform,
  osKeychain: boolean,
  onePassword: OnePasswordProbe = "absent",
): StorageProbe => ({ platform, osKeychain, onePassword })

describe("resolveWriteTier", () => {
  // Explicit env mode is always plaintext, regardless of platform/probe.
  it("env mode → env on every platform", () => {
    expect(resolveWriteTier("env", probe("darwin", true))).toBe("env")
    expect(resolveWriteTier("env", probe("linux", false))).toBe("env")
  })

  // auto: keychain when the OS keychain is usable (darwin), else luna-vault.
  it("auto → keychain on darwin (osKeychain true)", () => {
    expect(resolveWriteTier("auto", probe("darwin", true))).toBe("keychain")
  })
  it("auto → luna-vault on linux (osKeychain false)", () => {
    expect(resolveWriteTier("auto", probe("linux", false))).toBe("luna-vault")
  })
  it("auto → luna-vault on darwin when keychain unusable", () => {
    expect(resolveWriteTier("auto", probe("darwin", false))).toBe("luna-vault")
  })

  // keychain-* modes: keychain when usable, else luna-vault (never plaintext).
  it.each<[VaultStorageModeV2, boolean, WriteTier]>([
    ["keychain-preferred", true, "keychain"],
    ["keychain-preferred", false, "luna-vault"],
    ["keychain-only", true, "keychain"],
    ["keychain-only", false, "luna-vault"],
  ])("%s with osKeychain=%s → %s", (mode, osKeychain, expected) => {
    expect(resolveWriteTier(mode, probe("darwin", osKeychain))).toBe(expected)
  })

  // The onePassword probe never changes the write tier (op is read-only).
  it("onePassword=active does not divert the write tier", () => {
    expect(resolveWriteTier("auto", probe("linux", false, "active"))).toBe(
      "luna-vault",
    )
    expect(resolveWriteTier("auto", probe("darwin", true, "active"))).toBe(
      "keychain",
    )
  })
})

// A fake execFile that invokes the callback with the given error/exit.
const fakeExecFileImmediate = (
  err: NodeJS.ErrnoException | null,
): typeof execFile =>
  ((..._args: Array<unknown>) => {
    const cb = _args[3] as (e: NodeJS.ErrnoException | null) => void
    queueMicrotask(() => cb(err))
    return { kill: () => true } as unknown as ReturnType<typeof execFile>
  }) as unknown as typeof execFile

// A fake execFile that NEVER calls back - exercises the hard deadline.
const fakeExecFileHang = (
  killSpy?: (signal?: unknown) => void,
): typeof execFile =>
  ((..._args: Array<unknown>) =>
    ({
      kill: (signal?: unknown) => {
        killSpy?.(signal)
        return true
      },
    }) as unknown as ReturnType<typeof execFile>) as unknown as typeof execFile

describe("probeOnePassword", () => {
  it("accountsConfigured short-circuits to active without exec", async () => {
    const spy = vi.fn(fakeExecFileImmediate(null))
    const got = await probeOnePassword({
      accountsConfigured: true,
      execFileImpl: spy as unknown as typeof execFile,
    })
    expect(got).toBe<OnePasswordProbe>("active")
    expect(spy).not.toHaveBeenCalled()
  })

  it("exit 0 → detected", async () => {
    const got = await probeOnePassword({
      accountsConfigured: false,
      execFileImpl: fakeExecFileImmediate(null),
    })
    expect(got).toBe<OnePasswordProbe>("detected")
  })

  it("ENOENT (missing op) → absent", async () => {
    const enoent = Object.assign(new Error("spawn op ENOENT"), {
      code: "ENOENT",
    }) as NodeJS.ErrnoException
    const got = await probeOnePassword({
      accountsConfigured: false,
      execFileImpl: fakeExecFileImmediate(enoent),
    })
    expect(got).toBe<OnePasswordProbe>("absent")
  })

  it("non-zero exit → absent", async () => {
    const exitErr = Object.assign(new Error("exit 1"), {
      code: 1,
    }) as unknown as NodeJS.ErrnoException
    const got = await probeOnePassword({
      accountsConfigured: false,
      execFileImpl: fakeExecFileImmediate(exitErr),
    })
    expect(got).toBe<OnePasswordProbe>("absent")
  })

  it("a hang resolves absent within the deadline and kills the child", async () => {
    const killSpy = vi.fn()
    const start = Date.now()
    const got = await probeOnePassword({
      accountsConfigured: false,
      execFileImpl: fakeExecFileHang(killSpy),
      timeoutMs: 30,
    })
    const elapsed = Date.now() - start
    expect(got).toBe<OnePasswordProbe>("absent")
    expect(killSpy).toHaveBeenCalledWith("SIGKILL")
    // Comfortably under a 1s bound - proves it did not block indefinitely.
    expect(elapsed).toBeLessThan(1000)
  }, 2000)

  it("never throws on a synchronous spawn failure", async () => {
    const throwingExec = (() => {
      throw new Error("boom")
    }) as unknown as typeof execFile
    const got = await probeOnePassword({
      accountsConfigured: false,
      execFileImpl: throwingExec,
    })
    expect(got).toBe<OnePasswordProbe>("absent")
  })
})
