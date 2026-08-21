import { appendFileSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { afterEach, describe, expect, it } from "vitest"
import {
  type Harness,
  allCalls,
  cleanupTracked,
  forceCalls,
  headSha,
  incidentCount,
  installHarness,
  invocationLines,
  journalPath,
  journalValue,
  makeConvergedHarness as makeConvergedHarnessFixture,
  makeHarness as makeHarnessFixture,
  makeRestrictedBin,
  MUTATING_SYSTEMCTL,
  pinnedGuardian,
  processFingerprint,
  releaseManifest,
  repairCalls,
  runCheck,
  runPinnedCheck,
  seedJournal,
  snapshotUnits,
  statusValue,
  trackDir,
  writeBunBuildStub,
  writeStub,
  writeSystemctlStub,
} from "./helpers/guardian-harness"

const root = new URL("..", import.meta.url).pathname
const guardian = join(root, "scripts/luna-guardian")
const fixture = join(root, "test/fixtures/servers.toml")

/**
 * Removes a `pins/current-<profile>` SYMLINK itself, never what it points at.
 *
 * Use this instead of `rmSync` on any pin symlink a fixture is about to
 * replace (matches the established fix for the same trap in
 * releases-layout.test.ts's `unlinkCurrent`). `rmSync` stats THROUGH the
 * link, so on a link-to-directory it throws ERR_FS_EISDIR ("Path is a
 * directory") on Node 24 and the whole test dies before it can assert
 * anything; `rmSync(..., { recursive: true })` would "work" but by deleting
 * the engine directory the pin resolves to, silently destroying the fixture
 * the test is about to make claims against - a green suite proving nothing.
 * `unlinkSync` is the only call with the semantics a pin swap actually
 * wants. Asserts the target really is a symlink first, so a future fixture
 * bug that hands this the wrong path fails loudly here instead of silently
 * deleting something else.
 */
function unlinkPin(pins: string, name: string): void {
  const target = join(pins, name)
  if (!lstatSync(target).isSymbolicLink()) {
    throw new Error(`unlinkPin: ${target} is not a symlink - refusing to unlink (fixture bug, not a product bug)`)
  }
  unlinkSync(target)
}

// S21's publish_engine compiles apps/deploy-cli on every publish (scripts/
// luna-guardian), through the RUNTIME's own bun - the container's bun via
// run_runtime/incus exec for an incus profile, the publishing host's own bun
// otherwise. makeHarness/makeConvergedHarness (test/helpers/guardian-harness.ts)
// write their OWN registry with no incus stanza, so every test built on
// makeHarnessWithDeployCli/makeConvergedHarnessWithDeployCli below takes the
// BARE-HOST branch and needs only stubBun, never writeIncusPassthroughStub.
// The incus branch is exercised separately by tests using `fixture`
// (test/fixtures/servers.toml, whose stable/dev stanzas ARE incus-backed) or
// a hand-built registry - those call writeIncusPassthroughStub explicitly at
// their own setup site. Every harness-driven install test below just needs
// publish_engine to complete, so these two wrappers stub `bun build
// --compile` with a placeholder-file write instead of paying for a real
// compile per install. The ONE test that proves the REAL artifact actually
// compiles and runs is "naming the binary luna-deploy would collide..."
// below, which invokes `bun build --compile` directly against apps/deploy-cli,
// never through publish_engine's own plumbing.
// See the comment above makeHarnessWithDeployCli for which tests need the
// real deploy-cli artifact and which do not. strict:true (unrecognized bun
// invocations fail loudly) since a harness-driven install taking a code path
// this stub does not model should surface here, not downstream.
const stubBun = (bin: string) => writeBunBuildStub(bin, { strict: true })
// Named distinctly from the imported *Fixture functions they wrap (rather
// than shadowing makeHarness/makeConvergedHarness under the same name), so
// every call site below is visibly opted into the bun stub, not silently
// resolving to a different function than the import list names.
const makeHarnessWithDeployCli: typeof makeHarnessFixture = (label) => {
  const h = makeHarnessFixture(label)
  stubBun(join(h.temp, "bin"))
  return h
}
const makeConvergedHarnessWithDeployCli: typeof makeConvergedHarnessFixture = (label, opts) => {
  const h = makeConvergedHarnessFixture(label, opts)
  stubBun(join(h.temp, "bin"))
  return h
}

// Container-seam stub for publish_engine's incus compile branch: `incus exec
// <container> -- argv...` re-executes argv LOCALLY - the same shape as
// makeProbeFixture's incus stub below, kept separate since this one can
// optionally log invocations for a test that asserts the build actually
// routed through it. Every writeGuardianRegistry-backed test declares an
// incus profile, so publish_engine's compile step now needs this stub too;
// pair it with stubBun and LUNA_TEST_BUN_PATH so run_runtime finds a working
// "container" bun once execution passes through here.
const writeIncusPassthroughStub = (bin: string, log?: string) => {
  const logLine = log ? `printf '%s\\n' "\$*" >> "${log}"\n` : ""
  writeStub(join(bin, "incus"), `#!/usr/bin/env bash
${logLine}[[ "\${1:-}" == exec ]] || exit 1
shift 2
if [[ "\${1:-}" == -- ]]; then shift; fi
exec "\$@"
`)
}

const writeGuardianRegistry = (file: string) => {
  writeFileSync(
    file,
    [
      `kind = "registry"`,
      `[[server]]`,
      `name = "stable"`,
      `update.params.hostRepoDir = "${root}"`,
      `update.params.ref = "origin/master"`,
      `runtime.target.incus.container = "luna-stable"`,
      `ports.proxy = 4753`,
      `deploy.timer = true`,
    ].join("\n") + "\n",
  )
}

// Classify a single probe outcome through the real library function, with
// systemctl/curl/incus replaced by stubs driven from the environment.
//
// `bin` shadows the host tools and provides an `incus` that re-executes the
// remote argv locally, so the incus arm — the one that actually runs on the
// live box, where P_INCUS=luna-stable — is exercised, not just the direct arm.
// `isolated` is a PATH with no `incus` at all (the host really has
// /usr/bin/incus, so it cannot simply be omitted from a normal PATH).
type ProbeFixture = { bin: string; isolated: string; repo: string; head: string }

const makeProbeFixture = (): ProbeFixture => {
  const temp = trackDir(mkdtempSync(join(tmpdir(), "luna-classify-")))
  const bin = join(temp, "bin")
  const isolated = join(temp, "isolated")
  const repo = join(temp, "repo")
  mkdirSync(bin, { recursive: true })
  mkdirSync(isolated, { recursive: true })
  mkdirSync(repo, { recursive: true })
  spawnSync("git", ["-C", repo, "init", "-q"], { encoding: "utf8" })
  spawnSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t",
    "commit", "-q", "--allow-empty", "-m", "x"], { encoding: "utf8" })
  const systemctl = `#!/usr/bin/env bash\nprintf '%s\\n' "\${STUB_IS_ACTIVE-}"\nexit "\${STUB_IS_ACTIVE_RC:-0}"\n`
  const curl = `#!/usr/bin/env bash\nfor a in "$@"; do case "$a" in\n  *healthz) exit "\${STUB_HEALTHZ_RC:-0}" ;;\n  *readyz) printf '%s' "\${STUB_READY-}"; exit "\${STUB_READYZ_RC:-0}" ;;\nesac; done\nexit 0\n`
  for (const dir of [bin, isolated]) {
    writeStub(join(dir, "systemctl"), systemctl)
    writeStub(join(dir, "curl"), curl)
    for (const tool of ["bash", "git", "sed", "env"]) {
      const real = spawnSync("bash", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim()
      spawnSync("ln", ["-sf", real, join(dir, tool)])
    }
  }
  // `incus exec <container> -- argv...` runs argv against the stubs above; a
  // non-zero STUB_INCUS_RC simulates a stopped container or a wedged agent,
  // which produces empty output rather than a systemd answer.
  writeStub(join(bin, "incus"),
    `#!/usr/bin/env bash\nif [[ "\${STUB_INCUS_RC:-0}" != 0 ]]; then exit "\${STUB_INCUS_RC}"; fi\n` +
    `[[ "\${1:-}" == exec ]] || exit 1\nshift 2\nif [[ "\${1:-}" == -- ]]; then shift; fi\nexec "$@"\n`)
  const head = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim()
  return { bin, isolated, repo, head }
}

type Probe = {
  repo?: string
  incus?: string
  isolate?: boolean
  isActive?: string
  isActiveRc?: string
  incusRc?: string
  healthzRc?: string
  readyzRc?: string
  ready?: string
}

