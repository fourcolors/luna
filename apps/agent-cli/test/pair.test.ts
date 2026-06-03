import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { profileEnvPrefix } from "../src/chat/config.js"
import {
  lunaEnvPath,
  moonConnectionPath,
  upsertEnv,
  writeMoonConnection,
} from "../src/chat/pair-writers.js"
import {
  type PairVerify,
  isValidPairUrl,
  redactToken,
  runPair,
} from "../src/commands/pair.js"

const mode = (path: string): number => statSync(path).mode & 0o777

/** Seed an env file, creating its parent ~/.luna directory first. */
const seedEnv = (path: string, contents: string): void => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
}

describe("pair-writers: upsertEnv", () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "luna-pair-env-"))
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it("creates ~/.luna/.env and appends a new key when the file is absent", () => {
    upsertEnv(home, "LUNA_STABLE_WS_URL", "wss://host:4753/ui")
    const path = lunaEnvPath(home)
    expect(readFileSync(path, "utf8")).toBe("LUNA_STABLE_WS_URL=wss://host:4753/ui\n")
    expect(mode(path)).toBe(0o600)
  })

  it("replaces an existing key in place and preserves all other lines/keys", () => {
    const path = lunaEnvPath(home)
    // Seed an env with unrelated keys and the target key with an OLD value.
    seedEnv(
      path,
      [
        "# header comment",
        "LUNA_PROFILE=stable",
        "LUNA_STABLE_UI_WS_TOKEN=oldtoken",
        "LUNA_DEV_WS_URL=ws://127.0.0.1:4754/ui",
        "",
      ].join("\n"),
    )
    upsertEnv(home, "LUNA_STABLE_UI_WS_TOKEN", "newtoken")
    const out = readFileSync(path, "utf8")
    expect(out).toContain("# header comment")
    expect(out).toContain("LUNA_PROFILE=stable")
    expect(out).toContain("LUNA_DEV_WS_URL=ws://127.0.0.1:4754/ui")
    expect(out).toContain("LUNA_STABLE_UI_WS_TOKEN=newtoken")
    expect(out).not.toContain("oldtoken")
    // Replaced in place — only one occurrence of the key.
    expect(out.match(/^LUNA_STABLE_UI_WS_TOKEN=/gm)?.length).toBe(1)
    expect(mode(path)).toBe(0o600)
  })

  it("appends a new key while preserving existing ones", () => {
    const path = lunaEnvPath(home)
    seedEnv(path, "LUNA_PROFILE=stable\n")
    upsertEnv(home, "LUNA_STABLE_WS_URL", "wss://host:4753/ui")
    const out = readFileSync(path, "utf8")
    expect(out).toBe("LUNA_PROFILE=stable\nLUNA_STABLE_WS_URL=wss://host:4753/ui\n")
  })

  it("does not match a key that is only a prefix of another key", () => {
    const path = lunaEnvPath(home)
    // OTHER_LUNA_STABLE_WS_URL must NOT be matched by key LUNA_STABLE_WS_URL.
    seedEnv(path, "OTHER_LUNA_STABLE_WS_URL=keepme\n")
    upsertEnv(home, "LUNA_STABLE_WS_URL", "wss://host/ui")
    const out = readFileSync(path, "utf8")
    expect(out).toContain("OTHER_LUNA_STABLE_WS_URL=keepme")
    expect(out).toContain("LUNA_STABLE_WS_URL=wss://host/ui")
  })

  it("is idempotent across a token rotation (overwrites cleanly)", () => {
    upsertEnv(home, "LUNA_STABLE_UI_WS_TOKEN", "tokenA")
    upsertEnv(home, "LUNA_STABLE_UI_WS_TOKEN", "tokenB")
    const out = readFileSync(lunaEnvPath(home), "utf8")
    expect(out).toBe("LUNA_STABLE_UI_WS_TOKEN=tokenB\n")
  })
})

