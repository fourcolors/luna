/**
 * Unit cover for commands.ts (S22d PR2): every mutating argv the inplace
 * update transaction can issue, asserted against a literal.
 *
 * WHAT THIS SUITE PROVES AND WHAT IT DOES NOT. For the plain builders it is
 * DOCUMENTATION: a human wrote both the builder and the expectation, so
 * agreeing with itself proves only that nobody changed one without the other.
 * The real proof that these bytes match the bash is the argv byte diff in the
 * dual-drive parity suites, which run both engines and compare `git.log`,
 * `bun.log` and `incus.log`.
 *
 * The `incusRepinPayload` block IS a proof, and it is the reason this file
 * exists rather than being folded into flow-lines.test.ts: it reads
 * scripts/luna-update-server at test time and derives the expected bytes from
 * the source, so a future edit to the re-pin cannot land without either
 * updating commands.ts or failing here.
 *
 * PURE AND PORTABLE. No spawn, no temp dirs, no platform behaviour: the only
 * IO is one `readFileSync` of a file that is in the repository. Nothing here
 * depends on macOS, on this developer machine, or on anything being installed.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  bunInstallArgv,
  bunRunArgv,
  gitFetchOriginArgs,
  gitHashObjectArgv,
  gitResetHardArgs,
  gitRevParseCommitArgs,
  gitRevParseHeadArgs,
  incusRepinArgv,
  incusRepinPayload,
  nodeModulesTestArgv,
} from "../../src/update/commands.js"
import { repoRoot } from "./temp-dirs.js"

const UPDATE_SERVER = join(repoRoot, "scripts/luna-update-server")

/** 1-based, matching how the bash is cited everywhere in this port. */
const bashLine = (n: number): string => {
  const lines = readFileSync(UPDATE_SERVER, "utf8").split(/\r?\n/)
  const line = lines[n - 1]
  if (line === undefined) throw new Error(`scripts/luna-update-server has no line ${n}`)
  return line
}

describe("git argument tails (after target.ts's -C / --git-dir prefix)", () => {
  it("fetches origin (:1175, :1974)", () => {
    expect(gitFetchOriginArgs).toEqual(["fetch", "origin"])
  })

  it("resets hard to the target verbatim, with no case normalisation (:1177)", () => {
    expect(gitResetHardArgs("A1B2C3D")).toEqual(["reset", "--hard", "A1B2C3D"])
    expect(gitResetHardArgs(["0123456789abcdef0123", "456789abcdef01234567"].join(""))).toEqual([
      "reset", "--hard", ["0123456789abcdef0123", "456789abcdef01234567"].join(""),
    ])
  })

  it("reads HEAD (:1189, :1964, :2040)", () => {
    expect(gitRevParseHeadArgs).toEqual(["rev-parse", "HEAD"])
  })

  it("peels a non-hex ref to a commit, with ^{commit} inside the same argument (:1992)", () => {
    // One argument, not three: bash interpolates the suffix inside the same
    // double-quoted word, and the braces are literal bytes git parses.
    expect(gitRevParseCommitArgs("origin/master")).toEqual(["rev-parse", "origin/master^{commit}"])
    expect(gitRevParseCommitArgs("v1.2.3")).toEqual(["rev-parse", "v1.2.3^{commit}"])
  })
})

describe("lockfile hash (:538-544)", () => {
  it("is a plain host-side `git -C`, naming its own binary rather than routing through git_target", () => {
    expect(gitHashObjectArgv("/srv/luna/repo")).toEqual([
      "git", "-C", "/srv/luna/repo", "hash-object", "/srv/luna/repo/bun.lock",
    ])
  })

  it("concatenates the path with a literal slash and never normalises it", () => {
    // bash writes "$HOST_REPO_DIR/bun.lock", which does no normalisation at
    // all. path.join would collapse the doubled slash below, changing argv
    // bytes an operator diffs against a bash host.
    expect(gitHashObjectArgv("/srv/luna/repo/")).toEqual([
      "git", "-C", "/srv/luna/repo/", "hash-object", "/srv/luna/repo//bun.lock",
    ])
  })
})

