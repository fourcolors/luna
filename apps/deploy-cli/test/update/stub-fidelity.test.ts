/**
 * THE GUARD ON BLOCKER R11's MECHANICAL RISK.
 *
 * `test/helpers/update-server-fixtures.ts` is load-bearing for a 273-test
 * hostenv suite and this slice is forbidden to edit it, but the `systemctl`,
 * `curl` and `bun` stubs it defines carry no shared trace line, which makes
 * cross-stub ORDER unobservable and is blocker B18. So `bash-fixtures.ts`
 * re-implements all three in its own layer and overwrites them after
 * `makeStubBin` has written its own.
 *
 * Duplicating a stub is worse than editing one. It is chosen anyway, because
 * editing the shared fixture would put that 273-test suite inside this PR's
 * blast radius while the entire point of a parity gate is that the oracle side
 * is untouched. The price of that choice is DRIFT, and it is a nasty price:
 * `curl` interpolates six options (readyAtTarget, readyAtPrev, setupAtTarget,
 * omitBuildShaAtTarget, omitBuildShaAtPrev, mismatchBuildShaAtPrev) whose
 * semantics every scenario in GATE 1 depends on, and BOTH drives run the
 * replacement - so a drifted copy makes both engines agree on the wrong answer
 * and every scenario keeps passing. Nothing else in the tree would notice.
 *
 * This file is what notices. It drives makeStubBin's ORIGINAL `curl` and
 * bash-fixtures.ts's REPLACEMENT over the same option matrix, at the same repo
 * HEADs, with the same argv, and asserts byte-identical stdout and identical
 * exit status. The trace line is the one intended difference and it goes to a
 * file, not to stdout, so nothing has to be excluded from the comparison.
 *
 * The second test is a different kind of guard: it pins THE REPLACEMENT `curl`
 * MUST CALL GIT BY ABSOLUTE PATH against a future revert. See its own comment.
 */
import { describe, expect, it, afterAll } from "vitest"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { git, makeDeployRepo, makeStubBin } from "../../../../test/helpers/update-server-fixtures.js"
import {
  cleanupTempDirs,
  driveEnv,
  makeFixture,
  READINESS_PORT,
  resolveHostTool,
  writeCurlStub,
  type CurlStubOptions,
} from "./bash-fixtures.js"
import { makeTempDir } from "./temp-dirs.js"

afterAll(() => {
  cleanupTempDirs()
})

/** The six interpolated options, as the shape both writers take. */
type CurlFlags = Omit<CurlStubOptions, "repo" | "prevSha" | "targetSha" | "readyAfterCalls">

/**
 * The matrix. Four readiness combinations crossed with the six buildSha /
 * setup shapes, which is every branch the stub's own `if` chain can take,
 * including the two that only differ at one HEAD.
 */
const READY_COMBOS: ReadonlyArray<Pick<CurlFlags, "readyAtTarget" | "readyAtPrev">> = [
  { readyAtTarget: false, readyAtPrev: false },
  { readyAtTarget: true, readyAtPrev: false },
  { readyAtTarget: false, readyAtPrev: true },
  { readyAtTarget: true, readyAtPrev: true },
]

const SHAPES: ReadonlyArray<{ readonly name: string; readonly extra: Omit<CurlFlags, "readyAtTarget" | "readyAtPrev"> }> = [
  { name: "baseline", extra: {} },
  { name: "setupAtTarget", extra: { setupAtTarget: true } },
  { name: "omitBuildShaAtTarget", extra: { omitBuildShaAtTarget: true } },
  { name: "omitBuildShaAtPrev", extra: { omitBuildShaAtPrev: true } },
  { name: "mismatchBuildShaAtPrev", extra: { mismatchBuildShaAtPrev: true } },
  { name: "omitBoth", extra: { omitBuildShaAtTarget: true, omitBuildShaAtPrev: true } },
]

/**
 * The two argv shapes readiness_ok issues (scripts/luna-update-server:1082 and
 * :1087), verbatim. `\n%{http_code}` carries a LITERAL backslash-n, because
 * bash's single quotes do not interpret it and curl is what expands it.
 */
