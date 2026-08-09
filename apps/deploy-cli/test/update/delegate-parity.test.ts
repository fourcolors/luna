/**
 * Golden parity for whole-run DELEGATION (S22d PR1).
 *
 * The oracle here is not a function inside scripts/luna-update-server - it is
 * the SELECTION GATE that decides which engine runs at all. So every argv
 * assertion below extracts the REAL `luna_select_engine` out of
 * scripts/luna-autodeploy with awk, runs it twice over identical inputs (once
 * with LUNA_DEPLOY_ENGINE unset, once with it set to `binary`), and asserts
 * that what delegate.ts hands to the bash engine is FIELD-FOR-FIELD what the
 * unset run would have exec'd. That is the whole contract: a delegated run
 * must be indistinguishable from a run where the operator never asked for the
 * binary at all.
 *
 * WHY THE TWO-DRIVE SHAPE MATTERS HERE MORE THAN USUAL. The bash prefix is one
 * field (luna-update-server has a flag-only surface); the binary prefix is two
 * (`<cli> update`, because deploy-cli dispatches on a subcommand). Delegation
 * therefore has to DROP exactly one token and keep every other byte. Both
 * failure modes are silent and both are tested against the real thing rather
 * than a restatement:
 *
 *   - drop nothing, and luna-update-server's parser hits
 *     `*) luna_die "unknown option: $1"` (scripts/luna-update-server:239).
 *     This suite runs the REAL script to prove that is what happens, instead
 *     of asserting a comment.
 *   - drop by a hardcoded index, and a compiled `bun build --compile` artifact
 *     and `bun run main.ts` disagree about argv[1]; one of the two then
 *     forwards the profile NAME as a flag and eats a real one.
 *
 * THE MARKER IS TESTED AS AN AUDIT ARTIFACT, not as a log line: exactly one
 * occurrence, on stderr, emitted BEFORE the child runs, and greppable by the
 * literal prefix S23's accept gate will use. A soak that counts a delegated
 * deploy as binary-deployed proves nothing, and the marker is the only thing
 * standing between that mistake and a fleet-wide flip.
 *
 * THE DEFAULT RUNNER IS EXERCISED FOR REAL, not only through the seam. Half
 * these assertions (exit-code propagation, signal death, argv delivery, env
 * inheritance, inherited stdio) are properties of the actual spawn, and a
 * suite that only ever injected a recording stub would prove the orchestration
 * and none of the plumbing.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  BASH_ENGINE_ENV,
  DELEGATED_MARKER_PREFIX,
  DELEGATION_FLAGS,
  ENGINE_STDIO,
  EXIT_PREFLIGHT,
  UPDATE_SUBCOMMAND,
  bashEngineNotExecutableError,
  bashEngineUnsetError,
  delegateToBashSync,
  delegatedMarker,
  forwardedFlags,
  resolveBashEngine,
  type DelegationFlag,
  type EngineRunResult,
} from "../../src/update/delegate.js"
import { cleanupTempDirs, makeFixture } from "./bash-fixtures.js"
import { makeTempDir, repoRoot } from "./temp-dirs.js"

afterEach(() => { cleanupTempDirs() })

const AUTODEPLOY = join(repoRoot, "scripts/luna-autodeploy")
const UPDATE_SERVER = join(repoRoot, "scripts/luna-update-server")

// --- the real selection gate, extracted the way engine-select.test.ts does ---

/**
 * TWO DIRECTORIES, because production has two: luna_pin_engine quarantines the
 * bash engine into /usr/local/lib/luna/deploy-engine@<sha>/ while guardian
 * publishes deploy-cli into its own pin (scripts/luna-guardian:1216-1219). The
 * split is what makes $LUNA_DEPLOY_BASH_ENGINE necessary at all - there is
 * nothing beside the binary to derive the bash engine's path from.
 */
const makePin = (): { readonly engine: string; readonly binaryDir: string } => {
  const root = makeTempDir("delegate-parity-pin-")
  const enginePin = join(root, "deploy-engine@abc123")
  const binaryDir = join(root, "guardian-pin")
  mkdirSync(enginePin, { recursive: true })
  mkdirSync(binaryDir, { recursive: true })
  const engine = join(enginePin, "luna-update-server")
  writeFileSync(engine, "#!/usr/bin/env bash\nexit 0\n")
  chmodSync(engine, 0o755)
  const cli = join(binaryDir, "deploy-cli")
  writeFileSync(cli, "#!/usr/bin/env bash\nexit 0\n")
  chmodSync(cli, 0o755)
  return { engine, binaryDir }
}

