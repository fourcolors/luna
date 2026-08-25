/**
 * Tests for parseClientConfig + resolveTokenRef (Chunk 4-B).
 *
 * File I/O is injected (tests pass TOML strings + fake env/readFile/lstat) so
 * no real filesystem access is needed for the unit tests.
 * Real-fs tests use tmp files with proper permissions.
 */

import { describe, expect, it } from "vitest"
import { parseClientConfig, resolveTokenRef } from "../src/bootstrap/client-config.js"
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, symlinkSync, unlinkSync, rmdirSync } from "node:fs"
import type { Stats } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// ── fake lstat helper (safe stat for injected readFileFn tests) ───────────────

function makeSafeStat(overrides: Partial<{
  isSymbolicLink: boolean
  mode: number
  uid: number
}> = {}): Stats {
  const processUid = (process as { getuid?: () => number }).getuid?.() ?? 0
  return {
    isSymbolicLink: () => overrides.isSymbolicLink ?? false,
    isFile: () => true,
    mode: overrides.mode ?? 0o100600, // -rw------- (safe)
    uid: overrides.uid ?? processUid,
  } as unknown as Stats
}

// ── sample TOML (matches src/dev/sample-client.toml) ─────────────────────────

const SAMPLE_TOML = `
kind              = "bootstrap"
fileFormatVersion = 3
default           = "jax-stable"

[route.jax-stable]
  label     = "Stable (prod)"
  endpoints = ["ws://luna-host:4753/ui", "ws://luna-host.local:4753/ui"]
  tokenRef  = "env:LUNA_STABLE_UI_WS_TOKEN"

[route.hermes-local]
  label     = "Hermes (local)"
  endpoints = ["http://127.0.0.1:8642/v1"]
  tokenRef  = "env:HERMES_API_KEY"
`

// ── parseClientConfig ─────────────────────────────────────────────────────────