describe("pair-writers: writeMoonConnection", () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "luna-pair-moon-"))
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it("writes the exact camelCase shape Moon's Rust save_connection uses, mode 600", () => {
    writeMoonConnection(home, "wss://host:4753/ui", "secrettoken")
    const path = moonConnectionPath(home)
    const raw = readFileSync(path, "utf8")
    // Byte-match Rust serde_json::to_string WITHOUT preserve_order: compact,
    // keys in SORTED order (wsToken before wsUrl). See writeMoonConnection.
    expect(raw).toBe('{"wsToken":"secrettoken","wsUrl":"wss://host:4753/ui"}')
    expect(JSON.parse(raw)).toEqual({ wsUrl: "wss://host:4753/ui", wsToken: "secrettoken" })
    expect(mode(path)).toBe(0o600)
  })

  it("overwrites cleanly on a re-pair (rotation)", () => {
    writeMoonConnection(home, "wss://host/ui", "tokenA")
    writeMoonConnection(home, "wss://other/ui", "tokenB")
    expect(JSON.parse(readFileSync(moonConnectionPath(home), "utf8"))).toEqual({
      wsUrl: "wss://other/ui",
      wsToken: "tokenB",
    })
  })
})

describe("pair: isValidPairUrl", () => {
  it("accepts ws:// and wss:// URLs ending in /ui", () => {
    expect(isValidPairUrl("ws://127.0.0.1:4753/ui")).toBe(true)
    expect(isValidPairUrl("wss://jax-box:4753/ui")).toBe(true)
    expect(isValidPairUrl("wss://host/ui/")).toBe(true) // trailing slash tolerated
  })
  it("rejects non-ws schemes, missing /ui path, and garbage", () => {
    expect(isValidPairUrl("https://host/ui")).toBe(false)
    expect(isValidPairUrl("ws://host:4753")).toBe(false) // no /ui
    expect(isValidPairUrl("ws://host:4753/chat")).toBe(false)
    expect(isValidPairUrl("ws://host/ui/extra")).toBe(false)
    expect(isValidPairUrl("not a url")).toBe(false)
    expect(isValidPairUrl("")).toBe(false)
  })
})

describe("pair: redactToken", () => {
  it("shows only the first 6 chars + ellipsis and never the full token", () => {
    const tok = "supersecrettoken123456"
    const red = redactToken(tok)
    expect(red).toBe("supers…")
    expect(red).not.toContain("secret")
    expect(red.length).toBeLessThan(tok.length)
  })
  it("fully hides short tokens", () => {
    expect(redactToken("abc")).toBe("…")
    expect(redactToken("")).toBe("(empty)")
  })
})

