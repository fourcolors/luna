/**
 * Four fidelity defects the phase-2 verifiers found in the ASSEMBLED code,
 * each pinned by the source it was measured against rather than by a
 * transcription of the fix.
 *
 *   1. bash guards three journal writes with `|| true` (:1816, :1856, :1865)
 *      while the port bound them to a seam that THROWS, which loses exit 2 on
 *      the CRITICAL path and with it the whole exit-code contract.
 *   2. `${NEW_HEAD:-$REF}` was ported as `newHead ?? ref`, which substitutes
 *      for null but not for the empty string bash's `:-` also covers.
 *   3. Two dead surfaces: terminals.ts's `config-refused` arm, constructed
 *      nowhere, and main.ts's whole-argv `-h` membership test, which answered
 *      "help" for argvs where bash's positional `case` loop answers something
 *      else entirely.
 *   4. The `:1279` settling line was emitted AFTER the settle sleep, where
 *      bash prints it before (:1279, then :1282).
 *
 * WHAT MAKES THESE ASSERTIONS ORACLES RATHER THAN COPIES. The journal, settle
 * and NEW_HEAD rows read `scripts/luna-update-server` at test time and assert
 * a property OF THE BASH (this line is `|| true`-guarded; this print precedes
 * that sleep; this expansion is `:-` and not `-`), so a change to the bash
 * breaks the row instead of silently invalidating the port. The help row uses
 * `parseUpdateConfig` itself - the positional loop bash's own `case` was
 * ported into - as the oracle for the pre-`runMain` preamble's fast path, and
 * derives which flags take a value FROM that parser, so a 24th flag added to
 * the loop cannot drift out of the preamble unnoticed.
 *
 * PORTABLE: one readFileSync of a repo file, one temp dir, and stubs. No host
 * binary is spawned, nothing assumes a platform, and the "unwritable journal"
 * is a path whose parent is a regular FILE - which fails for every user
 * including root, unlike a permission bit.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import type { BashLib } from "../../src/update/bash-lib.js"
import { parseUpdateConfig, updateArgvWantsHelp, type UpdateConfig } from "../../src/update/config.js"
import { settleAfterStopSync } from "../../src/update/restart.js"
import { failForwardSync, headOrRef, type FailForwardOptions } from "../../src/update/rollback.js"
import { runUpdate } from "../../src/update/run-update.js"
import type { CommandResult } from "../../src/update/target.js"
import { exitCodeFor, type Terminal } from "../../src/update/terminals.js"
import { buildFlowDeps, type RealSeams } from "../../src/update/wiring.js"
import { cleanupTempDirs, makeTempDir, repoRoot } from "./temp-dirs.js"
import { makeCapturedSeams, makeEnv, makeStubIo } from "./update-io-doubles.js"

afterAll(cleanupTempDirs)

/**
 * A repo file as text. Read here rather than through bash-source-oracle.ts
 * because that helper's contract is one specific extraction (the payload of a
 * cited `luna_info`/`luna_warn`), and these rows assert STRUCTURE - a guard
 * suffix, a parameter expansion, the order of two statements - over both the
 * bash and this app's own TypeScript.
 */
const readRepoFile = (relative: string): string => readFileSync(join(repoRoot, relative), "utf8")

/** `scripts/luna-update-server`, split into lines, so an index is a line number minus one. */
const bashSourceLines = (): ReadonlyArray<string> => readRepoFile("scripts/luna-update-server").split("\n")

const PREV = "a".repeat(40)
const TARGET = "b".repeat(40)
const PROFILE = "fixture"
const NUMBERS = { readinessTimeoutSecs: 2, readinessTimeoutRaw: "2", readinessIntervalSecs: 0 }

const configFor = (
  flags: ReadonlyArray<string>,
  env: Readonly<Record<string, string | undefined>>,
  overrides: Partial<UpdateConfig> = {},
): UpdateConfig => {
  const parsed = parseUpdateConfig(["--profile", PROFILE, ...flags], env, {
    validateProfile: () => true,
    hasLaunchctl: () => true,
  })
  if (parsed.kind !== "ok") throw new Error(`fixture config did not parse: ${JSON.stringify(parsed)}`)
  return { ...parsed.config, ...overrides }
}