const healthzArgv = (port: string): ReadonlyArray<string> => [
  "-fsS",
  "-o",
  "/dev/null",
  "-w",
  "%{http_code}",
  "--max-time",
  "5",
  `http://127.0.0.1:${port}/healthz`,
]

const readyzArgv = (port: string): ReadonlyArray<string> => [
  "-sS",
  "-w",
  "\\n%{http_code}",
  "--max-time",
  "5",
  `http://127.0.0.1:${port}/readyz`,
]

describe("stub fidelity: the trace-emitting curl replacement is byte-identical to makeStubBin's original", () => {
  it(
    "answers identically on every option x HEAD x endpoint combination",
    () => {
      const temp = makeTempDir("deploy-cli-stub-fidelity-")
      const { work, prevSha, targetSha } = makeDeployRepo(temp)
      // A directory that is NOT a git repo, so `rev-parse HEAD` fails and both
      // stubs take their `|| printf 'unknown'` arm. That arm decides nothing on
      // its own but it is the one input neither stub validates, so it is
      // exactly where a transcription slip would hide.
      const notARepo = join(temp, "not-a-repo")
      mkdirSync(notARepo, { recursive: true })

      // The two REAL HEAD states get the full cross, because every one of the
      // six options is keyed off a HEAD comparison. The unreadable state gets
      // the baseline shape only: with `head=unknown` no option's condition can
      // match, so crossing it with the shapes would spend a third of the run
      // re-proving the same branch. That is a deliberate trade, stated here so
      // nobody quietly assumes a full 3x cross.
      const headStates: ReadonlyArray<{
        readonly name: string
        readonly repo: string
        readonly checkout?: string
        readonly shapes: typeof SHAPES
      }> = [
        { name: "HEAD==target", repo: work, checkout: targetSha, shapes: SHAPES },
        { name: "HEAD==prev", repo: work, checkout: prevSha, shapes: SHAPES },
        { name: "HEAD unreadable", repo: notARepo, shapes: SHAPES.slice(0, 1) },
      ]

      let compared = 0
      let expectedComparisons = 0
      for (const state of headStates) {
        expectedComparisons += READY_COMBOS.length * state.shapes.length * 2
        if (state.checkout !== undefined) git(work, "checkout", "--quiet", state.checkout)
        for (const ready of READY_COMBOS) {
          for (const shape of state.shapes) {
            // Normalised to CONCRETE booleans rather than spread straight
            // through. `exactOptionalPropertyTypes` is on, so a spread widens
            // each optional flag to `boolean | undefined`, which is not
            // assignable to the stub's `setupAtTarget?: boolean`. Defaulting
            // absent to false is not a behaviour change: the stub's own `if`
            // chain already treats an absent flag as falsy, so both drives see
            // exactly the arguments they saw before.
            const merged = { ...ready, ...shape.extra }
            // DELIBERATELY UNANNOTATED. `CurlFlags` keeps these fields
            // optional, and `Required<CurlFlags>` strips the `?` but preserves
            // the explicit `| undefined` in the source declaration, so both
            // annotations re-widen on spread and fail the same assignment.
            // Inference over the `?? false` expressions gives concrete
            // booleans, which is what the stub's options actually require.
            const flags = {
              readyAtTarget: merged.readyAtTarget,
              readyAtPrev: merged.readyAtPrev,
              setupAtTarget: merged.setupAtTarget ?? false,
              omitBuildShaAtTarget: merged.omitBuildShaAtTarget ?? false,
              omitBuildShaAtPrev: merged.omitBuildShaAtPrev ?? false,
              mismatchBuildShaAtPrev: merged.mismatchBuildShaAtPrev ?? false,
            }

            // The ORIGINAL, written by the forbidden file's own makeStubBin.
            const origRoot = join(temp, `orig-${compared}`)
            mkdirSync(origRoot, { recursive: true })
            const orig = makeStubBin(origRoot, { repo: state.repo, prevSha, targetSha, ...flags })

            // The REPLACEMENT, written by the layer under test.
            const replRoot = join(temp, `repl-${compared}`)
            const replBin = join(replRoot, "bin")
            mkdirSync(replBin, { recursive: true })
            writeCurlStub(replBin, join(replRoot, "curl.log"), join(replRoot, "trace.log"), join(replRoot, "curl.calls"), {
              repo: state.repo,
              prevSha,
              targetSha,
              ...flags,
            })

            for (const [endpoint, argv] of [
              ["healthz", healthzArgv(READINESS_PORT)],
              ["readyz", readyzArgv(READINESS_PORT)],
            ] as const) {
              // The AMBIENT env deliberately, not a fixture env: the ORIGINAL
              // stub resolves `git` from PATH by design, and the point of the
              // comparison is what each stub does in its own natural habitat.
              const a = spawnSync(join(orig.bin, "curl"), [...argv], { encoding: "utf8" })
              const b = spawnSync(join(replBin, "curl"), [...argv], { encoding: "utf8" })
              const where = `${state.name} / ready(${flags.readyAtTarget},${flags.readyAtPrev}) / ${shape.name} / ${endpoint}`
              expect(b.stdout, where).toBe(a.stdout)
              expect(b.status, where).toBe(a.status)
              // stderr is asserted too: a re-implementation that leaked a shell
              // diagnostic would otherwise pass on stdout alone.
              expect(b.stderr, where).toBe(a.stderr)
              compared += 1
            }
          }
        }
      }
      // A guard on the guard: if a future refactor empties the matrix, this
      // test must fail rather than silently prove nothing.
      expect(compared).toBe(expectedComparisons)
    },
    { timeout: 180_000 },
  )

  /**
   * THE ABSOLUTE-PATH PIN.
   *
   * `update-server-fixtures.ts:143` has the curl stub run `git -C <repo>
   * rev-parse HEAD` as its first action after its own log line, and the
   * fixture bin dir is FIRST on PATH with nothing in scripts/luna-update-server
   * or scripts/lib/luna-deploy.sh re-ordering it. So a bare `git` inside the
   * replacement resolves to the fixture's `git` SHIM, and every readiness poll
   * appends a git entry to git.log and trace.log.
   *
   * That breaks GATE 1 in two separate ways at once. git.log becomes exactly as
   * poll-count-dependent as the logs READINESS DETERMINISM admits it cannot
   * pin, so its STRICT diff starts flaking red on a CORRECT implementation. And
   * the poll-block definition normalisePollBlocks implements stops matching
   * anything real, because every block is interrupted by a git entry, so the
   * collapse never fires and the one scenario that needs it is compared
   * strictly against a varying log.
   *
   * This test drives the replacement ONCE with the fixture's own PATH in front
   * - the exact condition under which a bare `git` would resolve to the shim -
   * and asserts git.log did not change. Revert the absolute path and it fails
   * loudly here instead of flaking three suites later.
   */
  it("driving the replacement curl leaves git.log UNCHANGED, because it resolves git by absolute path", () => {
    const fixture = makeFixture({ readyAtTarget: true, readyAtPrev: false })
    const env = driveEnv(fixture)

    // Prove the premise rather than assume it: with this PATH, a bare `git`
    // DOES reach the shim, and the shim DOES write git.log. If that ever stops
    // being true the assertion below would pass vacuously.
    const viaShim = spawnSync("git", ["--version"], { env, encoding: "utf8" })
    expect(viaShim.status, viaShim.stderr).toBe(0)
    const afterShim = readFileSync(fixture.gitLog, "utf8")
    expect(afterShim).toBe("--version\n")

    const before = readFileSync(fixture.gitLog, "utf8")
    const traceBefore = readFileSync(fixture.traceLog, "utf8")

    const r = spawnSync(join(fixture.bin, "curl"), [...healthzArgv(fixture.readinessPort)], { env, encoding: "utf8" })
    expect(r.status).toBe(0)

    expect(readFileSync(fixture.gitLog, "utf8")).toBe(before)
    // and the shared trace gained the curl entry and NOTHING else: no poll
    // contributes a git entry to any artifact.
    const traceAdded = readFileSync(fixture.traceLog, "utf8").slice(traceBefore.length)
    expect(traceAdded.split("\n").filter((l) => l !== "")).toHaveLength(1)
    expect(traceAdded.startsWith("curl ")).toBe(true)
  })

  it("the bun replacement matches makeStubBin's original on stdout and status", () => {
    const temp = makeTempDir("deploy-cli-stub-fidelity-bun-")
    const orig = makeStubBin(temp, { repo: join(temp, "r"), prevSha: "p", targetSha: "t", readyAtTarget: true, readyAtPrev: false })
    const fixture = makeFixture({ readyAtTarget: true, readyAtPrev: false })
    const argv = ["install", "--cwd", "/root/luna", "--frozen-lockfile"]
    const a = spawnSync(join(orig.bin, "bun"), argv, { encoding: "utf8" })
    const b = spawnSync(join(fixture.bin, "bun"), argv, { env: driveEnv(fixture), encoding: "utf8" })
    expect(b.stdout).toBe(a.stdout)
    expect(b.stderr).toBe(a.stderr)
    expect(b.status).toBe(a.status)
    // The one intended difference: the replacement also appends to the shared trace.
    expect(readFileSync(fixture.traceLog, "utf8")).toBe(`bun ${argv.join(" ")}\n`)
    expect(readFileSync(fixture.bunLog, "utf8")).toBe(`${argv.join(" ")}\n`)
  })

  it("the systemctl replacement matches makeStubBin's original on stdout, status and its own log", () => {
    const temp = makeTempDir("deploy-cli-stub-fidelity-systemctl-")
    const orig = makeStubBin(temp, { repo: join(temp, "r"), prevSha: "p", targetSha: "t", readyAtTarget: true, readyAtPrev: false })
    const fixture = makeFixture({ readyAtTarget: true, readyAtPrev: false })
    const cases: ReadonlyArray<ReadonlyArray<string>> = [
      ["is-active", "luna-chat-server.service"],
      ["show", "luna-chat-server.service", "--property=NRestarts", "--value"],
      ["show", "luna-chat-server.service", "--property=MainPID", "--value"],
      ["daemon-reload"],
      ["stop", "luna-chat-server.service"],
    ]
    for (const argv of cases) {
      const a = spawnSync(join(orig.bin, "systemctl"), [...argv], { encoding: "utf8" })
      const b = spawnSync(join(fixture.bin, "systemctl"), [...argv], { env: driveEnv(fixture), encoding: "utf8" })
      expect(b.stdout, argv.join(" ")).toBe(a.stdout)
      expect(b.status, argv.join(" ")).toBe(a.status)
    }
    // The own-log bytes must match too: three green PR1 suites read
    // systemctl.log and would break on a reformatted line.
    expect(readFileSync(fixture.systemctlLog, "utf8")).toBe(readFileSync(orig.systemctlLog, "utf8"))
  })

  it("resolveHostTool refuses to answer from a fixture bin dir, and names the fix when the tool is absent", () => {
    // The absent-tool message is the whole point of the throw: a parity gate
    // that SKIPS looks exactly like one that passes.
    expect(() => resolveHostTool("definitely-not-a-real-host-tool-xyzzy")).toThrow(/no executable regular file named/)
    expect(() => resolveHostTool("definitely-not-a-real-host-tool-xyzzy")).toThrow(/ambient PATH/)

    // And the positive half: the resolved tool is absolute, executable, and
    // outside every fixture root this module has handed out.
    const fixture = makeFixture({ readyAtTarget: true, readyAtPrev: false })
    for (const name of ["bash", "git"]) {
      const resolved = resolveHostTool(name)
      expect(resolved.startsWith("/")).toBe(true)
      expect(resolved.startsWith(fixture.temp)).toBe(false)
    }
    // The fixture DOES carry its own bash and git; they are shims, and the
    // point of resolveHostTool is that it never returns one of them.
    expect(readFileSync(join(fixture.bin, "bash"), "utf8").startsWith("#!/bin/sh\n")).toBe(true)
    expect(readFileSync(join(fixture.bin, "git"), "utf8")).toContain(`exec "${resolveHostTool("git")}" "$@"`)
  })

  it("the git shim is transparent: same stdout, stderr and status as the real git, plus a log line", () => {
    const fixture = makeFixture({ readyAtTarget: true, readyAtPrev: false })
    const env = driveEnv(fixture)
    const real = spawnSync(resolveHostTool("git"), ["-C", fixture.work, "rev-parse", "HEAD"], { env, encoding: "utf8" })
    const viaShim = spawnSync(join(fixture.bin, "git"), ["-C", fixture.work, "rev-parse", "HEAD"], { env, encoding: "utf8" })
    expect(viaShim.stdout).toBe(real.stdout)
    expect(viaShim.stderr).toBe(real.stderr)
    expect(viaShim.status).toBe(real.status)
    expect(readFileSync(fixture.gitLog, "utf8")).toBe(`-C ${fixture.work} rev-parse HEAD\n`)
  })

  it("the ss stub emits one ESTAB line per simulated session and honours its rc", () => {
    const zero = makeFixture({ readyAtTarget: true, readyAtPrev: false })
    const two = makeFixture({ readyAtTarget: true, readyAtPrev: false, ss: { sessions: 2 } })
    const unknown = makeFixture({ readyAtTarget: true, readyAtPrev: false, ss: { rc: 1 } })
    const filter = `state established sport = :${READINESS_PORT}`
    const run = (f: { readonly bin: string }, env: Record<string, string>) =>
      spawnSync(join(f.bin, "ss"), ["-Htn", filter], { env, encoding: "utf8" })

    const a = run(zero, driveEnv(zero))
    expect(a.status).toBe(0)
    expect(a.stdout).toBe("")

    const b = run(two, driveEnv(two))
    expect(b.status).toBe(0)
    expect(b.stdout.split("\n").filter((l) => l !== "")).toHaveLength(2)

    const c = run(unknown, driveEnv(unknown))
    expect(c.status).toBe(1)

    // The own log carries the argv the guard passed as ONE quoted word, which
    // is what both engines' bare-host arms do.
    expect(readFileSync(zero.ssLog, "utf8")).toBe(`ss -Htn ${filter}\n`)
  })

  it("readyAfterCalls answers not-ready until the count is reached, and is inert when unset", () => {
    const retry = makeFixture({ readyAtTarget: true, readyAtPrev: false, readyAfterCalls: 3 })
    const env = driveEnv(retry)
    git(retry.work, "checkout", "--quiet", retry.targetSha)
    const codes = [1, 2, 3, 4].map(
      () => spawnSync(join(retry.bin, "curl"), [...healthzArgv(retry.readinessPort)], { env, encoding: "utf8" }).stdout,
    )
    expect(codes).toEqual(["503", "503", "200", "200"])

    // Unset: the counting block is not even emitted, so the stub answers from
    // HEAD alone on every call. That inertness is what makes the fidelity
    // comparison above meaningful.
    const plain = makeFixture({ readyAtTarget: true, readyAtPrev: false })
    git(plain.work, "checkout", "--quiet", plain.targetSha)
    const plainEnv = driveEnv(plain)
    const plainCodes = [1, 2, 3].map(
      () => spawnSync(join(plain.bin, "curl"), [...healthzArgv(plain.readinessPort)], { env: plainEnv, encoding: "utf8" }).stdout,
    )
    expect(plainCodes).toEqual(["200", "200", "200"])
    expect(readFileSync(join(plain.bin, "curl"), "utf8")).not.toContain("curl.calls")
  })

  it("driveEnv is one map for both drives, mkdirs HOME, and never carries LUNA_TEST_WS_COUNT", () => {
    const fixture = makeFixture({ readyAtTarget: true, readyAtPrev: false })
    const env = driveEnv(fixture)
    expect(Object.keys(env).sort()).toEqual([
      "HOME",
      "LANG",
      "LC_ALL",
      "LUNA_DEPLOY_BASH_ENGINE",
      "LUNA_RESTART_SETTLE_SECS",
      "LUNA_TEST_BUN_PATH",
      "LUNA_UPDATE_STATE_DIR",
      "PATH",
      "TZ",
    ])
    // concern 21: HOME must EXIST, because luna_find_bun's $HOME/.bun/bin/bun
    // fallback and git's config lookup both read it, and a directory present on
    // one drive and absent on the other is the asymmetry this map removes.
    expect(readFileSync(join(fixture.bin, "bun"), "utf8")).toContain("#!/usr/bin/env bash")
    const probe = spawnSync(resolveHostTool("bash"), ["-c", 'test -d "$HOME" && printf yes'], { env, encoding: "utf8" })
    expect(probe.stdout).toBe("yes")
    expect(env.LUNA_RESTART_SETTLE_SECS).toBe("0")
    expect(driveEnv(fixture, { settleSecs: "1" }).LUNA_RESTART_SETTLE_SECS).toBe("1")

    // Both drives get the SAME shape; only the per-root values differ, which is
    // the entire reason the pair has two roots.
    const other = makeFixture({ readyAtTarget: true, readyAtPrev: false })
    expect(Object.keys(driveEnv(other)).sort()).toEqual(Object.keys(env).sort())
    expect(driveEnv(other).LUNA_DEPLOY_BASH_ENGINE).toBe(env.LUNA_DEPLOY_BASH_ENGINE)
  })

  it("the failing sleep stub is opt-in, logs to the shared trace and exits 1", () => {
    const plain = makeFixture({ readyAtTarget: true, readyAtPrev: false })
    expect(spawnSync(join(plain.bin, "sleep"), ["0"], { encoding: "utf8" }).error).toBeDefined()

    const failing = makeFixture({ readyAtTarget: true, readyAtPrev: false, failingSleep: true })
    const r = spawnSync(join(failing.bin, "sleep"), ["1"], { env: driveEnv(failing), encoding: "utf8" })
    expect(r.status).toBe(1)
    expect(readFileSync(failing.traceLog, "utf8")).toBe("sleep 1\n")
  })

  it("the readiness argv pair is per-scenario and defaults to the historic values byte for byte", () => {
    const dflt = makeFixture({ readyAtTarget: true, readyAtPrev: false })
    expect(dflt.args).toContain("--readiness-timeout")
    expect(dflt.args[dflt.args.indexOf("--readiness-timeout") + 1]).toBe("2")
    expect(dflt.args[dflt.args.indexOf("--readiness-interval") + 1]).toBe("0.3")

    const pinned = makeFixture({ readyAtTarget: true, readyAtPrev: false, readiness: { timeout: "2", interval: "3" } })
    expect(pinned.args[pinned.args.indexOf("--readiness-timeout") + 1]).toBe("2")
    expect(pinned.args[pinned.args.indexOf("--readiness-interval") + 1]).toBe("3")
    // and NOTHING else moved. The two fixtures own different roots, so the
    // comparison is on root-relative argv: rewrite each vector against its own
    // root before diffing, or every path-valued slot reads as a difference.
    const rooted = (args: ReadonlyArray<string>, root: string): ReadonlyArray<string> =>
      args.map((a) => a.split(root).join("<ROOT>"))
    const a = rooted(dflt.args, dflt.temp)
    const b = rooted(pinned.args, pinned.temp)
    expect(a.length).toBe(b.length)
    expect(a.filter((x, i) => x !== b[i])).toEqual(["0.3"])
  })

  /**
   * DRIVE A, END TO END, which is the one thing nothing else here proves.
   *
   * `driveEnv` deliberately drops LUNA_TEST_WS_COUNT (blocker R21) and replaces
   * it with a real `ss` on the fixture PATH (blockers B6/B15). If that swap is
   * wrong the bash engine does not fail loudly - it falls into
   * `luna_active_ws_count`'s UNKNOWN arm and defers with exit 3, which reads
   * like a legitimate session-guard verdict. Every GATE 1 scenario would then
   * be comparing two engines that both never ran. So the oracle drive is
   * exercised here, on a happy path, before anything is built on top of it.
   */
  it(
    "runBashDrive: the real bash engine completes a happy path under driveEnv, with the guard probing the ss stub",
    async () => {
      const { runBashDrive, captureArtifacts } = await import("./bash-fixtures.js")
      // The pinned pair from GATE 1: READINESS DETERMINISM half (a).
      const fixture = makeFixture({ readyAtTarget: true, readyAtPrev: false, readiness: { timeout: "2", interval: "3" } })
      const result = runBashDrive(fixture)
      expect(result.status, result.stdout + result.stderr).toBe(0)
      expect(result.stdout).toContain("Checked out: ")

      const artifacts = captureArtifacts(fixture, result)
      expect(artifacts.head).toBe(fixture.targetSha)
      expect(artifacts.journal).toBeNull()
      expect(artifacts.lockDirPresent).toBe(false)

      // The guard really ran the probe rather than short-circuiting on an
      // ambient LUNA_TEST_WS_COUNT: the ss stub was invoked.
      // The real spelling luna_active_ws_count passes (luna-deploy.sh:283-287),
      // captured rather than transcribed: the filter travels as ONE quoted argv
      // word, which is what lets a single stub serve both engines' arms.
      expect(artifacts.ss ?? "").toContain(`ss -tnH state established ( sport = :${fixture.readinessPort} )`)

      // EXACTLY ONE readiness poll iteration, which is what
      // `--readiness-timeout 2 --readiness-interval 3` buys by construction:
      // the first `while (( SECONDS < deadline ))` always passes with at least
      // a one-second margin, and `sleep 3` guarantees the second never does.
      // A passing poll returns from inside the iteration before the sleep, so
      // this happy path costs one iteration and no sleep at all.
      const curlLines = (artifacts.curl ?? "").split("\n").filter((l) => l !== "")
      expect(curlLines.filter((l) => l.includes("/healthz"))).toHaveLength(1)
      expect(curlLines.filter((l) => l.includes("/readyz"))).toHaveLength(1)

      // And the shared trace records cross-stub ORDER, which no per-stub log
      // can: the restart precedes the readiness probe, which precedes the seed.
      const trace = (artifacts.trace ?? "").split("\n").filter((l) => l !== "")
      const firstIndex = (pred: (l: string) => boolean): number => trace.findIndex(pred)
      const start = firstIndex((l) => l.startsWith("systemctl start "))
      const healthz = firstIndex((l) => l.includes("/healthz"))
      const seed = firstIndex((l) => l.startsWith("bun run "))
      expect(start).toBeGreaterThanOrEqual(0)
      expect(healthz).toBeGreaterThan(start)
      expect(seed).toBeGreaterThan(healthz)
    },
    { timeout: 120_000 },
  )

  it("captureArtifacts reads the ten artifacts and maskArtifacts collapses exactly the three masked dimensions", async () => {
    const { captureArtifacts, maskArtifacts, MASK_ROOT, MASK_UPDATED_AT, MASK_PID } = await import("./bash-fixtures.js")
    const fixture = makeFixture({ readyAtTarget: true, readyAtPrev: false })
    mkdirSync(fixture.updateState, { recursive: true })
    writeFileSync(
      fixture.journalPath,
      `phase=prepared\nprev=${fixture.prevSha}\ntarget=${fixture.targetSha}\nprev_lock_hash=\nupdated_at=1700000000\n`,
    )
    mkdirSync(fixture.lockDir, { recursive: true })
    writeFileSync(join(fixture.lockDir, "owner"), "pid=4242\nfingerprint=abc\n")

    const captured = captureArtifacts(fixture, { status: 0, signal: null, stdout: `at ${fixture.temp}\n`, stderr: "" })
    expect(captured.exitCode).toBe(0)
    expect(captured.lockDirPresent).toBe(true)
    expect(captured.head).toMatch(/^[0-9a-f]{40}$/)
    expect(captured.journal).toContain("updated_at=1700000000")
    expect(captured.tree.some((l) => l.startsWith("f bin/curl "))).toBe(true)

    const masked = maskArtifacts(captured, fixture)
    expect(masked.stdout).toBe(`at ${MASK_ROOT}\n`)
    expect(masked.journal).toContain(MASK_UPDATED_AT)
    expect(masked.journal).not.toContain("1700000000")
    expect(masked.tree.every((l) => !l.includes(fixture.temp))).toBe(true)
    // Rule 3 is asserted through a synthetic owner record, since every current
    // scenario asserts the lock dir is ABSENT after the run.
    expect(maskArtifacts({ ...captured, stderr: "pid=4242\n" }, fixture).stderr).toBe(`${MASK_PID}\n`)
  })
})