/** The REAL luna_select_engine, sourced out of the live script. One field per line. */
const selectPrefix = (
  pin: { readonly engine: string; readonly binaryDir: string },
  engineChoice: string | undefined,
): ReadonlyArray<string> => {
  const script = [
    "set -uo pipefail",
    `eval "$(awk '/^luna_select_engine\\(\\)/{f=1} f{print} f && /^}$/{exit}' ${JSON.stringify(AUTODEPLOY)})"`,
    `luna_select_engine ${JSON.stringify(pin.engine)} ${JSON.stringify(pin.binaryDir)}`,
  ].join("\n")
  const r = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: { ...process.env, LUNA_DEPLOY_ENGINE: engineChoice },
  })
  if (r.status !== 0) throw new Error(`luna_select_engine refused unexpectedly: ${r.stderr}`)
  return (r.stdout ?? "").split("\n").filter((line) => line !== "")
}

/** Records what would have been exec'd, so the seam can be diffed against the bash prefix. */
const recordingRunner = (result: EngineRunResult = { status: 0, signal: null }) => {
  const calls: Array<{ readonly path: string; readonly args: ReadonlyArray<string> }> = []
  return {
    calls,
    run: (path: string, args: ReadonlyArray<string>): EngineRunResult => {
      calls.push({ path, args })
      return result
    },
  }
}

// --- the flag vectors every delegated topology is driven with ----------------

interface Vector {
  readonly name: string
  readonly flag: DelegationFlag
  readonly flags: ReadonlyArray<string>
}

const SHARED = ["--profile", "stable", "--repo-dir", "/srv/luna", "--ref", "origin/master"] as const

const VECTORS: ReadonlyArray<Vector> = [
  {
    name: "releases layout",
    flag: "--layout releases",
    flags: [...SHARED, "--layout", "releases", "--deploy-root", "/srv/luna-deploy", "--releases-keep", "3"],
  },
  {
    name: "launchd supervisor",
    flag: "--supervisor launchd",
    flags: [...SHARED, "--supervisor", "launchd", "--launchd-label", "com.user.luna-chat-server"],
  },
  { name: "systemd --user scope", flag: "--user", flags: [...SHARED, "--supervisor", "systemd", "--user"] },
  {
    name: "dry run",
    flag: "--dry-run",
    // The operator-override value carries a SPACE and a leading dash inside it
    // - autodeploy builds exactly this pair. It is the argument most likely to
    // be mangled by any re-quoting on the way through, so every vector list
    // keeps one.
    flags: [...SHARED, "--dry-run", "--operator-override", "operator --force: box is wedged"],
  },
  {
    name: "materialize",
    flag: "--materialize",
    flags: [...SHARED, "--layout", "releases", "--deploy-root", "/srv/luna-deploy", "--materialize"],
  },
]