const FIXTURE_BASH_LIB: BashLib = {
  bashEngine: "/fixture/engine",
  libFile: "/fixture/lib/luna-deploy.sh",
  validateProfile: () => ({ ok: true }),
  findBun: () => ({ ok: true, path: "/fixture/bun" }),
  envValue: () => ({ found: true, value: "", exitCode: 0, stderr: "" }),
  configureClaudeExecutable: () => ({ ok: true, exitCode: 0, stdout: "", stderr: "" }),
}

/**
 * Flow deps whose journal path is UNWRITABLE, because its parent directory is
 * a regular file. Every `write_transaction` therefore throws out of
 * journal.ts's atomic writer, which is the ENOSPC / read-only-state-dir shape
 * without needing either condition.
 */
const makeBrokenJournalRig = (
  label: string,
  flags: ReadonlyArray<string> = [],
  spawnTarget: (argv: ReadonlyArray<string>) => CommandResult = () => ({ status: 0, stdout: "" }),
): { readonly deps: ReturnType<typeof buildFlowDeps>; readonly stderr: () => string } => {
  const stateDir = makeTempDir(label)
  const blocker = join(stateDir, "not-a-directory")
  writeFileSync(blocker, "this is a regular file, so mkdir under it can never succeed\n")
  const env = makeEnv(stateDir)
  const config = configFor(flags, env, {
    updateStateDir: stateDir,
    updateJournal: join(blocker, `transaction-${PROFILE}`),
  })
  const io = makeStubIo({ spawnTarget: (argv) => spawnTarget(argv) })
  const captured = makeCapturedSeams(env, io)
  return {
    deps: buildFlowDeps({
      config,
      numbers: NUMBERS,
      bashLib: FIXTURE_BASH_LIB,
      bunBin: "/fixture/bun",
      requestedRef: TARGET,
      seams: captured.seams as RealSeams,
    }),
    stderr: () => captured.stderr.join(""),
  }
}

// --------------------------------------------------------------------------
// 1. the `|| true` journal writes (:1816, :1856, :1865)
// --------------------------------------------------------------------------

describe("the journal writes bash guards with `|| true`", () => {
  /** Every `write_transaction <phase>` call site in the bash, with its guard suffix. */
  const callSites = bashSourceLines()
    .map((text, index) => ({ line: index + 1, text: text.trim() }))
    .filter((row) => row.text.startsWith("write_transaction "))

  it("the bash still guards exactly the three rollback-path writes, and still leaves the forward four bare", () => {
    const guarded = callSites.filter((row) => row.text.endsWith("|| true")).map((row) => row.line)
    const bare = callSites.filter((row) => !row.text.includes("||")).map((row) => row.line)
    const returning = callSites.filter((row) => row.text.endsWith("|| return 1")).map((row) => row.line)

    // The three this port binds to the swallowing seam. :1749/:1756/:1789 are
    // do_rollback_releases', which config.ts delegates whole, so they are
    // guarded in the bash and unreachable from this binary.
    expect(guarded).toEqual([1749, 1756, 1789, 1816, 1856, 1865])
    // The four the port deliberately lets throw: under `set -euo pipefail` an
    // unguarded failure aborts the bash run, so a throw is the faithful port.
    expect(bare).toEqual([2002, 2043, 2045, 2071])
    // And the apply-phase checkout, which is neither: wiring.ts turns its
    // throw into a FAILED apply (`onCheckout`), not into a swallow.
    expect(returning).toEqual([1165, 1196])
  })

  it("a failed `rollback-failed` write still exits CRITICAL (2) and still prints the CRITICAL line", () => {
    // apply_ref fails, so the rollback never reaches restart or readiness and
    // lands directly on :1854-1857: the CRITICAL printf, then
    // `write_transaction "rollback-failed" || true`, then exit 2. TWO writes
    // are attempted on this path ("rolling-back" at :1816 as well) and both
    // must be survivable.
    const rig = makeBrokenJournalRig("luna-journal-critical-", [], (argv) => {
      const inner = argv[0] === "incus" ? argv.slice(4) : argv
      if (inner[0] === "git" && inner[3] === "reset") return { status: 1, stdout: "" }
      return { status: 0, stdout: "" }
    })

    const outcome = rig.deps.rollback({ ref: TARGET, prev: PREV, forwardRestartRan: true })

    expect(outcome.exitCode).toBe(2)
    expect(exitCodeFor({ kind: "rollback-failed" })).toBe(2)
    // The operator line another program greps for survived too: a throw here
    // would have escaped before ever returning an exit code.
    expect(rig.stderr()).toContain(`CRITICAL: update to ${TARGET} failed AND rollback to ${PREV} also failed`)
  })

  it("a failed `forward-failed` write still dies at exit 1 with its own message (:1865)", () => {
    const rig = makeBrokenJournalRig("luna-journal-forward-", ["--no-rollback"])

    const outcome = rig.deps.failForward({
      reason: "failed readiness",
      ref: TARGET,
      prev: PREV,
      newHead: TARGET,
      forwardRestartRan: true,
    })

    expect(outcome.kind).toBe("died")
    expect(outcome.kind === "died" && outcome.exitCode).toBe(1)
  })

  it("the FORWARD writes still throw, so the swallow is per-site and not a blanket catch", () => {
    const rig = makeBrokenJournalRig("luna-journal-forward-throws-")

    // `write_transaction "prepared"` (:2002) and friends are bare in bash.
    expect(() =>
      rig.deps.writeTransaction("prepared", { prev: PREV, target: TARGET, prevLockHash: "" }),
    ).toThrow()
  })
})

