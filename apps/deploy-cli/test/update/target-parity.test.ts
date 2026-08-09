/**
 * Golden parity for the execution waist (S22d): every scenario runs the REAL
 * `run_target` / `run_target_capture` / `git_target` / `git_target_capture` out
 * of scripts/luna-update-server and the TypeScript port over identical inputs,
 * then asserts BOTH agree on the exit code AND on stdout byte for byte.
 *
 * WHAT IS ACTUALLY BEING DIFFED. The waist's whole job is deciding which argv
 * gets executed - `incus exec <ctr> -- <cmd>` or `<cmd>`, `git -C <host repo>`
 * or `git --git-dir <mirror>` - and that decision leaves no artifact of its own
 * to inspect. So the stub commands print their OWN argv back, one
 * angle-bracketed token per argument (`PAYLOAD <a> <b>`), which makes both the
 * argument VALUES and the argument BOUNDARIES diffable: a port that joined
 * argv into one shell string, dropped the `--` separator, or wrapped git in
 * `incus exec` shows up here as a stdout mismatch rather than as a mystery on
 * a live host.
 *
 * HOW THE BASH SIDE IS DRIVEN, and why it needs no container and no repo. The
 * four functions are extracted from the script by awk and eval'd into a shell
 * that has sourced the REAL scripts/lib/luna-deploy.sh (so `luna_run` is the
 * genuine article, dry-run printing included) and defined `incus`, `git` and
 * `payload` as shell FUNCTIONS. Bash resolves `"$@"` against functions before
 * PATH, so the extracted code calls the stubs without knowing it - the same
 * technique rollback-parity.test.ts and readiness-parity.test.ts use for their
 * collaborators, and the reason this suite needs no incus daemon, no systemd
 * and no git checkout.
 *
 * THE THREE CLAIMS THIS SUITE EXISTS TO PIN:
 *   1. git NEVER routes through incus, even with a container set
 *      (scripts/luna-update-server:373-383). A port that "helpfully" wrapped it
 *      would operate on the in-container path against a container with no git.
 *   2. The CAPTURE arms ignore dry-run (:365-371, :392-398), because the
 *      transaction branches on what they read back. A dry-run-aware capture
 *      returns "" to a caller parsing a build sha.
 *   3. luna_run's dry-run line is byte-exact, `%q` quoting and all
 *      (scripts/lib/luna-deploy.sh:9-15) - an operator diffs it against a bash
 *      host's output literally, so the last describe block below drives a
 *      quoting corpus through the real bash rather than trusting the port.
 */
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { readFileSync, writeFileSync } from "node:fs"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  type CommandResult,
  type Layout,
  type TargetContext,
  defaultSpawnTarget,
  gitArgv,
  gitTargetCaptureSync,
  gitTargetSync,
  lunaRunLine,
  quoteForLunaRun,
  runTargetCaptureSync,
  runTargetSync,
} from "../../src/update/target.js"
import { stripTrailingNewlines } from "../../src/update/session-guard.js"
import { cleanupTempDirs, makeTempDir, repoRoot } from "./temp-dirs.js"

const UPDATE_SERVER = join(repoRoot, "scripts/luna-update-server")
const DEPLOY_LIB = join(repoRoot, "scripts/lib/luna-deploy.sh")

const HOST_REPO = "/root/luna/stable/repo"
const MIRROR = "/srv/luna/stable/mirror.git"
const CONTAINER = "luna-stable"

type Arm = "run_target" | "run_target_capture" | "git_target" | "git_target_capture"

interface Scenario {
  readonly arm: Arm
  /**
   * For the run_* arms this is the whole command (argv[0] included); for the
   * git_* arms it is only what follows the `-C <repo>` / `--git-dir <mirror>`
   * prefix the waist contributes, matching each bash call site.
   */
  readonly args: ReadonlyArray<string>
  readonly incusContainer?: string
  readonly dryRun?: boolean
  readonly layout?: Layout
  /** What the stub command exits with, so exit-code propagation is proven rather than assumed. */
  readonly exitCode?: number
  /** Overrides the fixed MIRROR default; used only by the unset-MIRROR_GIT scenario below. */
  readonly mirrorGit?: string
}

const isCapture = (arm: Arm): boolean => arm === "run_target_capture" || arm === "git_target_capture"

const ctxOf = (s: Scenario): Omit<TargetContext, "spawn" | "writeStdout"> => ({
  incusContainer: s.incusContainer ?? "",
  dryRun: s.dryRun ?? false,
  layout: s.layout ?? "inplace",
  hostRepoDir: HOST_REPO,
  mirrorGit: s.mirrorGit ?? MIRROR,
})