describe("forwarded argv is byte-identical to what a bash-only selection would have exec'd", () => {
  /**
   * The load-bearing assertion of the module. `bashArgv` is literally what
   * do_deploy execs when LUNA_DEPLOY_ENGINE is unset; `rawArgs` is literally
   * what the binary's own process sees when it is set to `binary`. If those
   * two do not reconcile, a delegated deploy is not the deploy the operator
   * asked for.
   */
  const assertParity = (pin: ReturnType<typeof makePin>, flag: DelegationFlag, flags: ReadonlyArray<string>) => {
    const bashArgv = [...selectPrefix(pin, undefined), ...flags]
    const binaryArgv = [...selectPrefix(pin, "binary"), ...flags]
    // What the binary's process actually receives, exactly as main.ts computes
    // it: everything after argv[0]/the entry path, i.e. the subcommand onward.
    const rawArgs = binaryArgv.slice(1)
    expect(rawArgs[0], "the gate appends the subcommand, so it is what the binary sees first").toBe(UPDATE_SUBCOMMAND)

    const runner = recordingRunner()
    const outcome = delegateToBashSync({
      flag,
      rawArgs,
      env: { [BASH_ENGINE_ENV]: pin.engine },
      writeStderr: () => {},
      runEngine: runner.run,
    })

    expect(runner.calls).toHaveLength(1)
    const call = runner.calls[0]!
    expect([call.path, ...call.args], "delegated argv vs the bash-only argv").toEqual(bashArgv)
    if (outcome.kind !== "delegated") throw new Error("expected a delegated outcome")
    expect(outcome.argv).toEqual(bashArgv)
  }

  for (const vector of VECTORS) {
    it(`${vector.name}: forwards the flags AFTER the subcommand, and only those`, () => {
      assertParity(makePin(), vector.flag, vector.flags)
    })
  }

  it("holds for the production-shaped arg vector the shared fixture builds", () => {
    // Not a hand-written list: makeFixture's args are the ones every other
    // parity suite drives the real bash engine with, so this pins delegation
    // against the same vector the rest of the harness trusts.
    const fixture = makeFixture({ readyAtTarget: true, readyAtPrev: true })
    assertParity(makePin(), "--dry-run", [...fixture.args, "--dry-run"])
  })

  it("holds for the --incus vector too, where the arg list is a strict superset", () => {
    const fixture = makeFixture({ readyAtTarget: true, readyAtPrev: true, incus: "luna-stable" })
    expect(fixture.args, "the incus fixture must actually carry the flag").toContain("--incus")
    assertParity(makePin(), "--layout releases", [...fixture.args, "--layout", "releases", "--deploy-root", "/srv/x"])
  })
})

describe("the subcommand token, against the real parser", () => {
  const flags = [...SHARED, "--dry-run"]

  it("would be rejected by luna-update-server if it were forwarded", () => {
    // The failure this module exists to avoid, proven against the oracle
    // rather than asserted in a comment: exit 1 and a parse error standing in
    // for the deploy - indistinguishable in a log from a preflight refusal.
    const r = spawnSync("bash", [UPDATE_SERVER, UPDATE_SUBCOMMAND, ...flags], { encoding: "utf8" })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain(`error: unknown option: ${UPDATE_SUBCOMMAND}`)
  })

  it("is absent from the forwarded argv, which the real parser accepts", () => {
    const forwarded = forwardedFlags([UPDATE_SUBCOMMAND, ...flags])
    expect(forwarded).toEqual(flags)
    // The run still fails (the repo dir is not a clone) - the point is that it
    // fails on the DEPLOY's own preflight, having parsed every flag.
    const r = spawnSync("bash", [UPDATE_SERVER, ...forwarded], { encoding: "utf8" })
    expect(r.stderr).not.toContain("unknown option")
    expect(r.stdout, "it got far enough to print the banner, so parsing succeeded").toContain("stable")
  })
})

describe("forwardedFlags computes the subcommand's position", () => {
  it("never assumes a fixed index - a flag VALUE spelled 'update' survives", () => {
    // `--ref update` is legal (a branch may be named `update`). The scan stops
    // at the first NON-flag token, which is the subcommand itself, so the
    // value is never mistaken for it.
    expect(forwardedFlags([UPDATE_SUBCOMMAND, "--ref", "update", "--profile", "stable"]))
      .toEqual(["--ref", "update", "--profile", "stable"])
  })

  it("forwards an empty flag list unchanged", () => {
    expect(forwardedFlags([UPDATE_SUBCOMMAND])).toEqual([])
  })

  it("refuses argv that never carried the subcommand, rather than guessing", () => {
    expect(() => forwardedFlags(["--profile", "stable"])).toThrow(/expected the 'update' subcommand/)
    expect(() => forwardedFlags(["guardian", "check", "stable"])).toThrow(/expected the 'update' subcommand/)
    expect(() => forwardedFlags([])).toThrow(/expected the 'update' subcommand/)
  })
})