// --------------------------------------------------------------------------
// 2. `${NEW_HEAD:-$REF}` (:1863, :1866)
// --------------------------------------------------------------------------

describe("`${NEW_HEAD:-$REF}` substitutes for an EMPTY NEW_HEAD, not only an unset one", () => {
  it("both fail_forward lines in the bash use `:-`, which is the whole reason this case exists", () => {
    const lines = bashSourceLines()
    const failForwardLines = lines.filter((text) => text.includes("${NEW_HEAD:-$REF}"))
    // :1863's luna_warn and :1866's luna_die. `:-` and not `-`: the colon form
    // fires on unset OR empty, and an empty NEW_HEAD is reachable whenever
    // `git rev-parse HEAD` exits 0 and prints nothing.
    expect(failForwardLines).toHaveLength(2)
    expect(lines.filter((text) => text.includes("${NEW_HEAD-$REF}"))).toHaveLength(0)
  })

  it("headOrRef maps null AND the empty string to the ref, and anything else to itself", () => {
    expect(headOrRef(null, TARGET)).toBe(TARGET)
    expect(headOrRef("", TARGET)).toBe(TARGET)
    expect(headOrRef(PREV, TARGET)).toBe(PREV)
  })

  it("an empty newHead prints HEAD=<ref>, never a HEAD of nothing", () => {
    const warns: string[] = []
    const options: FailForwardOptions = {
      supervisor: "systemd",
      systemdUser: false,
      uid: "0",
      launchdLabel: "label",
      serviceName: "luna-chat-server.service",
      ref: TARGET,
      prev: PREV,
      layout: "bare",
      forwardRestartRan: true,
      applyRef: () => true,
      restartService: () => 0,
      runReadiness: () => true,
      writeTransaction: () => {},
      clearTransaction: () => {},
      warn: (line) => warns.push(line),
      writeStderrRaw: () => {},
      rollbackEnabled: false,
      newHead: "",
    }

    const outcome = failForwardSync("failed readiness", options)

    expect(warns).toEqual([`update to ${TARGET} failed: failed readiness (HEAD=${TARGET})`])
    expect(outcome.kind === "died" && outcome.message).toBe(
      `failed readiness and --no-rollback set; server left at ${TARGET} (may be unhealthy)`,
    )
  })
})