describe("parseClientConfig", () => {
  describe("valid two-route file", () => {
    it("parses fileFormatVersion and default", () => {
      const cfg = parseClientConfig(SAMPLE_TOML)
      expect(cfg.fileFormatVersion).toBe(3)
      expect(cfg.default).toBe("jax-stable")
    })

    it("parses route jax-stable correctly", () => {
      const cfg = parseClientConfig(SAMPLE_TOML)
      const route = cfg.routes.get("jax-stable")
      expect(route).toBeDefined()
      expect(route!.routeKey).toBe("jax-stable")
      expect(route!.endpoints).toEqual(["ws://luna-host:4753/ui", "ws://luna-host.local:4753/ui"])
      expect(route!.tokenRef).toBe("env:LUNA_STABLE_UI_WS_TOKEN")
      expect(route!.label).toBe("Stable (prod)")
    })

    it("parses route hermes-local correctly", () => {
      const cfg = parseClientConfig(SAMPLE_TOML)
      const route = cfg.routes.get("hermes-local")
      expect(route).toBeDefined()
      expect(route!.endpoints).toEqual(["http://127.0.0.1:8642/v1"])
      expect(route!.tokenRef).toBe("env:HERMES_API_KEY")
    })

    it("routes map has exactly two entries", () => {
      const cfg = parseClientConfig(SAMPLE_TOML)
      expect(cfg.routes.size).toBe(2)
    })
  })

  describe("kind discrimination", () => {
    it("rejects kind='registry' (server registry fed to client parser)", () => {
      const toml = `
kind = "registry"
fileFormatVersion = 1
`
      expect(() => parseClientConfig(toml)).toThrow(/kind.*bootstrap/)
    })

    it("rejects missing kind", () => {
      const toml = `
fileFormatVersion = 3
[route.x]
  endpoints = ["ws://localhost:4753/ui"]
  tokenRef  = "env:TOKEN"
`
      expect(() => parseClientConfig(toml)).toThrow(/kind.*bootstrap/)
    })
  })

  describe("route validation", () => {
    it("rejects a route missing endpoints", () => {
      const toml = `
kind = "bootstrap"
fileFormatVersion = 3
[route.broken]
  tokenRef = "env:TOKEN"
`
      expect(() => parseClientConfig(toml)).toThrow(/missing a non-empty endpoints/)
    })

    it("rejects a route with an empty endpoints array", () => {
      const toml = `
kind = "bootstrap"
fileFormatVersion = 3
[route.broken]
  endpoints = []
  tokenRef = "env:TOKEN"
`
      expect(() => parseClientConfig(toml)).toThrow(/missing a non-empty endpoints/)
    })

    it("rejects a route missing tokenRef", () => {
      const toml = `
kind = "bootstrap"
fileFormatVersion = 3
[route.broken]
  endpoints = ["ws://localhost:4753/ui"]
`
      expect(() => parseClientConfig(toml)).toThrow(/missing tokenRef/)
    })
  })

  describe("default validation", () => {
    it("rejects default that references a non-existent route", () => {
      const toml = `
kind = "bootstrap"
fileFormatVersion = 3
default = "nonexistent"
[route.real-route]
  endpoints = ["ws://localhost:4753/ui"]
  tokenRef  = "env:TOKEN"
`
      expect(() => parseClientConfig(toml)).toThrow(/default=.*nonexistent/)
    })

    it("accepts a config with no default field", () => {
      const toml = `
kind = "bootstrap"
fileFormatVersion = 3
[route.a]
  endpoints = ["ws://localhost:4753/ui"]
  tokenRef  = "env:TOKEN"
`
      const cfg = parseClientConfig(toml)
      expect(cfg.default).toBeUndefined()
      expect(cfg.routes.size).toBe(1)
    })
  })

  describe("optional fields", () => {
    it("parses the expect field into {spki}", () => {
      const toml = `
kind = "bootstrap"
fileFormatVersion = 3
[route.pinned]
  endpoints = ["wss://example.com/ui"]
  tokenRef  = "env:TOKEN"
  expect    = "spki:sha256:9f2cabc"
`
      const cfg = parseClientConfig(toml)
      const route = cfg.routes.get("pinned")!
      expect(route.expect?.spki).toBe("spki:sha256:9f2cabc")
    })
  })

  describe("sample-client.toml fixture", () => {
    it("the fixture file on disk is parseable and matches SAMPLE_TOML", () => {
      // Verify the shipped sample file parses successfully.
      const fixtureToml = readFileSync(
        new URL("../src/dev/sample-client.toml", import.meta.url),
        "utf-8",
      )
      const cfg = parseClientConfig(fixtureToml)
      expect(cfg.fileFormatVersion).toBe(3)
      expect(cfg.default).toBe("jax-stable")
      expect(cfg.routes.has("jax-stable")).toBe(true)
      expect(cfg.routes.has("hermes-local")).toBe(true)
    })
  })
})

// ── resolveTokenRef ───────────────────────────────────────────────────────────