describe("the DELEGATED marker", () => {
  const delegateWith = (flag: DelegationFlag) => {
    const pin = makePin()
    const stderr: string[] = []
    const runner = recordingRunner()
    const outcome = delegateToBashSync({
      flag,
      rawArgs: [UPDATE_SUBCOMMAND, ...SHARED],
      env: { [BASH_ENGINE_ENV]: pin.engine },
      writeStderr: (line) => { stderr.push(line) },
      runEngine: runner.run,
    })
    return { stderr, runner, outcome }
  }

  for (const flag of DELEGATION_FLAGS) {
    it(`emits exactly one stable line for ${flag}`, () => {
      const { stderr } = delegateWith(flag)
      expect(stderr).toEqual([`DELEGATED to bash engine: ${flag}`])
      expect(stderr[0]).toBe(delegatedMarker(flag))
    })
  }

  it("is greppable by the literal prefix S23's accept gate will use", () => {
    // The gate cannot ask the binary what it did; it can only read the run's
    // stderr. If this prefix drifts, a bash-deployed host counts as a binary
    // soak sample and the flip ships on evidence that was never collected.
    expect(DELEGATED_MARKER_PREFIX).toBe("DELEGATED to bash engine: ")
    for (const flag of DELEGATION_FLAGS) {
      expect(delegatedMarker(flag).startsWith(DELEGATED_MARKER_PREFIX)).toBe(true)
    }
  })

  it("enumerates all five DelegationFlag members, not a subset of them", () => {
    // The `for (const flag of DELEGATION_FLAGS)` loop above is only as
    // complete as this array: a member dropped from DELEGATION_FLAGS while
    // the DelegationFlag union keeps it would silently stop testing (and
    // stop marking) that topology, with every other assertion in this file
    // still green. The type union cannot be reflected at runtime, so the
    // only way to pin the array to it is to spell all five out here.
    expect(DELEGATION_FLAGS).toEqual([
      "--layout releases",
      "--supervisor launchd",
      "--user",
      "--dry-run",
      "--materialize",
    ])
  })

  it("does not leave a marker behind when the argv is malformed enough to throw", () => {
    // Order is load-bearing (see the header on delegateToBashSync): argv is
    // computed BEFORE the marker is written, specifically so a caller bug
    // (a rawArgs that never carried the subcommand) cannot leave an audit
    // line claiming a delegation that never happened. Drive that with a
    // resolvable engine so the only way to reach the throw is through the
    // argv computation, not the refusal path.
    const pin = makePin()
    const stderr: string[] = []
    expect(() =>
      delegateToBashSync({
        flag: "--dry-run",
        rawArgs: ["--profile", "stable"], // no 'update' subcommand: forwardedFlags throws
        env: { [BASH_ENGINE_ENV]: pin.engine },
        writeStderr: (line) => { stderr.push(line) },
        runEngine: () => { throw new Error("must not run: the throw above should pre-empt the exec") },
      }),
    ).toThrow(/expected the 'update' subcommand/)
    expect(stderr, "a throw before the exec must not have already claimed a delegation").toEqual([])
  })

  it("is written BEFORE the child runs, so a child that never returns still leaves the audit line", () => {
    const pin = makePin()
    const order: string[] = []
    delegateToBashSync({
      flag: "--dry-run",
      rawArgs: [UPDATE_SUBCOMMAND, ...SHARED],
      env: { [BASH_ENGINE_ENV]: pin.engine },
      writeStderr: (line) => { order.push(`stderr:${line}`) },
      runEngine: () => { order.push("exec"); return { status: 0, signal: null } },
    })
    expect(order).toEqual([`stderr:${delegatedMarker("--dry-run")}`, "exec"])
  })

  it("is NOT emitted when nothing was delegated", () => {
    const stderr: string[] = []
    const runner = recordingRunner()
    const outcome = delegateToBashSync({
      flag: "--dry-run",
      rawArgs: [UPDATE_SUBCOMMAND, ...SHARED],
      env: {},
      writeStderr: (line) => { stderr.push(line) },
      runEngine: runner.run,
    })
    expect(outcome).toEqual({ kind: "refused", exitCode: EXIT_PREFLIGHT })
    expect(runner.calls, "a refusal must not start the engine").toEqual([])
    expect(stderr.some((line) => line.startsWith(DELEGATED_MARKER_PREFIX))).toBe(false)
  })
})