// --------------------------------------------------------------------------
// 3a. terminals.ts has no unconstructed arms
// --------------------------------------------------------------------------

describe("every Terminal arm is reachable", () => {
  const TERMINALS: ReadonlyArray<Terminal["kind"]> = [
    "lock-contention",
    "lock-unacquirable",
    "preflight-refused",
    "config-refused",
    "corrupt-journal",
    "deferred",
    "restart-only-ok",
    "restart-only-restart-failed",
    "restart-only-readiness-failed",
    "updated",
    "rolled-back",
    "rollback-failed",
    "forward-failed-no-rollback",
  ]

  it("is constructed somewhere under src/, not only declared in terminals.ts", () => {
    // A coarse but honest probe: it proves the literal appears outside the
    // declaration, which is what "dead arm" means here. It cannot tell a
    // Terminal's `kind: "rolled-back"` from FailForwardOutcome's, so it is a
    // floor rather than a proof of use - the exit-code matrix is what asserts
    // the behaviour of each arm.
    const sources = ["main.ts", "update-command.ts", "update/run-update.ts", "update/update-flow.ts", "update/restart-only.ts"]
      .map((relative) => readRepoFile(join("apps/deploy-cli/src", relative)))
      .join("\n")
    const unconstructed = TERMINALS.filter((kind) => !sources.includes(`kind: "${kind}"`))
    expect(unconstructed).toEqual([])
  })

  it("a refused argv exits through the config-refused arm and agrees with config.ts's own number", () => {
    const stateDir = makeTempDir("luna-config-refused-")
    const env = makeEnv(stateDir)
    const captured = makeCapturedSeams(env, makeStubIo())

    const code = runUpdate(["update", "--not-a-flag"], captured.seams as RealSeams)

    expect(code).toBe(exitCodeFor({ kind: "config-refused" }))
    const parsed = parseUpdateConfig(["--not-a-flag"], env, {
      validateProfile: () => true,
      hasLaunchctl: () => true,
    })
    expect(parsed.kind === "error" && parsed.exitCode).toBe(code)
    expect(captured.stderr.join("")).toBe("error: unknown option: --not-a-flag\n")
  })
})

// --------------------------------------------------------------------------
// 3b. `-h` is POSITIONAL, exactly as the parse loop is
// --------------------------------------------------------------------------

