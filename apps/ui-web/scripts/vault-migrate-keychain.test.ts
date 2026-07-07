import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  parseEnvFileEntries,
  parseEnvFileNames,
  planVaultKeychainMigration,
  readRuntimeEnvNames,
  runCli,
  type VaultMigrationTargetOps,
} from "./vault-migrate-keychain.js"

describe("planVaultKeychainMigration", () => {
  it("plans eligible env secrets and skips reserved names", () => {
    const plan = planVaultKeychainMigration({
      envNames: [
        "OPENAI_API_KEY",
        "LUNA_INTERNAL",
        "UI_WS_TOKEN",
        "ANTHROPIC_API_KEY",
      ],
      existingKeychainNames: new Set(["ANTHROPIC_API_KEY"]),
    })

    expect(plan.toCopy).toEqual(["OPENAI_API_KEY"])
    expect(plan.alreadyCopied).toEqual(["ANTHROPIC_API_KEY"])
    expect(plan.skippedReserved).toEqual(["LUNA_INTERNAL", "UI_WS_TOKEN"])
  })

  it("treats reserved names case-insensitively (matches the env denylist)", () => {
    const plan = planVaultKeychainMigration({
      envNames: ["ui_ws_token", "Luna_Thing", "GOOD_KEY"],
      existingKeychainNames: new Set(),
    })

    expect(plan.skippedReserved).toEqual(["ui_ws_token", "Luna_Thing"])
    expect(plan.toCopy).toEqual(["GOOD_KEY"])
  })
})

describe("parseEnvFileNames", () => {
  it("extracts keys, ignoring comments, blanks, and malformed lines", () => {
    const body = [
      "# a comment",
      "",
      "OPENAI_API_KEY=sk-test",
      "  SPACED_KEY = value-with-spaces ",
      "no_equals_here",
      "=leading-equals-no-key",
    ].join("\n")

    expect(parseEnvFileNames(body)).toEqual(["OPENAI_API_KEY", "SPACED_KEY"])
  })
})

describe("parseEnvFileEntries", () => {
  it("matches the boot loader: trims the value and keeps the first duplicate", () => {
    // Boot loader (chat-server) does `trimmed.slice(eq+1).trim()` and
    // first-occurrence-wins; apply must copy the SAME value the env path
    // resolves, or a later prune could orphan a drifted value.
    const body = [
      "# comment",
      "OPENAI_API_KEY= sk-leading-space ",
      "DUPE=first",
      "DUPE=second",
    ].join("\n")

    expect(parseEnvFileEntries(body)).toEqual([
      { name: "OPENAI_API_KEY", value: "sk-leading-space" },
      { name: "DUPE", value: "first" },
    ])
  })
})

// ── IO-path tests (dry-run / apply / prune) against a real temp `.env`, with
// a fake VaultMigrationTargetOps standing in for the platform target - the
// same "in-memory fake behind the injectable seam" idiom the script's
// header comment describes. `LUNA_HOME` is overridden so no test ever
// touches a real `~/.luna`.

/** In-memory fake target: records writes, answers probes from its own map. */
const makeFakeTarget = (
  kind: "keychain" | "luna-vault",
): VaultMigrationTargetOps & { readonly store: Map<string, string> } => {
  const store = new Map<string, string>()
  return {
    kind,
    label: kind === "keychain" ? "macOS keychain" : "Luna encrypted vault",
    store,
    probeExisting: async (names) => {
      const found = new Set<string>()
      for (const n of names) if (store.has(n)) found.add(n)
      return found
    },
    write: async (name, value) => {
      store.set(name, value)
      return true
    },
  }
}

const captureLog = (): { readonly lines: string[]; restore: () => void } => {
  const lines: string[] = []
  const original = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk))
    return true
  }) as typeof process.stdout.write
  return {
    lines,
    restore: () => {
      process.stdout.write = original
    },
  }
}