describe("resolveTokenRef", () => {
  // env: scheme
  describe("env: scheme", () => {
    it("resolves a set env variable", async () => {
      const token = await resolveTokenRef("env:MY_TOKEN", { MY_TOKEN: "secret-value" })
      expect(token).toBe("secret-value")
    })

    it("throws (fail-closed) when the env variable is unset", async () => {
      await expect(resolveTokenRef("env:MISSING_VAR", {})).rejects.toThrow(
        /MISSING_VAR.*unset/,
      )
    })

    it("throws when the env variable is empty string", async () => {
      await expect(resolveTokenRef("env:EMPTY_VAR", { EMPTY_VAR: "" })).rejects.toThrow(
        /EMPTY_VAR.*unset or empty/,
      )
    })
  })

  // file: scheme
  describe("file: scheme", () => {
    it("resolves a file that exists (via injected readFileFn)", async () => {
      const fakeRead = async (_path: string) => "file-secret-value\n"
      const token = await resolveTokenRef("file:/absolute/path/to/token", {}, fakeRead, makeSafeStat)
      expect(token).toBe("file-secret-value") // trimmed
    })

    it("throws when the file cannot be read", async () => {
      const fakeRead = async (_path: string) => {
        throw new Error("ENOENT: no such file or directory")
      }
      await expect(resolveTokenRef("file:/missing/token", {}, fakeRead, makeSafeStat)).rejects.toThrow(
        /could not read file/,
      )
    })

    it("throws when the file is empty", async () => {
      const fakeRead = async (_path: string) => "   \n  "
      await expect(resolveTokenRef("file:/empty/token", {}, fakeRead, makeSafeStat)).rejects.toThrow(
        /is empty/,
      )
    })

    it("throws when the path is not absolute (rejects relative paths)", async () => {
      const fakeRead = async (_path: string) => "token"
      await expect(resolveTokenRef("file:relative/path", {}, fakeRead, makeSafeStat)).rejects.toThrow(
        /absolute path/,
      )
    })
  })

  // none scheme
  describe("none scheme", () => {
    it("returns empty string (for no-auth routes)", async () => {
      const token = await resolveTokenRef("none")
      expect(token).toBe("")
    })
  })

  // op:// scheme — now WIRED (C6) via the 1Password CLI with an injectable
  // spawn so these tests NEVER launch a real `op` process.
  describe("op:// scheme (1Password CLI)", () => {
    const OP_PATH = "/usr/local/bin/op"

    /** A fake spawn that records its call and returns a canned result. */
    function makeFakeSpawn(result: Partial<{
      code: number | null
      signal: NodeJS.Signals | null
      stdout: string
      stderr: string
    }>) {
      const calls: Array<{ binaryPath: string; argv: readonly string[]; timeoutMs: number }> = []
      const fn = async (
        binaryPath: string,
        argv: readonly string[],
        opts: { timeoutMs: number },
      ) => {
        calls.push({ binaryPath, argv, timeoutMs: opts.timeoutMs })
        return {
          code: result.code ?? 0,
          signal: result.signal ?? null,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
        }
      }
      return { fn, calls }
    }

    // A lookup that pretends `op` is on PATH at OP_PATH (no real fs access).
    const fakeLookup = () => OP_PATH

    it("resolves a token when op exits 0 (allowInteractive + mocked spawn)", async () => {
      const { fn, calls } = makeFakeSpawn({ code: 0, stdout: "s3cr3t-token\n" })
      const token = await resolveTokenRef(
        "op://Luna/stable/token",
        {},
        undefined,
        undefined,
        {
          allowInteractive: true,
          opBinaryPath: OP_PATH,
          opSpawn: fn,
          opPathLookup: fakeLookup,
        },
      )
      expect(token).toBe("s3cr3t-token") // trimmed
      expect(calls).toHaveLength(1)
    })

    it("refuses op:// by DEFAULT (headless / no allowInteractive) — fail-closed", async () => {
      const { fn, calls } = makeFakeSpawn({ code: 0, stdout: "should-not-be-read" })
      await expect(
        resolveTokenRef("op://Luna/stable/token", {}, undefined, undefined, {
          opBinaryPath: OP_PATH,
          opSpawn: fn,
          opPathLookup: fakeLookup,
        }),
      ).rejects.toThrow(/refused in non-interactive contexts/)
      // The spawn must NEVER have been invoked when refused.
      expect(calls).toHaveLength(0)
    })

    it("throws on a nonzero exit (fail-closed)", async () => {
      const { fn } = makeFakeSpawn({ code: 1, stderr: "[ERROR] item not found" })
      await expect(
        resolveTokenRef("op://Luna/missing/token", {}, undefined, undefined, {
          allowInteractive: true,
          opBinaryPath: OP_PATH,
          opSpawn: fn,
          opPathLookup: fakeLookup,
        }),
      ).rejects.toThrow(/exited with code 1/)
    })

    it("throws on a timeout (spawn killed via SIGTERM signal)", async () => {
      const { fn } = makeFakeSpawn({ code: null, signal: "SIGTERM", stdout: "" })
      await expect(
        resolveTokenRef("op://Luna/slow/token", {}, undefined, undefined, {
          allowInteractive: true,
          opBinaryPath: OP_PATH,
          opTimeoutMs: 50,
          opSpawn: fn,
          opPathLookup: fakeLookup,
        }),
      ).rejects.toThrow(/timed out/)
    })

    it("throws on a timeout when the spawn REJECTS with killed (execFile-style)", async () => {
      const rejectingSpawn = async () => {
        const e = new Error("Command failed: op read") as NodeJS.ErrnoException & { killed?: boolean; signal?: string }
        e.killed = true
        e.signal = "SIGTERM"
        throw e
      }
      await expect(
        resolveTokenRef("op://Luna/slow/token", {}, undefined, undefined, {
          allowInteractive: true,
          opBinaryPath: OP_PATH,
          opTimeoutMs: 50,
          opSpawn: rejectingSpawn,
          opPathLookup: fakeLookup,
        }),
      ).rejects.toThrow(/timed out/)
    })

    it("throws when the op binary is missing (no PATH match, no injected path)", async () => {
      const { fn, calls } = makeFakeSpawn({ code: 0, stdout: "tok" })
      await expect(
        resolveTokenRef("op://Luna/stable/token", {}, undefined, undefined, {
          allowInteractive: true,
          opSpawn: fn,
          opPathLookup: () => null, // op not found anywhere
        }),
      ).rejects.toThrow(/not found on PATH/)
      expect(calls).toHaveLength(0)
    })

    it("throws when the spawn rejects with ENOENT (binary vanished between check and spawn)", async () => {
      const enoentSpawn = async () => {
        const e = new Error("spawn op ENOENT") as NodeJS.ErrnoException
        e.code = "ENOENT"
        throw e
      }
      await expect(
        resolveTokenRef("op://Luna/stable/token", {}, undefined, undefined, {
          allowInteractive: true,
          opBinaryPath: OP_PATH,
          opSpawn: enoentSpawn,
          opPathLookup: fakeLookup,
        }),
      ).rejects.toThrow(/ENOENT|could not be spawned/)
    })

    it("rejects a non-absolute injected op binary path", async () => {
      const { fn } = makeFakeSpawn({ code: 0, stdout: "tok" })
      await expect(
        resolveTokenRef("op://Luna/stable/token", {}, undefined, undefined, {
          allowInteractive: true,
          opBinaryPath: "op", // not absolute → refuse
          opSpawn: fn,
          opPathLookup: fakeLookup,
        }),
      ).rejects.toThrow(/must be an absolute path/)
    })

    it("throws on an empty resolved secret (exit 0 but blank stdout)", async () => {
      const { fn } = makeFakeSpawn({ code: 0, stdout: "   \n" })
      await expect(
        resolveTokenRef("op://Luna/blank/token", {}, undefined, undefined, {
          allowInteractive: true,
          opBinaryPath: OP_PATH,
          opSpawn: fn,
          opPathLookup: fakeLookup,
        }),
      ).rejects.toThrow(/empty secret/)
    })

    // ── ARGV-INJECTION SAFETY ──────────────────────────────────────────────────
    // The whole point: a malicious ref MUST NOT reach a shell. We assert the
    // spawn receives an argv VECTOR with the binary as element 0 and the ref as
    // a DISCRETE element — never an "sh -c"-style single concatenated string.
    it("passes the ref as a discrete argv element — never a shell string", async () => {
      const { fn, calls } = makeFakeSpawn({ code: 0, stdout: "ok" })
      // This test proves the VECTORIZATION property (binary + ref as separate
      // argv elements). It uses a charset-VALID ref on purpose so it reaches the
      // spawn — the metacharacter-rejection property is proven by the adjacent
      // "rejects a ref containing shell metacharacters" test instead.
      const validRef = "op://Luna/item/field"
      await resolveTokenRef(validRef, {}, undefined, undefined, {
        allowInteractive: true,
        opBinaryPath: OP_PATH,
        opSpawn: fn,
        opPathLookup: fakeLookup,
      })
      expect(calls).toHaveLength(1)
      const call = calls[0]!
      // binary is the validated absolute path, passed SEPARATELY from argv.
      expect(call.binaryPath).toBe(OP_PATH)
      // argv is a vector; the ref is its own element, not interpolated.
      expect(Array.isArray(call.argv)).toBe(true)
      expect(call.argv).toContain("read")
      expect(call.argv).toContain(validRef)
      // No element is a shell invocation, and the binary is NOT "sh"/"bash".
      expect(call.binaryPath).not.toMatch(/\/(sh|bash|zsh)$/)
      expect(call.argv).not.toContain("-c")
      // The ref must NOT be glued onto another arg (no element CONTAINS the ref
      // alongside other text — it stands alone).
      const refElements = call.argv.filter((a) => a.includes("op://"))
      expect(refElements).toEqual([validRef])
    })

    it("rejects a ref containing shell metacharacters before any spawn (defense-in-depth)", async () => {
      const { fn, calls } = makeFakeSpawn({ code: 0, stdout: "ok" })
      await expect(
        resolveTokenRef("op://Luna/item/field;rm -rf ~", {}, undefined, undefined, {
          allowInteractive: true,
          opBinaryPath: OP_PATH,
          opSpawn: fn,
          opPathLookup: fakeLookup,
        }),
      ).rejects.toThrow(/characters outside the allowed set/)
      // Refused at the charset gate → spawn never called.
      expect(calls).toHaveLength(0)
    })
  })

  // unrecognized scheme
  describe("unrecognized / raw scheme", () => {
    it("throws on a raw token with no scheme prefix", async () => {
      await expect(resolveTokenRef("rawtoken123")).rejects.toThrow(
        /unrecognized scheme/,
      )
    })

    it("throws on an unknown scheme prefix", async () => {
      await expect(resolveTokenRef("keychain:luna-token")).rejects.toThrow(
        /unrecognized scheme/,
      )
    })
  })

  // FIX 3: env: whitespace-only rejection
  describe("env: whitespace-only value → throws", () => {
    it("throws when the env variable is whitespace-only", async () => {
      await expect(
        resolveTokenRef("env:WHITESPACE_VAR", { WHITESPACE_VAR: "   " }),
      ).rejects.toThrow(/unset or empty/)
    })

    it("throws when the env variable is a tab character", async () => {
      await expect(
        resolveTokenRef("env:TAB_VAR", { TAB_VAR: "\t" }),
      ).rejects.toThrow(/unset or empty/)
    })
  })

  // FIX 2: file: §8 security hardening tests using real temp files
  describe("file: §8 security hardening (real tmp files)", () => {
    it("resolves a correct 0600 owner-owned regular file", async () => {
      const dir = mkdtempSync(join(tmpdir(), "luna-test-"))
      const tokenFile = join(dir, "token")
      try {
        writeFileSync(tokenFile, "real-secret\n", { mode: 0o600 })
        const token = await resolveTokenRef(`file:${tokenFile}`)
        expect(token).toBe("real-secret")
      } finally {
        try { unlinkSync(tokenFile) } catch {}
        try { rmdirSync(dir) } catch {}
      }
    })

    it("refuses a symlink token file", async () => {
      const dir = mkdtempSync(join(tmpdir(), "luna-test-"))
      const realFile = join(dir, "real")
      const linkFile = join(dir, "link")
      try {
        writeFileSync(realFile, "secret", { mode: 0o600 })
        symlinkSync(realFile, linkFile)
        await expect(resolveTokenRef(`file:${linkFile}`)).rejects.toThrow(
          /symbolic link/,
        )
      } finally {
        try { unlinkSync(linkFile) } catch {}
        try { unlinkSync(realFile) } catch {}
        try { rmdirSync(dir) } catch {}
      }
    })

    it("refuses a group/world-readable file (0o644)", async () => {
      const dir = mkdtempSync(join(tmpdir(), "luna-test-"))
      const tokenFile = join(dir, "token-644")
      try {
        writeFileSync(tokenFile, "secret", { mode: 0o644 })
        await expect(resolveTokenRef(`file:${tokenFile}`)).rejects.toThrow(
          /unsafe permissions/,
        )
      } finally {
        try { unlinkSync(tokenFile) } catch {}
        try { rmdirSync(dir) } catch {}
      }
    })

    it("refuses a non-absolute path", async () => {
      await expect(resolveTokenRef("file:relative/path/token")).rejects.toThrow(
        /absolute path/,
      )
    })

    it("refuses a path containing '..'", async () => {
      await expect(resolveTokenRef("file:/etc/../etc/passwd")).rejects.toThrow(
        /\.\./,
      )
    })
  })
})