describe("main.ts's pre-runMain help decision", () => {
  const wantsHelpPerParser = (argv: ReadonlyArray<string>): boolean =>
    parseUpdateConfig(argv, {}, { validateProfile: () => true, hasLaunchctl: () => true }).kind === "help"

  /**
   * The argvs that separate a positional walk from a membership test. Each is
   * checked against `parseUpdateConfig`, which IS the ported `case` loop, so
   * the expectation is the parser's answer rather than a typed-in boolean.
   */
  const ARGVS: ReadonlyArray<ReadonlyArray<string>> = [
    ["-h"],
    ["--help"],
    ["--dry-run", "-h"],
    ["--profile", "stable", "--help"],
    // The row the finding named: `-h` is the VALUE of --ref, and bash deploys
    // a ref literally named "-h" rather than printing usage.
    ["--ref", "-h"],
    ["--launchd-label", "--help"],
    ["--operator-override", "-h"],
    // An unknown option refuses at exit 1 before any later -h is reached.
    ["--not-a-flag", "-h"],
    // A positional token is `unknown option` too.
    ["stable", "-h"],
    // `${2:?...}` refuses a MISSING or EMPTY value first.
    ["--ref", ""],
    ["--ref"],
    ["--ref", "", "-h"],
    // Ordinary argvs, neither help nor a refusal.
    ["--ref", "origin/master"],
    [],
  ]

  it.each(ARGVS.map((argv) => [JSON.stringify(argv), argv] as const))(
    "agrees with the parse loop for %s",
    (_label, argv) => {
      expect(updateArgvWantsHelp(argv)).toBe(wantsHelpPerParser(argv))
    },
  )

  it("is the preamble main.ts actually runs, not a membership test beside it", () => {
    // main.ts is the process boundary: it runs before `runMain` and cannot be
    // imported without executing, so its wiring is asserted structurally here
    // and behaviourally by the spawned rows in main.test.ts. What must never
    // come back is `rawArgs.includes("-h")` as the UPDATE branch's condition.
    const source = readRepoFile("apps/deploy-cli/src/main.ts")
    const branch = source
      .split("\n")
      .find((line) => line.startsWith('if (rawArgs[firstTokenIndex] === "update"'))
    expect(branch).toBe(
      'if (rawArgs[firstTokenIndex] === "update" && updateArgvWantsHelp(rawArgs.slice(firstTokenIndex + 1))) {',
    )
  })

  it("derives value-taking-ness from the parser itself, so a 24th flag cannot drift out of the preamble", () => {
    // Every `case "-...":` label the parse loop declares, read out of the
    // source rather than listed here.
    const source = readRepoFile("apps/deploy-cli/src/update/config.ts")
    const labels = [...source.matchAll(/^\s+case "(-[^"]+)":/gm)].map((m) => m[1] as string)
    expect(labels.length).toBeGreaterThanOrEqual(25)

    for (const flag of labels) {
      if (flag === "-h" || flag === "--help") {
        expect(updateArgvWantsHelp([flag])).toBe(true)
        continue
      }
      // `missing-value` is the parser's own answer to "this flag consumes the
      // next word"; a flag that takes a value must EAT the `-h` after it.
      const takesValue =
        parseUpdateConfig([flag], {}, { validateProfile: () => true, hasLaunchctl: () => true }).kind ===
        "missing-value"
      expect(updateArgvWantsHelp([flag, "-h"]), `${flag} (takesValue=${takesValue})`).toBe(!takesValue)
    }
  })
})

// --------------------------------------------------------------------------
// 4. the :1279 settling line precedes the :1282 sleep
// --------------------------------------------------------------------------

describe("the settling line is printed BEFORE the settle sleep", () => {
  it("bash prints it first, which is the property being ported", () => {
    const lines = bashSourceLines()
    const infoAt = lines.findIndex((text) => text.trim().startsWith('luna_info "settling '))
    const sleepAt = lines.findIndex((text) => text.trim() === 'if ! sleep "$RESTART_SETTLE_SECS"; then')
    expect(infoAt).toBeGreaterThan(-1)
    expect(sleepAt).toBeGreaterThan(infoAt)
  })

  it("settleAfterStopSync announces the settle, THEN sleeps", () => {
    const events: string[] = []
    const outcome = settleAfterStopSync({
      dryRun: false,
      settleSecs: "6",
      onSettling: (secs) => events.push(`announce:${secs}`),
      sleepSync: (secs) => (events.push(`sleep:${secs}`), { ok: true }),
    })

    expect(outcome).toEqual({ kind: "settled", settleSecs: "6" })
    expect(events).toEqual(["announce:6", "sleep:6"])
  })

  it("announces even when the sleep then FAILS, because bash has already printed :1279 by then", () => {
    const events: string[] = []
    const outcome = settleAfterStopSync({
      dryRun: false,
      settleSecs: "6",
      onSettling: (secs) => events.push(`announce:${secs}`),
      sleepSync: () => (events.push("sleep"), { ok: false }),
    })

    expect(outcome).toEqual({ kind: "settled-sleep-failed", settleSecs: "6" })
    expect(events).toEqual(["announce:6", "sleep"])
  })

  it("does NOT announce on any branch that never sleeps (:1267, :1268, :1276)", () => {
    for (const opts of [
      { dryRun: true, settleSecs: "6" },
      { dryRun: false, settleSecs: "0" },
      { dryRun: false, settleSecs: "not-a-number" },
    ]) {
      const events: string[] = []
      settleAfterStopSync({
        ...opts,
        onSettling: (secs) => events.push(`announce:${secs}`),
        sleepSync: () => (events.push("sleep"), { ok: true }),
      })
      expect(events, JSON.stringify(opts)).toEqual([])
    }
  })
})