describe("runCli IO paths (fake target, temp .env)", () => {
  let lunaHome: string
  let envPath: string
  let prevLunaHome: string | undefined

  beforeEach(async () => {
    lunaHome = await fsp.mkdtemp(
      path.join(os.tmpdir(), "vault-migrate-test-"),
    )
    envPath = path.join(lunaHome, ".env")
    prevLunaHome = process.env.LUNA_HOME
    process.env.LUNA_HOME = lunaHome
  })

  afterEach(async () => {
    if (prevLunaHome === undefined) delete process.env.LUNA_HOME
    else process.env.LUNA_HOME = prevLunaHome
    await fsp.rm(lunaHome, { recursive: true, force: true })
  })

  const writeEnv = async (body: string): Promise<void> => {
    await fsp.writeFile(envPath, body, { mode: 0o600 })
  }

  describe("linux target (luna-vault)", () => {
    it("dry-run names the luna-vault target", async () => {
      await writeEnv("OPENAI_API_KEY=sk-test\nLUNA_INTERNAL=x\n")
      const target = makeFakeTarget("luna-vault")
      const cap = captureLog()
      const code = await runCli(["--dry-run"], target)
      cap.restore()
      expect(code).toBe(0)
      expect(cap.lines.join("")).toContain("target: Luna encrypted vault")
      expect(cap.lines.join("")).toContain("toCopy: [OPENAI_API_KEY]")
      expect(cap.lines.join("")).toContain("skippedReserved: [LUNA_INTERNAL]")
    })

    it("--apply copies eligible values into the fake vault and leaves .env untouched", async () => {
      const body = "OPENAI_API_KEY=sk-test\nLUNA_INTERNAL=x\nUI_WS_TOKEN=y\n"
      await writeEnv(body)
      const target = makeFakeTarget("luna-vault")
      const cap = captureLog()
      const code = await runCli(["--apply", "--keep-env"], target)
      cap.restore()

      expect(code).toBe(0)
      expect(target.store.get("OPENAI_API_KEY")).toBe("sk-test")
      expect(target.store.has("LUNA_INTERNAL")).toBe(false)
      expect(target.store.has("UI_WS_TOKEN")).toBe(false)
      // .env is copy-only: byte-identical after apply.
      expect(await fsp.readFile(envPath, "utf8")).toBe(body)
      expect(cap.lines.join("")).toContain("target: Luna encrypted vault")
    })

    it("--prune-env removes only names confirmed readable from the fake vault", async () => {
      const body = [
        "OPENAI_API_KEY=sk-test",
        "ANOTHER_KEY=still-here",
        "LUNA_INTERNAL=reserved",
        "",
      ].join("\n")
      await writeEnv(body)
      const target = makeFakeTarget("luna-vault")
      // Only OPENAI_API_KEY is confirmed readable back from the vault;
      // ANOTHER_KEY was never actually written there (simulates a partial/
      // failed prior apply), so prune must leave it in .env.
      target.store.set("OPENAI_API_KEY", "sk-test")

      const cap = captureLog()
      const code = await runCli(["--prune-env"], target)
      cap.restore()

      expect(code).toBe(0)
      const remaining = await fsp.readFile(envPath, "utf8")
      expect(remaining).not.toContain("OPENAI_API_KEY")
      expect(remaining).toContain("ANOTHER_KEY=still-here")
      expect(remaining).toContain("LUNA_INTERNAL=reserved")
      expect(cap.lines.join("")).toContain("target: Luna encrypted vault")
      expect(cap.lines.join("")).toContain("pruned from .env: OPENAI_API_KEY")
    })

    it("reserved names are never pruned even if somehow readable from the target", async () => {
      await writeEnv("LUNA_INTERNAL=reserved\nUI_WS_TOKEN=tok\n")
      const target = makeFakeTarget("luna-vault")
      // Simulate a buggy/compromised target that would answer "readable" for
      // a reserved name - the prune path must filter reserved names BEFORE
      // probing, so this can never happen via the real path, but pin the
      // defense here too.
      target.store.set("LUNA_INTERNAL", "reserved")
      target.store.set("UI_WS_TOKEN", "tok")

      const code = await runCli(["--prune-env"], target)
      expect(code).toBe(0)
      const remaining = await fsp.readFile(envPath, "utf8")
      expect(remaining).toContain("LUNA_INTERNAL=reserved")
      expect(remaining).toContain("UI_WS_TOKEN=tok")
    })
  })

  describe("darwin target (keychain) regression pin", () => {
    it("dry-run names the macOS keychain target, same plan shape as before", async () => {
      await writeEnv("OPENAI_API_KEY=sk-test\nLUNA_INTERNAL=x\n")
      const target = makeFakeTarget("keychain")
      const cap = captureLog()
      const code = await runCli(["--dry-run"], target)
      cap.restore()
      expect(code).toBe(0)
      expect(cap.lines.join("")).toContain("target: macOS keychain")
      expect(cap.lines.join("")).toContain("toCopy: [OPENAI_API_KEY]")
      expect(cap.lines.join("")).toContain("skippedReserved: [LUNA_INTERNAL]")
    })

    it("--apply copies eligible values into the fake keychain and leaves .env untouched", async () => {
      const body = "OPENAI_API_KEY=sk-test\nLUNA_INTERNAL=x\n"
      await writeEnv(body)
      const target = makeFakeTarget("keychain")
      const code = await runCli(["--apply", "--keep-env"], target)
      expect(code).toBe(0)
      expect(target.store.get("OPENAI_API_KEY")).toBe("sk-test")
      expect(target.store.has("LUNA_INTERNAL")).toBe(false)
      expect(await fsp.readFile(envPath, "utf8")).toBe(body)
    })

    it("--apply without --keep-env still refuses (copy-only guard unchanged)", async () => {
      await writeEnv("OPENAI_API_KEY=sk-test\n")
      const target = makeFakeTarget("keychain")
      const code = await runCli(["--apply"], target)
      expect(code).toBe(2)
      expect(target.store.size).toBe(0)
    })

    it("--prune-env removes only names confirmed readable from the fake keychain", async () => {
      const body = ["OPENAI_API_KEY=sk-test", "ANOTHER_KEY=still-here", ""].join(
        "\n",
      )
      await writeEnv(body)
      const target = makeFakeTarget("keychain")
      target.store.set("OPENAI_API_KEY", "sk-test")
      const code = await runCli(["--prune-env"], target)
      expect(code).toBe(0)
      const remaining = await fsp.readFile(envPath, "utf8")
      expect(remaining).not.toContain("OPENAI_API_KEY")
      expect(remaining).toContain("ANOTHER_KEY=still-here")
    })
  })

  it("readRuntimeEnvNames reads names from the overridden LUNA_HOME .env", async () => {
    await writeEnv("A=1\nB=2\n# comment\n")
    expect(readRuntimeEnvNames()).toEqual(["A", "B"])
  })
})