describe("run_target argv (container-routed when a container is set)", () => {
  it("installs frozen against the CONTAINER repo dir (:1206)", () => {
    expect(bunInstallArgv("/root/.bun/bin/bun", "/root/luna")).toEqual([
      "/root/.bun/bin/bun", "install", "--cwd", "/root/luna", "--frozen-lockfile",
    ])
  })

  it("probes node_modules with an external test(1), against the CONTAINER repo dir (:1210)", () => {
    expect(nodeModulesTestArgv("/root/luna")).toEqual(["test", "-d", "/root/luna/node_modules"])
  })

  it("seeds the dream/wake rows with a CONTAINER-relative script path (:1719)", () => {
    expect(bunRunArgv("/root/.bun/bin/bun", "/root/luna/apps/server/scripts/install-dream-wake.ts")).toEqual([
      "/root/.bun/bin/bun", "run", "/root/luna/apps/server/scripts/install-dream-wake.ts",
    ])
  })
})

describe("the incus claude re-pin, against the bash source (:1236-1237)", () => {
  /**
   * THE EXTRACTION RULE, written out because the naive form of this test
   * cannot pass: line 1237 is a double-quoted BASH LITERAL, not the payload
   * bytes. It carries six characters of leading indentation, an opening and a
   * closing `"`, a trailing ` ||`, and three `\$` escapes that bash strips
   * before `bash -lc` ever sees the string.
   *
   * So, in this order, and NOTHING else:
   *   1. strip leading whitespace
   *   2. strip the trailing ` ||`
   *   3. assert the remainder starts and ends with `"`, and strip both
   *   4. replace every `\$` with `$`
   *
   * Step 5 then asserts NO other backslash survives, so a future edit to :1237
   * that introduces `\"` or `\\` fails here loudly instead of being silently
   * mis-extracted into a payload that looks plausible and is wrong.
   */
  const extractPayload = (raw: string): string => {
    const noIndent = raw.replace(/^\s+/, "")
    expect(noIndent.endsWith(" ||")).toBe(true)
    const noTrailer = noIndent.slice(0, -" ||".length)
    expect(noTrailer.startsWith('"')).toBe(true)
    expect(noTrailer.endsWith('"')).toBe(true)
    const inner = noTrailer.slice(1, -1)
    const unescaped = inner.replaceAll("\\$", "$")
    expect(unescaped).not.toContain("\\")
    return unescaped
  }

  it("is anchored on the right two lines, so a shifted file fails loudly rather than mis-extracting", () => {
    // Cheap guard: if the script moves, these assertions name the problem
    // instead of the payload comparison reporting a mystery diff.
    expect(bashLine(1236).trim()).toBe("run_target bash -lc \\")
    expect(bashLine(1237)).toContain("luna_configure_claude_executable")
  })

  it("reproduces the payload byte for byte", () => {
    expect(incusRepinPayload).toBe(extractPayload(bashLine(1237)))
  })

  it("keeps the container-hardcoded paths and the exit 9 sentinel", () => {
    // Named separately from the byte compare so a templatised regression reads
    // as "you parameterised the container paths", not as an opaque diff.
    expect(incusRepinPayload).toContain("/root/luna/scripts/lib/luna-deploy.sh")
    expect(incusRepinPayload).toContain("/root/.luna/.env")
    expect(incusRepinPayload).toContain("|| exit 9; }")
  })

  it("is passed as exactly three arguments, the payload being ONE of them", () => {
    // Boundaries matter as much as bytes: a port that joined these into a
    // shell string would hand `incus exec` a payload it re-splits on spaces.
    expect(incusRepinArgv).toEqual(["bash", "-lc", incusRepinPayload])
    expect(incusRepinArgv).toHaveLength(3)
  })
})

describe("every builder is a pure argv of non-empty strings", () => {
  it("emits no empty or non-string elements", () => {
    const all: ReadonlyArray<ReadonlyArray<string>> = [
      gitFetchOriginArgs,
      gitResetHardArgs("abc1234"),
      gitRevParseHeadArgs,
      gitRevParseCommitArgs("main"),
      gitHashObjectArgv("/repo"),
      bunInstallArgv("bun", "/repo"),
      nodeModulesTestArgv("/repo"),
      bunRunArgv("bun", "s.ts"),
      incusRepinArgv,
    ]
    for (const argv of all) {
      for (const arg of argv) {
        expect(typeof arg).toBe("string")
        expect(arg).not.toBe("")
      }
    }
  })
})