const classify = (f: ProbeFixture, probe: Probe) => {
  const dir = probe.isolate ? f.isolated : f.bin
  const result = spawnSync("bash", ["-c",
    `source "${join(root, "scripts/lib/luna-deploy.sh")}"; rc=0; ` +
    `luna_runtime_matches_checkout "$1" 4753 "$2" svc || rc=$?; printf '%s' "$rc"`, "_",
    probe.repo ?? f.repo,
    probe.incus ?? "",
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      // An isolated run must not inherit the host PATH, or it would find the
      // real /usr/bin/incus and defeat the "incus is missing" case.
      PATH: probe.isolate ? dir : `${dir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      STUB_IS_ACTIVE: probe.isActive ?? "active",
      STUB_IS_ACTIVE_RC: probe.isActiveRc ?? "0",
      STUB_INCUS_RC: probe.incusRc ?? "0",
      STUB_HEALTHZ_RC: probe.healthzRc ?? "0",
      STUB_READYZ_RC: probe.readyzRc ?? "0",
      STUB_READY: probe.ready ?? "",
    },
  })
  return Number(result.stdout)
}

const seamCode = (value: string) => {
  const result = spawnSync("bash", ["-c",
    `source "${join(root, "scripts/lib/luna-deploy.sh")}"; rc=0; ` +
    `luna_runtime_matches_checkout /nonexistent 1 "" svc || rc=$?; printf '%s' "$rc"`,
  ], { encoding: "utf8", env: { ...process.env, LUNA_TEST_RUNTIME_MATCHES_CHECKOUT: value } })
  return Number(result.stdout)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

afterEach(cleanupTracked)

describe("luna-guardian", () => {
  it("units-only reconciliation never mutates state or restarts", () => {
    const temp = mkdtempSync(join(tmpdir(), "luna-units-test-"))
    trackDir(temp)
    const result = spawnSync("bash", [
      join(root, "scripts/luna-server-install"), "--dry-run", "--units-only",
      "--profile", "stable", "--repo-dir", join(temp, "repo"),
      "--luna-home", join(temp, "state"), "--service-dir", join(temp, "units"),
    ], {
      cwd: root, encoding: "utf8",
      env: { ...process.env, LUNA_TEST_BUN_PATH: "/root/.bun/bin/bun", LUNA_TAILSCALE_IP: "" },
    })
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toContain("Would write")
    expect(result.stdout).not.toContain("UI_WS_TOKEN=")
    expect(result.stdout).not.toContain("systemctl restart")
    expect(existsSync(join(temp, "state"))).toBe(false)
  })

  it("is executable and syntactically valid", () => {
    expect(spawnSync("bash", ["-n", guardian]).status).toBe(0)
    expect(spawnSync("test", ["-x", guardian]).status).toBe(0)
    const source = readFileSync(guardian, "utf8")
    expect(source).toContain("refresh_guardian_if_needed")
    expect(source).toContain("if runtime_health; then refresh_guardian_if_needed")
    // The promotion gate must live INSIDE refresh_guardian_if_needed — the
    // single choke point both automated pin advances flow through
    // (update_then_refresh and the post-repair check) — and must consume the
    // SAME evidence verifier accept uses, not a forked format.
    const refreshBody = source.match(/refresh_guardian_if_needed\(\) \{[\s\S]*?\n\}/)?.[0] ?? ""
    expect(refreshBody).toContain("guardian_status_evidence")
    expect(refreshBody).toContain("consecutive_runtime_healthy")
  })

  it("installs an immutable engine and independent timer/alert units", () => {
    const temp = mkdtempSync(join(tmpdir(), "luna-guardian-test-"))
    trackDir(temp)
    const bin = join(temp, "bin")
    const units = join(temp, "systemd")
    const pins = join(temp, "pins")
    const state = join(temp, "state")
    const lunaHome = join(temp, "luna-home")
    const systemctlState = join(temp, "systemctl-state")
    mkdirSync(bin, { recursive: true })
    mkdirSync(units, { recursive: true })
    writeSystemctlStub(bin)
    // fixture (test/fixtures/servers.toml) declares stable as incus-backed -
    // publish_engine's compile step now routes through run_runtime/incus exec
    // for it, so a hermetic run needs the container-seam stub too.
    writeIncusPassthroughStub(bin)
    stubBun(bin)

    const result = spawnSync("bash", [guardian, "install", "stable", "--interval", "2min"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        LUNA_SERVERS_CONFIG: fixture,
        LUNA_TEST_STAT_MODE: "600",
        LUNA_HOME: lunaHome,
        LUNA_GUARDIAN_PIN_BASE: pins,
        LUNA_GUARDIAN_STATE_DIR: state,
        LUNA_UPDATE_STATE_DIR: join(temp, "update"),
        LUNA_TEST_SYSTEMD_DIR: units,
        LUNA_TEST_SYSTEMCTL_STATE: systemctlState,
        LUNA_TEST_RUNTIME_MATCHES_CHECKOUT: "true",
        LUNA_TEST_BUN_PATH: join(bin, "bun"),
      },
    })

    expect(result.status, result.stdout + result.stderr).toBe(0)
    const current = join(pins, "current-stable")
    expect(existsSync(current)).toBe(true)
    expect(existsSync(join(current, ".complete"))).toBe(true)
    expect(existsSync(join(current, "luna-update-server"))).toBe(true)
    expect(existsSync(join(current, "luna-autodeploy"))).toBe(true)
    expect(existsSync(join(current, "luna-server-install"))).toBe(true)
    expect(existsSync(join(current, "luna-pager"))).toBe(true)
    expect(existsSync(join(current, "luna-doctor"))).toBe(true)
    expect(existsSync(join(current, "lib", "luna-deploy.sh"))).toBe(true)
    expect(existsSync(join(current, "lib", "luna-registry.sh"))).toBe(true)
    // S21: publish_engine also compiles apps/deploy-cli into the pin, named
    // off the luna-* prefix (see scripts/luna-guardian's publish_engine
    // comment) so it can never collide with the `bash -n "$tmp"/luna-*`
    // syntax check, and proves it runs before the pin is marked complete.
    const deployCli = join(current, "deploy-cli")
    expect(existsSync(deployCli)).toBe(true)
    // Symbolic `chmod +x` applies the umask, so the group/other execute bits
    // are not guaranteed - only that SOME execute bit is set (this process
    // owns the file, so owner-execute always survives).
    expect(statSync(deployCli).mode & 0o100).toBe(0o100)
    const deployCliVersion = spawnSync(deployCli, ["--version"], { encoding: "utf8" })
    expect(deployCliVersion.status, deployCliVersion.stdout + deployCliVersion.stderr).toBe(0)
    expect(deployCliVersion.stdout.trim().length, "must print a version, not silently exit 0").toBeGreaterThan(0)

    const service = readFileSync(join(units, "luna-guardian-stable.service"), "utf8")
    expect(service).toContain(`ExecStart=${current}/luna-guardian check stable`)
    expect(service).toContain(`Environment=LUNA_HOME=${lunaHome}`)
    expect(service).toContain("OnFailure=luna-guardian-alert-stable.service")
    expect(service).toContain("TimeoutStartSec=12min")
    const timer = readFileSync(join(units, "luna-guardian-stable.timer"), "utf8")
    expect(timer).toContain("OnActiveSec=90s")
    expect(timer).not.toContain("OnBootSec=")
    expect(timer).toContain("OnUnitInactiveSec=2min")
    expect(timer).toContain("Persistent=true")
    const alert = readFileSync(join(units, "luna-guardian-alert-stable.service"), "utf8")
    expect(alert).toContain(`${current}/luna-pager`)
    expect(alert).not.toContain("/root/luna/stable/repo/scripts/luna-pager")
    expect(alert).toContain(`Environment=LUNA_HOME=${lunaHome}`)
    expect(alert).toContain(`EnvironmentFile=-${lunaHome}/pager.env`)
    expect(alert).not.toContain(`${state}/pager.env`)
  })

  it("naming the binary luna-deploy would collide with the bash -n glob it validates - deploy-cli is named off the prefix instead", () => {
    // Regression lock for the glob-collision publish_engine's comment
    // documents: `chmod +x "$tmp"/luna-*; bash -n "$tmp"/luna-* "$tmp/lib/"*.sh`
    // globs on the luna-* prefix, so a compiled artifact named luna-deploy
    // would be handed to `bash -n` as if it were a script. Uses the REAL
    // compiled deploy-cli bytes, not synthetic magic bytes: a few raw ELF/
    // Mach-O header bytes alone do not reliably trip bash's own
    // "cannot execute binary file" refusal - only a real executable does.
    //
    // The REAL artifact name is read out of publish_engine's own --outfile
    // literal (not hand-copied here) so a future rename of the artifact
    // changes what this test exercises instead of silently testing a name
    // publish_engine no longer uses.
    const guardianSrc = readFileSync(guardian, "utf8")
    const outfileMatch = guardianSrc.match(/--outfile="\$tmp\/([^"]+)"/)
    expect(outfileMatch, "publish_engine's deploy-cli --outfile literal").not.toBeNull()
    const artifactName = outfileMatch![1]
    // Lock the naming decision in directly: whatever publish_engine builds
    // must never sit inside the luna-* glob it would then collide with.
    expect(artifactName).not.toMatch(/^luna-/)

    const temp = mkdtempSync(join(tmpdir(), "luna-glob-collision-"))
    trackDir(temp)
    mkdirSync(join(temp, "lib"), { recursive: true })
    writeFileSync(join(temp, "luna-guardian"), "#!/usr/bin/env bash\ntrue\n")
    writeFileSync(join(temp, "lib", "x.sh"), "true\n")
    const build = spawnSync(
      "bun",
      ["build", "--compile", `--outfile=${join(temp, "deploy-cli-real")}`, "src/main.ts"],
      { cwd: join(root, "apps/deploy-cli"), encoding: "utf8", timeout: 60_000 },
    )
    expect(build.status, build.stdout + build.stderr).toBe(0)

    const lunaDeploy = join(temp, "luna-deploy")
    writeFileSync(lunaDeploy, readFileSync(join(temp, "deploy-cli-real")))
    const collision = spawnSync("bash", ["-c", 'bash -n "$1"/luna-* "$1/lib/"*.sh', "_", temp], { encoding: "utf8" })
    expect(collision.status, "a luna-*-prefixed binary must NOT silently pass bash -n").not.toBe(0)

    // The REAL artifact name sits outside the glob and is unaffected: prove
    // the glob expansion itself excludes it, not just that `bash -n` exits 0
    // (which it would do identically if artifactName's writeFileSync above
    // were deleted entirely, since an empty `bash -n` with no args is also 0).
    rmSync(lunaDeploy)
    const realName = join(temp, artifactName)
    writeFileSync(realName, readFileSync(join(temp, "deploy-cli-real")))
    const globbed = spawnSync("bash", ["-c", 'printf "%s\\n" "$1"/luna-* "$1/lib/"*.sh', "_", temp], { encoding: "utf8" })
    expect(globbed.stdout.trim().split("\n").sort()).toEqual(
      [join(temp, "luna-guardian"), join(temp, "lib", "x.sh")].sort(),
    )
    const clean = spawnSync("bash", ["-c", 'bash -n "$1"/luna-* "$1/lib/"*.sh', "_", temp], { encoding: "utf8" })
    expect(clean.status, clean.stdout + clean.stderr).toBe(0)
  })

  it("a pin published by an older (pre-deploy-cli) engine, missing the binary, is still classified complete", () => {
    const h = makeConvergedHarnessWithDeployCli("luna-guardian-pre-deploy-cli-")
    installHarness(h)
    const current = join(h.env.LUNA_GUARDIAN_PIN_BASE as string, "current-stable")
    expect(existsSync(join(current, "deploy-cli"))).toBe(true)
    // Simulate a pin an older engine (pre-S21) published: .complete already
    // present, deploy-cli never existed. The completeness classifier under
    // test is install_guardian's converged fast-path (scripts/luna-guardian
    // ~:1217-1218): `.complete` plus `-x luna-guardian`/`-x luna-pager`, which
    // names neither deploy-cli nor any binary.
    rmSync(join(current, "deploy-cli"))
    expect(existsSync(join(current, ".complete"))).toBe(true)

    // Drive the classifier directly by re-running `install` from the
    // CHECKOUT (h.guardian) - not `check`, and not through the pin symlink.
    // `check` cannot reach it here: makeConvergedHarnessWithDeployCli's
    // engine sha equals P_REPO HEAD, so refresh_guardian_if_needed's early
    // return (scripts/luna-guardian:476) fires before install_guardian is
    // ever called. Running `install` THROUGH the pin symlink is also wrong -
    // production only ever invokes it from a checkout (refresh_guardian_
    // if_needed re-execs "$P_REPO/scripts/luna-guardian install", never the
    // pin's own copy) - and install_guardian's un-physical `cd "$SCRIPT_DIR/
    // .." ` would resolve `root` to PIN_BASE, not the engine's real root, if
    // run through the symlink.
    //
    // The fast-path returns 0 SILENTLY (no stdout). Falling through to a
    // full re-install - e.g. a future change that adds `-x "$current/
    // deploy-cli"` to the fast-path condition - prints "luna-guardian:
    // installed ...", so stdout is what proves which branch actually ran.
    const reinstall = spawnSync("bash", [h.guardian, "install", "stable"], {
      cwd: root,
      encoding: "utf8",
      env: { ...h.env, LUNA_TEST_RUNTIME_MATCHES_CHECKOUT: "true" },
    })
    expect(reinstall.status, reinstall.stdout + reinstall.stderr).toBe(0)
    expect(reinstall.stdout, "must take the converged fast-path, not fall through to a full re-install").toBe("")
    expect(existsSync(join(current, "deploy-cli")), "fast-path must not resurrect the missing binary").toBe(false)

    // render_control_plane (scripts/luna-guardian:~1016) is the OTHER call
    // site sharing this exact completeness classifier - it fires on every
    // ordinary `check` tick that finds control-plane drift, not just a
    // by-hand `install` re-run. Force real drift (delete the rendered timer
    // unit) so this tick genuinely reaches render_control_plane, and prove
    // its own `-x luna-guardian`/`-x luna-pager` gate tolerates the missing
    // binary too - the same property, through the path production actually
    // walks every tick.
    const timer = join(h.env.LUNA_TEST_SYSTEMD_DIR as string, "luna-guardian-stable.timer")
    rmSync(timer)
    const check = spawnSync("bash", [h.guardian, "check", "stable"], {
      cwd: root,
      encoding: "utf8",
      env: { ...h.env, LUNA_TEST_RUNTIME_MATCHES_CHECKOUT: "true" },
    })
    expect(check.status, check.stdout + check.stderr).toBe(0)
    // Proves the tick actually reached render_control_plane (not merely that
    // it exited 0) - without this, a future change that returned early would
    // pass vacuously and the completeness-gate coverage above it would
    // silently stop meaning anything.
    expect(existsSync(timer), "the deleted timer must have been re-rendered - this tick must have reached render_control_plane").toBe(true)
    expect(existsSync(join(current, "deploy-cli")), "render_control_plane's completeness gate must not resurrect the missing binary either").toBe(false)
  })

  it("install defers (rc 10) rather than dying when bun is unavailable on the publishing host", () => {
    // The hermetic-PATH canaries below (phase 5) only ever reach an ALREADY-
    // .complete pin, where publish_engine's early return means bun is never
    // invoked - they prove nothing about the NEW host-bun coupling S21
    // added. This drives a FRESH, never-published pin instead, so install_
    // guardian's bun preflight (scripts/luna-guardian) is the one actually
    // under test, not publish_engine's early-return skip.
    const h = makeConvergedHarnessFixture("luna-guardian-bun-missing-")
    const restricted = makeRestrictedBin(h.temp, [
      "bash", "env", "git", "sed", "awk", "grep", "date", "mkdir", "chmod",
      "cat", "rm", "ln", "ls", "cut", "head", "sleep", "cp", "touch", "tr",
      "dirname", "basename", "mktemp", "stat", "id", "mv", "perl", "ps",
    ])
    const install = spawnSync("bash", [h.guardian, "install", "stable"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...h.env,
        LUNA_TEST_RUNTIME_MATCHES_CHECKOUT: "true",
        // HOME must ALSO have no ~/.bun/bin/bun - luna_find_bun's own
        // fallback - or this dev machine's real bun would leak through
        // beneath the restricted PATH and the preflight would never fire.
        HOME: join(h.temp, "empty-home"),
        PATH: `${join(h.temp, "bin")}:${restricted}`,
      },
    })
    expect(install.status, install.stdout + install.stderr).toBe(10)
    expect(install.stderr).toContain("DEFERRED: bun not found")
    // "DEFERRED: bun not found" is a prefix shared by BOTH preflight
    // branches (scripts/luna-guardian): the incus-container form appends
    // "inside container '<profile>'", the bare-host form does not. Ruling
    // that phrase out is what proves this run took the host branch, not
    // just that it deferred.
    expect(install.stderr).not.toContain("inside container")
    // The bun preflight (install_guardian, scripts/luna-guardian) defers
    // BEFORE `mkdir -p "$PIN_BASE"`, so PIN_BASE itself must never come into
    // existence - not merely be empty, which a ternary against a directory
    // that was never created would vacuously satisfy regardless of what the
    // script actually did.
    const pins = h.env.LUNA_GUARDIAN_PIN_BASE as string
    expect(existsSync(pins), "no half-published pin, tmp, or lock").toBe(false)
  })

  it("replaces the pin symlink on re-install instead of nesting it in the old engine", () => {
    const temp = mkdtempSync(join(tmpdir(), "luna-guardian-reinstall-"))
    trackDir(temp)
    const bin = join(temp, "bin")
    const units = join(temp, "systemd")
    const pins = join(temp, "pins")
    mkdirSync(bin, { recursive: true })
    mkdirSync(units, { recursive: true })
    writeSystemctlStub(bin)
    writeIncusPassthroughStub(bin)
    stubBun(bin)

    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      LUNA_SERVERS_CONFIG: fixture,
      LUNA_TEST_STAT_MODE: "600",
      LUNA_HOME: join(temp, "luna-home"),
      LUNA_GUARDIAN_PIN_BASE: pins,
      LUNA_GUARDIAN_STATE_DIR: join(temp, "state"),
      LUNA_UPDATE_STATE_DIR: join(temp, "update"),
      LUNA_TEST_SYSTEMD_DIR: units,
      LUNA_TEST_SYSTEMCTL_STATE: join(temp, "systemctl-state"),
      LUNA_TEST_RUNTIME_MATCHES_CHECKOUT: "true",
      LUNA_TEST_BUN_PATH: join(bin, "bun"),
    }

    for (const attempt of ["first", "second"]) {
      const run = spawnSync("bash", [guardian, "install", "stable"], { cwd: root, encoding: "utf8", env })
      expect(run.status, `${attempt}: ${run.stdout}${run.stderr}`).toBe(0)
    }

    // The pin must still be a symlink resolving to an engine@ directory —
    // installed_engine_sha() reads it to decide whether the release is healthy.
    const engines = readdirSync(pins).filter((name) => name.startsWith("engine@"))
    expect(engines).toHaveLength(1)
    // `pins` can sit under a symlink (macOS mktemp lands in /var/folders ->
    // /private/var), so both sides of this comparison must be physically resolved.
    expect(realpathSync(join(pins, "current-stable"))).toBe(realpathSync(join(pins, engines[0])))

    // A dereferenced `mv` would have dropped the temp link inside the engine.
    const leaked = readdirSync(join(pins, engines[0])).filter((name) => name.startsWith("current-"))
    expect(leaked).toEqual([])
  })

  it("refuses installation when the registry disables the timer", () => {
    const temp = mkdtempSync(join(tmpdir(), "luna-guardian-disabled-"))
    trackDir(temp)
    const registry = join(temp, "servers.toml")
    writeFileSync(
      registry,
      readFileSync(fixture, "utf8").replace(
        "deploy.timer         = true",
        "deploy.timer         = false",
      ),
    )

    const result = spawnSync("bash", [guardian, "install", "stable"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        LUNA_SERVERS_CONFIG: registry,
        LUNA_TEST_STAT_MODE: "600",
        LUNA_GUARDIAN_PIN_BASE: join(temp, "pins"),
        LUNA_GUARDIAN_STATE_DIR: join(temp, "state"),
        LUNA_TEST_SYSTEMD_DIR: join(temp, "systemd"),
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("deploy.timer=false")
    expect(existsSync(join(temp, "pins"))).toBe(false)
  })

  it("self-removes its units when deploy.timer is later switched off", () => {
    const temp = mkdtempSync(join(tmpdir(), "luna-guardian-hard-rail-"))
    trackDir(temp)
    const bin = join(temp, "bin")
    const units = join(temp, "systemd")
    const registry = join(temp, "servers.toml")
    const state = join(temp, "state")
    mkdirSync(bin, { recursive: true })
    mkdirSync(units, { recursive: true })
    writeSystemctlStub(bin)
    writeIncusPassthroughStub(bin)
    stubBun(bin)
    writeGuardianRegistry(registry)
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      LUNA_SERVERS_CONFIG: registry,
      LUNA_TEST_STAT_MODE: "600",
      LUNA_GUARDIAN_PIN_BASE: join(temp, "pins"),
      LUNA_GUARDIAN_STATE_DIR: state,
      LUNA_UPDATE_STATE_DIR: join(temp, "update"),
      LUNA_TEST_SYSTEMD_DIR: units,
      LUNA_TEST_SYSTEMCTL_STATE: join(temp, "systemctl-state"),
      LUNA_TEST_RUNTIME_MATCHES_CHECKOUT: "true",
      LUNA_TEST_BUN_PATH: join(bin, "bun"),
    }
    const install = spawnSync("bash", [guardian, "install", "stable"], {
      cwd: root, encoding: "utf8", env,
    })
    expect(install.status, install.stdout + install.stderr).toBe(0)

    writeFileSync(registry, readFileSync(registry, "utf8").replace("deploy.timer = true", "deploy.timer = false"))
    const check = spawnSync("bash", [guardian, "check", "stable"], {
      cwd: root, encoding: "utf8", env,
    })
    expect(check.status, check.stdout + check.stderr).toBe(0)
    expect(check.stderr).toContain("deploy.timer=false")
    expect(existsSync(join(units, "luna-guardian-stable.timer"))).toBe(false)
    expect(readFileSync(join(state, "status-stable"), "utf8")).toContain("outcome=disabled")
  })

  // The three adopt-defer tests below run against a stubbed systemd (empty
  // unit dir + empty stub state), so guardian_control_plane_adopted answers
  // NO on every host — on jax-box the REAL systemctl answers "adopted" for
  // stable and adopt short-circuited before ever reaching the check under
  // test. The stub state is identical on a host with stable adopted and on a
  // bare CI runner: that is the hermeticity contract.
  const adoptEnv = (temp: string) => {
    const bin = join(temp, "bin")
    const units = join(temp, "systemd")
    mkdirSync(bin, { recursive: true })
    mkdirSync(units, { recursive: true })
    writeSystemctlStub(bin)
    // fixture declares stable as incus-backed; harmless for the two defer-
    // before-install_guardian tests above (they never reach the bun
    // preflight), load-bearing for "defers pin publication..." below, which
    // proceeds into install_guardian and must clear that preflight first to
    // reach the update-lock contention it actually exercises.
    writeIncusPassthroughStub(bin)
    stubBun(bin)
    return {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      LUNA_SERVERS_CONFIG: fixture,
      LUNA_TEST_STAT_MODE: "600",
      LUNA_TEST_SYSTEMD_DIR: units,
      LUNA_TEST_SYSTEMCTL_STATE: join(temp, "systemctl-state"),
      LUNA_HOME: join(temp, "luna-home"),
      LUNA_GUARDIAN_STATE_DIR: join(temp, "state"),
      LUNA_UPDATE_STATE_DIR: join(temp, "update"),
      LUNA_GUARDIAN_PIN_BASE: join(temp, "pins"),
      LUNA_TEST_BUN_PATH: join(bin, "bun"),
    }
  }

  it("defers adoption while an update transaction is pending", () => {
    const temp = mkdtempSync(join(tmpdir(), "luna-guardian-pending-"))
    trackDir(temp)
    const update = join(temp, "update")
    mkdirSync(update)
    writeFileSync(join(update, "transaction-stable"), "phase=checkout\n")

    const result = spawnSync("bash", [guardian, "adopt", "stable"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...adoptEnv(temp),
        // Reorder defense: the fixture registry names the live luna-stable
        // container. Should a future refactor move the pending check behind
        // the runtime probe, the seam keeps the probe off the real container;
        // the pending branch must still defer (mutation: with the branch
        // deleted, seam=true lets adoption PROCEED and the pins-absent
        // assertion below fails the mutant via STATE, not just a message).
        LUNA_TEST_RUNTIME_MATCHES_CHECKOUT: "true",
      },
    })

    expect(result.status, result.stdout + result.stderr).toBe(10)
    expect(result.stdout).toContain("update transaction pending")
    expect(existsSync(join(temp, "pins"))).toBe(false)
  })

  it("defers adoption when runtime does not prove checkout HEAD", () => {
    const temp = mkdtempSync(join(tmpdir(), "luna-guardian-mismatch-"))
    trackDir(temp)
    const result = spawnSync("bash", [guardian, "adopt", "stable"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...adoptEnv(temp),
        LUNA_TEST_RUNTIME_MATCHES_CHECKOUT: "false",
      },
    })
    expect(result.status, result.stdout + result.stderr).toBe(10)
    expect(result.stdout).toContain("runtime does not prove checkout HEAD")
    expect(existsSync(join(temp, "pins"))).toBe(false)
  })

  it("defers pin publication while the updater owns the shared profile lock", () => {
    const temp = mkdtempSync(join(tmpdir(), "luna-guardian-update-lock-"))
    trackDir(temp)
    const update = join(temp, "update")
    const lock = join(update, "lock-stable")
    mkdirSync(lock, { recursive: true })
    // The owner fingerprint must match what the guardian computes for a live
    // pid: /proc starttime FIRST on Linux. The old `ps -o lstart=` planting
    // read as a MISMATCHED fingerprint on Linux, so the lock was reaped as
    // stale and adoption proceeded — the test then failed on the live host's
    // real profile state, never on the code under test.
    writeFileSync(join(lock, "owner"), `pid=${process.pid}\nfingerprint=${processFingerprint(process.pid)}\n`)

    const result = spawnSync("bash", [guardian, "adopt", "stable"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...adoptEnv(temp),
        LUNA_TEST_RUNTIME_MATCHES_CHECKOUT: "true",
      },
    })

    expect(result.status, result.stdout + result.stderr).toBe(10)
    expect(result.stderr).toContain("update lock is held")
    expect(existsSync(join(temp, "pins"))).toBe(false)
  })

  it("cannot report success when legacy timer retirement fails", () => {
    const temp = mkdtempSync(join(tmpdir(), "luna-guardian-handoff-"))
    trackDir(temp)
    const bin = join(temp, "bin")
    const units = join(temp, "systemd")
    mkdirSync(bin, { recursive: true })
    mkdirSync(units, { recursive: true })
    writeFileSync(join(units, "luna-autodeploy-stable.timer"), "legacy\n")
    writeFileSync(join(units, "luna-autodeploy-stable.service"), "legacy\n")
    writeSystemctlStub(bin)
    writeIncusPassthroughStub(bin)
    stubBun(bin)

    const result = spawnSync("bash", [guardian, "install", "stable"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        LUNA_SERVERS_CONFIG: fixture,
        LUNA_TEST_STAT_MODE: "600",
        LUNA_GUARDIAN_PIN_BASE: join(temp, "pins"),
        LUNA_GUARDIAN_STATE_DIR: join(temp, "state"),
        LUNA_UPDATE_STATE_DIR: join(temp, "update"),
        LUNA_TEST_SYSTEMD_DIR: units,
        LUNA_TEST_SYSTEMCTL_STATE: join(temp, "systemctl-state"),
        LUNA_TEST_LEGACY_DISABLE_FAIL: "true",
        LUNA_TEST_RUNTIME_MATCHES_CHECKOUT: "true",
        LUNA_TEST_BUN_PATH: join(bin, "bun"),
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("failed to disable legacy timer")
    expect(existsSync(join(units, "luna-autodeploy-stable.timer"))).toBe(true)

    const retry = spawnSync("bash", [guardian, "install", "stable"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        LUNA_SERVERS_CONFIG: fixture,
        LUNA_TEST_STAT_MODE: "600",
        LUNA_GUARDIAN_PIN_BASE: join(temp, "pins"),
        LUNA_GUARDIAN_STATE_DIR: join(temp, "state"),
        LUNA_UPDATE_STATE_DIR: join(temp, "update"),
        LUNA_TEST_SYSTEMD_DIR: units,
        LUNA_TEST_SYSTEMCTL_STATE: join(temp, "systemctl-state"),
        LUNA_TEST_RUNTIME_MATCHES_CHECKOUT: "true",
        LUNA_TEST_BUN_PATH: join(bin, "bun"),
      },
    })
    expect(retry.status, retry.stdout + retry.stderr).toBe(0)
    expect(existsSync(join(units, "luna-autodeploy-stable.timer"))).toBe(false)
  })

  it("publishes one complete engine under simultaneous profile installs", () => {
    const temp = mkdtempSync(join(tmpdir(), "luna-guardian-concurrent-"))
    trackDir(temp)
    const bin = join(temp, "bin")
    const units = join(temp, "systemd")
    const pins = join(temp, "pins")
    mkdirSync(bin, { recursive: true })
    mkdirSync(units, { recursive: true })
    writeSystemctlStub(bin)
    writeIncusPassthroughStub(bin)
    stubBun(bin)
    const result = spawnSync(
      "bash",
      ["-c", `"${guardian}" install stable & a=$!; "${guardian}" install dev & b=$!; wait "$a"; ra=$?; wait "$b"; rb=$?; (( ra == 0 && rb == 0 ))`],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
          LUNA_SERVERS_CONFIG: fixture,
          LUNA_TEST_STAT_MODE: "600",
          LUNA_GUARDIAN_PIN_BASE: pins,
          LUNA_GUARDIAN_STATE_DIR: join(temp, "state"),
          LUNA_UPDATE_STATE_DIR: join(temp, "update"),
          LUNA_TEST_SYSTEMD_DIR: units,
          LUNA_TEST_SYSTEMCTL_STATE: join(temp, "systemctl-state"),
          LUNA_TEST_RUNTIME_MATCHES_CHECKOUT: "true",
          LUNA_TEST_BUN_PATH: join(bin, "bun"),
        },
      },
    )
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(readdirSync(pins).filter((name) => name.startsWith("engine@"))).toHaveLength(1)
    expect(existsSync(join(pins, "current-stable", ".complete"))).toBe(true)
    expect(existsSync(join(pins, "current-dev", ".complete"))).toBe(true)
  })

  it("accepts only after two healthy cycles attest the exact SHA", () => {
    const temp = mkdtempSync(join(tmpdir(), "luna-guardian-accept-"))
    trackDir(temp)
    const bin = join(temp, "bin")
    const units = join(temp, "systemd")
    const pins = join(temp, "pins")
    const state = join(temp, "state")
    const registry = join(temp, "servers.toml")
    const systemctlState = join(temp, "systemctl-state")
    const sha = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim()
    mkdirSync(bin, { recursive: true })
    mkdirSync(units, { recursive: true })
    writeSystemctlStub(bin)
    writeIncusPassthroughStub(bin)
    stubBun(bin)
    writeGuardianRegistry(registry)
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      LUNA_SERVERS_CONFIG: registry,
      LUNA_TEST_STAT_MODE: "600",
      LUNA_GUARDIAN_PIN_BASE: pins,
      LUNA_GUARDIAN_STATE_DIR: state,
      LUNA_UPDATE_STATE_DIR: join(temp, "update"),
      LUNA_TEST_SYSTEMD_DIR: units,
      LUNA_TEST_SYSTEMCTL_STATE: systemctlState,
      LUNA_TEST_RUNTIME_MATCHES_CHECKOUT: "true",
      LUNA_TEST_BUN_PATH: join(bin, "bun"),
      LUNA_TEST_GUARDIAN_UNIT_HARDENED: "true",
      LUNA_TEST_ACCEPT_SHA: sha,
      LUNA_TEST_DOCTOR_INCUS_ACTIVE: "true",
      LUNA_TEST_DOCTOR_HOST_ACTIVE: "false",
      LUNA_TEST_DOCTOR_TIMER_PRESENT: "true",
      LUNA_TEST_DOCTOR_GUARDIAN_TIMER_STATE: "active",
      LUNA_TEST_DOCTOR_LEGACY_TIMER_STATE: "missing",
      LUNA_TAILSCALE_IP: "",
    }
    const install = spawnSync("bash", [guardian, "install", "stable"], {
      cwd: root, encoding: "utf8", env,
    })
    expect(install.status, install.stdout + install.stderr).toBe(0)

    const wrongSha = spawnSync(
      "bash",
      [guardian, "accept", "stable", "--expected-sha", "0".repeat(40), "--min-cycles", "2"],
      { cwd: root, encoding: "utf8", env },
    )
    expect(wrongSha.status).not.toBe(0)
    expect(wrongSha.stderr).toContain("does not match expected")

    const result = spawnSync(
      "bash",
      [guardian, "accept", "stable", "--expected-sha", sha, "--min-cycles", "2"],
      { cwd: root, encoding: "utf8", env },
    )
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toContain("ACCEPTED stable")
    expect(result.stdout).toContain("2 consecutive healthy cycles")
  })

  it("keeps every deploy script syntactically valid", () => {
    const files = [
      join(root, "scripts/luna-guardian"),
      join(root, "scripts/luna-autodeploy"),
      join(root, "scripts/lib/luna-deploy.sh"),
      join(root, "scripts/lib/luna-registry.sh"),
    ]
    const result = spawnSync("bash", ["-n", ...files], { encoding: "utf8" })
    expect(result.status, result.stdout + result.stderr).toBe(0)
  })

  // ── phase 1: classify + debounce the deep-health probe ────────────────────

  it("classifies probe outcomes as healthy, negative, or inconclusive", () => {
    const f = makeProbeFixture()

    // INCONCLUSIVE — we never got a usable answer. None of these may repair.
    expect(classify(f, { repo: "/nonexistent-repo-path" })).toBe(3)
    expect(classify(f, { isActive: "", isActiveRc: "4" })).toBe(3)
    expect(classify(f, { healthzRc: "28" })).toBe(3)
    expect(classify(f, { readyzRc: "28" })).toBe(3)
    expect(classify(f, { ready: "" })).toBe(3)
    expect(classify(f, { ready: "<html>gateway timeout</html>" })).toBe(3)

    // NEGATIVE — the server answered and the answer was wrong.
    expect(classify(f, { isActive: "failed" })).toBe(1)
    expect(classify(f, { isActive: "inactive" })).toBe(1)
    expect(classify(f, { ready: `{"mode":"degraded","buildSha":"${f.head}"}` })).toBe(1)
    expect(classify(f, { ready: `{"mode":"normal","buildSha":"deadbeef"}` })).toBe(1)

    // A transitional unit state is a state that was READ, not a transport
    // failure. Type=notify + Restart=always spends almost the whole
    // wedged-at-start cycle in activating/auto-restart, so calling these
    // "unknown" would mean a crash loop is never counted as a strike; the
    // caller's K-of-N debounce is what tolerates a legitimate restart.
    expect(classify(f, { isActive: "activating" })).toBe(1)
    expect(classify(f, { isActive: "reloading" })).toBe(1)
    expect(classify(f, { isActive: "deactivating" })).toBe(1)

    // A server that cannot identify its own build answers with the documented
    // "unknown" fallback. That is a wrong answer a redeploy fixes, not an
    // absent one — classifying it INCONCLUSIVE paralyses the guardian forever.
    expect(classify(f, { ready: `{"status":"ok","mode":"normal","buildSha":"unknown"}` })).toBe(1)

    // HEALTHY.
    expect(classify(f, { ready: `{"mode":"normal","buildSha":"${f.head}"}` })).toBe(0)
  })

  it("classifies the incus arm, the one that runs in production", () => {
    const f = makeProbeFixture()
    const via = (probe: Probe) => classify(f, { incus: "luna-test", ...probe })

    // INCONCLUSIVE — no usable answer came back through `incus exec`.
    expect(via({ isolate: true })).toBe(3) // incus binary missing
    expect(via({ incusRc: "1" })).toBe(3) // container stopped / exec failed
    expect(via({ isActive: "", isActiveRc: "4" })).toBe(3)
    expect(via({ healthzRc: "28" })).toBe(3) // curl --max-time 4 timeout
    expect(via({ readyzRc: "28" })).toBe(3)
    expect(via({ ready: "" })).toBe(3)

    // NEGATIVE — the container answered and the answer was wrong.
    expect(via({ isActive: "failed" })).toBe(1)
    expect(via({ isActive: "activating" })).toBe(1)
    expect(via({ ready: `{"mode":"normal","buildSha":"unknown"}` })).toBe(1)
    expect(via({ ready: `{"mode":"normal","buildSha":"deadbeef"}` })).toBe(1)
    expect(via({ ready: `{"mode":"degraded","buildSha":"${f.head}"}` })).toBe(1)

    // HEALTHY.
    expect(via({ ready: `{"mode":"normal","buildSha":"${f.head}"}` })).toBe(0)
  })

  it("maps the test seam onto the same tri-state exit codes", () => {
    expect(seamCode("true")).toBe(0)
    expect(seamCode("false")).toBe(1)
    expect(seamCode("garbage")).toBe(1)
    expect(seamCode("inconclusive")).toBe(3)
    expect(seamCode("unknown")).toBe(3)
  })

  it("debounces negative readings across separate guardian processes before forcing a repair", () => {
    const h = makeHarnessWithDeployCli("luna-guardian-debounce-")
    installHarness(h)

    const first = runCheck(h, "false")
    expect(first.status, first.stdout + first.stderr).toBe(0)
    expect(first.stderr).toContain("NEGATIVE (1/3 consecutive)")
    expect(journalValue(h, "consecutive_negative")).toBe("1")
    expect(incidentCount(h)).toBe(0)
    expect(forceCalls(h)).toEqual([])

    // A second, separate oneshot process must see the first process's strike.
    const second = runCheck(h, "false")
    expect(second.status, second.stdout + second.stderr).toBe(0)
    expect(second.stderr).toContain("NEGATIVE (2/3 consecutive)")
    expect(journalValue(h, "consecutive_negative")).toBe("2")
    expect(incidentCount(h)).toBe(0)
    expect(forceCalls(h)).toEqual([])

    // Third strike escalates exactly once. wait_runtime_healthy is short-circuited
    // by the seam, so this must not hang — the elapsed assertion proves it.
    const started = Date.now()
    const third = runCheck(h, "false")
    expect(Date.now() - started).toBeLessThan(30_000)
    expect(third.status, third.stdout + third.stderr).toBe(2)
    expect(third.stderr).toContain("deep health failed 3 consecutive checks")
    expect(repairCalls(h)).toHaveLength(1)
    expect(forceCalls(h)).toEqual([])
    expect(incidentCount(h)).toBeGreaterThanOrEqual(1)

    // Armed before the destructive action: the streak is cleared and the
    // cooldown timestamp is recorded even though the repair did not succeed.
    expect(journalValue(h, "consecutive_negative")).toBe("0")
    expect(Number(journalValue(h, "last_repair_at"))).toBeGreaterThan(0)
  })

  it("suppresses a repeat forced repair inside the cooldown window", () => {
    const h = makeHarnessWithDeployCli("luna-guardian-cooldown-")
    installHarness(h)
    for (let i = 0; i < 3; i++) runCheck(h, "false")
    expect(repairCalls(h)).toHaveLength(1)
    expect(forceCalls(h)).toEqual([])

    // Re-accumulating three strikes must NOT restart production again: without
    // the cooldown this is a forced rebuild every tick, forever.
    let last = runCheck(h, "false")
    expect(last.status, last.stdout + last.stderr).toBe(0)
    last = runCheck(h, "false")
    expect(last.status, last.stdout + last.stderr).toBe(0)
    last = runCheck(h, "false")
    expect(last.status, last.stdout + last.stderr).toBe(0)
    expect(last.stderr).toContain("suppressed for")
    expect(repairCalls(h)).toHaveLength(1)

    // With the cooldown disabled the same state escalates again.
    const again = runCheck(h, "false", { LUNA_GUARDIAN_REPAIR_COOLDOWN_SEC: "0" })
    expect(again.status, again.stdout + again.stderr).toBe(2)
    expect(repairCalls(h)).toHaveLength(2)
    expect(forceCalls(h)).toEqual([])
  })

  it("never repairs on inconclusive readings", () => {
    const h = makeHarnessWithDeployCli("luna-guardian-unknown-")
    installHarness(h)
    for (let i = 1; i <= 5; i++) {
      const run = runCheck(h, "inconclusive")
      expect(run.status, run.stdout + run.stderr).toBe(0)
      expect(run.stderr).toContain(`INCONCLUSIVE (${i} consecutive)`)
      expect(run.stderr).toContain("no repair")
    }
    expect(forceCalls(h)).toEqual([])
    expect(incidentCount(h)).toBe(0)
    expect(journalValue(h, "consecutive_unknown")).toBe("5")
    expect(journalValue(h, "consecutive_negative")).toBe("0")
  })

  it("pages once per window when the runtime state stays unknown", () => {
    const h = makeHarnessWithDeployCli("luna-guardian-unknown-page-")
    installHarness(h)
    const env = { LUNA_GUARDIAN_HEALTH_UNKNOWN_LIMIT: "2" }

    expect(runCheck(h, "inconclusive", env).status).toBe(0)
    expect(incidentCount(h)).toBe(0)

    const paged = runCheck(h, "inconclusive", env)
    expect(paged.status, paged.stdout + paged.stderr).toBe(2)
    expect(paged.stderr).toContain("runtime state unknown for 2 consecutive checks")
    expect(incidentCount(h)).toBe(1)

    // Modulo, not >=: a wedged probe must not page on every subsequent tick.
    const quiet = runCheck(h, "inconclusive", env)
    expect(quiet.status, quiet.stdout + quiet.stderr).toBe(0)
    expect(incidentCount(h)).toBe(1)
    expect(forceCalls(h)).toEqual([])
  })

  it("treats the health journal as evidence, not authority", () => {
    // (a) a healthy tick clears both counters.
    const healthy = makeHarnessWithDeployCli("luna-guardian-journal-healthy-")
    installHarness(healthy)
    runCheck(healthy, "false")
    runCheck(healthy, "false")
    expect(journalValue(healthy, "consecutive_negative")).toBe("2")
    const ok = runCheck(healthy, "true")
    expect(ok.status, ok.stdout + ok.stderr).toBe(0)
    expect(journalValue(healthy, "consecutive_negative")).toBe("0")
    expect(journalValue(healthy, "consecutive_unknown")).toBe("0")

    // (b) a record older than the freshness window is not evidence.
    const stale = makeHarnessWithDeployCli("luna-guardian-journal-stale-")
    installHarness(stale)
    mkdirSync(stale.state, { recursive: true })
    writeFileSync(journalPath(stale), [
      `profile=stable`,
      `updated_at=${Math.floor(Date.now() / 1000) - 100_000}`,
      `repo_sha=${headSha()}`,
      `consecutive_negative=2`,
      `consecutive_unknown=0`,
      `last_repair_at=0`,
    ].join("\n") + "\n")
    const aged = runCheck(stale, "false")
    expect(aged.status, aged.stdout + aged.stderr).toBe(0)
    expect(aged.stderr).toContain("NEGATIVE (1/3 consecutive)")
    expect(forceCalls(stale)).toEqual([])

    // (c) a different HEAD invalidates the strikes but NOT the repair cooldown.
    const rebuilt = makeHarnessWithDeployCli("luna-guardian-journal-sha-")
    installHarness(rebuilt)
    mkdirSync(rebuilt.state, { recursive: true })
    const repairedAt = Math.floor(Date.now() / 1000) - 10
    writeFileSync(journalPath(rebuilt), [
      `profile=stable`,
      `updated_at=${Math.floor(Date.now() / 1000)}`,
      `repo_sha=${"a".repeat(40)}`,
      `consecutive_negative=2`,
      `consecutive_unknown=0`,
      `last_repair_at=${repairedAt}`,
    ].join("\n") + "\n")
    const moved = runCheck(rebuilt, "false")
    expect(moved.status, moved.stdout + moved.stderr).toBe(0)
    expect(moved.stderr).toContain("NEGATIVE (1/3 consecutive)")
    expect(journalValue(rebuilt, "last_repair_at")).toBe(String(repairedAt))
    expect(forceCalls(rebuilt)).toEqual([])

    // (d) a missing journal reads as all-zero and cannot repair.
    const gone = makeHarnessWithDeployCli("luna-guardian-journal-missing-")
    installHarness(gone)
    runCheck(gone, "false")
    rmSync(journalPath(gone), { force: true })
    const fresh = runCheck(gone, "false")
    expect(fresh.status, fresh.stdout + fresh.stderr).toBe(0)
    expect(fresh.stderr).toContain("NEGATIVE (1/3 consecutive)")
    expect(forceCalls(gone)).toEqual([])
  })

  it("ages the negative streak out even while inconclusive ticks keep writing", async () => {
    // Every tick rewrites updated_at and an inconclusive tick carries the
    // negative streak forward, so freshness measured from the last write would
    // never expire on a 1min timer: "K consecutive" would silently mean
    // "K ever", and two old blips plus one new one would restart production.
    const h = makeHarnessWithDeployCli("luna-guardian-aging-")
    installHarness(h)
    const env = { LUNA_GUARDIAN_HEALTH_WINDOW_SEC: "4" }

    runCheck(h, "false", env)
    runCheck(h, "false", env)
    expect(journalValue(h, "consecutive_negative")).toBe("2")

    for (let i = 0; i < 4; i++) {
      await sleep(1200)
      const tick = runCheck(h, "inconclusive", env)
      expect(tick.status, tick.stdout + tick.stderr).toBe(0)
    }

    const late = runCheck(h, "false", env)
    expect(late.status, late.stdout + late.stderr).toBe(0)
    expect(late.stderr).toContain("NEGATIVE (1/3 consecutive)")
    expect(forceCalls(h)).toEqual([])
  }, 60_000)

  it("refuses a forced repair when the repair timestamp is in the future", () => {
    const h = makeHarnessWithDeployCli("luna-guardian-skew-")
    installHarness(h)
    const now = Math.floor(Date.now() / 1000)

    // Control: the same journal with the repair in the recent past suppresses
    // via the normal cooldown message.
    seedJournal(h, { consecutive_negative: 2, negative_at: now, last_repair_at: now - 60 })
    const past = runCheck(h, "false")
    expect(past.status, past.stdout + past.stderr).toBe(0)
    expect(past.stderr).toContain("suppressed for")
    expect(forceCalls(h)).toEqual([])

    // A backwards clock step (NTP correcting a bad RTC, restored snapshot) must
    // not be read as permission to restart production.
    seedJournal(h, { consecutive_negative: 2, negative_at: now, last_repair_at: now + 600 })
    const future = runCheck(h, "false")
    expect(future.status, future.stdout + future.stderr).toBe(0)
    expect(future.stderr).toContain("clock skew")
    expect(future.stderr).toContain("refusing forced repair")
    expect(forceCalls(h)).toEqual([])
  })

  it("refuses a forced repair when the cooldown cannot be armed", () => {
    // An unwritable $STATE_DIR must not degrade into "escalate every tick":
    // without a durable last_repair_at there is nothing bounding the restart
    // rate, which is the per-minute rebuild loop this change exists to prevent.
    const h = makeHarnessWithDeployCli("luna-guardian-unwritable-")
    installHarness(h)
    const env = { LUNA_TEST_MV_FAIL_GLOB: "*health-stable*" }
    seedJournal(h, {
      consecutive_negative: 2,
      negative_at: Math.floor(Date.now() / 1000),
      last_repair_at: 0,
    })

    for (let i = 0; i < 4; i++) {
      const tick = runCheck(h, "false", env)
      expect(tick.status, tick.stdout + tick.stderr).toBe(2)
      expect(tick.stderr).toContain("refusing forced repair")
      expect(forceCalls(h)).toEqual([])
    }
    // The stale seed is still there — proof the writes really did fail.
    expect(journalValue(h, "consecutive_negative")).toBe("2")
  })

  it("escalates a runtime that has been inconclusive for an unbroken run", () => {
    // One inconclusive reading is ignorance; hundreds in a row is evidence.
    // A wedged event loop keeps the unit active and every probe timing out, and
    // before this path existed nothing ever restarted it.
    const h = makeHarnessWithDeployCli("luna-guardian-unknown-escalate-")
    installHarness(h)
    const env = { LUNA_GUARDIAN_HEALTH_UNKNOWN_REPAIR_LIMIT: "3" }

    for (let i = 1; i <= 2; i++) {
      const tick = runCheck(h, "inconclusive", env)
      expect(tick.status, tick.stdout + tick.stderr).toBe(0)
      expect(tick.stderr).toContain("no repair")
      expect(forceCalls(h)).toEqual([])
    }

    const escalated = runCheck(h, "inconclusive", env)
    expect(escalated.status, escalated.stdout + escalated.stderr).toBe(2)
    expect(escalated.stderr).toContain("INCONCLUSIVE for 3 consecutive checks")
    expect(repairCalls(h)).toHaveLength(1)
    expect(forceCalls(h)).toEqual([])
    expect(incidentCount(h)).toBeGreaterThanOrEqual(1)

    // Armed before acting, so the cooldown bounds this to one restart.
    expect(journalValue(h, "consecutive_unknown")).toBe("0")
    const after = runCheck(h, "inconclusive", env)
    expect(after.status, after.stdout + after.stderr).toBe(0)
    expect(repairCalls(h)).toHaveLength(1)
  })

  it("keeps running the gentle updater on non-healthy ticks", () => {
    // --from-timer has its own fail-closed active-session guard and never drops
    // the operator. It is also the only path that pulls a fix commit and
    // advances the guardian engine pin, so a flaky probe must not suppress it.
    const h = makeHarnessWithDeployCli("luna-guardian-from-timer-")
    installHarness(h)

    expect(runCheck(h, "false").status).toBe(0)
    expect(allCalls(h)).toEqual(["stable --from-timer"])

    expect(runCheck(h, "inconclusive").status).toBe(0)
    expect(allCalls(h)).toEqual(["stable --from-timer", "stable --from-timer"])
    expect(forceCalls(h)).toEqual([])
  })

  // ── phase 2: escalation goes through the guarded --repair ladder ──────────

  it("escalation constructs --repair with exact argv", () => {
    const h = makeHarnessWithDeployCli("luna-guardian-repair-argv-")
    installHarness(h)
    runCheck(h, "false")
    runCheck(h, "false")
    // Isolate the escalation tick's calls: the K-th strike must record exactly
    // one autodeploy invocation, and it must be `stable --repair` — no --force.
    rmSync(h.calls, { force: true })
    const third = runCheck(h, "false")
    expect(third.status, third.stdout + third.stderr).toBe(2)
    expect(allCalls(h)).toEqual(["stable --repair"])
    expect(forceCalls(h)).toEqual([])
  })

  it("deferred repair pages once and keeps the cooldown armed", () => {
    const h = makeHarnessWithDeployCli("luna-guardian-repair-defer-")
    installHarness(h)
    // Autodeploy stub: --repair defers with rc=3 (engine session guard);
    // everything else (the gentle --from-timer tick) succeeds.
    writeStub(
      join(h.temp, "scripts", "luna-autodeploy"),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$LUNA_TEST_AUTODEPLOY_CALLS"
for a in "$@"; do [[ "$a" == "--repair" ]] && exit 3; done
exit 0
`,
    )
    runCheck(h, "false")
    runCheck(h, "false")
    expect(incidentCount(h)).toBe(0)

    const deferred = runCheck(h, "false")
    expect(deferred.status, deferred.stdout + deferred.stderr).toBe(2)
    expect(deferred.stderr).toMatch(/DEFERRED by session guard.*paging/)
    expect(repairCalls(h)).toHaveLength(1)
    expect(forceCalls(h)).toEqual([])
    expect(incidentCount(h)).toBeGreaterThanOrEqual(1)
    // The cooldown stays armed: a deferred repair pages at most once per window.
    expect(Number(journalValue(h, "last_repair_at"))).toBeGreaterThan(0)

    const withinCooldown = runCheck(h, "false")
    expect(withinCooldown.status, withinCooldown.stdout + withinCooldown.stderr).toBe(0)
    expect(repairCalls(h)).toHaveLength(1)
  })

  it("lock-contended repair (rc 4) pages with the contention reason, not a phantom session-guard defer", () => {
    // A repair rung colliding with a live manual deploy is update-lock
    // contention: the engine never evaluated sessions, so the incident trail
    // must not send the responder hunting for live sessions that never existed.
    const h = makeHarnessWithDeployCli("luna-guardian-repair-lock-")
    installHarness(h)
    writeStub(
      join(h.temp, "scripts", "luna-autodeploy"),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$LUNA_TEST_AUTODEPLOY_CALLS"
for a in "$@"; do [[ "$a" == "--repair" ]] && exit 4; done
exit 0
`,
    )
    runCheck(h, "false")
    runCheck(h, "false")

    const contended = runCheck(h, "false")
    expect(contended.status, contended.stdout + contended.stderr).toBe(2)
    expect(contended.stderr).toContain("concurrent update holds the profile lock")
    expect(contended.stderr).not.toMatch(/DEFERRED by session guard/)
    expect(repairCalls(h)).toHaveLength(1)
    expect(forceCalls(h)).toEqual([])
    expect(incidentCount(h)).toBeGreaterThanOrEqual(1)
    // Contention consumes the arming like any other ladder outcome; the
    // cooldown still bounds the ladder to one attempt per window.
    expect(Number(journalValue(h, "last_repair_at"))).toBeGreaterThan(0)
    const withinCooldown = runCheck(h, "false")
    expect(withinCooldown.status, withinCooldown.stdout + withinCooldown.stderr).toBe(0)
    expect(repairCalls(h)).toHaveLength(1)
  })

  it("failed repair pages", () => {
    const h = makeHarnessWithDeployCli("luna-guardian-repair-fail-")
    installHarness(h)
    writeStub(
      join(h.temp, "scripts", "luna-autodeploy"),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$LUNA_TEST_AUTODEPLOY_CALLS"
for a in "$@"; do [[ "$a" == "--repair" ]] && exit 1; done
exit 0
`,
    )
    runCheck(h, "false")
    runCheck(h, "false")
    const failed = runCheck(h, "false")
    expect(failed.status, failed.stdout + failed.stderr).toBe(2)
    expect(failed.stderr).toContain("repair failed")
    expect(repairCalls(h)).toHaveLength(1)
    expect(forceCalls(h)).toEqual([])
  })

  it("gentle tick unchanged", () => {
    const h = makeHarnessWithDeployCli("luna-guardian-gentle-")
    installHarness(h)
    const tick = runCheck(h, "false")
    expect(tick.status, tick.stdout + tick.stderr).toBe(0)
    expect(allCalls(h)).toEqual(["stable --from-timer"])
  })

  it("exit criterion: no automated path constructs --force / --allow-active / --operator-override", () => {
    // Static half: the guardian source must contain ZERO occurrences of the
    // three override tokens — automation must be structurally unable to
    // construct them.
    const source = readFileSync(guardian, "utf8")
    expect(source).not.toContain("--force")
    expect(source).not.toContain("--allow-active")
    expect(source).not.toContain("--operator-override")

    // Rendered half: the guardian units from a harness install, plus the
    // legacy luna-autodeploy timer service, must be equally clean.
    const h = makeHarnessWithDeployCli("luna-guardian-exit-criterion-")
    installHarness(h)
    const units = h.env.LUNA_TEST_SYSTEMD_DIR as string
    const rendered = ["luna-guardian-stable.service", "luna-guardian-stable.timer", "luna-guardian-alert-stable.service"]
      .filter((name) => existsSync(join(units, name)))
      .map((name) => readFileSync(join(units, name), "utf8"))
    expect(rendered.length).toBeGreaterThanOrEqual(2)

    // Render the legacy autodeploy timer service with the REAL script (the
    // harness scripts copy stubs luna-autodeploy) into the same unit dir.
    const timerInstall = spawnSync(
      "bash",
      [join(root, "scripts/luna-autodeploy"), "install-timer", "stable"],
      { cwd: root, encoding: "utf8", env: h.env },
    )
    expect(timerInstall.status, timerInstall.stdout + timerInstall.stderr).toBe(0)
    rendered.push(readFileSync(join(units, "luna-autodeploy-stable.service"), "utf8"))

    for (const unit of rendered) {
      expect(unit).not.toContain("--force")
      expect(unit).not.toContain("--allow-active")
      expect(unit).not.toContain("--operator-override")
    }
  })

  // ── phase 3: verify every mutation; converge, don't re-apply ──────────────

  it("SIGNATURE 1: a fully converged tick is silent and writes nothing", async () => {
    const h = makeConvergedHarnessWithDeployCli("luna-guardian-converged-")
    // This fixture's P_REPO is a filesystem COPY of this repo's scripts/
    // (makeHarness), not a rendered unit, so it always carries the launcher
    // ON DISK - bypass unit_paths_current (mirrors LUNA_TEST_GUARDIAN_UNIT_
    // HARDENED) so this test's silence assertion tests what it always tested.
    h.env.LUNA_TEST_GUARDIAN_UNIT_PATHS_CURRENT = "true"
    installHarness(h)

    // Tick A establishes convergence (it may log while getting there).
    const tickA = runPinnedCheck(h)
    expect(tickA.status, tickA.stdout + tickA.stderr).toBe(0)

    const before = snapshotUnits(h)
    const beforeInvocations = invocationLines(h).length
    const beforeEngines = readdirSync(h.env.LUNA_GUARDIAN_PIN_BASE as string).sort()
    const beforeCalls = allCalls(h).length
    const beforeCompleted = Number(statusValue(h, "completed_at"))
    expect(existsSync(journalPath(h))).toBe(false)
    await sleep(1100) // completed_at has 1s resolution; let it provably advance

    // Tick B, from the pin, on a fully converged system.
    const tickB = runPinnedCheck(h)
    expect(tickB.status, tickB.stdout + tickB.stderr).toBe(0)
    // (a) ZERO output — silence is the converged signal; any line means
    //     something changed or is wrong.
    expect(tickB.stdout).toBe("")
    expect(tickB.stderr).toBe("")
    // (b) zero unit-file writes: mtime AND inode unchanged on all three units.
    const after = snapshotUnits(h)
    for (let i = 0; i < before.length; i++) {
      expect(after[i].mtimeMs, after[i].path).toBe(before[i].mtimeMs)
      expect(after[i].ino, after[i].path).toBe(before[i].ino)
    }
    // (c) zero mutating systemctl invocations (show reads are allowed).
    const delta = invocationLines(h).slice(beforeInvocations)
    expect(delta.filter((line) => MUTATING_SYSTEMCTL.test(line))).toEqual([])
    // Health journal: never created by healthy ticks (zero-skip).
    expect(existsSync(journalPath(h))).toBe(false)
    // Engine pins untouched.
    expect(readdirSync(h.env.LUNA_GUARDIAN_PIN_BASE as string).sort()).toEqual(beforeEngines)
    // The ONE allowed write: the status heartbeat advanced — proof the tick ran.
    expect(Number(statusValue(h, "completed_at"))).toBeGreaterThan(beforeCompleted)
    expect(statusValue(h, "outcome")).toBe("healthy")
    // Exactly one gentle updater invocation.
    expect(allCalls(h).length).toBe(beforeCalls + 1)
    expect(allCalls(h)[allCalls(h).length - 1]).toBe("stable --from-timer")
  })

  it("SIGNATURE 2: one drifted aspect is repaired exactly, loudly, then silence returns", async () => {
    const h = makeConvergedHarnessWithDeployCli("luna-guardian-drift-")
    // See SIGNATURE 1's comment: this fixture's P_REPO always carries the
    // launcher on disk (an incidental artifact of the copied scripts/ dir),
    // unrelated to the control-plane drift this test exercises.
    h.env.LUNA_TEST_GUARDIAN_UNIT_PATHS_CURRENT = "true"
    installHarness(h)
    expect(runPinnedCheck(h).status).toBe(0)

    const [service, alert, timer] = snapshotUnits(h)

    // Drift ONE aspect: delete the timer unit.
    rmSync(timer.path)
    const beforeInvocations = invocationLines(h).length
    const repair = runPinnedCheck(h)
    expect(repair.status, repair.stdout + repair.stderr).toBe(0)
    // Loud about exactly what drifted...
    expect(repair.stderr).toContain("control-plane drift detected")
    expect(repair.stderr).toContain("control plane: updated luna-guardian-stable.timer")
    // ...and about nothing else.
    expect(repair.stderr).not.toContain("updated luna-guardian-stable.service")
    expect(repair.stderr).not.toContain("updated luna-guardian-alert-stable.service")
    // The timer is recreated byte-identical; the other two units untouched.
    expect(readFileSync(timer.path, "utf8")).toBe(timer.content)
    const [serviceAfter, alertAfter] = snapshotUnits(h)
    expect(serviceAfter.mtimeMs).toBe(service.mtimeMs)
    expect(serviceAfter.ino).toBe(service.ino)
    expect(alertAfter.mtimeMs).toBe(alert.mtimeMs)
    expect(alertAfter.ino).toBe(alert.ino)
    // Exactly ONE daemon-reload, zero enable/disable (stub state persists).
    const delta = invocationLines(h).slice(beforeInvocations)
    expect(delta.filter((line) => line.startsWith("daemon-reload"))).toHaveLength(1)
    expect(delta.filter((line) => /^(enable|disable)\b/.test(line))).toEqual([])

    // The tick after the repair satisfies SIGNATURE 1 again.
    await sleep(1100)
    const beforeInvocations2 = invocationLines(h).length
    const quiet = runPinnedCheck(h)
    expect(quiet.status, quiet.stdout + quiet.stderr).toBe(0)
    expect(quiet.stdout).toBe("")
    expect(quiet.stderr).toBe("")
    const delta2 = invocationLines(h).slice(beforeInvocations2)
    expect(delta2.filter((line) => MUTATING_SYSTEMCTL.test(line))).toEqual([])
  })

  it("SIGNATURE 2 variant: content drift in one unit rewrites only that unit", () => {
    // guardian_control_plane_adopted alone could never see this: the timer is
    // loaded/enabled/active and the legacy timer is gone — only the byte-level
    // desired-vs-actual compare notices an edited alert unit.
    const h = makeConvergedHarnessWithDeployCli("luna-guardian-content-drift-")
    installHarness(h)
    expect(runPinnedCheck(h).status).toBe(0)

    const [service, alert, timer] = snapshotUnits(h)
    appendFileSync(alert.path, "# hand-edited junk\n")

    const repair = runPinnedCheck(h)
    expect(repair.status, repair.stdout + repair.stderr).toBe(0)
    expect(repair.stderr).toContain("control-plane drift detected")
    expect(repair.stderr).toContain("control plane: updated luna-guardian-alert-stable.service")
    expect(repair.stderr).not.toContain("updated luna-guardian-stable.timer")
    expect(repair.stderr).not.toContain("updated luna-guardian-stable.service")
    expect(readFileSync(alert.path, "utf8")).toBe(alert.content)
    const [serviceAfter, , timerAfter] = snapshotUnits(h)
    expect(serviceAfter.mtimeMs).toBe(service.mtimeMs)
    expect(serviceAfter.ino).toBe(service.ino)
    expect(timerAfter.mtimeMs).toBe(timer.mtimeMs)
    expect(timerAfter.ino).toBe(timer.ino)
  })

  it("a converged re-install is a silent no-op", () => {
    const h = makeConvergedHarnessWithDeployCli("luna-guardian-reinstall-noop-")
    installHarness(h)

    const before = snapshotUnits(h)
    const beforeInvocations = invocationLines(h).length
    const enginesBefore = readdirSync(h.env.LUNA_GUARDIAN_PIN_BASE as string)
      .filter((name) => name.startsWith("engine@"))
    // The durable interval record converges too: record_guardian_interval's
    // equal-value early return must leave the file untouched (mtime AND inode).
    const intervalBefore = statSync(join(h.state, "interval-stable"))

    const again = spawnSync("bash", [h.guardian, "install", "stable"], {
      cwd: root,
      encoding: "utf8",
      env: { ...h.env, LUNA_TEST_RUNTIME_MATCHES_CHECKOUT: "true" },
    })
    expect(again.status, again.stdout + again.stderr).toBe(0)
    // The per-call "installed stable (engine ...)" line is gone: convergence.
    expect(again.stdout).toBe("")
    expect(again.stderr).toBe("")
    const delta = invocationLines(h).slice(beforeInvocations)
    expect(delta.filter((line) => line.startsWith("daemon-reload"))).toEqual([])
    expect(
      readdirSync(h.env.LUNA_GUARDIAN_PIN_BASE as string).filter((name) => name.startsWith("engine@")),
    ).toEqual(enginesBefore)
    const after = snapshotUnits(h)
    for (let i = 0; i < before.length; i++) {
      expect(after[i].mtimeMs, after[i].path).toBe(before[i].mtimeMs)
    }
    const intervalAfter = statSync(join(h.state, "interval-stable"))
    expect(intervalAfter.mtimeMs).toBe(intervalBefore.mtimeMs)
    expect(intervalAfter.ino).toBe(intervalBefore.ino)
  })

  it("the pin-flip postcondition fails loudly when the flip lies", () => {
    const h = makeConvergedHarnessWithDeployCli("luna-guardian-flip-lie-")
    installHarness(h)
    const pins = h.env.LUNA_GUARDIAN_PIN_BASE as string

    // Make the pin STALE: current-stable resolves to a different engine, so the
    // converged fast-path does not trigger and install must re-flip.
    const stale = join(pins, "engine@" + "d".repeat(40))
    mkdirSync(stale, { recursive: true })
    writeFileSync(join(stale, ".complete"), "")
    unlinkPin(pins, "current-stable")
    symlinkSync(stale, join(pins, "current-stable"))

    const result = spawnSync("bash", [h.guardian, "install", "stable"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...h.env,
        LUNA_TEST_RUNTIME_MATCHES_CHECKOUT: "true",
        LUNA_TEST_FLIP_LIE_GLOB: "*current-stable*",
      },
    })
    expect(result.status).not.toBe(0)
    // The POSTCONDITION message is distinguishable from the action errors
    // ("cannot stage engine link" / "cannot publish engine link") beside it.
    expect(result.stderr).toMatch(/POSTCONDITION.*current-stable.*resolves to/)
    expect(result.stderr).not.toContain("cannot publish engine link")
  })

  it("prune never removes a pinned engine and refuses on an unresolvable pin", () => {
    const h = makeConvergedHarnessWithDeployCli("luna-guardian-prune-")
    installHarness(h)
    const pins = h.env.LUNA_GUARDIAN_PIN_BASE as string

    // Seed 6 stale engines with staggered OLD mtimes; current-dev pins the oldest.
    const now = Date.now() / 1000
    const fakes: string[] = []
    for (let i = 1; i <= 6; i++) {
      const dir = join(pins, `engine@${String(i).repeat(40)}`)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, ".complete"), "")
      utimesSync(dir, now - 1000 * i, now - 1000 * i)
      fakes.push(dir)
    }
    const oldest = fakes[5]
    symlinkSync(oldest, join(pins, "current-dev"))

    // Trigger a full (non-fast-path) install by drifting one unit file.
    rmSync(join(h.env.LUNA_TEST_SYSTEMD_DIR as string, "luna-guardian-stable.timer"))
    const install = spawnSync("bash", [h.guardian, "install", "stable"], {
      cwd: root,
      encoding: "utf8",
      env: { ...h.env, LUNA_TEST_RUNTIME_MATCHES_CHECKOUT: "true" },
    })
    expect(install.status, install.stdout + install.stderr).toBe(0)
    // The OLDEST engine survives with .complete: it is pinned by current-dev.
    expect(existsSync(join(oldest, ".complete"))).toBe(true)
    // Prune actually pruned something (7 engines, keep 5 + 1 protected = 6).
    const kept = readdirSync(pins).filter((name) => name.startsWith("engine@"))
    expect(kept).toHaveLength(6)

    // Break current-dev (dangling) → prune must refuse to touch ANY engine.
    unlinkPin(pins, "current-dev")
    symlinkSync(join(pins, "engine@gone"), join(pins, "current-dev"))
    rmSync(join(h.env.LUNA_TEST_SYSTEMD_DIR as string, "luna-guardian-stable.timer"))
    const refused = spawnSync("bash", [h.guardian, "install", "stable"], {
      cwd: root,
      encoding: "utf8",
      env: { ...h.env, LUNA_TEST_RUNTIME_MATCHES_CHECKOUT: "true" },
    })
    expect(refused.status, refused.stdout + refused.stderr).toBe(0)
    expect(refused.stderr).toContain("prune refused")
    expect(
      readdirSync(pins).filter((name) => name.startsWith("engine@")).sort(),
    ).toEqual(kept.sort())
  })

  it("a failed status write warns distinctly and does not change the tick's exit code", () => {
    const h = makeConvergedHarnessWithDeployCli("luna-guardian-status-write-")
    installHarness(h)
    const tick = runPinnedCheck(h, { LUNA_TEST_MV_FAIL_GLOB: "*status-stable*" })
    expect(tick.status, tick.stdout + tick.stderr).toBe(0)
    expect(tick.stderr).toContain("guardian status write failed")
  })

  it("health-journal zero-skip: converged ticks never create the journal; a stored strike still gets its zero overwrite", () => {
    const h = makeConvergedHarnessWithDeployCli("luna-guardian-zero-skip-")
    installHarness(h)

    // (a) healthy ticks leave the journal ABSENT.
    expect(runPinnedCheck(h).status).toBe(0)
    expect(runPinnedCheck(h).status).toBe(0)
    expect(existsSync(journalPath(h))).toBe(false)

    // (b) a stored nonzero strike blocks the skip: one healthy tick writes zeros.
    mkdirSync(h.state, { recursive: true })
    const repoSha = spawnSync("git", ["-C", h.temp, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim()
    writeFileSync(journalPath(h), [
      `profile=stable`,
      `updated_at=${Math.floor(Date.now() / 1000)}`,
      `repo_sha=${repoSha}`,
      `consecutive_negative=2`,
      `negative_at=${Math.floor(Date.now() / 1000)}`,
      `consecutive_unknown=0`,
      `last_repair_at=0`,
    ].join("\n") + "\n")
    const heal = runPinnedCheck(h)
    expect(heal.status, heal.stdout + heal.stderr).toBe(0)
    expect(journalValue(h, "consecutive_negative")).toBe("0")
    expect(journalValue(h, "consecutive_unknown")).toBe("0")
  })

  it("an engine advance preserves a custom timer cadence instead of resetting it to 1min", () => {
    const h = makeConvergedHarnessWithDeployCli("luna-guardian-cadence-advance-")
    const install = spawnSync("bash", [h.guardian, "install", "stable", "--interval", "5min"], {
      cwd: root,
      encoding: "utf8",
      env: { ...h.env, LUNA_TEST_RUNTIME_MATCHES_CHECKOUT: "true" },
    })
    expect(install.status, install.stdout + install.stderr).toBe(0)
    const timerPath = join(h.env.LUNA_TEST_SYSTEMD_DIR as string, "luna-guardian-stable.timer")
    expect(readFileSync(timerPath, "utf8")).toContain("OnUnitInactiveSec=5min")

    // Advance HEAD: the healthy tick's refresh path must install the NEW engine
    // while passing the CURRENT cadence through (`install` defaults to 1min).
    spawnSync("git", ["-C", h.temp, "-c", "user.email=t@t", "-c", "user.name=t",
      "commit", "-q", "--allow-empty", "-m", "advance"], { encoding: "utf8" })
    const newSha = spawnSync("git", ["-C", h.temp, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim()

    // Promotion gate disabled: this test pins the CADENCE property of an
    // engine advance (and, since phase 5, the knob's 0-disables escape hatch);
    // gated-advance cadence preservation is pinned by the promotion suite.
    const tick = runPinnedCheck(h, { LUNA_GUARDIAN_PROMOTE_MIN_CYCLES: "0" })
    expect(tick.status, tick.stdout + tick.stderr).toBe(0)
    expect(tick.stderr).toContain("advancing guardian engine")
    // The pin advanced to the new sha...
    const resolved = spawnSync("bash", ["-c", `cd -P "${join(h.env.LUNA_GUARDIAN_PIN_BASE as string, "current-stable")}" && pwd`], { encoding: "utf8" }).stdout.trim()
    expect(resolved.endsWith(`engine@${newSha}`)).toBe(true)
    // ...and the 5min cadence SURVIVED the advance.
    expect(readFileSync(timerPath, "utf8")).toContain("OnUnitInactiveSec=5min")
    expect(readFileSync(timerPath, "utf8")).not.toContain("OnUnitInactiveSec=1min")
  })

  it("a hand-edited timer cadence is drift to repair, not desired state to self-bless", () => {
    const h = makeConvergedHarnessWithDeployCli("luna-guardian-cadence-edit-")
    installHarness(h)
    expect(runPinnedCheck(h).status).toBe(0)

    const timerPath = join(h.env.LUNA_TEST_SYSTEMD_DIR as string, "luna-guardian-stable.timer")
    const edited = readFileSync(timerPath, "utf8").replace("OnUnitInactiveSec=1min", "OnUnitInactiveSec=1w")
    writeFileSync(timerPath, edited)

    // The durable interval record (written at install) is desired state; the
    // edited timer is actual. Without the record the drift gate would render
    // desired content WITH the edited value, compare equal, and stay silent —
    // the guardian's own cadence permanently exempt from repair.
    const repair = runPinnedCheck(h)
    expect(repair.status, repair.stdout + repair.stderr).toBe(0)
    expect(repair.stderr).toContain("control-plane drift detected")
    expect(repair.stderr).toContain("control plane: updated luna-guardian-stable.timer")
    expect(readFileSync(timerPath, "utf8")).toContain("OnUnitInactiveSec=1min")
  })

  it("a manual check run under foreign env overrides refuses to rewrite the live control plane", () => {
    const h = makeConvergedHarnessWithDeployCli("luna-guardian-foreign-env-")
    installHarness(h)
    expect(runPinnedCheck(h).status).toBe(0)

    const before = snapshotUnits(h)
    // The debug-override scenario: LUNA_GUARDIAN_STATE_DIR points elsewhere, so
    // env-derived desired content mismatches the installed units. Pre-fix, the
    // drift gate "repaired" the live units to embed the debug state dir.
    const tick = runPinnedCheck(h, { LUNA_GUARDIAN_STATE_DIR: join(h.temp, "dbg-state") })
    expect(tick.status, tick.stdout + tick.stderr).toBe(0)
    expect(tick.stderr).toContain("different guardian environment")
    expect(tick.stderr).not.toContain("control plane: updated")
    const after = snapshotUnits(h)
    for (let i = 0; i < before.length; i++) {
      expect(after[i].content, after[i].path).toBe(before[i].content)
      expect(after[i].mtimeMs, after[i].path).toBe(before[i].mtimeMs)
    }
  })

  it("byte-current units with stale LOADED definitions (NeedDaemonReload) get exactly one retry reload", async () => {
    const h = makeConvergedHarnessWithDeployCli("luna-guardian-need-reload-")
    // See SIGNATURE 1's comment: unrelated to the NeedDaemonReload retry path.
    h.env.LUNA_TEST_GUARDIAN_UNIT_PATHS_CURRENT = "true"
    installHarness(h)
    expect(runPinnedCheck(h).status).toBe(0)

    // Model a daemon-reload that failed after a real unit write: bytes current,
    // systemd's in-memory definition stale. Disk-byte comparison alone can
    // never see this; only NeedDaemonReload can.
    writeFileSync(join(h.env.LUNA_TEST_SYSTEMCTL_STATE as string, "needs-reload"), "")
    const before = snapshotUnits(h)
    const beforeInvocations = invocationLines(h).length
    const tick = runPinnedCheck(h)
    expect(tick.status, tick.stdout + tick.stderr).toBe(0)
    expect(tick.stderr).toContain("stale loaded definitions")
    // Exactly one reload, zero unit-file writes.
    const delta = invocationLines(h).slice(beforeInvocations)
    expect(delta.filter((line) => line.startsWith("daemon-reload"))).toHaveLength(1)
    const after = snapshotUnits(h)
    for (let i = 0; i < before.length; i++) {
      expect(after[i].mtimeMs, after[i].path).toBe(before[i].mtimeMs)
    }
    // The reload cleared the flag: the next tick is converged-silent again.
    await sleep(1100)
    const quiet = runPinnedCheck(h)
    expect(quiet.status, quiet.stdout + quiet.stderr).toBe(0)
    expect(quiet.stderr).toBe("")
  })

  it("a corrupted pin (missing luna-pager) cannot read as converged install silence", () => {
    const h = makeConvergedHarnessWithDeployCli("luna-guardian-corrupt-pin-")
    installHarness(h)
    const pins = h.env.LUNA_GUARDIAN_PIN_BASE as string
    const target = spawnSync("bash", ["-c", `cd -P "${join(pins, "current-stable")}" && pwd`], { encoding: "utf8" }).stdout.trim()
    rmSync(join(target, "luna-pager"))

    // Pre-fix the fast-path checked only .complete and returned silent 0,
    // masking a broken alert pager until the first real page was needed.
    const repair = spawnSync("bash", [h.guardian, "install", "stable"], {
      cwd: root,
      encoding: "utf8",
      env: { ...h.env, LUNA_TEST_RUNTIME_MATCHES_CHECKOUT: "true" },
    })
    expect(repair.status).not.toBe(0)
    expect(repair.stderr).toContain("guardian engine is incomplete")
  })

  it("prune postcondition: pre-existing corruption of ANOTHER pin warns with attribution, never dies", () => {
    const h = makeConvergedHarnessWithDeployCli("luna-guardian-prune-preexisting-")
    installHarness(h)
    const pins = h.env.LUNA_GUARDIAN_PIN_BASE as string

    // current-dev resolves into an engine dir that is missing .complete —
    // corruption prune did not cause and cannot touch (protected set).
    const broken = join(pins, "engine@" + "e".repeat(40))
    mkdirSync(broken, { recursive: true })
    symlinkSync(broken, join(pins, "current-dev"))

    // Force the full (non-fast-path) install so prune runs.
    rmSync(join(h.env.LUNA_TEST_SYSTEMD_DIR as string, "luna-guardian-stable.timer"))
    const install = spawnSync("bash", [h.guardian, "install", "stable"], {
      cwd: root,
      encoding: "utf8",
      env: { ...h.env, LUNA_TEST_RUNTIME_MATCHES_CHECKOUT: "true" },
    })
    // The install SUCCEEDS: the defect is not prune's, and the message says so.
    expect(install.status, install.stdout + install.stderr).toBe(0)
    expect(install.stderr).toContain("pre-existing corruption")
    expect(install.stderr).not.toContain("POSTCONDITION: engine prune broke")
  })

  it("prune postcondition: a prune that breaks a protected pin dies with the prune attribution", () => {
    const h = makeConvergedHarnessWithDeployCli("luna-guardian-prune-broke-")
    installHarness(h)
    const pins = h.env.LUNA_GUARDIAN_PIN_BASE as string

    // Six extra complete engines so prune has something to delete; current-dev
    // protects the oldest.
    const now = Date.now() / 1000
    let oldest = ""
    for (let i = 1; i <= 6; i++) {
      const dir = join(pins, `engine@${String(i).repeat(40)}`)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, ".complete"), "")
      utimesSync(dir, now - 1000 * i, now - 1000 * i)
      oldest = dir
    }
    symlinkSync(oldest, join(pins, "current-dev"))

    // An `rm` that collaterally destroys the protected pin's .complete while
    // removing an unprotected engine — the exact failure the postcondition
    // exists to catch, distinguishable from the pre-existing-corruption warn.
    writeStub(join(h.temp, "bin", "rm"), `#!/usr/bin/env bash
if [[ -n "\${LUNA_TEST_RM_BREAK_FILE:-}" ]]; then
  for a in "$@"; do case "$a" in */engine@*) /bin/rm -f "\$LUNA_TEST_RM_BREAK_FILE" ;; esac; done
fi
exec /bin/rm "$@"
`)
    rmSync(join(h.env.LUNA_TEST_SYSTEMD_DIR as string, "luna-guardian-stable.timer"))
    const install = spawnSync("bash", [h.guardian, "install", "stable"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...h.env,
        LUNA_TEST_RUNTIME_MATCHES_CHECKOUT: "true",
        LUNA_TEST_RM_BREAK_FILE: join(oldest, ".complete"),
      },
    })
    expect(install.status).not.toBe(0)
    expect(install.stderr).toMatch(/POSTCONDITION: engine prune broke current-dev/)
  })

  it("guardian_unit_write failure arms: mv failure and a lying mv die with distinguishable messages", () => {
    // Arm 1: the write itself fails -> "cannot write".
    const h1 = makeConvergedHarnessWithDeployCli("luna-guardian-unit-mv-fail-")
    installHarness(h1)
    rmSync(join(h1.env.LUNA_TEST_SYSTEMD_DIR as string, "luna-guardian-stable.timer"))
    const failed = runPinnedCheck(h1, { LUNA_TEST_MV_FAIL_GLOB: "*luna-guardian-stable.timer*" })
    expect(failed.status).not.toBe(0)
    expect(failed.stderr).toContain("control plane: cannot write")
    expect(failed.stderr).not.toContain("does not match the rendered unit")

    // Arm 2: the write LIES (exit 0, no effect) -> the post-write re-read dies
    // with the POSTCONDITION message, not the action message.
    const h2 = makeConvergedHarnessWithDeployCli("luna-guardian-unit-mv-lie-")
    installHarness(h2)
    rmSync(join(h2.env.LUNA_TEST_SYSTEMD_DIR as string, "luna-guardian-stable.timer"))
    const lied = runPinnedCheck(h2, { LUNA_TEST_MV_LIE_GLOB: "*luna-guardian-stable.timer*" })
    expect(lied.status).not.toBe(0)
    expect(lied.stderr).toMatch(/POSTCONDITION: .*does not match the rendered unit after write/)
    expect(lied.stderr).not.toContain("cannot write")
  })

  it("publish postcondition: an engine publish whose mv lies dies on the missing .complete marker", () => {
    const h = makeConvergedHarnessWithDeployCli("luna-guardian-publish-lie-")
    installHarness(h)
    // New sha -> the full install path must PUBLISH a new engine dir.
    spawnSync("git", ["-C", h.temp, "-c", "user.email=t@t", "-c", "user.name=t",
      "commit", "-q", "--allow-empty", "-m", "advance"], { encoding: "utf8" })
    const install = spawnSync("bash", [h.guardian, "install", "stable"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...h.env,
        LUNA_TEST_RUNTIME_MATCHES_CHECKOUT: "true",
        LUNA_TEST_MV_LIE_GLOB: "*engine@*.tmp.*",
      },
    })
    expect(install.status).not.toBe(0)
    expect(install.stderr).toMatch(/POSTCONDITION: published engine .* is missing its \.complete marker/)
  })

  it("uninstall postcondition: a lying rm cannot report the units removed", () => {
    const h = makeConvergedHarnessWithDeployCli("luna-guardian-uninstall-lie-")
    installHarness(h)
    writeStub(join(h.temp, "bin", "rm"), `#!/usr/bin/env bash
if [[ -n "\${LUNA_TEST_RM_LIE_GLOB:-}" ]]; then
  keep=()
  for a in "$@"; do
    case "$a" in \${LUNA_TEST_RM_LIE_GLOB}) continue ;; esac
    keep+=("$a")
  done
  exec /bin/rm "\${keep[@]}"
fi
exec /bin/rm "$@"
`)
    const result = spawnSync("bash", [h.guardian, "uninstall", "stable"], {
      cwd: root,
      encoding: "utf8",
      env: { ...h.env, LUNA_TEST_RM_LIE_GLOB: "*luna-guardian-stable.timer*" },
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/POSTCONDITION: guardian unit removal left .*luna-guardian-stable\.timer/)
  })

  it("legacy retirement postcondition: a lying rm cannot report the legacy units retired", () => {
    const h = makeConvergedHarnessWithDeployCli("luna-guardian-legacy-lie-")
    installHarness(h)
    // Reintroduce legacy units -> adoption state drifts -> render must retire
    // them; the lying rm leaves them, and the postcondition dies.
    const units = h.env.LUNA_TEST_SYSTEMD_DIR as string
    writeFileSync(join(units, "luna-autodeploy-stable.timer"), "[Unit]\n")
    writeFileSync(join(units, "luna-autodeploy-stable.service"), "[Unit]\n")
    writeStub(join(h.temp, "bin", "rm"), `#!/usr/bin/env bash
if [[ -n "\${LUNA_TEST_RM_LIE_GLOB:-}" ]]; then
  keep=()
  for a in "$@"; do
    case "$a" in \${LUNA_TEST_RM_LIE_GLOB}) continue ;; esac
    keep+=("$a")
  done
  exec /bin/rm "\${keep[@]}"