describe("resolving the co-pinned bash engine", () => {
  it("accepts an executable file", () => {
    const pin = makePin()
    expect(resolveBashEngine({ [BASH_ENGINE_ENV]: pin.engine })).toEqual({ ok: true, path: pin.engine })
  })

  it("treats an empty value as unset, matching bash's ${VAR:-} idiom", () => {
    const unset = resolveBashEngine({})
    const empty = resolveBashEngine({ [BASH_ENGINE_ENV]: "" })
    expect(empty).toEqual(unset)
    expect(unset).toEqual({ ok: false, errorLine: bashEngineUnsetError() })
  })

  it("refuses a path that does not exist", () => {
    const missing = join(makeTempDir("delegate-missing-"), "nope")
    expect(resolveBashEngine({ [BASH_ENGINE_ENV]: missing }))
      .toEqual({ ok: false, errorLine: bashEngineNotExecutableError(missing) })
  })

  it("refuses a present-but-not-executable file", () => {
    const root = makeTempDir("delegate-noexec-")
    const path = join(root, "luna-update-server")
    writeFileSync(path, "#!/usr/bin/env bash\nexit 0\n")
    chmodSync(path, 0o644)
    expect(resolveBashEngine({ [BASH_ENGINE_ENV]: path }))
      .toEqual({ ok: false, errorLine: bashEngineNotExecutableError(path) })
  })

  it("refuses a DIRECTORY, which is executable-by-permission but not runnable", () => {
    const root = makeTempDir("delegate-dir-")
    expect(resolveBashEngine({ [BASH_ENGINE_ENV]: root }).ok).toBe(false)
  })

  describe("both refusal lines", () => {
    it("carry luna_die's byte-exact `error: ` prefix and exit 1", () => {
      // A delegated topology is decided before the lock, so these are ordinary
      // preflight errors and an operator must be able to diff them against a
      // bash host's output (scripts/lib/luna-deploy.sh:6).
      expect(bashEngineUnsetError().startsWith("error: ")).toBe(true)
      expect(bashEngineNotExecutableError("/x").startsWith("error: ")).toBe(true)
      expect(EXIT_PREFLIGHT).toBe(1)
      const stderr: string[] = []
      const outcome = delegateToBashSync({
        flag: "--user",
        rawArgs: [UPDATE_SUBCOMMAND],
        env: { [BASH_ENGINE_ENV]: "/definitely/not/here" },
        writeStderr: (line) => { stderr.push(line) },
        runEngine: () => { throw new Error("must not run") },
      })
      expect(outcome.exitCode).toBe(1)
      expect(stderr).toEqual([bashEngineNotExecutableError("/definitely/not/here")])
    })

    it("names the variable, because it is the operator's only lever", () => {
      expect(bashEngineUnsetError()).toContain(BASH_ENGINE_ENV)
      expect(bashEngineNotExecutableError("/x")).toContain(`${BASH_ENGINE_ENV}=/x`)
    })
  })
})

// --- the real spawn, not the seam --------------------------------------------

/**
 * A stub bash engine that records the argv it was handed (NUL-separated, so an
 * argument containing a space or a newline stays distinguishable), records one
 * inherited env var, and exits with a caller-chosen code.
 */
const makeStubEngine = (opts: { readonly exitCode?: number; readonly killWith?: string }): {
  readonly path: string
  readonly argvLog: string
  readonly envLog: string
  readonly readArgv: () => ReadonlyArray<string>
} => {
  const root = makeTempDir("delegate-engine-")
  const path = join(root, "luna-update-server")
  const argvLog = join(root, "argv.log")
  const envLog = join(root, "env.log")
  const tail = opts.killWith === undefined
    ? `exit ${opts.exitCode ?? 0}\n`
    : `kill -${opts.killWith} $$\nsleep 5\n`
  writeFileSync(
    path,
    `#!/usr/bin/env bash
: > ${JSON.stringify(argvLog)}
for a in "$@"; do printf '%s\\0' "$a" >> ${JSON.stringify(argvLog)}; done
printf '%s' "\${DELEGATE_PARITY_PROBE:-<unset>}" > ${JSON.stringify(envLog)}
${tail}`,
  )
  chmodSync(path, 0o755)
  return {
    path,
    argvLog,
    envLog,
    readArgv: () => readFileSync(argvLog, "utf8").split("\0").slice(0, -1),
  }
}