/** POSIX single-quote escaping, so a scenario argument reaches bash as itself no matter what it contains. */
const sq = (value: string): string => `'${value.split("'").join(`'\\''`)}'`

/**
 * The stub commands' self-report. Both drives must produce this identically:
 * bash from inside the stub shell function, the port from the argv handed to
 * its injected spawn.
 */
const renderArgv = (argv: ReadonlyArray<string>): string => {
  const head = (argv[0] ?? "").toUpperCase()
  return `${head}${argv.slice(1).map((a) => ` <${a}>`).join("")}\n`
}

const runBash = (s: Scenario): { readonly rc: number; readonly stdout: string } => {
  const ctx = ctxOf(s)
  const stub = (name: string): string =>
    `${name}() { printf '%s' ${sq(name.toUpperCase())}; for a in "$@"; do printf ' <%s>' "$a"; done; printf '\\n'; return $EXIT_CODE; }`
  const invoke = isCapture(s.arm)
    ? `out="$(${s.arm} ${s.args.map(sq).join(" ")})"; rc=$?`
    : `${s.arm} ${s.args.map(sq).join(" ")}; rc=$?`
  const script = [
    "set -uo pipefail",
    `source ${sq(DEPLOY_LIB)}`,
    `INCUS_CONTAINER=${sq(ctx.incusContainer)}`,
    `DRY_RUN=${ctx.dryRun}`,
    `LAYOUT=${sq(ctx.layout)}`,
    `HOST_REPO_DIR=${sq(ctx.hostRepoDir)}`,
    `MIRROR_GIT=${sq(ctx.mirrorGit ?? "")}`,
    `EXIT_CODE=${s.exitCode ?? 0}`,
    // Shell functions, not files on PATH: bash resolves `"$@"` against these
    // first, so the extracted waist calls them without knowing.
    stub("payload"),
    stub("incus"),
    stub("git"),
    `eval "$(awk '/^${s.arm}\\(\\)/{f=1} f{print} f && /^}$/{exit}' ${sq(UPDATE_SERVER)})"`,
    invoke,
    `printf 'RC=%s\\n' "$rc"`,
    ...(isCapture(s.arm) ? [`printf 'OUT=[%s]\\n' "$out"`] : []),
  ].join("\n")

  const r = spawnSync("bash", ["-c", script], { encoding: "utf8" })
  if ((r.status ?? 1) !== 0) throw new Error(`bash driver failed (${r.status}): ${r.stderr ?? ""}`)
  const out = r.stdout ?? ""
  const rcMatch = /^RC=(-?\d+)$/m.exec(out)
  if (rcMatch === null) throw new Error(`bash driver produced no RC line: ${JSON.stringify(out)}`)
  return { rc: Number(rcMatch[1]), stdout: out }
}

const runTs = (s: Scenario): { readonly rc: number; readonly stdout: string } => {
  let out = ""
  const ctx: TargetContext = {
    ...ctxOf(s),
    writeStdout: (text) => { out += text },
    spawn: (argv, opts) => {
      const rendered = renderArgv(argv)
      // Non-capture children write straight to the engine's stdout; captured
      // ones do not, exactly as `$( )` swallows it on the bash side.
      if (!opts.capture) out += rendered
      return { status: s.exitCode ?? 0, stdout: opts.capture ? rendered : "" }
    },
  }
  const result: CommandResult =
    s.arm === "run_target" ? runTargetSync(ctx, s.args)
    : s.arm === "run_target_capture" ? runTargetCaptureSync(ctx, s.args)
    : s.arm === "git_target" ? gitTargetSync(ctx, s.args)
    : gitTargetCaptureSync(ctx, s.args)

  const rc = result.status ?? 1
  out += `RC=${rc}\n`
  // `$( )` strips trailing newlines - the port deliberately does not, so the
  // harness applies the same helper every production caller is told to use.
  if (isCapture(s.arm)) out += `OUT=[${stripTrailingNewlines(result.stdout)}]\n`
  return { rc, stdout: out }
}

const parity = (name: string, s: Scenario, expect_: { readonly rc?: number; readonly stdoutMatch?: RegExp }): void => {
  it(name, () => {
    const bash = runBash(s)
    const ts = runTs(s)
    expect(ts.rc, "exit code").toBe(bash.rc)
    // The assertion that matters: identical resolved argv, identical dry-run
    // transcript, identical capture.
    expect(ts.stdout).toBe(bash.stdout)
    if (expect_.rc !== undefined) expect(bash.rc).toBe(expect_.rc)
    if (expect_.stdoutMatch !== undefined) expect(bash.stdout).toMatch(expect_.stdoutMatch)
  })
}

describe("execution waist: golden parity with scripts/luna-update-server", () => {
  afterEach(cleanupTempDirs)

  describe("run_target - the mutating arm", () => {
    parity(
      "bare host runs the command directly",
      { arm: "run_target", args: ["payload", "install", "--frozen-lockfile"] },
      { rc: 0, stdoutMatch: /^PAYLOAD <install> <--frozen-lockfile>\n/ },
    )

    parity(
      "an incus container wraps it in `incus exec <ctr> -- ...`",
      { arm: "run_target", args: ["payload", "install", "--frozen-lockfile"], incusContainer: CONTAINER },
      { rc: 0, stdoutMatch: /^INCUS <exec> <luna-stable> <--> <payload> <install> <--frozen-lockfile>\n/ },
    )

    parity(
      "a failing command's exit code propagates (bare host)",
      { arm: "run_target", args: ["payload", "install"], exitCode: 7 },
      { rc: 7 },
    )

    parity(
      "a failing command's exit code propagates through incus exec",
      { arm: "run_target", args: ["payload", "install"], incusContainer: CONTAINER, exitCode: 7 },
      { rc: 7 },
    )

    parity(
      "argument boundaries survive: a payload argument containing spaces stays ONE argument",
      { arm: "run_target", args: ["payload", "bash", "-lc", "command -v claude >/dev/null 2>&1"], incusContainer: CONTAINER },
      { rc: 0, stdoutMatch: /<bash> <-lc> <command -v claude >\/dev\/null 2>&1>\n/ },
    )
  })

  describe("run_target - dry-run prints and executes nothing", () => {
    parity(
      "bare host prints the luna_run line",
      { arm: "run_target", args: ["payload", "install", "--frozen-lockfile"], dryRun: true },
      { rc: 0, stdoutMatch: /^\+ payload install --frozen-lockfile\nRC=0\n$/ },
    )

    parity(
      "the printed line carries the incus prefix, since luna_run receives the WRAPPED command",
      { arm: "run_target", args: ["payload", "install"], incusContainer: CONTAINER, dryRun: true },
      { rc: 0, stdoutMatch: /^\+ incus exec luna-stable -- payload install\nRC=0\n$/ },
    )

    // A command that would have failed still reports success: nothing ran.
    parity(
      "a would-be-failing command is not executed and reports 0",
      { arm: "run_target", args: ["payload", "install"], dryRun: true, exitCode: 7 },
      { rc: 0 },
    )
  })

  describe("dry-run's default write sink (no injected writeStdout)", () => {
    // Every golden-parity scenario above supplies ctx.writeStdout itself, so
    // none of them exercise the DEFAULT sink `writeOf` falls back to. bash's
    // luna_run prints to its own stdout (scripts/lib/luna-deploy.sh:9), and an
    // operator piping a real run's stdout to a log file must still see the
    // dry-run transcript there, not on stderr where it would be invisible to
    // that pipe.
    it("runTargetSync writes the dry-run line to the process's real stdout, not stderr", () => {
      const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
      try {
        const ctx: TargetContext = { incusContainer: "", dryRun: true, layout: "inplace", hostRepoDir: HOST_REPO }
        const r = runTargetSync(ctx, ["payload", "install"])
        expect(r).toEqual({ status: 0, stdout: "" })
        expect(stdoutSpy).toHaveBeenCalledWith("+ payload install\n")
        expect(stderrSpy).not.toHaveBeenCalled()
      } finally {
        stdoutSpy.mockRestore()
        stderrSpy.mockRestore()
      }
    })

    it("gitTargetSync writes the dry-run line to the process's real stdout, not stderr", () => {
      const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
      try {
        const ctx: TargetContext = { incusContainer: "", dryRun: true, layout: "inplace", hostRepoDir: HOST_REPO }
        gitTargetSync(ctx, ["fetch", "origin"])
        expect(stdoutSpy).toHaveBeenCalledWith(`+ git -C ${HOST_REPO} fetch origin\n`)
        expect(stderrSpy).not.toHaveBeenCalled()
      } finally {
        stdoutSpy.mockRestore()
        stderrSpy.mockRestore()
      }
    })
  })

  describe("run_target_capture - the read-only probe arm", () => {
    parity(
      "bare host captures stdout",
      { arm: "run_target_capture", args: ["payload", "systemctl", "is-active"] },
      { rc: 0, stdoutMatch: /OUT=\[PAYLOAD <systemctl> <is-active>\]/ },
    )

    parity(
      "incus routes the probe INTO the container",
      { arm: "run_target_capture", args: ["payload", "curl", "-fsS"], incusContainer: CONTAINER },
      { rc: 0, stdoutMatch: /OUT=\[INCUS <exec> <luna-stable> <--> <payload> <curl> <-fsS>\]/ },
    )

    // CLAIM 2. The capture arms never consult DRY_RUN: they run for real, and
    // the transaction branches on what they read back.
    parity(
      "dry-run does NOT suppress the probe (no luna_run gate on this arm)",
      { arm: "run_target_capture", args: ["payload", "curl", "-fsS"], dryRun: true },
      { rc: 0, stdoutMatch: /OUT=\[PAYLOAD <curl> <-fsS>\]/ },
    )

    parity(
      "a probe's exit code propagates",
      { arm: "run_target_capture", args: ["payload", "is-failed"], exitCode: 3 },
      { rc: 3 },
    )
  })

  describe("git_target - always host-side", () => {
    parity(
      "inplace addresses the host checkout with -C",
      { arm: "git_target", args: ["fetch", "origin"] },
      { rc: 0, stdoutMatch: /^GIT <-C> <\/root\/luna\/stable\/repo> <fetch> <origin>\n/ },
    )

    // CLAIM 1. The load-bearing one: a container is set, and git STILL runs on
    // the host with the HOST path.
    parity(
      "an incus container does NOT wrap git",
      { arm: "git_target", args: ["fetch", "origin"], incusContainer: CONTAINER },
      { rc: 0, stdoutMatch: /^GIT <-C> <\/root\/luna\/stable\/repo> <fetch> <origin>\nRC=0\n$/ },
    )

    parity(
      "releases addresses the bare mirror with --git-dir",
      { arm: "git_target", args: ["fetch", "origin"], layout: "releases" },
      { rc: 0, stdoutMatch: /^GIT <--git-dir> <\/srv\/luna\/stable\/mirror\.git> <fetch> <origin>\n/ },
    )

    parity(
      "releases under incus is still host-side",
      { arm: "git_target", args: ["fetch", "origin"], layout: "releases", incusContainer: CONTAINER },
      { rc: 0, stdoutMatch: /^GIT <--git-dir> </ },
    )

    // A releases context minted before MIRROR_GIT is populated (scripts/
    // luna-update-server:206 initialises it to "") must reproduce bash's own
    // behaviour - an empty --git-dir argument that git itself will reject -
    // rather than the waist inventing a refusal bash never makes. This is the
    // waist's documented job: diff against the oracle, not validate.
    parity(
      "an unset MIRROR_GIT reaches git as an empty --git-dir argument, exactly as bash sends it",
      { arm: "git_target", args: ["fetch", "origin"], layout: "releases", mirrorGit: "" },
      { rc: 0, stdoutMatch: /^GIT <--git-dir> <> <fetch> <origin>\n/ },
    )

    it("gitArgv itself never throws on a releases context built without mirrorGit at all", () => {
      // Same fallback as the empty-string scenario above, exercised on the
      // pure function directly with the field OMITTED rather than set to "" -
      // the shape a caller gets before MIRROR_GIT is ever assigned.
      const ctx: TargetContext = { incusContainer: "", dryRun: false, layout: "releases", hostRepoDir: HOST_REPO }
      expect(gitArgv(ctx, ["fetch", "origin"])).toEqual(["git", "--git-dir", "", "fetch", "origin"])
    })

    parity(
      "a failing git propagates its exit code",
      { arm: "git_target", args: ["fetch", "origin"], exitCode: 1 },
      { rc: 1 },
    )

    parity(
      "dry-run prints the fully-prefixed git command",
      { arm: "git_target", args: ["fetch", "origin"], dryRun: true },
      { rc: 0, stdoutMatch: /^\+ git -C \/root\/luna\/stable\/repo fetch origin\nRC=0\n$/ },
    )

    parity(
      "dry-run under releases prints --git-dir",
      { arm: "git_target", args: ["fetch", "origin"], layout: "releases", dryRun: true },
      { rc: 0, stdoutMatch: /^\+ git --git-dir \/srv\/luna\/stable\/mirror\.git fetch origin\nRC=0\n$/ },
    )
  })

  describe("git_target_capture - host-side reads", () => {
    parity(
      "inplace rev-parse reads through -C",
      { arm: "git_target_capture", args: ["rev-parse", "HEAD"] },
      { rc: 0, stdoutMatch: /OUT=\[GIT <-C> <\/root\/luna\/stable\/repo> <rev-parse> <HEAD>\]/ },
    )

    parity(
      "releases rev-parse reads through --git-dir",
      { arm: "git_target_capture", args: ["rev-parse", "HEAD"], layout: "releases" },
      { rc: 0, stdoutMatch: /OUT=\[GIT <--git-dir> <\/srv\/luna\/stable\/mirror\.git> <rev-parse> <HEAD>\]/ },
    )

    parity(
      "dry-run does NOT suppress the read",
      { arm: "git_target_capture", args: ["rev-parse", "HEAD"], dryRun: true },
      { rc: 0, stdoutMatch: /OUT=\[GIT <-C> </ },
    )

    parity(
      "a rev-parse that fails propagates its code (the `|| true` is the caller's job, not the waist's)",
      { arm: "git_target_capture", args: ["rev-parse", "--verify", "nope^{commit}"], exitCode: 128 },
      { rc: 128 },
    )
  })

  /**
   * CLAIM 3. luna_run's dry-run transcript is operator-facing output, so the
   * `%q` quoting is diffed against the real bash over a corpus rather than
   * assumed. Every argument below goes through the waist's dry-run arm, which
   * is the only path that prints.
   */
  describe("luna_run's %q quoting, byte-exact", () => {
    const CORPUS: ReadonlyArray<string> = [
      "plain",
      "--frozen-lockfile",
      "/root/luna/stable/repo",
      "origin/master",
      "luna-chat-server.service",
      "a path with spaces",
      "single'quote",
      'double"quote',
      "dollar$sign",
      "back\\slash",
      "glob*?[x]",
      "semi;colon",
      "amp&pipe|",
      "paren()brace{}",
      "lt<gt>",
      "back`tick",
      "bang!",
      "comma,sep",
      "caret^",
      "hash#inside",
      "#leading-hash",
      "a~b",
      "",
      "command -v claude >/dev/null 2>&1",
      "LUNA_CLAUDE_CODE_EXECUTABLE=/usr/local/bin/claude",
    ]

    for (const arg of CORPUS) {
      parity(
        `quotes ${JSON.stringify(arg)} exactly as bash does`,
        { arm: "run_target", args: ["payload", arg], dryRun: true },
        {},
      )
    }

    it("renders the whole line, not just the arguments", () => {
      expect(lunaRunLine(["git", "-C", "/a b", "fetch"])).toBe("+ git -C /a\\ b fetch\n")
      // Zero arguments: bash prints the bare `+` and a newline.
      expect(lunaRunLine([])).toBe("+\n")
    })
  })

  /**
   * The ONE input where bash 3.2.57 and bash 5.x disagree with each other, and
   * the several that look like they should and do not. The port follows bash
   * 5.x (what `#!/usr/bin/env bash` resolves to on every host and runner this
   * engine targets), and this block asserts the divergence is EXACTLY the
   * documented one on whichever bash is present, rather than letting an old
   * macOS bash turn it into a mystery failure. Nothing on the deploy path -
   * paths, refs, unit names, flags - begins with a tilde.
   */
  describe("documented cross-version %q divergence", () => {
    const bashQ = (value: string): string => {
      const r = spawnSync("bash", ["-c", `printf '%q' ${sq(value)}`], { encoding: "utf8" })
      return r.stdout ?? ""
    }
    const bashMajor = Number(
      spawnSync("bash", ["-c", "printf %s ${BASH_VERSINFO[0]}"], { encoding: "utf8" }).stdout ?? "0",
    )

    it("a leading tilde: bash 5 escapes it, bash 3.2 does not", () => {
      expect(quoteForLunaRun("~lead")).toBe("\\~lead")
      expect(quoteForLunaRun("PATH=~/bin")).toBe("PATH=\\~/bin")
      expect(bashQ("~lead")).toBe(bashMajor >= 5 ? "\\~lead" : "~lead")
    })

    // backslashQuote's three-way positional rule is position-0, right-after-
    // `=`, and right-after-`:` (bash 5's shquote.c). The %q corpus above only
    // ever puts a tilde at position 0, after `=`, or bare mid-string, so the
    // `:` branch has no coverage anywhere else in this file.
    it("a tilde right after a colon expands too, not just after '=' or position 0", () => {
      expect(quoteForLunaRun("a:~b")).toBe("a:\\~b")
      expect(quoteForLunaRun("PATH=/a:~/bin")).toBe("PATH=/a:\\~/bin")
      if (bashMajor >= 5) expect(bashQ("PATH=/a:~/bin")).toBe("PATH=/a:\\~/bin")
    })

    // The ANSI-C arm is where a SECOND divergence would be expected, and there
    // is none: 3.2.57 and 5.3 agree on the named escapes, on the octal
    // fallback, and on a single quote embedded in a $'...' string. (A
    // $'\\x01ctl' ARRAY LITERAL inside a bash 3.2 script does render as
    // $'\\001\\001ctl', which looks like a %q bug and is not one - that is 3.2
    // parsing the literal. luna_run quotes an ARGUMENT, which is the shape
    // asserted here.)
    it("the ANSI-C arm agrees across versions, including the octal fallback", () => {
      for (const [value, quoted] of [
        ["tab\there", "$'tab\\there'"],
        ["nl\nhere", "$'nl\\nhere'"],
        ["esc\u001bhere", "$'esc\\Ehere'"],
        ["q'\ttab", "$'q\\'\\ttab'"],
        ["\u0001ctl", "$'\\001ctl'"],
        ["del\u007f", "$'del\\177'"],
      ] as ReadonlyArray<readonly [string, string]>) {
        expect(quoteForLunaRun(value), value).toBe(quoted)
        expect(bashQ(value), value).toBe(quoted)
      }
    })

    it("multibyte text is printable and stays raw, in both versions", () => {
      expect(quoteForLunaRun("héllo")).toBe("héllo")
      expect(bashQ("héllo")).toBe("héllo")
    })

    // A C1 code point (U+0080-U+009F, here U+0085 NEL) is what
    // isPrintableCodePoint's C1 clause excludes; without it the code point
    // takes the backslash arm instead of the ANSI-C `$'...'` arm bash uses.
    // Every C1 code point UTF-8-encodes with lead byte 0xC2, and macOS's
    // shipped bash 3.2.57 has its own UTF-8-locale-only bug classifying that
    // LEAD byte as printable Latin-1 (it is `Â`) while still octal-escaping
    // the trailing byte alone - neither this port nor bash 5.x makes that
    // mistake. LC_ALL=C forces byte-wise classification, which is what
    // sidesteps 3.2's locale-specific bug: under it, both the byte 3.2.57 and
    // 5.3 agree the whole sequence needs octal-per-byte escaping, matching
    // this port under its normal UTF-8 locale.
    it("a C1 code point takes the ANSI-C arm, byte-exact against real bash", () => {
      const value = `c1${String.fromCodePoint(0x85)}ctrl`
      const expected = "$'c1\\302\\205ctrl'"
      expect(quoteForLunaRun(value)).toBe(expected)
      const r = spawnSync("bash", ["-c", `printf '%q' ${sq(value)}`], {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C" },
      })
      expect(r.stdout).toBe(expected)
    })
  })

  /**
   * The one invariant this file carries for the WHOLE slice: the waist stays
   * incapable of mutating a checkout, so "what can move HEAD?" has exactly one
   * answer from one grep (apply-inplace.ts). A future edit that added a git
   * verb here - even a well-meaning `git fetch` helper - fails this.
   */
  it("the module contains no git subcommand of its own", () => {
    const source = readFileSync(join(repoRoot, "apps/deploy-cli/src/update/target.ts"), "utf8")
    expect(source).not.toMatch(/(["'])(reset|--hard|fetch|checkout|clean|pull|clone|merge|rebase)\1/)
  })

  describe("defaultSpawnTarget - the production runner", () => {
    it("captures stdout when asked", () => {
      const r = defaultSpawnTarget(["printf", "%s", "hi"], { capture: true })
      expect(r.status).toBe(0)
      expect(r.stdout).toBe("hi")
    })

    it("reports a command's exit code", () => {
      expect(defaultSpawnTarget(["bash", "-c", "exit 7"], { capture: true }).status).toBe(7)
    })

    it("maps a binary that does not exist to 127, the status bash reports for it", () => {
      const r = defaultSpawnTarget(["luna-no-such-binary-for-parity-test"], { capture: true })
      expect(r.status).toBe(127)
      const bash = spawnSync("bash", ["-c", "luna-no-such-binary-for-parity-test"], { encoding: "utf8" })
      expect(bash.status).toBe(127)
    })

    it("an empty argv is a no-op that succeeds, matching `luna_run` with no arguments", () => {
      expect(defaultSpawnTarget([], { capture: false })).toEqual({ status: 0, stdout: "" })
    })

    /**
     * THE PROBE MUST RUN UNDER A RUNTIME THAT UNDERSTANDS TYPESCRIPT, and
     * `process.execPath` is not reliably one.
     *
     * The probe imports target.ts directly. process.execPath is whatever
     * launched vitest, which on the Linux CI runner is a Node that cannot
     * import a .ts file - so the probe died before writing anything, and both
     * probe tests failed on a MISSING MARKER rather than on the behaviour they
     * exist to check. That is the worst failure shape available: the assertion
     * still reads like a real stdio regression.
     *
     * These passed locally only because this machine's launcher happens to
     * handle TypeScript, which quietly made the host OS part of the fixture.
     * bun is this repo's runtime and is version-pinned in CI, so the probe now
     * names its interpreter instead of inheriting one.
     *
     * A MISSING bun FAILS LOUDLY rather than skipping: a silent skip here would
     * turn the only real proof of the fd handoff into a no-op the day the
     * toolchain moved, which is exactly how these two tests became decorative
     * in CI for four merges without anyone noticing.
     */
    const runProbe = (probePath: string): { stdout: string; stderr: string } => {
      const which = spawnSync("which", ["bun"], { encoding: "utf8" })
      const bun = (which.stdout ?? "").trim()
      expect(
        bun,
        "bun is required to run the TypeScript probe; process.execPath cannot be assumed to import .ts",
      ).not.toBe("")
      const probe = spawnSync(bun, [probePath], { encoding: "utf8" })
      return { stdout: probe.stdout ?? "", stderr: probe.stderr ?? "" }
    }

    // A capture:true child's stderr must still reach the operator (this
    // module's header: stderr always flows through in both arms). Proving
    // that needs a REAL descendant process, because "inherit" is an OS-level
    // fd handoff invisible to anything short of a grandchild whose own stdio
    // WE control - a mock or a return-value check cannot see it, since
    // CommandResult never carries stderr at all.
    it("lets a captured child's stderr reach the operator rather than swallowing it into an unread pipe", () => {
      const dir = makeTempDir("target-stderr-probe-")
      const probePath = join(dir, "probe.mjs")
      const targetPath = join(repoRoot, "apps/deploy-cli/src/update/target.ts")
      writeFileSync(
        probePath,
        [
          `import { defaultSpawnTarget } from ${JSON.stringify(targetPath)}`,
          `const r = defaultSpawnTarget(["bash", "-c", "printf out; printf STDERR_MARKER_9f3a >&2"], { capture: true })`,
          `process.stdout.write("CAPTURED=[" + r.stdout + "]")`,
        ].join("\n"),
      )
      // The probe is a real grandchild-spawning process, not the vitest
      // worker itself: WE pipe its stdout/stderr, so "inherit" one level down
      // hands the grandchild's stderr straight to the pipe we are reading.
      const probe = runProbe(probePath)
      expect(probe.stdout).toBe("CAPTURED=[out]")
      expect(probe.stderr).toContain("STDERR_MARKER_9f3a")
    })

    // The mirror image of the stderr probe above: the MUTATING arm
    // (capture:false) is documented to let the child write straight to the
    // engine's own stdout (this module's header). That is an OS-level fd
    // handoff invisible to a mock or a return-value check, since
    // capture:false always returns stdout:"" regardless of what the child
    // wrote - so the only way to prove the bytes actually reached the
    // operator is a real grandchild whose own stdout WE capture one level up.
    // BOTH fds are asserted, and the stderr half is the one that matters most.
    // capture:false is the arm every MUTATING command runs through - bun
    // install, systemctl daemon-reload, systemctl restart, git fetch - so it is
    // where essentially every deploy failure message originates. An earlier
    // version of this test pinned stdout only, which left `"inherit"` free to
    // become `"pipe"` on fd 2 alone: the deploy would still return its non-zero
    // status, but the operator would see a rollback with no reason attached.
    // The module header states this as a contract in both arms, so proving one
    // of them was proving half a promise.
    it("lets a mutating child's stdout AND stderr reach the operator rather than swallowing them into an unread pipe", () => {
      const dir = makeTempDir("target-stdout-probe-")
      const probePath = join(dir, "probe.mjs")
      const targetPath = join(repoRoot, "apps/deploy-cli/src/update/target.ts")
      writeFileSync(
        probePath,
        [
          `import { defaultSpawnTarget } from ${JSON.stringify(targetPath)}`,
          `defaultSpawnTarget(["bash", "-c", "printf STDOUT_MARKER_7c2e; printf STDERR_MARKER_4b81 >&2"], { capture: false })`,
        ].join("\n"),
      )
      const probe = runProbe(probePath)
      expect(probe.stdout).toContain("STDOUT_MARKER_7c2e")
      expect(
        probe.stderr,
        "a failed deploy step's diagnostic must reach the operator, not an unread pipe",
      ).toContain("STDERR_MARKER_4b81")
    })

    // CommandResult's own doc block promises that a signal-killed child comes
    // back as `status: null`, never a fabricated number, and that every
    // caller in this slice tests `!== 0` so null reads as failure exactly as
    // bash's non-zero would. A real SIGKILL is the only way to prove that: a
    // mocked spawn can return whatever a test author types, but this asserts
    // what Node's spawnSync ACTUALLY reports for a process the kernel killed.
    it("a child killed by a signal is not reported as a success", () => {
      const r = defaultSpawnTarget(["bash", "-c", "kill -9 $$"], { capture: false })
      expect(r.status).not.toBe(0)
    })
  })

  describe("spawnOf's production default - `ctx.spawn ?? defaultSpawnTarget` (target.ts:286)", () => {
    // Every scenario above, and every test in the two describe blocks just
    // above this one, injects `ctx.spawn` - so the `??` itself is never
    // forced to fall through to `defaultSpawnTarget` in production shape.
    // The only tests that omit `spawn` are the dry-run-default-sink pair
    // (line ~246), and dry-run RETURNS before `spawnOf` is ever called, so
    // even those never reach this line. These two tests are the one place
    // in the suite that supplies NO injected spawn AND sets dryRun:false, so
    // a real OS process is what has to answer - a stubbed `?? (() => ...)`
    // fallback, or a fallback that quietly swaps the capture flag, or a
    // fallback whose capture arm trims the child's stdout, all have to
    // survive an actual `bash` child rather than a test-authored double.
    it("run_target with no injected spawn forks a real process: a file it writes lands on real disk", () => {
      const dir = makeTempDir("target-default-spawn-mutating-")
      const marker = join(dir, "marker.txt")
      const ctx: TargetContext = {
        incusContainer: "",
        dryRun: false,
        layout: "inplace",
        hostRepoDir: HOST_REPO,
        // `spawn` deliberately OMITTED: this is the one context shape that
        // actually reaches `ctx.spawn ?? defaultSpawnTarget`. A stubbed
        // fallback that reports success without running anything (or one
        // that misroutes capture so the child's redirection target never
        // gets opened the way bash would) leaves this file missing.
      }
      const result = runTargetSync(ctx, ["bash", "-c", `printf '%s' REAL_SPAWN_MARKER_a1 > ${sq(marker)}`])
      expect(result.status).toBe(0)
      expect(readFileSync(marker, "utf8")).toBe("REAL_SPAWN_MARKER_a1")
    })

    it("run_target_capture with no injected spawn returns a real child's raw, untrimmed stdout", () => {
      const ctx: TargetContext = {
        incusContainer: "",
        dryRun: false,
        layout: "inplace",
        hostRepoDir: HOST_REPO,
        // `spawn` deliberately OMITTED, same reasoning as above. RAW carries
        // leading, interior and trailing whitespace plus a blank line, so a
        // fallback whose capture arm reaches for `.trim()` instead of
        // leaving `$( )`-style raw bytes to the caller cannot pass either.
      }
      const RAW = "  leading and trailing padded  \n\n"
      const result = runTargetCaptureSync(ctx, ["bash", "-c", `printf '%s' ${sq(RAW)}`])
      expect(result.status).toBe(0)
      expect(result.stdout).toBe(RAW)
    })
  })

  describe("runTargetCaptureSync / gitTargetCaptureSync - raw passthrough contract", () => {
    // This module's header is explicit that trimming is the CALLER's job
    // (session-guard.ts's stripTrailingNewlines) and that `.trim()` is "the
    // wrong tool there": it would eat a leading blank line or interior
    // padding a caller might need to read literally, not just the trailing
    // newline `$( )` strips. The stub argv-echo used throughout this file
    // never produces leading/interior whitespace, so only an injected spawn
    // with real padding can distinguish "returned raw" from "silently
    // trimmed".
    const RAW = "  padded\nsecond line  \n\n"

    it("runTargetCaptureSync returns capture stdout untouched, whitespace and all", () => {
      const ctx: TargetContext = {
        incusContainer: "",
        dryRun: false,
        layout: "inplace",
        hostRepoDir: HOST_REPO,
        spawn: () => ({ status: 0, stdout: RAW }),
      }
      expect(runTargetCaptureSync(ctx, ["payload"]).stdout).toBe(RAW)
    })

    it("gitTargetCaptureSync returns capture stdout untouched, whitespace and all", () => {
      const ctx: TargetContext = {
        incusContainer: "",
        dryRun: false,
        layout: "inplace",
        hostRepoDir: HOST_REPO,
        spawn: () => ({ status: 0, stdout: RAW }),
      }
      expect(gitTargetCaptureSync(ctx, ["rev-parse", "HEAD"]).stdout).toBe(RAW)
    })
  })
})
