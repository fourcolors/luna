/**
 * Scaffold-slice coverage for the deploy-cli entrypoint (S21): --version,
 * --help and the three stub subcommands that will eventually fold in
 * scripts/luna-update-server, scripts/luna-autodeploy and
 * scripts/luna-guardian (S22/S24). No deploy logic lives here yet - these
 * tests only pin the argv surface and the exit-code contract.
 */
import { spawnSync } from "node:child_process"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import pkg from "../package.json"
import { EXIT_CODES } from "../src/exit-codes.js"

const CLI_ENTRY = path.resolve(__dirname, "..", "src", "main.ts")

interface RunOut {
  status: number
  stdout: string
  stderr: string
}

// Deliberately does NOT strip NODE_ENV/TEST from the spawned child (vitest
// sets both, inherited by default): see docs/deploy-binary.md's "Operational
// gotcha" section - citty's own --version/--help handling goes silent under
// either, which is exactly why main.ts answers both without going through
// citty's consola-backed path at all. Running under vitest's own hostile
// environment is the regression lock for that fix, not something to avoid.
const runCli = (args: ReadonlyArray<string>): RunOut => {
  const r = spawnSync("bun", ["run", CLI_ENTRY, ...args], {
    encoding: "utf8",
    timeout: 15_000,
  })
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
}

const hasBun = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0
const d = hasBun ? describe : describe.skip

describe("EXIT_CODES", () => {
  // Locks the constants to the bash contract they must stay byte-identical
  // to (scripts/luna-update-server:171-184) so a future port cannot drift.
  it("matches the documented luna-update-server exit codes 0-4", () => {
    expect(EXIT_CODES.OK).toBe(0)
    expect(EXIT_CODES.ROLLED_BACK).toBe(1)
    expect(EXIT_CODES.CRITICAL).toBe(2)
    expect(EXIT_CODES.DEFERRED_SESSION_GUARD).toBe(3)
    expect(EXIT_CODES.DEFERRED_LOCK_CONTENTION).toBe(4)
  })

})

d("deploy-cli main", () => {
  it("--version prints the package version and exits 0", () => {
    const r = runCli(["--version"])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout.trim()).toBe(pkg.version)
  })

  it("--help lists all three stub surfaces and exits 0", () => {
    const r = runCli(["--help"])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain("update")
    expect(r.stdout).toContain("autodeploy")
    expect(r.stdout).toContain("guardian")
  })

  // `update` is NO LONGER on this list, and that is the whole point of S22d.
  // It was a stubSurface that exited CRITICAL saying "not implemented"; it is
  // now the real command, so the assertion below would fail against it. The
  // two remaining stubs stay here until their own slices land, which keeps
  // this test honest about exactly how much of the bash engine is ported.
  for (const surface of ["autodeploy", "guardian"] as const) {
    it(`${surface}: not implemented, exits CRITICAL (${EXIT_CODES.CRITICAL}), regardless of trailing args`, () => {
      const r = runCli([surface, "stable", "--some-flag", "value"])
      expect(r.status).toBe(EXIT_CODES.CRITICAL)
      expect(r.stderr).toContain(`deploy-cli ${surface}: not implemented`)
      expect(r.stdout).toBe("")
    })
  }

  /**
   * The inverse assertion, so "update is real" is pinned rather than merely
   * un-asserted. Deleting a stub test without adding this would leave the
   * surface untested in either direction, which is how a regression back to a
   * stub could ship unnoticed.
   *
   * The refusal it must NOT produce is the stub's; the refusal it SHOULD
   * produce is the engine's own, because no bash engine path is set in this
   * bare environment. Both are exit-code-bearing, so the string is what
   * distinguishes them.
   */
  it("update is the REAL command now, not a stub", () => {
    const r = runCli(["update", "--profile", "stable"])
    expect(r.stderr).not.toContain("deploy-cli update: not implemented")
    expect(r.status, `stderr: ${r.stderr}`).not.toBe(EXIT_CODES.CRITICAL)
  })

  it("an unknown top-level subcommand exits 1", () => {
    const r = runCli(["bogus"])
    expect(r.status).toBe(1)
  })

  it("no arguments exits 1 (no fallthrough to any stub)", () => {
    const r = runCli([])
    expect(r.status).toBe(1)
  })
})

d("deploy-cli compiled binary (matches the S21 verification command)", () => {
  it("bun build --compile produces a working single-file executable", () => {
    const outfile = path.join(tmpdir(), `deploy-cli-test-${process.pid}-${Date.now()}`)
    // Neither the build step nor the run step strips NODE_ENV/TEST - see
    // runCli's comment above: main.ts answers --version without going
    // through citty's consola-backed path, so building AND running under
    // vitest's own NODE_ENV=test is the regression lock, not a hazard to
    // avoid.
    const build = spawnSync(
      "bun",
      ["build", "--compile", `--outfile=${outfile}`, "src/main.ts"],
      { cwd: path.resolve(__dirname, ".."), encoding: "utf8", timeout: 60_000 },
    )
    try {
      expect(build.status, build.stdout + build.stderr).toBe(0)
      const run = spawnSync(outfile, ["--version"], { encoding: "utf8" })
      expect(run.status, run.stderr).toBe(0)
      expect(run.stdout.trim()).toBe(pkg.version)
    } finally {
      rmSync(outfile, { force: true })
    }
  })
})