fi
exec /bin/rm "$@"
`)
    const tick = runPinnedCheck(h, { LUNA_TEST_RM_LIE_GLOB: "*luna-autodeploy-stable*" })
    expect(tick.status).not.toBe(0)
    expect(tick.stderr).toContain("POSTCONDITION: legacy autodeploy units still present after removal")
  })

  it("update-lock acquisition treats an unwitnessable ownership record as contention (rc 10)", () => {
    // Unit-level: source the guardian (its own dispatch guard at the bottom
    // skips the CLI dispatch for us, no sed hack needed), then break the
    // ownership re-verify seam. If the re-verify block regresses away, acquire
    // returns 0 while holding a lock nobody can witness - the stale-classifier
    // would steal it mid-critical-section.
    const h = makeConvergedHarnessWithDeployCli("luna-guardian-lock-witness-")
    // $1 (not $0) carries the guardian path: `source "$1"` sets BASH_SOURCE[0]
    // to that path so the sourced prefix resolves SCRIPT_DIR (and its lib/
    // sourcing) against the harness scripts copy, while $0 stays the literal
    // below so BASH_SOURCE[0] != $0 and the dispatch guard skips the tail.
    const result = spawnSync("bash", ["-c", `
source "$1"
guardian_update_lock_owner_alive() { return 1; }
rc=0
acquire_guardian_update_lock stable || rc=$?
printf 'rc=%s\\n' "$rc"
`, "guardian-lock-witness-test", h.guardian], {
      cwd: root,
      encoding: "utf8",
      env: h.env,
    })
    expect(result.stdout).toContain("rc=10")
    expect(result.stderr).toContain("cannot record update-lock ownership")
    // And the unwitnessable lock was self-released, not left to block others.
    expect(existsSync(join(h.env.LUNA_UPDATE_STATE_DIR as string, "lock-stable"))).toBe(false)
  })

  it("diagnose prints the INCIDENT-CAPTURE-FAILED marker when the capture cannot land", () => {
    const h = makeConvergedHarnessWithDeployCli("luna-guardian-diagnose-fail-")
    installHarness(h)
    const result = spawnSync("bash", [h.guardian, "diagnose", "stable"], {
      cwd: root,
      encoding: "utf8",
      env: { ...h.env, LUNA_TEST_MV_FAIL_GLOB: "*incidents*" },
    })
    expect(result.status).not.toBe(0)
    // The marker is IN the page text — not a path to a file that does not exist.
    expect(result.stdout).toContain("INCIDENT-CAPTURE-FAILED")
  })

  it("a disallowed profile converges to a silent steady state", () => {
    const h = makeConvergedHarnessWithDeployCli("luna-guardian-disallowed-steady-")
    installHarness(h)
    writeFileSync(
      join(h.temp, "servers.toml"),
      [
        `kind = "registry"`,
        `[[server]]`,
        `name = "stable"`,
        `update.params.hostRepoDir = "${h.temp}"`,
        `update.params.ref = "origin/master"`,
        `ports.proxy = 4753`,
        `deploy.timer = false`,
      ].join("\n") + "\n",
    )

    // Tick 1: existing behaviour — warn, remove units, reload.
    const first = runPinnedCheck(h)
    expect(first.status, first.stdout + first.stderr).toBe(0)
    expect(first.stderr).toContain("deploy.timer=false")
    expect(existsSync(join(h.env.LUNA_TEST_SYSTEMD_DIR as string, "luna-guardian-stable.timer"))).toBe(false)

    // Tick 2: converged-absent — total silence, zero reloads, heartbeat still on.
    const beforeInvocations = invocationLines(h).length
    const second = runPinnedCheck(h)
    expect(second.status, second.stdout + second.stderr).toBe(0)
    expect(second.stdout).toBe("")
    expect(second.stderr).toBe("")
    const delta = invocationLines(h).slice(beforeInvocations)
    expect(delta.filter((line) => MUTATING_SYSTEMCTL.test(line))).toEqual([])
    expect(statusValue(h, "outcome")).toBe("disabled")
  })

  // ── phase 5: idempotency properties ────────────────────────────────────────

  it("SIGNATURE 1R: a fully converged tick under P_LAYOUT=releases is silent and writes nothing", async () => {
    const h = makeConvergedHarnessWithDeployCli("luna-guardian-converged-rel-", { layout: "releases" })
    installHarness(h)
    const deploy = join(h.temp, "deploy")
    const relSha = readlinkSync(join(deploy, "current")).replace("releases/", "")
    const releaseDir = join(deploy, "releases", relSha)

    // Tick A establishes convergence (it may log while getting there).
    const tickA = runPinnedCheck(h)
    expect(tickA.status, tickA.stdout + tickA.stderr).toBe(0)

    const before = snapshotUnits(h)
    const beforeInvocations = invocationLines(h).length
    const beforeEngines = readdirSync(h.env.LUNA_GUARDIAN_PIN_BASE as string).sort()
    const beforeCalls = allCalls(h).length
    const beforeCompleted = Number(statusValue(h, "completed_at"))
    const beforeCurrent = readlinkSync(join(deploy, "current"))
    const beforeManifest = releaseManifest(releaseDir)
    expect(existsSync(journalPath(h))).toBe(false)
    await sleep(1100)

    const tickB = runPinnedCheck(h)
    expect(tickB.status, tickB.stdout + tickB.stderr).toBe(0)
    expect(tickB.stdout).toBe("")
    expect(tickB.stderr).toBe("")
    const after = snapshotUnits(h)
    for (let i = 0; i < before.length; i++) {
      expect(after[i].mtimeMs, after[i].path).toBe(before[i].mtimeMs)
      expect(after[i].ino, after[i].path).toBe(before[i].ino)
    }
    const delta = invocationLines(h).slice(beforeInvocations)
    expect(delta.filter((line) => MUTATING_SYSTEMCTL.test(line))).toEqual([])
    expect(existsSync(journalPath(h))).toBe(false)
    expect(readdirSync(h.env.LUNA_GUARDIAN_PIN_BASE as string).sort()).toEqual(beforeEngines)
    // Releases-layout additions: the deploy topology is untouched by the tick.
    expect(readlinkSync(join(deploy, "current"))).toBe(beforeCurrent)
    expect(existsSync(join(deploy, "previous"))).toBe(false)
    expect(releaseManifest(releaseDir)).toBe(beforeManifest)
    // The ONE allowed write: the status heartbeat advanced.
    expect(Number(statusValue(h, "completed_at"))).toBeGreaterThan(beforeCompleted)
    expect(statusValue(h, "outcome")).toBe("healthy")
    expect(allCalls(h).length).toBe(beforeCalls + 1)
    expect(allCalls(h)[allCalls(h).length - 1]).toBe("stable --from-timer")
  })

  it("adopt on an adopted profile answers one line and mutates nothing", () => {
    // Deliberately NOT silent — adopt is a human/migration command and
    // maybe_migrate depends on rc 0; the property is no-mutation plus a
    // stable one-line answer.
    const h = makeConvergedHarnessWithDeployCli("luna-guardian-adopt-noop-")
    installHarness(h)
    const pins = h.env.LUNA_GUARDIAN_PIN_BASE as string
    const before = snapshotUnits(h)
    const beforeInvocations = invocationLines(h).length
    const enginesBefore = readdirSync(pins).filter((n) => n.startsWith("engine@")).sort()

    const result = spawnSync("bash", [pinnedGuardian(h), "adopt", "stable"], {
      cwd: root,
      encoding: "utf8",
      env: { ...h.env, LUNA_TEST_RUNTIME_MATCHES_CHECKOUT: "true" },
    })
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toBe("luna-guardian: already adopted stable\n")
    expect(result.stderr).toBe("")
    const delta = invocationLines(h).slice(beforeInvocations)
    expect(delta.filter((line) => MUTATING_SYSTEMCTL.test(line))).toEqual([])
    // The fast path never touches the update lock or re-installs.
    expect(existsSync(join(h.env.LUNA_UPDATE_STATE_DIR as string, "lock-stable"))).toBe(false)
    expect(readdirSync(pins).filter((n) => n.startsWith("engine@")).sort()).toEqual(enginesBefore)
    const after = snapshotUnits(h)
    for (let i = 0; i < before.length; i++) {
      expect(after[i].mtimeMs, after[i].path).toBe(before[i].mtimeMs)
      expect(after[i].ino, after[i].path).toBe(before[i].ino)
    }
  })

  it("a second accept with the same --expected-sha also passes and leaves evidence untouched", () => {
    const temp = mkdtempSync(join(tmpdir(), "luna-guardian-accept-twice-"))
    trackDir(temp)
    const bin = join(temp, "bin")
    const units = join(temp, "systemd")
    const pins = join(temp, "pins")
    const state = join(temp, "state")
    const registry = join(temp, "servers.toml")
    const sha = headSha()
    mkdirSync(bin, { recursive: true })
    mkdirSync(units, { recursive: true })
    writeSystemctlStub(bin)
    writeIncusPassthroughStub(bin)
    stubBun(bin)
    writeGuardianRegistry(registry)
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      LUNA_SERVERS_CONFIG: registry,
      LUNA_TEST_STAT_MODE: "600",
      LUNA_GUARDIAN_PIN_BASE: pins,
      LUNA_GUARDIAN_STATE_DIR: state,
      LUNA_UPDATE_STATE_DIR: join(temp, "update"),
      LUNA_TEST_SYSTEMD_DIR: units,
      LUNA_TEST_SYSTEMCTL_STATE: join(temp, "systemctl-state"),
      LUNA_TEST_RUNTIME_MATCHES_CHECKOUT: "true",
      LUNA_TEST_BUN_PATH: join(bin, "bun"),
      LUNA_TEST_GUARDIAN_UNIT_HARDENED: "true",
      LUNA_TEST_ACCEPT_SHA: sha,
      LUNA_TEST_DOCTOR_INCUS_ACTIVE: "true",
      LUNA_TEST_DOCTOR_HOST_ACTIVE: "false",
      LUNA_TEST_DOCTOR_TIMER_PRESENT: "true",
      LUNA_TEST_DOCTOR_GUARDIAN_TIMER_STATE: "active",
      LUNA_TEST_DOCTOR_LEGACY_TIMER_STATE: "missing",
      LUNA_TAILSCALE_IP: "",
    }
    const install = spawnSync("bash", [guardian, "install", "stable"], { cwd: root, encoding: "utf8", env })
    expect(install.status, install.stdout + install.stderr).toBe(0)
    const unitPaths = readdirSync(units).map((n) => join(units, n))
    const unitStats = unitPaths.map((p) => statSync(p).mtimeMs)
    const enginesBefore = readdirSync(pins).filter((n) => n.startsWith("engine@")).sort()

    const first = spawnSync("bash",
      [guardian, "accept", "stable", "--expected-sha", sha, "--min-cycles", "2"],
      { cwd: root, encoding: "utf8", env })
    expect(first.status, first.stdout + first.stderr).toBe(0)
    const countAfterFirst = Number(readFileSync(join(state, "status-stable"), "utf8")
      .match(/^consecutive_healthy=(.*)$/m)?.[1])

    const second = spawnSync("bash",
      [guardian, "accept", "stable", "--expected-sha", sha, "--min-cycles", "2"],
      { cwd: root, encoding: "utf8", env })
    expect(second.status, second.stdout + second.stderr).toBe(0)
    expect(second.stdout).toContain("ACCEPTED stable")
    // Evidence only GROWS: accept reads, never truncates or rewrites.
    const countAfterSecond = Number(readFileSync(join(state, "status-stable"), "utf8")
      .match(/^consecutive_healthy=(.*)$/m)?.[1])
    expect(countAfterSecond).toBeGreaterThan(countAfterFirst)
    // Pins and units untouched by either accept.
    expect(readdirSync(pins).filter((n) => n.startsWith("engine@")).sort()).toEqual(enginesBefore)
    expect(unitPaths.map((p) => statSync(p).mtimeMs)).toEqual(unitStats)
  })

  it("a second full install prunes nothing and warns nothing", () => {
    const h = makeConvergedHarnessWithDeployCli("luna-guardian-prune-idem-")
    installHarness(h)
    const pins = h.env.LUNA_GUARDIAN_PIN_BASE as string
    const units = h.env.LUNA_TEST_SYSTEMD_DIR as string

    // Seed 6 stale complete engines with staggered OLD mtimes; current-dev
    // pins the oldest (same shape as the prune-protection test).
    const now = Date.now() / 1000
    const fakes: string[] = []
    for (let i = 1; i <= 6; i++) {
      const dir = join(pins, `engine@${String(i).repeat(40)}`)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, ".complete"), "")
      utimesSync(dir, now - 1000 * i, now - 1000 * i)
      fakes.push(dir)
    }
    const oldest = fakes[5]
    symlinkSync(oldest, join(pins, "current-dev"))

    // Full install #1 (drift one unit): prunes down to keep+protected.
    rmSync(join(units, "luna-guardian-stable.timer"))
    const install1 = spawnSync("bash", [h.guardian, "install", "stable"], {
      cwd: root, encoding: "utf8",
      env: { ...h.env, LUNA_TEST_RUNTIME_MATCHES_CHECKOUT: "true" },
    })
    expect(install1.status, install1.stdout + install1.stderr).toBe(0)
    const after1 = readdirSync(pins).filter((n) => n.startsWith("engine@")).sort()

    // Full install #2 (drift again): prune has converged — deletes NOTHING.
    rmSync(join(units, "luna-guardian-stable.timer"))
    const install2 = spawnSync("bash", [h.guardian, "install", "stable"], {
      cwd: root, encoding: "utf8",
      env: { ...h.env, LUNA_TEST_RUNTIME_MATCHES_CHECKOUT: "true" },
    })
    expect(install2.status, install2.stdout + install2.stderr).toBe(0)
    expect(install2.stderr).not.toContain("prune")
    expect(install2.stderr).not.toContain("could not remove")
    expect(readdirSync(pins).filter((n) => n.startsWith("engine@")).sort()).toEqual(after1)
    expect(existsSync(join(oldest, ".complete"))).toBe(true)
  })

  // ── phase 5: wait_runtime_healthy — the REAL polling loop, executed ────────

  // Drive the real loop through the real CLI repair path: a NEGATIVE third
  // strike escalates, the repair stub flips a phase file, and the post-repair
  // verification must poll through boot-time INCONCLUSIVE probes to healthy.
  const waitHarness = (label: string, opts: { postHealthzFailures: number }) => {
    const h = makeHarnessWithDeployCli(label)
    installHarness(h)
    const repaired = join(h.temp, "repaired")
    const healthzCount = join(h.temp, "healthz-count")
    writeStub(join(h.temp, "scripts", "luna-autodeploy"), `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$LUNA_TEST_AUTODEPLOY_CALLS"