describe("pair: runPair (verify injected, no live server)", () => {
  let home: string
  // A stub verify so tests never touch the network.
  const stubVerify: PairVerify = async ({ profileName }) => ({
    lines: [`STUBBED verify for ${profileName}`],
    tokenRejected: false,
  })

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "luna-pair-run-"))
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it("writes both config files with the profile-derived keys and mode 600", async () => {
    const res = await runPair(
      { url: "wss://host:4753/ui", token: "tok123456789" },
      { homeDir: home, cwd: home, env: {}, verify: stubVerify },
    )
    expect(res.exitCode).toBe(0)

    const prefix = profileEnvPrefix("stable")
    const env = readFileSync(lunaEnvPath(home), "utf8")
    expect(env).toContain(`${prefix}_WS_URL=wss://host:4753/ui`)
    expect(env).toContain(`${prefix}_UI_WS_TOKEN=tok123456789`)
    expect(mode(lunaEnvPath(home))).toBe(0o600)

    expect(JSON.parse(readFileSync(moonConnectionPath(home), "utf8"))).toEqual({
      wsUrl: "wss://host:4753/ui",
      wsToken: "tok123456789",
    })
    expect(mode(moonConnectionPath(home))).toBe(0o600)
  })

  it("honors a custom --profile for the env keys", async () => {
    await runPair(
      { url: "ws://127.0.0.1:4754/ui", token: "devtoken123", profile: "dev" },
      { homeDir: home, cwd: home, env: {}, verify: stubVerify },
    )
    const env = readFileSync(lunaEnvPath(home), "utf8")
    expect(env).toContain("LUNA_DEV_WS_URL=ws://127.0.0.1:4754/ui")
    expect(env).toContain("LUNA_DEV_UI_WS_TOKEN=devtoken123")
  })

  it("never prints the full token in its own messages", async () => {
    const res = await runPair(
      { url: "wss://host/ui", token: "supersecrettoken123456" },
      { homeDir: home, cwd: home, env: {}, verify: stubVerify },
    )
    const joined = res.lines.join("\n")
    expect(joined).not.toContain("supersecrettoken123456")
    expect(joined).toContain("supers…")
  })

  it("rejects a bad url with exit 2 and writes nothing", async () => {
    const res = await runPair(
      { url: "https://host/ui", token: "tok123456" },
      { homeDir: home, cwd: home, env: {}, verify: stubVerify },
    )
    expect(res.exitCode).toBe(2)
    expect(() => statSync(lunaEnvPath(home))).toThrow()
    expect(() => statSync(moonConnectionPath(home))).toThrow()
  })

  it("rejects an empty token with exit 2 and writes nothing", async () => {
    const res = await runPair(
      { url: "wss://host/ui", token: "   " },
      { homeDir: home, cwd: home, env: {}, verify: stubVerify },
    )
    expect(res.exitCode).toBe(2)
    expect(() => statSync(lunaEnvPath(home))).toThrow()
  })

  it("server DOWN (not token-rejected) → still exit 0: pairing is config, files written", async () => {
    // A correct pairing against a server that isn't running yet is a SUCCESSFUL
    // pair — you can pair before starting the server. Verify is advisory here.
    const serverDownVerify: PairVerify = async () => ({
      lines: ["[FAIL] L1 REACH server down"],
      tokenRejected: false,
    })
    const res = await runPair(
      { url: "wss://host/ui", token: "tok123456" },
      { homeDir: home, cwd: home, env: {}, verify: serverDownVerify },
    )
    expect(res.exitCode).toBe(0)
    expect(res.lines.join("\n")).toContain("✓ paired")
    // The write still happened.
    expect(statSync(lunaEnvPath(home)).isFile()).toBe(true)
    expect(statSync(moonConnectionPath(home)).isFile()).toBe(true)
  })

  it("token REJECTED by server → exit 1 (the pairing itself is wrong)", async () => {
    const rejectVerify: PairVerify = async () => ({
      lines: ["[FAIL] L2 TOKEN token REJECTED"],
      tokenRejected: true,
    })
    const res = await runPair(
      { url: "wss://host/ui", token: "wrongtok123" },
      { homeDir: home, cwd: home, env: {}, verify: rejectVerify },
    )
    expect(res.exitCode).toBe(1)
    expect(res.lines.join("\n")).toContain("REJECTED")
    // Files are still written (so a re-pair with the right token just overwrites).
    expect(statSync(lunaEnvPath(home)).isFile()).toBe(true)
    expect(statSync(moonConnectionPath(home)).isFile()).toBe(true)
  })

  it("re-pairing with a new token cleanly overwrites both files", async () => {
    await runPair(
      { url: "wss://host/ui", token: "oldtoken1" },
      { homeDir: home, cwd: home, env: {}, verify: stubVerify },
    )
    await runPair(
      { url: "wss://host/ui", token: "newtoken2" },
      { homeDir: home, cwd: home, env: {}, verify: stubVerify },
    )
    const env = readFileSync(lunaEnvPath(home), "utf8")
    expect(env).not.toContain("oldtoken1")
    expect(env).toContain("newtoken2")
    expect(env.match(/_UI_WS_TOKEN=/g)?.length).toBe(1)
    expect(JSON.parse(readFileSync(moonConnectionPath(home), "utf8")).wsToken).toBe("newtoken2")
  })
})
