/**
 * `luna account` CLI tests — Phase 25b.
 *
 * The CLI binary imports `bun:sqlite` directly, so we exercise it as a
 * subprocess under `bun`. This works regardless of whether the test
 * runner itself is bun or node-vitest, as long as `bun` is on PATH.
 *
 * Each test runs against a fresh temp DB via the `LUNA_DB_PATH` env var
 * (mirrors the `--db-path` flag — both supported, env var simpler for
 * subprocess tests).
 */
import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

const CLI_ENTRY = path.resolve(__dirname, "..", "src", "luna.ts")

interface RunOut {
  status: number
  stdout: string
  stderr: string
}

const runCli = (args: ReadonlyArray<string>, dbPath: string): RunOut => {
  const r = spawnSync("bun", ["run", CLI_ENTRY, "account", ...args], {
    encoding: "utf8",
    env: { ...process.env, LUNA_DB_PATH: dbPath },
    timeout: 15_000,
  })
  return {
    status: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  }
}

const tmpDb = (): string =>
  path.join(
    os.tmpdir(),
    `luna-cli-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  )

const cleanup = (p: string) => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(p + suffix)
    } catch {
      /* ignore */
    }
  }
}

const hasBun = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0
const d = hasBun ? describe : describe.skip

d("luna account CLI", () => {
  let db: string
  beforeEach(() => {
    db = tmpDb()
  })
  afterEach(() => {
    cleanup(db)
  })

  it("add → list happy path: row appears with all fields", () => {
    const ref = "op://vault/item/credential"
    const add = runCli(
      [
        "add",
        "--id",
        "operator",
        "--label",
        "Operator",
        "--kind",
        "anthropic",
        "--secret-ref",
        ref,
      ],
      db,
    )
    expect(add.status, add.stderr).toBe(0)
    expect(add.stdout).toContain("added account id=operator kind=anthropic")

    const list = runCli(["list"], db)
    expect(list.status, list.stderr).toBe(0)
    expect(list.stdout).toContain("operator")
    expect(list.stdout).toContain("Operator")
    expect(list.stdout).toContain("anthropic")
    expect(list.stdout).toContain(ref)
  })

  it("add rejects empty --id", () => {
    const r = runCli(
      [
        "add",
        "--id",
        "",
        "--label",
        "x",
        "--kind",
        "anthropic",
        "--secret-ref",
        "op://a/b/c",
      ],
      db,
    )
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/--id/)
  })

  it("add rejects missing --label", () => {
    const r = runCli(
      [
        "add",
        "--id",
        "x",
        "--kind",
        "anthropic",
        "--secret-ref",
        "op://a/b/c",
      ],
      db,
    )
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/--label/)
  })

  it("add rejects empty --secret-ref", () => {
    const r = runCli(
      [
        "add",
        "--id",
        "x",
        "--label",
        "x",
        "--kind",
        "anthropic",
        "--secret-ref",
        "",
      ],
      db,
    )
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/--secret-ref/)
  })

  it("add rejects --kind outside allowlist", () => {
    const r = runCli(
      [
        "add",
        "--id",
        "x",
        "--label",
        "x",
        "--kind",
        "bogus",
        "--secret-ref",
        "op://a/b/c",
      ],
      db,
    )
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/invalid --kind/)
  })

  it("add accepts tool-<name> and mcp-<name> kinds", () => {
    const a = runCli(
      [
        "add",
        "--id",
        "t1",
        "--label",
        "T1",
        "--kind",
        "tool-search",
        "--secret-ref",
        "env:TOOL_TOKEN",
      ],
      db,
    )
    expect(a.status, a.stderr).toBe(0)
    const b = runCli(
      [
        "add",
        "--id",
        "m1",
        "--label",
        "M1",
        "--kind",
        "mcp-memory",
        "--secret-ref",
        "env:MCP_MEMORY_TOKEN",
      ],
      db,
    )
    expect(b.status, b.stderr).toBe(0)
  })

  it("add rejects --secret-ref without supported scheme", () => {
    const r = runCli(
      [
        "add",
        "--id",
        "x",
        "--label",
        "x",
        "--kind",
        "anthropic",
        "--secret-ref",
        "sk-ant-oat-totally-bogus-but-looks-like-a-token",
      ],
      db,
    )
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/invalid --secret-ref/)
  })

  it("list on empty db prints 'no accounts' and exits 0", () => {
    const r = runCli(["list"], db)
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/no accounts/)
  })

  it("list never resolves secrets — output contains the pointer, not a token shape", () => {
    runCli(
      [
        "add",
        "--id",
        "operator",
        "--label",
        "Operator",
        "--kind",
        "anthropic",
        "--secret-ref",
        "op://vault/item/credential",
      ],
      db,
    )
    const list = runCli(["list"], db)
    expect(list.status, list.stderr).toBe(0)
    // Pointer shows verbatim
    expect(list.stdout).toContain("op://vault/item/credential")
    // No resolved-token shape
    expect(list.stdout).not.toMatch(/sk-ant-/)
    // No 30+ char alphanumeric blob (would-be token)
    expect(list.stdout).not.toMatch(/[A-Za-z0-9_-]{30,}/)
  })

  it("rm --id <missing> exits 1 with helpful stderr", () => {
    const r = runCli(["rm", "--id", "ghost"], db)
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/no such account: ghost/)
  })

  it("rm --id <existing> happy path", () => {
    runCli(
      [
        "add",
        "--id",
        "operator",
        "--label",
        "Operator",
        "--kind",
        "anthropic",
        "--secret-ref",
        "op://a/b/c",
      ],
      db,
    )
    const rm = runCli(["rm", "--id", "operator"], db)
    expect(rm.status, rm.stderr).toBe(0)
    expect(rm.stdout).toMatch(/removed account id=operator/)
    const list = runCli(["list"], db)
    expect(list.stdout).toMatch(/no accounts/)
  })

  it("add rejects duplicate id with exit 1", () => {
    const args = [
      "add",
      "--id",
      "dup",
      "--label",
      "Dup",
      "--kind",
      "anthropic",
      "--secret-ref",
      "op://a/b/c",
    ]
    const a = runCli(args, db)
    expect(a.status, a.stderr).toBe(0)
    const b = runCli(args, db)
    expect(b.status).toBe(1)
    expect(b.stderr).toMatch(/already exists/)
  })

  it("unknown subcommand exits 1", () => {
    const r = runCli(["wat"], db)
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/Unknown command/)
  })

  // ── Phase 25d: luna-op:// + env: validator cases ──────────────────────

  const addRefArgs = (ref: string): ReadonlyArray<string> => [
    "add",
    "--id",
    "x",
    "--label",
    "x",
    "--kind",
    "anthropic",
    "--secret-ref",
    ref,
  ]

  it("add accepts luna-op://<label>/<rest>", () => {
    const r = runCli(addRefArgs("luna-op://flow/v/i/credential"), db)
    expect(r.status, r.stderr).toBe(0)
  })

  it("add accepts luna-op://<label>/<vault>/<item>/<section>/<field>", () => {
    const r = runCli(addRefArgs("luna-op://primary/v/i/sec/f"), db)
    expect(r.status, r.stderr).toBe(0)
  })

  it("add rejects luna-op:// with empty rest", () => {
    const r = runCli(addRefArgs("luna-op://flow/"), db)
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/invalid --secret-ref/)
  })

  it("add rejects luna-op:// with no slash", () => {
    const r = runCli(addRefArgs("luna-op://flow"), db)
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/invalid --secret-ref/)
  })

  it("add rejects luna-op:// with reserved label (env)", () => {
    const r = runCli(addRefArgs("luna-op://env/v/i/f"), db)
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/invalid --secret-ref/)
  })

  it("add rejects luna-op:// with reserved label (file)", () => {
    const r = runCli(addRefArgs("luna-op://file/v/i/f"), db)
    expect(r.status).toBe(1)
  })

  it("add rejects luna-op:// with reserved label (op)", () => {
    const r = runCli(addRefArgs("luna-op://op/v/i/f"), db)
    expect(r.status).toBe(1)
  })

  it("add rejects luna-op:// with uppercase label", () => {
    const r = runCli(addRefArgs("luna-op://Bad/v/i/f"), db)
    expect(r.status).toBe(1)
  })

  it("add rejects luna-op:// with space in label", () => {
    const r = runCli(addRefArgs("luna-op://Example Vault/v/i/f"), db)
    expect(r.status).toBe(1)
  })

  it("add rejects env://VAR (legacy bug — env: is the canonical form)", () => {
    const r = runCli(addRefArgs("env://FOO"), db)
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/invalid --secret-ref/)
  })

  it("add accepts env:VAR (one colon, no slashes)", () => {
    const r = runCli(addRefArgs("env:CLAUDE_TOKEN"), db)
    expect(r.status, r.stderr).toBe(0)
  })

  it("add accepts claude-code:login", () => {
    const r = runCli(addRefArgs("claude-code:login"), db)
    expect(r.status, r.stderr).toBe(0)
  })

  it("add rejects env: with slash in name", () => {
    const r = runCli(addRefArgs("env:FOO/BAR"), db)
    expect(r.status).toBe(1)
  })

  it("add rejects file:<path> with an actionable message", () => {
    const r = runCli(addRefArgs("file:/tmp/x"), db)
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(
      /file: refs are not resolvable by the Luna server/,
    )
    expect(r.stderr).toMatch(/env:NAME/)
    expect(r.stderr).toMatch(/luna-op:\/\/<label>/)
  })

  it("add rejects file:///<path> with an actionable message", () => {
    const r = runCli(addRefArgs("file:///tmp/x"), db)
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(
      /file: refs are not resolvable by the Luna server/,
    )
  })
})