for a in "$@"; do [[ "$a" == "--repair" ]] && { touch "${repaired}"; exit 0; }; done
exit 0
`)
    // Pre-repair: server answers, WRONG buildSha (NEGATIVE — a real strike).
    // Post-repair: first N healthz probes fail transport (INCONCLUSIVE, the
    // boot window), then healthz+readyz prove the checkout HEAD.
    writeStub(join(h.temp, "bin", "curl"), `#!/usr/bin/env bash
for a in "$@"; do case "$a" in
  *healthz)
    if [[ ! -f "${repaired}" ]]; then exit 0; fi
    n="$(cat "${healthzCount}" 2>/dev/null || echo 0)"; n=$((n + 1)); echo "$n" > "${healthzCount}"
    if (( n <= ${String(opts.postHealthzFailures)} )); then exit 7; fi
    exit 0
    ;;
  *readyz)
    if [[ ! -f "${repaired}" ]]; then
      printf '{"status":"ok","mode":"normal","credentialOk":true,"buildSha":"aaaaaaaaaaaa"}'
      exit 0
    fi
    printf '{"status":"ok","mode":"normal","credentialOk":true,"buildSha":"${headSha()}"}'
    exit 0
    ;;
esac; done
exit 0
`)
    return { h, healthzCount }
  }

  // The tick env: seam UNSET (h.env has none) so runtime_health runs the real
  // classifier against the stub systemctl (is-active answers "active") + curl.
  const realProbeTick = (h: Harness, extra: Record<string, string> = {}) =>
    spawnSync("bash", [h.guardian, "check", "stable"], {
      cwd: root,
      encoding: "utf8",
      timeout: 60_000,
      env: { ...h.env, ...extra },
    })

  it("post-repair verification polls through boot-time INCONCLUSIVE to healthy", () => {
    const { h, healthzCount } = waitHarness("luna-guardian-wait-poll-", { postHealthzFailures: 2 })
    seedJournal(h, { consecutive_negative: 2, negative_at: Math.floor(Date.now() / 1000) })

    const tick = realProbeTick(h)
    expect(tick.status, tick.stdout + tick.stderr).toBe(0)
    expect(tick.stderr).toContain("deep health failed 3 consecutive checks")
    expect(tick.stderr).not.toContain("repair failed")
    expect(repairCalls(h)).toHaveLength(1)
    // Post-repair the journal is zeroed — the repair VERIFIED, not assumed.
    expect(journalValue(h, "consecutive_negative")).toBe("0")
    // The loop probed more than once after the repair (2 INCONCLUSIVE + the
    // healthy one at minimum; semantics, not exact counts — diagnose curls too).
    expect(Number(readFileSync(healthzCount, "utf8").trim())).toBeGreaterThanOrEqual(3)
  })

  it("the deadline bounds post-repair verification", { timeout: 30_000 }, () => {
    // Probes never succeed after the repair; a 1s deadline must terminate the
    // loop and classify the repair as failed (paging), not hang the tick.
    const { h } = waitHarness("luna-guardian-wait-deadline-", { postHealthzFailures: 1_000_000 })
    seedJournal(h, { consecutive_negative: 2, negative_at: Math.floor(Date.now() / 1000) })

    const tick = realProbeTick(h, { LUNA_GUARDIAN_REPAIR_VERIFY_SEC: "1" })
    expect(tick.status, tick.stdout + tick.stderr).toBe(2)
    expect(tick.stderr).toContain("repair failed")
    expect(repairCalls(h)).toHaveLength(1)
  })

  it("clock skew returns after exactly one probe", () => {
    // The `now < started` branch is unreachable hermetically through the CLI
    // (it needs the wall clock to move backwards mid-loop), so the loop body
    // is extracted by sed and driven with scripted date()/runtime_health()
    // shell functions. The extraction is asserted non-empty before eval.
    const temp = mkdtempSync(join(tmpdir(), "luna-guardian-wait-skew-"))
    trackDir(temp)
    const probeCount = join(temp, "probes")
    const dateCount = join(temp, "dates")
    const driver = `