// ── FIX 1: parser adversarial / gap tests ─────────────────────────────────────

describe("parseClientConfig — adversarial gap tests (FIX 1)", () => {
  it("tokenRef containing '#' is preserved intact (not truncated)", () => {
    const toml = `
kind = "bootstrap"
fileFormatVersion = 1
[route.x]
  endpoints = ["ws://localhost:4753/ui"]
  tokenRef  = "env:TOKEN_WITH_#_IN_NAME"
`
    const cfg = parseClientConfig(toml)
    // The # is inside a quoted value — smol-toml must preserve it
    expect(cfg.routes.get("x")!.tokenRef).toBe("env:TOKEN_WITH_#_IN_NAME")
  })

  it("label value containing '#' is preserved intact", () => {
    const toml = `
kind = "bootstrap"
fileFormatVersion = 1
[route.x]
  label     = "Prod #1"
  endpoints = ["ws://localhost:4753/ui"]
  tokenRef  = "env:TOKEN"
`
    const cfg = parseClientConfig(toml)
    expect(cfg.routes.get("x")!.label).toBe("Prod #1")
  })

  it("endpoint URL with a '#fragment' is preserved intact", () => {
    const toml = `
kind = "bootstrap"
fileFormatVersion = 1
[route.x]
  endpoints = ["ws://host:4753/ui#channel"]
  tokenRef  = "env:TOKEN"
`
    const cfg = parseClientConfig(toml)
    expect(cfg.routes.get("x")!.endpoints[0]).toBe("ws://host:4753/ui#channel")
  })

  it("duplicate [route.x] sections → throws (smol-toml TOML spec enforcement)", () => {
    const toml = `
kind = "bootstrap"
fileFormatVersion = 1
[route.x]
  endpoints = ["ws://localhost:4753/ui"]
  tokenRef  = "env:TOKEN"
[route.x]
  endpoints = ["ws://localhost:4754/ui"]
  tokenRef  = "env:TOKEN2"
`
    expect(() => parseClientConfig(toml)).toThrow()
  })

  it("malformed / junk line in TOML → throws (fail-closed)", () => {
    const toml = `
kind = "bootstrap"
fileFormatVersion = 1
this is junk that is not valid toml
[route.x]
  endpoints = ["ws://localhost:4753/ui"]
  tokenRef  = "env:TOKEN"
`
    expect(() => parseClientConfig(toml)).toThrow()
  })

  it("kind='registry' → throws", () => {
    const toml = `
kind = "registry"
fileFormatVersion = 1
[route.x]
  endpoints = ["ws://localhost:4753/ui"]
  tokenRef  = "env:TOKEN"
`
    expect(() => parseClientConfig(toml)).toThrow(/kind.*bootstrap/)
  })

  it("unknown major fileFormatVersion (> MAX) → throws", () => {
    const toml = `
kind = "bootstrap"
fileFormatVersion = 999
[route.x]
  endpoints = ["ws://localhost:4753/ui"]
  tokenRef  = "env:TOKEN"
`
    expect(() => parseClientConfig(toml)).toThrow(/fileFormatVersion.*newer|newer.*fileFormatVersion/)
  })
})