describe("the default runner: a real spawn of the real bash engine", () => {
  it("delivers the forwarded argv byte-for-byte, spaces and dashes intact", () => {
    const engine = makeStubEngine({ exitCode: 0 })
    const flags = [...SHARED, "--operator-override", "operator --force: box is wedged", "--dry-run"]
    const outcome = delegateToBashSync({
      flag: "--dry-run",
      rawArgs: [UPDATE_SUBCOMMAND, ...flags],
      env: { [BASH_ENGINE_ENV]: engine.path },
      writeStderr: () => {},
    })
    expect(outcome.exitCode).toBe(0)
    expect(engine.readArgv()).toEqual(flags)
  })

  for (const code of [0, 1, 2, 3, 4, 7]) {
    it(`propagates exit ${code} verbatim`, () => {
      // Every one of 0-4 means something specific to autodeploy's rc case and
      // to LunaChatServerDriver's switch; a delegated run must be
      // indistinguishable from a bash-only one, so nothing is remapped.
      const engine = makeStubEngine({ exitCode: code })
      const outcome = delegateToBashSync({
        flag: "--user",
        rawArgs: [UPDATE_SUBCOMMAND, ...SHARED],
        env: { [BASH_ENGINE_ENV]: engine.path },
        writeStderr: () => {},
      })
      expect(outcome.exitCode).toBe(code)
    })
  }

  it("reports a signal-killed child as 128+signum, bash's own convention", () => {
    const engine = makeStubEngine({ killWith: "TERM" })
    const outcome = delegateToBashSync({
      flag: "--materialize",
      rawArgs: [UPDATE_SUBCOMMAND, ...SHARED],
      env: { [BASH_ENGINE_ENV]: engine.path },
      writeStderr: () => {},
    })
    // Looked up, not hardcoded: SIGTERM is 15 on both platforms this suite
    // runs on, but the module resolves it through os.constants precisely
    // because other signals are not.
    expect(outcome.exitCode).toBe(143)
  })

  it("passes the parent's environment through untouched", () => {
    // The bash engine reads LUNA_UPDATE_STATE_DIR, LUNA_TEST_BUN_PATH,
    // LUNA_RESTART_SETTLE_SECS and more off the environment; a delegated run
    // that scrubbed it would behave differently from the bash-only run it is
    // supposed to reproduce.
    const engine = makeStubEngine({ exitCode: 0 })
    const saved = process.env.DELEGATE_PARITY_PROBE
    process.env.DELEGATE_PARITY_PROBE = "inherited"
    try {
      delegateToBashSync({
        flag: "--dry-run",
        rawArgs: [UPDATE_SUBCOMMAND, ...SHARED],
        env: { [BASH_ENGINE_ENV]: engine.path },
        writeStderr: () => {},
      })
    } finally {
      if (saved === undefined) delete process.env.DELEGATE_PARITY_PROBE
      else process.env.DELEGATE_PARITY_PROBE = saved
    }
    expect(readFileSync(engine.envLog, "utf8")).toBe("inherited")
  })

  it("inherits stdio rather than piping it", () => {
    // Asserted by its EFFECT, not by reading the source: spawnSync returns a
    // null stdout only when the fd was inherited. Piping would reorder the
    // engine's stdout narrative (luna_info) against its stderr warnings
    // (`ROLLED BACK to`, which luna-chat-server.ts:164 classifies on).
    expect(ENGINE_STDIO).toBe("inherit")
    const engine = makeStubEngine({ exitCode: 0 })
    const r = spawnSync(engine.path, ["--profile", "stable"], { stdio: ENGINE_STDIO })
    expect(r.stdout).toBeNull()
    expect(r.stderr).toBeNull()
  })

  it("spawns the engine with inherited stdio by default, not piped", () => {
    // defaultRunEngine is not exported, so ENGINE_STDIO's effect there can
    // only be proven by observing it, not by reading the constant: spawn a
    // WRAPPER process that calls delegateToBashSync with no runEngine
    // override (the real default), pointed at a stub engine that writes a
    // marker to its own stdout. If defaultRunEngine inherits stdio, that
    // marker rides straight through the wrapper's fds into the wrapper's own
    // stdout, which THIS test captures via an outer spawnSync. If it were
    // piped instead, the marker would be trapped inside defaultRunEngine's
    // own (discarded) spawnSync return value and never reach here.
    const root = makeTempDir("delegate-stdio-")
    const enginePath = join(root, "luna-update-server")
    const marker = "ENGINE-WROTE-THIS-TO-STDOUT"
    writeFileSync(enginePath, `#!/usr/bin/env bash\nprintf '%s\\n' ${JSON.stringify(marker)}\nexit 0\n`)
    chmodSync(enginePath, 0o755)

    const wrapper = join(root, "wrapper.ts")
    const delegateSrc = join(repoRoot, "apps/deploy-cli/src/update/delegate.ts")
    writeFileSync(
      wrapper,
      [
        `import { delegateToBashSync } from ${JSON.stringify(delegateSrc)}`,
        "delegateToBashSync({",
        `  flag: "--dry-run",`,
        `  rawArgs: [${JSON.stringify(UPDATE_SUBCOMMAND)}, "--profile", "stable"],`,
        `  env: { ${JSON.stringify(BASH_ENGINE_ENV)}: ${JSON.stringify(enginePath)} },`,
        "  writeStderr: () => {},",
        "})",
      ].join("\n"),
    )

    const r = spawnSync("bun", [wrapper], { encoding: "utf8" })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain(marker)
  })

  it("treats a null status with no signal and no spawn error as a failed run, not a success", () => {
    // `status` is null in practice only when a signal killed the child
    // (covered above) or when the spawn itself errored (also covered above);
    // this is the third, deliberately-defensive cell of that table. Reporting
    // exit 0 for a run whose outcome this engine cannot explain is exactly
    // the silent-wrong-answer class delegation exists to remove.
    const pin = makePin()
    const outcome = delegateToBashSync({
      flag: "--dry-run",
      rawArgs: [UPDATE_SUBCOMMAND, ...SHARED],
      env: { [BASH_ENGINE_ENV]: pin.engine },
      writeStderr: () => {},
      runEngine: () => ({ status: null, signal: null }),
    })
    expect(outcome.exitCode).toBe(EXIT_PREFLIGHT)
  })

  it("falls back to bash's unknown-signal floor of 128 for a signal Node's table cannot name", () => {
    // SIGLOST is a real member of NodeJS.Signals but is not a key in
    // os.constants.signals on either platform this suite runs on, so it
    // reliably exercises the `number === undefined` branch without depending
    // on which signals happen to be mapped here today.
    const pin = makePin()
    const outcome = delegateToBashSync({
      flag: "--materialize",
      rawArgs: [UPDATE_SUBCOMMAND, ...SHARED],
      env: { [BASH_ENGINE_ENV]: pin.engine },
      writeStderr: () => {},
      runEngine: () => ({ status: null, signal: "SIGLOST" as NodeJS.Signals }),
    })
    expect(outcome.exitCode).toBe(128)
  })

  it("reports a failed exec as a preflight error rather than as success", () => {
    // The X_OK probe can pass and the exec still fail - guardian prunes a pin
    // mid-run, or the file is not a valid executable format. Reporting 0 for a
    // run whose outcome is unknown is the silent-wrong-answer class this
    // engine exists to remove.
    const engine = makeStubEngine({ exitCode: 0 })
    const stderr: string[] = []
    const outcome = delegateToBashSync({
      flag: "--dry-run",
      rawArgs: [UPDATE_SUBCOMMAND, ...SHARED],
      env: { [BASH_ENGINE_ENV]: engine.path },
      writeStderr: (line) => { stderr.push(line) },
      runEngine: () => ({ status: null, signal: null, error: new Error("spawn ENOENT") }),
    })
    expect(outcome.exitCode).toBe(EXIT_PREFLIGHT)
    expect(stderr.some((line) => line.startsWith("error: failed to exec the bash engine"))).toBe(true)
  })
})

describe("delegation happens BEFORE the lock", () => {
  /**
   * A SOURCE invariant, and deliberately so. The delegated child acquires the
   * same profile lock this binary would (scripts/luna-update-server:950-1008),
   * so delegating from inside our own lock would pit the child against its own
   * parent - resolved by whichever of the stale-takeover path and the exit-4
   * contention path won the race. No behavioural test in this suite could see
   * that, because this module never acquires a lock to begin with; what needs
   * guarding is that a future edit does not add one.
   */
  const source = readFileSync(join(repoRoot, "apps/deploy-cli/src/update/delegate.ts"), "utf8")

  it("imports nothing from lock.ts", () => {
    const lockImports = source
      .split("\n")
      .filter((line) => /^\s*import\b/.test(line) && /lock/i.test(line))
    expect(lockImports, "delegation must not be able to touch the lock").toEqual([])
  })

  it("never calls process.exit - the caller owns the exit, after its own finally", () => {
    // process.exit() skips `finally` in Node/Bun, which is how a lock leaks on
    // exactly the paths the finally exists for (S22d spec, update-flow.ts).
    expect(source).not.toContain("process.exit")
  })
})