body="$(sed -n '/^wait_runtime_healthy() {/,/^}/p' "$1")"
if [[ -z "$body" ]]; then echo "EXTRACTION-EMPTY" >&2; exit 9; fi
runtime_health() {
  n="$(cat "${probeCount}" 2>/dev/null || echo 0)"; n=$((n + 1)); echo "$n" > "${probeCount}"
  return 1
}
date() {
  n="$(cat "${dateCount}" 2>/dev/null || echo 0)"; n=$((n + 1)); echo "$n" > "${dateCount}"
  case "$n" in 1) echo 1000 ;; 2) echo 500 ;; *) echo 999999 ;; esac
}
eval "$body"
rc=0
wait_runtime_healthy || rc=$?
printf 'rc=%s probes=%s\\n' "$rc" "$(cat "${probeCount}")"
`
    const result = spawnSync("bash", ["-c", driver, "_", guardian], {
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, LUNA_GUARDIAN_HEALTH_RETRY_DELAY: "0" },
    })
    expect(result.stderr).not.toContain("EXTRACTION-EMPTY")
    // started=1000, first loop reads now=500: the clock moved BACKWARDS, so
    // the loop must return (non-zero) after exactly ONE probe — with the skew
    // clause deleted, the third scripted date (999999) terminates it via the
    // deadline on probe TWO, failing this assertion deterministically.
    expect(result.stdout).toContain("rc=1 probes=1")
  })

  // ── phase 5: accept-grade engine-pin promotion gate ────────────────────────

  it("T1: the engine pin advances only on accept-grade evidence (cadence preserved)", () => {
    const h = makeConvergedHarnessWithDeployCli("luna-guardian-gate-advance-")
    const install = spawnSync("bash", [h.guardian, "install", "stable", "--interval", "5min"], {
      cwd: root, encoding: "utf8",
      env: { ...h.env, LUNA_TEST_RUNTIME_MATCHES_CHECKOUT: "true" },
    })
    expect(install.status, install.stdout + install.stderr).toBe(0)
    const timerPath = join(h.env.LUNA_TEST_SYSTEMD_DIR as string, "luna-guardian-stable.timer")
    const pins = h.env.LUNA_GUARDIAN_PIN_BASE as string
    const gateEnv = { LUNA_GUARDIAN_PROMOTE_MIN_CYCLES: "2" }
    const pinTarget = () =>
      spawnSync("bash", ["-c", `cd -P "${join(pins, "current-stable")}" && pwd`], { encoding: "utf8" }).stdout.trim()
    const oldSha = spawnSync("git", ["-C", h.temp, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim()
    // A converged tick stores status at OLD, so the advance below is a real
    // state change for the log-once rule to notice.
    expect(runPinnedCheck(h, gateEnv).status).toBe(0)

    spawnSync("git", ["-C", h.temp, "-c", "user.email=t@t", "-c", "user.name=t",
      "commit", "-q", "--allow-empty", "-m", "advance"], { encoding: "utf8" })
    const newSha = spawnSync("git", ["-C", h.temp, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim()

    // Tick 1: candidate appears — exactly ONE pending line, no advance.
    const tick1 = runPinnedCheck(h, gateEnv)
    expect(tick1.status, tick1.stdout + tick1.stderr).toBe(0)
    const pending1 = tick1.stderr.split("\n").filter((l) => l.includes("promotion pending"))
    expect(pending1).toHaveLength(1)
    expect(pending1[0]).toContain(oldSha.slice(0, 12))
    expect(pending1[0]).toContain(newSha.slice(0, 12))
    // The pending line reports the CANDIDATE's proven count (structurally 0 on
    // its first tick), not the previous sha's stored counter — the stored
    // record here holds consecutive_runtime_healthy=1 at OLD, and leaking it
    // would tell the operator the evidence bar is already met while deferring.
    expect(pending1[0]).toContain("(0/2 proven cycles)")
    expect(pinTarget().endsWith(`engine@${oldSha}`)).toBe(true)
    expect(statusValue(h, "consecutive_runtime_healthy")).toBe("1")
    expect(statusValue(h, "outcome")).toBe("deferred")

    // Tick 2: still accumulating — SILENT defer (state-change logging).
    const tick2 = runPinnedCheck(h, gateEnv)
    expect(tick2.status, tick2.stdout + tick2.stderr).toBe(0)
    expect(tick2.stderr).not.toContain("promotion pending")
    expect(pinTarget().endsWith(`engine@${oldSha}`)).toBe(true)
    expect(statusValue(h, "consecutive_runtime_healthy")).toBe("2")

    // Tick 3: evidence sufficient — advance, cadence preserved.
    const tick3 = runPinnedCheck(h, gateEnv)
    expect(tick3.status, tick3.stdout + tick3.stderr).toBe(0)
    expect(tick3.stderr).toContain("advancing guardian engine")
    expect(pinTarget().endsWith(`engine@${newSha}`)).toBe(true)
    expect(readFileSync(timerPath, "utf8")).toContain("OnUnitInactiveSec=5min")
    expect(readFileSync(timerPath, "utf8")).not.toContain("OnUnitInactiveSec=1min")
  })

  it("T2: an unproven tick resets the promotion streak", () => {
    const h = makeConvergedHarnessWithDeployCli("luna-guardian-gate-reset-")
    installHarness(h)
    const pins = h.env.LUNA_GUARDIAN_PIN_BASE as string
    const gateEnv = { LUNA_GUARDIAN_PROMOTE_MIN_CYCLES: "2" }
    const pinTarget = () =>
      spawnSync("bash", ["-c", `cd -P "${join(pins, "current-stable")}" && pwd`], { encoding: "utf8" }).stdout.trim()
    const oldSha = spawnSync("git", ["-C", h.temp, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim()
    spawnSync("git", ["-C", h.temp, "-c", "user.email=t@t", "-c", "user.name=t",
      "commit", "-q", "--allow-empty", "-m", "advance"], { encoding: "utf8" })
    const newSha = spawnSync("git", ["-C", h.temp, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim()

    expect(runPinnedCheck(h, gateEnv).status).toBe(0) // defer, streak 1
    expect(statusValue(h, "consecutive_runtime_healthy")).toBe("1")

    // An INCONCLUSIVE tick is not evidence: streak resets, and no second
    // pending line appears (the candidate did not change).
    const blip = runPinnedCheck(h, { ...gateEnv, LUNA_TEST_RUNTIME_MATCHES_CHECKOUT: "inconclusive" })
    expect(blip.status, blip.stdout + blip.stderr).toBe(0)
    expect(blip.stderr).not.toContain("promotion pending")
    expect(statusValue(h, "consecutive_runtime_healthy")).toBe("0")
    expect(pinTarget().endsWith(`engine@${oldSha}`)).toBe(true)

    expect(runPinnedCheck(h, gateEnv).status).toBe(0) // streak 1
    expect(statusValue(h, "consecutive_runtime_healthy")).toBe("1")
    expect(pinTarget().endsWith(`engine@${oldSha}`)).toBe(true)
    expect(runPinnedCheck(h, gateEnv).status).toBe(0) // streak 2, still gated this tick
    expect(statusValue(h, "consecutive_runtime_healthy")).toBe("2")
    expect(pinTarget().endsWith(`engine@${oldSha}`)).toBe(true)
    const advance = runPinnedCheck(h, gateEnv)
    expect(advance.status, advance.stdout + advance.stderr).toBe(0)
    expect(advance.stderr).toContain("advancing guardian engine")
    expect(pinTarget().endsWith(`engine@${newSha}`)).toBe(true)
  })

  it("T3: stale evidence defers promotion", () => {
    const h = makeConvergedHarnessWithDeployCli("luna-guardian-gate-stale-")
    installHarness(h)
    const pins = h.env.LUNA_GUARDIAN_PIN_BASE as string
    const gateEnv = { LUNA_GUARDIAN_PROMOTE_MIN_CYCLES: "2" }
    const pinTarget = () =>
      spawnSync("bash", ["-c", `cd -P "${join(pins, "current-stable")}" && pwd`], { encoding: "utf8" }).stdout.trim()
    const oldSha = spawnSync("git", ["-C", h.temp, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim()
    spawnSync("git", ["-C", h.temp, "-c", "user.email=t@t", "-c", "user.name=t",
      "commit", "-q", "--allow-empty", "-m", "advance"], { encoding: "utf8" })
    const newSha = spawnSync("git", ["-C", h.temp, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim()

    // Hand-written evidence: plenty of cycles at NEW but a heartbeat OLDER
    // than LUNA_GUARDIAN_HEALTH_WINDOW_SEC — stale evidence is not evidence.
    mkdirSync(h.state, { recursive: true })
    writeFileSync(join(h.state, "status-stable"), [
      `profile=stable`,
      `completed_at=${Math.floor(Date.now() / 1000) - 2000}`,
      `repo_sha=${newSha}`,
      `engine_sha=${oldSha}`,
      `outcome=deferred`,
      `consecutive_healthy=0`,
      `consecutive_runtime_healthy=5`,
    ].join("\n") + "\n")

    const tick = runPinnedCheck(h, gateEnv)
    expect(tick.status, tick.stdout + tick.stderr).toBe(0)
    expect(tick.stderr).not.toContain("advancing guardian engine")
    expect(pinTarget().endsWith(`engine@${oldSha}`)).toBe(true)
  })

  it("T3b: a non-numeric or zero LUNA_GUARDIAN_HEALTH_WINDOW_SEC falls back to 900 instead of starving promotion", () => {
    // An unvalidated window ("15m", or 0 under which every ~cadence-old
    // heartbeat reads stale) would make the freshness test fail on every tick
    // — permanent silent starvation of auto-promotion, plus a bash arithmetic
    // error per gated tick. The gate must validate like health_journal_read.
    for (const badWindow of ["15m", "0"]) {
      const h = makeConvergedHarnessWithDeployCli(`luna-guardian-gate-window-${badWindow === "0" ? "zero" : "suffix"}-`)
      installHarness(h)
      const pins = h.env.LUNA_GUARDIAN_PIN_BASE as string
      const gateEnv = { LUNA_GUARDIAN_PROMOTE_MIN_CYCLES: "2", LUNA_GUARDIAN_HEALTH_WINDOW_SEC: badWindow }
      const pinTarget = () =>
        spawnSync("bash", ["-c", `cd -P "${join(pins, "current-stable")}" && pwd`], { encoding: "utf8" }).stdout.trim()
      spawnSync("git", ["-C", h.temp, "-c", "user.email=t@t", "-c", "user.name=t",
        "commit", "-q", "--allow-empty", "-m", "advance"], { encoding: "utf8" })
      const newSha = spawnSync("git", ["-C", h.temp, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim()

      const tick1 = runPinnedCheck(h, gateEnv)
      expect(tick1.status, tick1.stdout + tick1.stderr).toBe(0)
      expect(tick1.stderr).not.toContain("value too great") // no raw arithmetic on the bad value
      const tick2 = runPinnedCheck(h, gateEnv)
      expect(tick2.status, tick2.stdout + tick2.stderr).toBe(0)
      const tick3 = runPinnedCheck(h, gateEnv)
      expect(tick3.status, tick3.stdout + tick3.stderr).toBe(0)
      expect(tick3.stderr, `window=${badWindow} starved promotion`).toContain("advancing guardian engine")
      expect(pinTarget().endsWith(`engine@${newSha}`)).toBe(true)
    }
  })

  it("T4: LUNA_GUARDIAN_PROMOTE_MIN_CYCLES=0 disables the gate", () => {
    const h = makeConvergedHarnessWithDeployCli("luna-guardian-gate-disable-")
    installHarness(h)
    const pins = h.env.LUNA_GUARDIAN_PIN_BASE as string
    spawnSync("git", ["-C", h.temp, "-c", "user.email=t@t", "-c", "user.name=t",
      "commit", "-q", "--allow-empty", "-m", "advance"], { encoding: "utf8" })
    const newSha = spawnSync("git", ["-C", h.temp, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim()
    const tick = runPinnedCheck(h, { LUNA_GUARDIAN_PROMOTE_MIN_CYCLES: "0" })
    expect(tick.status, tick.stdout + tick.stderr).toBe(0)
    expect(tick.stderr).toContain("advancing guardian engine")
    const resolved = spawnSync("bash", ["-c", `cd -P "${join(pins, "current-stable")}" && pwd`], { encoding: "utf8" }).stdout.trim()
    expect(resolved.endsWith(`engine@${newSha}`)).toBe(true)
  })

  it("T5: manual install bypasses the gate with zero stored evidence", () => {
    const h = makeConvergedHarnessWithDeployCli("luna-guardian-gate-manual-")
    installHarness(h)
    const pins = h.env.LUNA_GUARDIAN_PIN_BASE as string
    spawnSync("git", ["-C", h.temp, "-c", "user.email=t@t", "-c", "user.name=t",
      "commit", "-q", "--allow-empty", "-m", "advance"], { encoding: "utf8" })
    const newSha = spawnSync("git", ["-C", h.temp, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim()
    // No ticks have run: the status file does not even exist.
    expect(existsSync(join(h.state, "status-stable"))).toBe(false)
    const install = spawnSync("bash", [h.guardian, "install", "stable"], {
      cwd: root, encoding: "utf8",
      env: { ...h.env, LUNA_TEST_RUNTIME_MATCHES_CHECKOUT: "true", LUNA_GUARDIAN_PROMOTE_MIN_CYCLES: "2" },
    })
    expect(install.status, install.stdout + install.stderr).toBe(0)
    const resolved = spawnSync("bash", ["-c", `cd -P "${join(pins, "current-stable")}" && pwd`], { encoding: "utf8" }).stdout.trim()
    expect(resolved.endsWith(`engine@${newSha}`)).toBe(true)
  })

  it("a repair is never blocked by missing promotion evidence", () => {
    // The repair ladder runs BEFORE the post-repair refresh — the gate can
    // only defer the pin advance that FOLLOWS a repair, never the repair.
    const h = makeConvergedHarnessWithDeployCli("luna-guardian-gate-repair-")
    installHarness(h)
    const pins = h.env.LUNA_GUARDIAN_PIN_BASE as string
    const oldSha = spawnSync("git", ["-C", h.temp, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim()
    spawnSync("git", ["-C", h.temp, "-c", "user.email=t@t", "-c", "user.name=t",
      "commit", "-q", "--allow-empty", "-m", "advance"], { encoding: "utf8" })
    // Third NEGATIVE strike with ZERO stored promotion evidence at the new sha.
    seedJournal(h, {
      repo_sha: spawnSync("git", ["-C", h.temp, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(),
      consecutive_negative: 2,
      negative_at: Math.floor(Date.now() / 1000),
    })
    const tick = runPinnedCheck(h, { LUNA_TEST_RUNTIME_MATCHES_CHECKOUT: "false", LUNA_GUARDIAN_PROMOTE_MIN_CYCLES: "2" })
    // The repair RAN (stub exit 0), its verification (seam=false) failed → page.
    expect(tick.status, tick.stdout + tick.stderr).toBe(2)
    expect(repairCalls(h)).toHaveLength(1)
    // And the pin did not advance without evidence.
    const resolved = spawnSync("bash", ["-c", `cd -P "${join(pins, "current-stable")}" && pwd`], { encoding: "utf8" }).stdout.trim()
    expect(resolved.endsWith(`engine@${oldSha}`)).toBe(true)
  })

  // ── phase 5: hermeticity canary ────────────────────────────────────────────

  it("a converged tick is hermetic under a minimal PATH", async () => {
    // The most-executed path in production, run with a PATH containing ONLY
    // the harness stubs plus an explicit allowlist of real tools. Any future
    // host-binary coupling on the converged tick fails this loudly — the
    // regression class the six formerly-failing tests embodied.
    const h = makeConvergedHarnessWithDeployCli("luna-guardian-canary-")
    // See SIGNATURE 1's comment: unrelated to this test's PATH-hermeticity
    // concern, and the restricted PATH below has no `test`/`systemctl` beyond
    // the harness stubs, which do not answer luna-chat-server.service queries.
    h.env.LUNA_TEST_GUARDIAN_UNIT_PATHS_CURRENT = "true"
    installHarness(h)
    expect(runPinnedCheck(h).status).toBe(0)
    await sleep(1100)
    const restricted = makeRestrictedBin(h.temp, [
      "bash", "env", "git", "sed", "awk", "grep", "date", "mkdir", "chmod",
      "cat", "rm", "ln", "ls", "cut", "head", "sleep", "cp", "touch", "tr",
      "dirname", "basename", "mktemp", "stat", "id", "mv",
    ])
    const tick = spawnSync("bash", [pinnedGuardian(h), "check", "stable"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...h.env,
        LUNA_TEST_RUNTIME_MATCHES_CHECKOUT: "true",
        PATH: `${join(h.temp, "bin")}:${restricted}`,
      },
    })
    expect(tick.status, tick.stdout + tick.stderr).toBe(0)
    expect(tick.stdout).toBe("")
    expect(tick.stderr).toBe("")
  })

  it("an install flip is hermetic under a minimal PATH allowing perl and ps", () => {
    // The converged tick above takes install_guardian's converged fast-path
    // and never calls luna_atomic_replace, so it proves nothing about the
    // perl coupling that helper adds. Stale the pin (as the flip-lie test
    // above does) so install must re-flip: this is the one path that
    // actually reaches luna_atomic_replace, so pulling "perl" off the
    // allowlist below must turn this test red. acquire_guardian_update_lock's
    // /proc-less fingerprint fallback (scripts/luna-guardian) shells out to
    // "ps", so it is allowlisted here too - deliberately kept OFF the tick
    // canary above, whose allowlist stays the pre-existing minimal set.
    const h = makeConvergedHarnessWithDeployCli("luna-guardian-install-flip-canary-")
    installHarness(h)
    const pins = h.env.LUNA_GUARDIAN_PIN_BASE as string
    const restricted = makeRestrictedBin(h.temp, [
      "bash", "env", "git", "sed", "awk", "grep", "date", "mkdir", "chmod",
      "cat", "rm", "ln", "ls", "cut", "head", "sleep", "cp", "touch", "tr",
      "dirname", "basename", "mktemp", "stat", "id", "mv", "perl", "ps",
    ])
    const restrictedEnv = {
      ...h.env,
      LUNA_TEST_RUNTIME_MATCHES_CHECKOUT: "true",
      PATH: `${join(h.temp, "bin")}:${restricted}`,
    }
    const realSha = spawnSync("git", ["-C", h.temp, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim()
    const stale = join(pins, "engine@" + "e".repeat(40))
    mkdirSync(stale, { recursive: true })
    writeFileSync(join(stale, ".complete"), "")
    unlinkPin(pins, "current-stable")
    symlinkSync(stale, join(pins, "current-stable"))
    const flip = spawnSync("bash", [h.guardian, "install", "stable"], {
      cwd: root,
      encoding: "utf8",
      env: restrictedEnv,
    })
    expect(flip.status, flip.stdout + flip.stderr).toBe(0)
    const resolved = spawnSync("bash", ["-c", `cd -P "${join(pins, "current-stable")}" && pwd`], { encoding: "utf8" }).stdout.trim()
    expect(resolved.endsWith(`engine@${realSha}`)).toBe(true)
  })

  // ── phase 6: unit-path drift (S07 - path-independent launcher) ────────────
  // unit_hardened() inspects ONLY Type/WatchdogUSec, so a unit rendered with
  // the OLD app-specific WorkingDirectory/ExecStart reads exactly as
  // "hardened" as one rendered by this slice. unit_paths_current is the other
  // half of the reconcile gate. These tests exercise it - and
  // reconcile_unit_if_idle's use of it - by SOURCING scripts/luna-guardian
  // (the dispatch guard at the bottom of that file skips the command
  // dispatch when BASH_SOURCE[0] != $0, i.e. when sourced) and calling the
  // functions directly against a hand-set profile environment: no registry,
  // no real systemctl, hermetic and fast.

  type ProfileGlobals = { repo: string; layout: "inplace" | "releases"; deployRoot?: string }

  const profileAssigns = (g: ProfileGlobals) =>
    `P_REPO=${JSON.stringify(g.repo)}; P_LAYOUT=${JSON.stringify(g.layout)}; P_INCUS=""; `
    + `P_SERVICE_NAME="luna-chat-server.service"; P_DEPLOY_ROOT=${JSON.stringify(g.deployRoot ?? "")}; P_PORT=4753`

  const writeLauncher = (dir: string) => {
    mkdirSync(join(dir, "scripts"), { recursive: true })
    writeFileSync(join(dir, "scripts", "luna-chat-server-entry.ts"), "")
  }

  const writeServerInstallStub = (dir: string, log: string) => {
    mkdirSync(join(dir, "scripts"), { recursive: true })
    writeFileSync(
      join(dir, "scripts", "luna-server-install"),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexit 0\n`,
    )
    spawnSync("chmod", ["+x", join(dir, "scripts", "luna-server-install")])
  }

  // systemctl's ExecStart --value answer is stubbed to STUB_EXEC_START
  // (default empty - the shape of an unrendered/old unit); nothing else in
  // these tests touches systemctl.
  const callUnitPathsCurrent = (g: ProfileGlobals, execStart = "") =>
    spawnSync("bash", ["-c",
      `source "$1"; systemctl() { printf '%s' "$STUB_EXEC_START"; }; ${profileAssigns(g)}; `
      + `rc=0; unit_paths_current || rc=$?; echo "RC=$rc"`,
      "_", guardian], { encoding: "utf8", env: { ...process.env, STUB_EXEC_START: execStart } })

  const callReconcile = (
    g: ProfileGlobals,
    opts: { hardened: "true" | "false"; wsCount?: string; pendingTransaction?: boolean },
  ) => {
    // Isolated, always-empty update-state dir: reconcile_unit_if_idle now
    // defers while a transaction-stable marker exists there, so these
    // branch tests must not inherit the real $HOME/.luna/update on the
    // machine running them.
    const updateState = mkdtempSync(join(tmpdir(), "luna-guardian-reconcile-update-"))
    trackDir(updateState)
    if (opts.pendingTransaction) {
      writeFileSync(join(updateState, "transaction-stable"), "phase=checkout\n")
    }
    return spawnSync("bash", ["-c",
      `source "$1"; systemctl() { printf '%s' ""; }; ${profileAssigns(g)}; `
      + `rc=0; reconcile_unit_if_idle stable || rc=$?; echo "RC=$rc"`,
      "_", guardian], {
      encoding: "utf8",
      env: {
        ...process.env,
        LUNA_TEST_GUARDIAN_UNIT_HARDENED: opts.hardened,
        LUNA_UPDATE_STATE_DIR: updateState,
        ...(opts.wsCount !== undefined ? { LUNA_TEST_WS_COUNT: opts.wsCount } : {}),
      },
    })
  }

  describe("unit_paths_current (S07 - rollback-safe unit-shape drift detector)", () => {
    it("an already-rendered ExecStart reads as current even when previous lacks the launcher", () => {
      const temp = mkdtempSync(join(tmpdir(), "luna-guardian-paths-rendered-"))
      trackDir(temp)
      const current = join(temp, "current")
      writeLauncher(current)
      const result = callUnitPathsCurrent(
        { repo: current, layout: "releases", deployRoot: temp },
        "{ path=/usr/bin/bun ; argv[]=/usr/bin/bun run scripts/luna-chat-server-entry.ts ; }",
      )
      expect(result.status, result.stdout + result.stderr).toBe(0)
      expect(result.stdout).toContain("RC=0")
    })

    it("releases: current AND previous both carrying the launcher IS drift worth reconciling", () => {
      const temp = mkdtempSync(join(tmpdir(), "luna-guardian-paths-both-"))
      trackDir(temp)
      const current = join(temp, "current")
      const previous = join(temp, "previous")
      writeLauncher(current)
      writeLauncher(previous)
      const result = callUnitPathsCurrent({ repo: current, layout: "releases", deployRoot: temp })
      expect(result.status, result.stdout + result.stderr).toBe(0)
      expect(result.stdout).toContain("RC=1")
    })

    it("releases: a previous lacking the launcher is NOT reported as drift (unsafe rollback target)", () => {
      const temp = mkdtempSync(join(tmpdir(), "luna-guardian-paths-prev-missing-"))
      trackDir(temp)
      const current = join(temp, "current")
      writeLauncher(current)
      // `previous` is never created here - the pre-first-rollback shape, and
      // the shape of any pre-S07 rollback target.
      const result = callUnitPathsCurrent({ repo: current, layout: "releases", deployRoot: temp })
      expect(result.status, result.stdout + result.stderr).toBe(0)
      expect(result.stdout).toContain("RC=0")
    })

    it("releases: a current lacking the launcher is NOT reported as drift (never target a broken tree)", () => {
      const temp = mkdtempSync(join(tmpdir(), "luna-guardian-paths-current-missing-"))
      trackDir(temp)
      const current = join(temp, "current")
      const previous = join(temp, "previous")
      mkdirSync(current, { recursive: true })
      writeLauncher(previous)
      const result = callUnitPathsCurrent({ repo: current, layout: "releases", deployRoot: temp })
      expect(result.status, result.stdout + result.stderr).toBe(0)
      expect(result.stdout).toContain("RC=0")
    })

    it("inplace: the current checkout carrying the launcher IS drift worth reconciling (no separate previous tree to check)", () => {
      const temp = mkdtempSync(join(tmpdir(), "luna-guardian-paths-inplace-"))
      trackDir(temp)
      const repo = join(temp, "repo")
      writeLauncher(repo)
      const result = callUnitPathsCurrent({ repo, layout: "inplace" })
      expect(result.status, result.stdout + result.stderr).toBe(0)
      expect(result.stdout).toContain("RC=1")
    })
  })

  describe("reconcile_unit_if_idle (S07 acceptance branches)", () => {
    it("idle (unhardened) reconcile renders exactly one luna-server-install --units-only --no-enable --no-start", () => {
      const temp = mkdtempSync(join(tmpdir(), "luna-guardian-reconcile-idle-"))
      trackDir(temp)
      const repo = join(temp, "repo")
      const log = join(temp, "install.log")
      writeServerInstallStub(repo, log)

      const result = callReconcile({ repo, layout: "inplace" }, { hardened: "false", wsCount: "0" })
      expect(result.status, result.stdout + result.stderr).toBe(0)
      expect(result.stdout).toContain("RC=0")
      expect(result.stderr).toContain("reconciling supervisor unit before repair restart")
      expect(existsSync(log)).toBe(true)
      const lines = readFileSync(log, "utf8").trim().split("\n")
      expect(lines.length).toBe(1)
      expect(lines[0]).toBe(`--profile stable --repo-dir ${repo} --units-only --no-enable --no-start`)
    })

    it("a pending update transaction defers reconcile with a warning and renders nothing", () => {
      // apply_ref may already have git-reset the checkout to a not-yet-verified
      // ref by the time this tick runs; rendering here would target a tree
      // do_rollback could discard moments later. Mirrors install_guardian's
      // own pending-transaction defer for the engine-pin flip.
      const temp = mkdtempSync(join(tmpdir(), "luna-guardian-reconcile-pending-"))
      trackDir(temp)
      const repo = join(temp, "repo")
      const log = join(temp, "install.log")
      writeServerInstallStub(repo, log)

      const result = callReconcile(
        { repo, layout: "inplace" },
        { hardened: "false", wsCount: "0", pendingTransaction: true },
      )
      expect(result.status, result.stdout + result.stderr).toBe(0)
      expect(result.stdout).toContain("RC=1")
      expect(result.stderr).toContain("unit drift: update transaction pending for profile 'stable'; deferring reconcile")
      expect(existsSync(log)).toBe(false)
    })

    it("active sessions (>0) defer reconcile with a warning and render nothing", () => {
      const temp = mkdtempSync(join(tmpdir(), "luna-guardian-reconcile-active-"))
      trackDir(temp)
      const repo = join(temp, "repo")
      const log = join(temp, "install.log")
      writeServerInstallStub(repo, log)

      const result = callReconcile({ repo, layout: "inplace" }, { hardened: "false", wsCount: "3" })
      expect(result.status, result.stdout + result.stderr).toBe(0)
      expect(result.stdout).toContain("RC=1")
      expect(result.stderr).toContain("unit drift: 3 active session(s); deferring")
      expect(existsSync(log)).toBe(false)
    })

    it("luna_active_ws_count NON-ZERO EXIT defers reconcile with 'session count unknown' and renders nothing", () => {
      const temp = mkdtempSync(join(tmpdir(), "luna-guardian-reconcile-unknown-"))
      trackDir(temp)
      const repo = join(temp, "repo")
      const log = join(temp, "install.log")
      writeServerInstallStub(repo, log)

      // LUNA_TEST_WS_COUNT="unknown" fails luna_active_ws_count's numeric
      // regex, simulating an unavailable probe (luna-guardian:525-526) -
      // never read as "zero sessions".
      const result = callReconcile({ repo, layout: "inplace" }, { hardened: "false", wsCount: "unknown" })
      expect(result.status, result.stdout + result.stderr).toBe(0)
      expect(result.stdout).toContain("RC=1")
      expect(result.stderr).toContain("unit drift: session count unknown; deferring")
      expect(existsSync(log)).toBe(false)
    })

    it("a previous lacking the launcher leaves the old unit installed (hardened=true, unsafe rollback target)", () => {
      const temp = mkdtempSync(join(tmpdir(), "luna-guardian-reconcile-stale-prev-"))
      trackDir(temp)
      const current = join(temp, "current")
      writeLauncher(current)
      const log = join(temp, "install.log")
      writeServerInstallStub(current, log)
      // `previous` is never created - current alone carrying the launcher is
      // not enough to prove a rollback stays bootable.

      const result = callReconcile(
        { repo: current, layout: "releases", deployRoot: temp },
        { hardened: "true", wsCount: "0" },
      )
      expect(result.status, result.stdout + result.stderr).toBe(0)
      // unit_hardened && unit_paths_current short-circuits true - reconcile
      // never reaches the WS-count check or the install call.
      expect(result.stdout).toContain("RC=0")
      expect(existsSync(log)).toBe(false)
    })
  })

  // ── publish_engine compile-topology split ───────────────────────────────
  // publish_engine compiles apps/deploy-cli against the RUNTIME's own bun
  // (docs/deploy-binary.md), never the publishing host's bun on an incus
  // profile's behalf - the container's bun via run_runtime/incus exec for an
  // incus profile, the publishing host's own bun otherwise. These tests call
  // publish_engine DIRECTLY by sourcing scripts/luna-guardian (same seam as
  // unit_paths_current above), so they exercise the topology split without
  // paying for a full install_guardian run through a registry.
  describe("publish_engine (compile-topology split)", () => {
    // Parametrized over BOTH layouts: publish_engine's container_root branch
    // (scripts/luna-guardian) picks the source tree the compile reads from -
    // "/root/luna" for inplace, "$LUNA_CONTAINER_DEPLOY_ROOT/current" for
    // releases - and a wrong pick would silently build a different commit
    // than the pin's own sha, with no postcondition able to catch it.
    for (const layout of ["inplace", "releases"] as const) {
      it(`incus profile (${layout} layout): compiles deploy-cli INSIDE the container through run_runtime/incus exec, never with the host's own bun`, () => {
        const temp = mkdtempSync(join(tmpdir(), `luna-guardian-publish-incus-${layout}-`))
        trackDir(temp)
        const bin = join(temp, "bin")
        const pinBase = join(temp, "pins")
        const sha = "a".repeat(40)
        const pin = join(pinBase, `engine@${sha}`)
        const log = join(temp, "incus-calls.log")
        mkdirSync(bin, { recursive: true })
        mkdirSync(pinBase, { recursive: true })
        writeIncusPassthroughStub(bin, log)
        stubBun(bin)

        // Deliberately non-default for the releases case, so a passing
        // assertion proves LUNA_CONTAINER_DEPLOY_ROOT was actually READ, not
        // merely that the "/root/luna" default happens to match either branch.
        const containerDeployRoot = layout === "releases" ? "/root/custom-releases-root" : ""
        const expectedMainTs = layout === "releases"
          ? `${containerDeployRoot}/current/apps/deploy-cli/src/main.ts`
          : "/root/luna/apps/deploy-cli/src/main.ts"

        const result = spawnSync("bash", ["-c",
          `source "$1"; P_INCUS="luna-test"; P_LAYOUT="$2"; P_REPO=""; publish_engine "$3" "$4" "$5"`,
          "_", guardian, layout, root, sha, pin], {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
            LUNA_GUARDIAN_PIN_BASE: pinBase,
            LUNA_TEST_BUN_PATH: join(bin, "bun"),
            ...(containerDeployRoot ? { LUNA_CONTAINER_DEPLOY_ROOT: containerDeployRoot } : {}),
          },
        })

        expect(result.status, result.stdout + result.stderr).toBe(0)
        expect(existsSync(join(pin, ".complete"))).toBe(true)
        const deployCli = join(pin, "deploy-cli")
        expect(existsSync(deployCli)).toBe(true)
        expect(statSync(deployCli).mode & 0o100).toBe(0o100)

        // The build itself, and the retrieval read afterward, both went
        // through `incus exec luna-test -- ...` - never invoked directly on
        // the host - and the build used the CONTAINER's bun (LUNA_TEST_BUN_PATH,
        // this stub's stand-in for /root/.bun/bin/bun) against the container's
        // OWN view of the checkout, never $root on the host side.
        const calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean)
        expect(calls.some((line) =>
          line.startsWith("exec luna-test -- ") &&
          line.includes(join(bin, "bun")) &&
          line.includes(" build ") &&
          line.includes("--compile") &&
          line.includes(expectedMainTs),
        ), calls.join("\n")).toBe(true)
        expect(calls.some((line) => line.startsWith("exec luna-test -- cat /tmp/deploy-cli.")), calls.join("\n")).toBe(true)
      })
    }

    it("bare-host profile: a bun that vanishes after install_guardian's own preflight dies with a named cause, never a raw exit 127", () => {
      const temp = mkdtempSync(join(tmpdir(), "luna-guardian-publish-diebun-"))
      trackDir(temp)
      const pinBase = join(temp, "pins")
      const sha = "b".repeat(40)
      const pin = join(pinBase, `engine@${sha}`)
      mkdirSync(pinBase, { recursive: true })
      // A path that resolves to nothing - the TOCTOU shape this test
      // exercises: bun present at install_guardian's own preflight,
      // gone by the time publish_engine's OWN check runs this same lookup
      // again. Under `set -euo pipefail`, calling this path directly (`"$bun_
      // bin" build --compile ...`) without the runtime_bun_executable guard
      // first would fail as a raw `exec` ENOENT - exit 127, no postcondition,
      // no named cause - instead of the actionable luna_die this proves.
      const missingBun = join(temp, "nonexistent-bun", "bun")

      const result = spawnSync("bash", ["-c",
        `source "$1"; P_INCUS=""; P_LAYOUT="inplace"; P_REPO=""; publish_engine "$2" "$3" "$4"`,
        "_", guardian, root, sha, pin], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, LUNA_GUARDIAN_PIN_BASE: pinBase, LUNA_TEST_BUN_PATH: missingBun },
      })

      expect(result.status, result.stdout + result.stderr).not.toBe(127)
      expect(result.status, result.stdout + result.stderr).toBe(1)
      expect(result.stderr).toContain(`error: bun not found at ${missingBun}; cannot publish deploy-cli`)
      expect(existsSync(pin)).toBe(false)
    })
  })

  // ── publish_engine leak containment ─────────────────────────────────────
  // publish_engine's staging dir ($tmp = "$pin.tmp.$$") and lock ($lock =
  // "$PIN_BASE/.engine-$sha.lock") match prune_engines' own `engine@*` glob
  // (the lock does not, but the tmp dir does) and its keep=5 window. A die
  // inside the critical section that skipped cleanup left `$tmp` behind, and
  // enough of them accumulated across retries to consume prune's keep=5
  // budget and get a REAL rollback engine pruned instead of the garbage.
  it("publish_engine never leaks engine@*.tmp.* or its lock across repeated failed compiles", () => {
    const temp = mkdtempSync(join(tmpdir(), "luna-guardian-leak-repro-"))
    trackDir(temp)
    const bin = join(temp, "bin")
    const pinBase = join(temp, "pins")
    const sha = "c".repeat(40)
    const pin = join(pinBase, `engine@${sha}`)
    mkdirSync(bin, { recursive: true })
    mkdirSync(pinBase, { recursive: true })
    // Executable (passes the runtime_bun_executable preflight) but always
    // fails the actual compile, distinct from a MISSING bun (already covered
    // above): this exercises the mid-critical-section `bun build --compile`
    // POSTCONDITION die, not the preflight die.
    writeStub(join(bin, "bun"), `#!/usr/bin/env bash\nexit 1\n`)

    for (let attempt = 1; attempt <= 3; attempt++) {
      // A fresh bash process per attempt, the same shape as a guardian tick
      // retrying on its own timer after a failed publish: a fresh $$, hence
      // a fresh $tmp name every time, so a single-attempt-only fix could not
      // hide a leak that only shows up once several have accumulated.
      const result = spawnSync("bash", ["-c",
        `source "$1"; P_INCUS=""; P_LAYOUT="inplace"; P_REPO=""; publish_engine "$2" "$3" "$4"`,
        "_", guardian, root, sha, pin], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, LUNA_GUARDIAN_PIN_BASE: pinBase, LUNA_TEST_BUN_PATH: join(bin, "bun") },
      })
      expect(result.status, `attempt ${attempt}: ${result.stdout}${result.stderr}`).not.toBe(0)
      expect(result.stderr, `attempt ${attempt}`).toContain("POSTCONDITION: bun build --compile failed")
    }

    // Zero survivors after EVERY attempt, not just on average across three -
    // one leaked directory from any single attempt already proves the bug.
    const entries = readdirSync(pinBase)
    const leakedTmp = entries.filter((name) => name.includes(".tmp."))
    const leakedLock = entries.filter((name) => name.includes(".lock"))
    expect(leakedTmp, entries.join("\n")).toEqual([])
    expect(leakedLock, entries.join("\n")).toEqual([])
    expect(existsSync(pin)).toBe(false)
  })

  // The repro above drives ONLY the `bun build --compile` POSTCONDITION,
  // which was always wrapped by an explicit `|| luna_die` (now `||
  // publish_abort`) even before this slice - it passes identically with the
  // ERR trap deleted, so it cannot lock the trap in. `mv "$tmp" "$pin"` on
  // the atomic flip is the one statement in the critical section neither
  // publish_abort nor an explicit `|| luna_die` wraps: LUNA_TEST_MV_FAIL_GLOB
  // makes it genuinely fail (exit 1, distinct from LUNA_TEST_MV_LIE_GLOB's
  // exit-0-without-acting below), tripping `set -e` - only the ERR trap can
  // clean up after that.
  it("publish_engine's ERR trap - not the explicit-die cleanup - closes the implicit set -e leak class on the atomic flip's mv", () => {
    const h = makeConvergedHarnessWithDeployCli("luna-guardian-publish-mv-fail-")
    installHarness(h)
    // New sha -> the full install path must PUBLISH a new engine dir, same
    // shape as the mv-LIE postcondition test above.
    spawnSync("git", ["-C", h.temp, "-c", "user.email=t@t", "-c", "user.name=t",
      "commit", "-q", "--allow-empty", "-m", "advance"], { encoding: "utf8" })
    const install = spawnSync("bash", [h.guardian, "install", "stable"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...h.env,
        LUNA_TEST_RUNTIME_MATCHES_CHECKOUT: "true",
        LUNA_TEST_MV_FAIL_GLOB: "*engine@*.tmp.*",
      },
    })
    expect(install.status, install.stdout + install.stderr).not.toBe(0)
    // Proves the run actually reached the mv flip (and not, say, an earlier
    // preflight die that would also leave zero .tmp./.lock survivors): the
    // mv stub only emits this line when LUNA_TEST_MV_FAIL_GLOB matched an
    // invoked mv argument, so its presence is evidence publish_engine got to
    // the atomic flip before failing.
    expect(install.stderr).toContain("mv: simulated failure")
    const pins = h.env.LUNA_GUARDIAN_PIN_BASE as string
    const entries = readdirSync(pins)
    expect(entries.filter((name) => name.includes(".tmp.")), entries.join("\n")).toEqual([])
    expect(entries.filter((name) => name.includes(".lock")), entries.join("\n")).toEqual([])
  })

  it("prune_engines reaps a dead owner's leaked engine@*.tmp.* staging dir but never touches a live owner's", () => {
    const h = makeConvergedHarnessWithDeployCli("luna-guardian-prune-tmp-glob-")
    installHarness(h)
    const pins = h.env.LUNA_GUARDIAN_PIN_BASE as string

    // current-dev pins ONE live engine; a second,
    // complete engine sits unpinned as a rollback target, relying on the
    // keep=5 window alone (no current-* symlink) to survive. Leaked
    // engine@<sha>.tmp.<pid> staging dirs - publish_engine's OWN naming for a
    // still-building or abandoned pin - are all NEWER than every real engine
    // here, so pre-defense-in-depth they would fill the entire keep=5 window
    // and push the unpinned rollback engine out to be pruned.
    const now = Date.now() / 1000
    const rollback = join(pins, `engine@${"1".repeat(40)}`)
    mkdirSync(rollback, { recursive: true })
    writeFileSync(join(rollback, ".complete"), "")
    utimesSync(rollback, now - 2000, now - 2000)

    const live = join(pins, `engine@${"2".repeat(40)}`)
    mkdirSync(live, { recursive: true })
    writeFileSync(join(live, ".complete"), "")
    utimesSync(live, now - 1000, now - 1000)
    symlinkSync(live, join(pins, "current-dev"))

    // Dead-owner leaks: pids nothing on this host holds (SIGKILL/OOM/reboot
    // mid-publish - ERR does not fire on a signal - or any future bug in the
    // ERR-trap cleanup above). These must be reaped, or they are immortal:
    // nothing else in PIN_BASE ever reclaims them.
    const deadLeaks: string[] = []
    for (let i = 1; i <= 4; i++) {
      const leak = join(pins, `engine@${String(i).repeat(40)}.tmp.${90000 + i}`)
      mkdirSync(leak, { recursive: true })
      utimesSync(leak, now + 500, now + 500)
      deadLeaks.push(leak)
    }
    // Live-owner leak: this test process's OWN pid, guaranteed alive for the
    // whole run - the one case prune must never touch (a still-running
    // publish's own $tmp).
    const liveLeak = join(pins, `engine@${"5".repeat(40)}.tmp.${process.pid}`)
    mkdirSync(liveLeak, { recursive: true })
    utimesSync(liveLeak, now + 500, now + 500)

    // Trigger a full (non-fast-path) install so prune_engines actually runs.
    rmSync(join(h.env.LUNA_TEST_SYSTEMD_DIR as string, "luna-guardian-stable.timer"))
    const install = spawnSync("bash", [h.guardian, "install", "stable"], {
      cwd: root,
      encoding: "utf8",
      env: { ...h.env, LUNA_TEST_RUNTIME_MATCHES_CHECKOUT: "true" },
    })
    expect(install.status, install.stdout + install.stderr).toBe(0)

    // Both real engines survive - the rollback engine specifically, since it
    // is the unprotected one the pre-defense-in-depth bug pruned.
    expect(existsSync(join(rollback, ".complete")), "rollback engine must survive prune").toBe(true)
    expect(existsSync(join(live, ".complete")), "live-pinned engine must survive prune").toBe(true)
    for (const leak of deadLeaks) {
      expect(existsSync(leak), `dead-owner leak ${leak} must be reaped`).toBe(false)
    }
    expect(existsSync(liveLeak), "a live owner's own $tmp must never be touched").toBe(true)
  })

  it("check_profile reconciles unit-path drift through the FULL wiring - both the 524 early-return gate and the 670 caller gate", () => {
    // Regression guard for exactly the risk the approach called out: editing
    // ONLY reconcile_unit_if_idle's body (the 524 gate) without ALSO gating
    // its sole caller in check_profile (670) leaves unit_paths_current
    // permanently unreachable, because unit_hardened=true alone already
    // short-circuits the caller. This goes through run_check/check_profile
    // for real - LUNA_TEST_GUARDIAN_UNIT_HARDENED stays "true" (makeHarness's
    // default), so ONLY unit_paths_current returning false can explain a
    // reconcile firing here.
    const h = makeConvergedHarnessWithDeployCli("luna-guardian-unit-paths-wiring-", { layout: "releases" })
    installHarness(h)
    const deploy = join(h.temp, "deploy")
    const relSha = readlinkSync(join(deploy, "current")).replace("releases/", "")
    const releaseDir = join(deploy, "releases", relSha)

    // Current release already carries the launcher (a post-S07 tree would).
    writeLauncher(releaseDir)
    // Rollback target ALSO carries it - safe to reconcile.
    symlinkSync(`releases/${relSha}`, join(deploy, "previous"))
    // Recording stub at the exact path reconcile_unit_if_idle invokes:
    // $P_REPO/scripts/luna-server-install (P_REPO resolves through `current`).
    const log = join(h.temp, "install-invocations.log")
    writeServerInstallStub(releaseDir, log)

    const tick = runPinnedCheck(h, { LUNA_TEST_WS_COUNT: "0" })
    expect(tick.status, tick.stdout + tick.stderr).toBe(0)
    expect(existsSync(log)).toBe(true)
    const invocations = readFileSync(log, "utf8").trim().split("\n")
    expect(invocations.length).toBe(1)
    expect(invocations[0]).toBe(
      `--profile stable --repo-dir ${join(deploy, "current")} --units-only --no-enable --no-start --layout releases`,
    )
  })

})
