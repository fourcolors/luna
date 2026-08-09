/**
 * Golden parity for the pre-mutation checks (S22d): every scenario runs the
 * REAL `--- preflight ---` region of scripts/luna-update-server (:421-530) and
 * the TypeScript port over ONE shared temp tree, then asserts they agree on
 * the exit code, on stdout byte for byte, on stderr byte for byte, and on the
 * two values the region leaves behind for the rest of the run (REF and
 * BUN_BIN).
 *
 * WHY STDOUT IS DIFFED AND NOT JUST THE REFUSALS. The banner block is the only
 * record of WHICH host, service and target an engine was talking to, and it is
 * printed before every refusal precisely so an operator reading a failed
 * unattended run can tell a misaddressed deploy from a genuinely missing unit.
 * A port that agreed on every exit code while dropping or re-wording a banner
 * line would be silently worse at the one moment anyone reads this output.
 *
 * ONE TREE, TWO DRIVES. Both drives probe the SAME directories - which is what
 * makes the byte-diff meaningful at all, since every banner line and every
 * refusal interpolates an absolute path, and two temp roots would differ in
 * every one of them. Sharing is safe here for the same reason preflight is
 * allowed to run before the lock: it writes nothing. That is not assumed - each
 * scenario fingerprints the tree before and after both drives and asserts it is
 * byte-identical, so the ordering invariant the S22d spec asks preflight to
 * carry (no lock, no mutation, before validation returns) is an observation
 * rather than a comment. Only the two drives' logs live outside it.
 *
 * HOW THE BASH SIDE IS DRIVEN. Preflight is not a function - it is top-level
 * script text - so the awk extraction takes the REGION between the script's own
 * two section banners rather than a `fn() { ... }` block, and eval's it into a
 * shell where the real scripts/lib/luna-deploy.sh is sourced (so `luna_info`,
 * `luna_die` and `luna_find_bun` are the genuine article, not transcriptions)
 * and only the two collaborators that would touch a real host - `incus` and
 * `git` - are shell-function stubs. Everything else is REAL: the `[[ -d ]]` /
 * `[[ -f ]]` probes run against the same directories the port stats with its
 * own default seams, so a divergence in what "exists" means cannot hide here.
 *
 * LAYOUT=inplace ON BOTH DRIVES. The releases arm of the repo check (:456-466)
 * and the releases "explicit --ref required" refusal (:507-508) are NOT ported
 * - `--layout releases` is delegated whole to the bash engine before the lock,
 * so preflight never runs on that path. Driving the region with LAYOUT=inplace
 * is what makes that scoping honest rather than a hole: the un-ported lines are
 * never executed on either side.
 *
 * ORDER IS ASSERTED BY BREAKING TWO THINGS AT ONCE. Several scenarios leave
 * BOTH the clone check and the unit check failing; since an operator only ever
 * sees the first refusal, a port that reordered them would surface as a stderr
 * mismatch instead of as a green test with a different message.
 */
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import {
  type PreflightOptions,
  type Supervisor,
  notAGitCloneMessage,
  resolveDefaultRefSync,
  runPreflightSync,
  unitPreflightSync,
  unitRefusalMessages,
} from "../../src/update/preflight.js"
import { cleanupTempDirs, makeTempDir, repoRoot } from "./temp-dirs.js"

const UPDATE_SERVER = join(repoRoot, "scripts/luna-update-server")
const DEPLOY_LIB = join(repoRoot, "scripts/lib/luna-deploy.sh")

const SERVICE_NAME = "luna-chat-server.service"
const LAUNCHD_LABEL = "ai.luna.chat-server"
const INCUS_CONTAINER = "luna-dev"
/** What `luna_find_bun` answers on both drives: bash reads LUNA_TEST_BUN_PATH first (scripts/lib/luna-deploy.sh:442-445); the port is handed the same string. */
const TEST_BUN_PATH = "/opt/stub/bun"
/** `BUN_BIN_INCUS` (scripts/luna-update-server:317) - the CONTAINER's bun, used verbatim off the incus path and never resolved on the host. */
const BUN_BIN_INCUS = "/root/.bun/bin/bun"
/** `CONTAINER_REPO_DIR` on the incus path is hardcoded (scripts/luna-update-server:313); the banner prints it, so it is pinned here too. */
const CONTAINER_REPO_DIR = "/root/luna"
/** bash's `$UID`, which the launchd banner interpolates; both drives run as the same user. */
const UID_STRING = String(process.getuid?.() ?? 0)

afterAll(cleanupTempDirs)

interface Scenario {
  readonly profile: string
  readonly incusContainer: string
  readonly supervisor: Supervisor
  readonly systemdUser: boolean
  readonly dryRun: boolean
  readonly materializeOnly: boolean
  /** `--ref` as given; "" drives the default-resolution block (:510-520). */
  readonly ref: string
  /** Whether `$HOST_REPO_DIR/.git` exists. */
  readonly repoIsClone: boolean
  readonly unitExists: boolean
  readonly plistExists: boolean
  readonly userUnitExists: boolean
  /** `incus exec <c> -- test -f <unit>`: 0 means the unit is present in the container. */
  readonly incusRc: number
  /** What the `rev-parse --abbrev-ref HEAD` stub prints ("HEAD" when detached). */
  readonly gitBranch: string
  /** Non-zero makes the stub fail, which the region's `|| true` collapses to "". */
  readonly gitRc: number
}

const base: Scenario = {
  profile: "dev",
  incusContainer: "",
  supervisor: "systemd",
  systemdUser: false,
  dryRun: false,
  materializeOnly: false,
  ref: "origin/master",
  repoIsClone: true,
  unitExists: true,
  plistExists: true,
  userUnitExists: true,
  incusRc: 0,
  gitBranch: "master",
  gitRc: 0,
}

interface Paths {
  readonly temp: string
  /** The subtree both drives probe and neither may touch. */
  readonly host: string
  readonly hostRepoDir: string
  readonly containerRepoDir: string
  readonly serviceFile: string
  readonly userUnitFile: string
  readonly launchdPlist: string
}

/** Per-drive log sinks, deliberately OUTSIDE `host/` so writing them cannot show up in the no-mutation fingerprint. */
interface Logs {
  readonly incusLog: string
  readonly gitLog: string
  readonly resultFile: string
}

const makePaths = (s: Scenario): Paths => {
  const temp = makeTempDir("deploy-cli-preflight-parity-")
  const host = join(temp, "host")
  const hostRepoDir = join(host, "repo")
  const serviceDir = join(host, "systemd")
  const userUnitDir = join(host, "user-units")
  const launchAgents = join(host, "LaunchAgents")
  for (const d of [hostRepoDir, serviceDir, userUnitDir, launchAgents]) mkdirSync(d, { recursive: true })
  if (s.repoIsClone) mkdirSync(join(hostRepoDir, ".git"), { recursive: true })
  if (s.unitExists) writeFileSync(join(serviceDir, SERVICE_NAME), "[Unit]\n")
  if (s.userUnitExists) writeFileSync(join(userUnitDir, SERVICE_NAME), "[Unit]\n")
  if (s.plistExists) writeFileSync(join(launchAgents, `${LAUNCHD_LABEL}.plist`), "<plist/>\n")
  return {
    temp,
    host,
    hostRepoDir,
    // Off the incus path CONTAINER_REPO_DIR equals HOST_REPO_DIR (:320).
    containerRepoDir: s.incusContainer === "" ? hostRepoDir : CONTAINER_REPO_DIR,
    serviceFile: join(serviceDir, SERVICE_NAME),
    userUnitFile: join(userUnitDir, SERVICE_NAME),
    launchdPlist: join(launchAgents, `${LAUNCHD_LABEL}.plist`),
  }
}

const makeLogs = (temp: string, drive: string): Logs => {
  const dir = join(temp, `logs-${drive}`)
  mkdirSync(dir, { recursive: true })
  return { incusLog: join(dir, "incus.log"), gitLog: join(dir, "git.log"), resultFile: join(dir, "result") }
}

/** Sorted relative paths plus file contents under `dir` - the "nothing was mutated" fingerprint. */
const snapshot = (dir: string): ReadonlyArray<string> => {
  const out: string[] = []
  const walk = (current: string): void => {
    for (const entry of readdirSync(current).sort()) {
      const full = join(current, entry)
      const rel = relative(dir, full)
      if (statSync(full).isDirectory()) {
        out.push(`${rel}/`)
        walk(full)
      } else {
        out.push(`${rel} ${readFileSync(full, "utf8")}`)
      }
    }
  }
  walk(dir)
  return out
}

interface Drive {
  readonly rc: number
  readonly stdout: string
  readonly stderr: string
  /** Only meaningful when rc === 0; bash never reaches the readback on a refusal. */
  readonly ref: string
  readonly bunBin: string
  /** Raw argv of every `incus` / `git` call, one per entry, as each drive saw it. */
  readonly incusCalls: ReadonlyArray<string>
  readonly gitCalls: ReadonlyArray<string>
}

const readLines = (path: string): ReadonlyArray<string> =>
  existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((l) => l !== "") : []

/** Run the REAL preflight region over the scenario. */
const runBash = (s: Scenario, p: Paths, logs: Logs): Drive => {
  const q = (v: string): string => JSON.stringify(v)
  const script = [
    "set -uo pipefail",
    `source ${q(DEPLOY_LIB)}`,
    // The only two stubs. `incus` logs its raw argv and answers with the
    // scenario's rc, standing in for `-- test -f "$SERVICE_FILE"` inside the
    // container; `git` logs and answers the abbrev-ref query. Both are shell
    // FUNCTIONS, so the region's own quoting and its `2>/dev/null || true`
    // wrapper are exercised unchanged.
    `incus() { printf '%s\\n' "$*" >> ${q(logs.incusLog)}; return ${s.incusRc}; }`,
    `git() { printf '%s\\n' "$*" >> ${q(logs.gitLog)}; if [[ ${s.gitRc} -ne 0 ]]; then return ${s.gitRc}; fi; printf '%s\\n' ${q(s.gitBranch)}; }`,
    `PROFILE=${q(s.profile)}`,
    `INCUS_CONTAINER=${q(s.incusContainer)}`,
    `SUPERVISOR=${q(s.supervisor)}`,
    `SYSTEMD_USER=${s.systemdUser}`,
    `HOST_REPO_DIR=${q(p.hostRepoDir)}`,
    `CONTAINER_REPO_DIR=${q(p.containerRepoDir)}`,
    `SERVICE_FILE=${q(p.serviceFile)}`,
    `USER_UNIT_FILE=${q(p.userUnitFile)}`,
    `LAUNCHD_LABEL=${q(LAUNCHD_LABEL)}`,
    `LAUNCHD_PLIST=${q(p.launchdPlist)}`,
    `DRY_RUN=${s.dryRun}`,
    `MATERIALIZE_ONLY=${s.materializeOnly}`,
    "LAYOUT=inplace",
    `REF=${q(s.ref)}`,
    `BUN_BIN_INCUS=${q(BUN_BIN_INCUS)}`,
    // The region between the script's own two section banners: preflight in
    // full, stopping before the lockfile-hash helpers that follow it.
    `eval "$(awk '/^# --- preflight ---/{f=1} f && /^# --- helpers: lockfile-change detection/{exit} f{print}' ${q(UPDATE_SERVER)})"`,
    // Reached only when the region did not luna_die; written to a file rather
    // than stdout so the stdout byte-diff stays exactly what bash printed.
    `printf 'REF=%s\\nBUN_BIN=%s\\n' "$REF" "$BUN_BIN" > ${q(logs.resultFile)}`,
  ].join("\n")

  const r = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: { ...process.env, LUNA_TEST_BUN_PATH: TEST_BUN_PATH },
  })
  const result = existsSync(logs.resultFile) ? readFileSync(logs.resultFile, "utf8") : ""
  const value = (key: string): string => {
    const line = result.split("\n").find((l) => l.startsWith(`${key}=`))
    return line === undefined ? "" : line.slice(key.length + 1)
  }
  return {
    rc: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    ref: value("REF"),
    bunBin: value("BUN_BIN"),
    incusCalls: readLines(logs.incusLog),
    gitCalls: readLines(logs.gitLog),
  }
}

/** Run the TypeScript port over the same tree. */
const runTs = (s: Scenario, p: Paths): Drive => {
  const stdout: string[] = []
  const incusCalls: string[] = []
  const gitCalls: string[] = []
  const opts: PreflightOptions = {
    profile: s.profile,
    incusContainer: s.incusContainer,
    supervisor: s.supervisor,
    systemdUser: s.systemdUser,
    hostRepoDir: p.hostRepoDir,
    containerRepoDir: p.containerRepoDir,
    serviceFile: p.serviceFile,
    userUnitFile: p.userUnitFile,
    launchdLabel: LAUNCHD_LABEL,
    launchdPlist: p.launchdPlist,
    uid: UID_STRING,
    dryRun: s.dryRun,
    materializeOnly: s.materializeOnly,
    ref: s.ref,
    bunBinIncus: BUN_BIN_INCUS,
    print: (line) => stdout.push(line),
    // dirExists/fileExists are DELIBERATELY left to the module's real-fs
    // defaults: they answer about the same directories bash's `[[ -d ]]` /
    // `[[ -f ]]` just tested, which is the whole point of sharing the tree.
    containerFileExists: (container, path) => {
      incusCalls.push(`exec ${container} -- test -f ${path}`)
      return s.incusRc === 0
    },
    gitCurrentBranch: (hostRepoDir) => {
      gitCalls.push(`-C ${hostRepoDir} rev-parse --abbrev-ref HEAD`)
      return s.gitRc === 0 ? s.gitBranch : ""
    },
    findBun: () => TEST_BUN_PATH,
  }
  const outcome = runPreflightSync(opts)
  return {
    rc: outcome.ok ? 0 : outcome.exitCode,
    stdout: stdout.map((l) => `${l}\n`).join(""),
    stderr: outcome.ok ? "" : `${outcome.errorLine}\n`,
    ref: outcome.ok ? outcome.ref : "",
    bunBin: outcome.ok ? outcome.bunBin : "",
    incusCalls,
    gitCalls,
  }
}

/** stdout/stderr are compared byte for byte, so every expectation is spelled as exact lines. */
const lines = (...l: ReadonlyArray<string>): string => l.map((x) => `${x}\n`).join("")

interface Expectation {
  readonly rc: number
  /** Byte-exact stdout, built from the tree's real paths. */
  readonly stdout: (p: Paths) => string
  /** Byte-exact stderr; omitted means "". */
  readonly stderr?: (p: Paths) => string
  readonly ref?: string
  readonly bunBin?: string
  /** How many times each collaborator must have been consulted (both drives). */
  readonly incusCalls?: number
  readonly gitCalls?: number
}

const parity = (name: string, s: Scenario, expected: Expectation): void => {
  it(name, () => {
    const p = makePaths(s)
    const before = snapshot(p.host)

    const bash = runBash(s, p, makeLogs(p.temp, "bash"))
    const afterBash = snapshot(p.host)
    const ts = runTs(s, p)

    // The four artifacts, port against oracle.
    expect(ts.rc, `rc (bash stderr: ${bash.stderr})`).toBe(bash.rc)
    expect(ts.stdout).toBe(bash.stdout)
    expect(ts.stderr).toBe(bash.stderr)
    if (bash.rc === 0) {
      expect(ts.ref).toBe(bash.ref)
      expect(ts.bunBin).toBe(bash.bunBin)
    }

    // The two seams: same collaborator, same argv, same call count - so a port
    // that "passed" by never probing the container would fail here.
    expect(ts.incusCalls, "incus argv").toStrictEqual(bash.incusCalls)
    expect(ts.gitCalls, "git argv").toStrictEqual(bash.gitCalls)
    if (expected.incusCalls !== undefined) expect(bash.incusCalls.length, "incus call count").toBe(expected.incusCalls)
    if (expected.gitCalls !== undefined) expect(bash.gitCalls.length, "git call count").toBe(expected.gitCalls)

    // The pinned expectation, so this suite also fails when the SHARED
    // behaviour drifts rather than only when the two drives disagree.
    expect(bash.rc, "bash rc").toBe(expected.rc)
    expect(bash.stdout, "bash stdout").toBe(expected.stdout(p))
    expect(bash.stderr, "bash stderr").toBe(expected.stderr === undefined ? "" : expected.stderr(p))
    if (expected.ref !== undefined) expect(bash.ref).toBe(expected.ref)
    if (expected.bunBin !== undefined) expect(bash.bunBin).toBe(expected.bunBin)

    // Nothing was written, by either drive, on any path.
    expect(afterBash, "the bash drive mutated the host tree").toStrictEqual(before)
    expect(snapshot(p.host), "the port mutated the host tree").toStrictEqual(before)
  })
}

const head = "-> Updating Luna server profile: dev"

describe("preflight: golden parity with scripts/luna-update-server", () => {
  describe("the banner block (:423-440)", () => {
    parity("bare host", base, {
      rc: 0,
      stdout: (p) =>
        lines(head, `Repo: ${p.hostRepoDir}`, `Service: ${p.serviceFile}`, "Target: bare host", "Target ref: origin/master"),
      ref: "origin/master",
      bunBin: TEST_BUN_PATH,
      incusCalls: 0,
      gitCalls: 0,
    })

    parity("bare host, systemd --user scope", { ...base, systemdUser: true }, {
      rc: 0,
      stdout: (p) =>
        lines(
          head,
          `Repo: ${p.hostRepoDir}`,
          `Service: ${p.serviceFile} (systemd --user)`,
          "Target: bare host (user scope)",
          "Target ref: origin/master",
        ),
      bunBin: TEST_BUN_PATH,
    })

    parity("macOS launchd", { ...base, supervisor: "launchd" }, {
      rc: 0,
      stdout: (p) =>
        lines(
          head,
          `Repo: ${p.hostRepoDir}`,
          `Service: ${LAUNCHD_LABEL} (launchd plist: ${p.launchdPlist})`,
          `Target: macOS launchd (gui/${UID_STRING})`,
          "Target ref: origin/master",
        ),
      bunBin: TEST_BUN_PATH,
    })

    // The three-space run in `Repo (in-container):   %s` is column alignment
    // (:426) and a byte-diff catches its loss.
    parity("incus container, with the container's own bun", { ...base, incusContainer: INCUS_CONTAINER }, {
      rc: 0,
      stdout: (p) =>
        lines(
          head,
          `Repo (host git mount): ${p.hostRepoDir}`,
          `Repo (in-container):   ${CONTAINER_REPO_DIR}`,
          `Service: ${p.serviceFile} (in container)`,
          `Target: incus container ${INCUS_CONTAINER}`,
          "Target ref: origin/master",
        ),
      bunBin: BUN_BIN_INCUS,
      incusCalls: 1,
    })

    // incus wins the BANNER even under --user, matching the arm order at :424.
    parity("incus outranks --user in the banner", { ...base, incusContainer: INCUS_CONTAINER, systemdUser: true }, {
      rc: 0,
      stdout: (p) =>
        lines(
          head,
          `Repo (host git mount): ${p.hostRepoDir}`,
          `Repo (in-container):   ${CONTAINER_REPO_DIR}`,
          `Service: ${p.serviceFile} (in container)`,
          `Target: incus container ${INCUS_CONTAINER}`,
          "Target ref: origin/master",
        ),
      bunBin: BUN_BIN_INCUS,
    })

    // ... and launchd wins the BANNER over --user (:424), off the incus path
    // this time, so a launchd host that also passes --user still gets the
    // launchd banner rather than the "bare host (user scope)" one. A port
    // that tested the --user arm before the launchd arm would print the
    // wrong banner here and diverge from bash's stdout byte for byte.
    parity(
      "launchd outranks --user in the banner",
      { ...base, supervisor: "launchd", systemdUser: true },
      {
        rc: 0,
        stdout: (p) =>
          lines(
            head,
            `Repo: ${p.hostRepoDir}`,
            `Service: ${LAUNCHD_LABEL} (launchd plist: ${p.launchdPlist})`,
            `Target: macOS launchd (gui/${UID_STRING})`,
            "Target ref: origin/master",
          ),
        bunBin: TEST_BUN_PATH,
      },
    )
  })

  describe("the inplace clone check (:468)", () => {
    // BOTH checks are broken here on purpose: the clone refusal is the one an
    // operator must see, because a host whose repo is not a clone has a
    // different problem than a host missing a unit.
    parity(
      "refuses a repo dir that is not a git clone, BEFORE the unit check",
      { ...base, repoIsClone: false, unitExists: false },
      {
        rc: 1,
        stdout: (p) => lines(head, `Repo: ${p.hostRepoDir}`, `Service: ${p.serviceFile}`, "Target: bare host"),
        stderr: (p) => lines(`error: ${p.hostRepoDir} is not a git clone`),
        incusCalls: 0,
        gitCalls: 0,
      },
    )

    // Exempt from NOTHING: --dry-run skips the unit check (:478) but never the
    // clone check, so a dry run against a non-clone still refuses.
    parity(
      "--dry-run does NOT exempt the clone check",
      { ...base, repoIsClone: false, dryRun: true },
      {
        rc: 1,
        stdout: (p) => lines(head, `Repo: ${p.hostRepoDir}`, `Service: ${p.serviceFile}`, "Target: bare host"),
        stderr: (p) => lines(`error: ${p.hostRepoDir} is not a git clone`),
      },
    )
  })

  describe("the unit-existence preflight (:478-497)", () => {
    parity("refuses a missing system unit", { ...base, unitExists: false }, {
      rc: 1,
      stdout: (p) => lines(head, `Repo: ${p.hostRepoDir}`, `Service: ${p.serviceFile}`, "Target: bare host"),
      stderr: (p) =>
        lines(
          `error: system unit ${p.serviceFile} not found; run luna-server-install to create it, or pass --supervisor launchd / --user for non-system-unit hosts`,
        ),
    })

    parity("refuses a missing systemd USER unit", { ...base, systemdUser: true, userUnitExists: false }, {
      rc: 1,
      stdout: (p) =>
        lines(head, `Repo: ${p.hostRepoDir}`, `Service: ${p.serviceFile} (systemd --user)`, "Target: bare host (user scope)"),
      stderr: (p) =>
        lines(
          `error: systemd user unit ${p.userUnitFile} not found; copy or symlink your unit there (e.g. cp my.service ${p.userUnitFile}) then run systemctl --user daemon-reload`,
        ),
    })

    // The --user arm probes USER_UNIT_FILE, not SERVICE_FILE: SERVICE_DIR is
    // rewritten to the XDG dir at :294-296 only when the operator did not pass
    // --service-dir, so the two can name different files and the check must
    // follow the user one.
    parity(
      "the --user arm probes USER_UNIT_FILE, not SERVICE_FILE",
      { ...base, systemdUser: true, userUnitExists: false, unitExists: true },
      {
        rc: 1,
        stdout: (p) =>
          lines(head, `Repo: ${p.hostRepoDir}`, `Service: ${p.serviceFile} (systemd --user)`, "Target: bare host (user scope)"),
        stderr: (p) => lines(`error: systemd user unit ${p.userUnitFile} not found; copy or symlink your unit there (e.g. cp my.service ${p.userUnitFile}) then run systemctl --user daemon-reload`),
      },
    )

    parity("refuses a missing launchd plist", { ...base, supervisor: "launchd", plistExists: false }, {
      rc: 1,
      stdout: (p) =>
        lines(
          head,
          `Repo: ${p.hostRepoDir}`,
          `Service: ${LAUNCHD_LABEL} (launchd plist: ${p.launchdPlist})`,
          `Target: macOS launchd (gui/${UID_STRING})`,
        ),
      stderr: (p) =>
        lines(
          `error: launchd plist ${p.launchdPlist} not found; create it (e.g. via render_launchd_plist) before running luna-update-server`,
        ),
    })

    // The unit is a CONTAINER-FS artifact, so the probe must go through incus:
    // the host-side file EXISTS in this scenario and the run must still refuse.
    parity(
      "refuses a unit missing INSIDE the container even though the host file exists",
      { ...base, incusContainer: INCUS_CONTAINER, incusRc: 1, unitExists: true },
      {
        rc: 1,
        stdout: (p) =>
          lines(
            head,
            `Repo (host git mount): ${p.hostRepoDir}`,
            `Repo (in-container):   ${CONTAINER_REPO_DIR}`,
            `Service: ${p.serviceFile} (in container)`,
            `Target: incus container ${INCUS_CONTAINER}`,
          ),
        stderr: (p) =>
          lines(
            `error: system unit ${p.serviceFile} not found in container ${INCUS_CONTAINER}; run luna-server-install inside the container first`,
          ),
        incusCalls: 1,
      },
    )

    // Arm PRECEDENCE (:479-492): launchd is tested before incus, so an
    // incus-bannered run on a launchd host refuses about the PLIST and never
    // shells out to incus at all.
    parity(
      "launchd outranks incus in the unit check, even when the banner said incus",
      { ...base, incusContainer: INCUS_CONTAINER, supervisor: "launchd", plistExists: false },
      {
        rc: 1,
        stdout: (p) =>
          lines(
            head,
            `Repo (host git mount): ${p.hostRepoDir}`,
            `Repo (in-container):   ${CONTAINER_REPO_DIR}`,
            `Service: ${p.serviceFile} (in container)`,
            `Target: incus container ${INCUS_CONTAINER}`,
          ),
        stderr: (p) =>
          lines(
            `error: launchd plist ${p.launchdPlist} not found; create it (e.g. via render_launchd_plist) before running luna-update-server`,
          ),
        incusCalls: 0,
      },
    )

    // ... and incus outranks --user (:482-488).
    parity(
      "incus outranks --user in the unit check",
      { ...base, incusContainer: INCUS_CONTAINER, systemdUser: true, incusRc: 1, userUnitExists: false },
      {
        rc: 1,
        stdout: (p) =>
          lines(
            head,
            `Repo (host git mount): ${p.hostRepoDir}`,
            `Repo (in-container):   ${CONTAINER_REPO_DIR}`,
            `Service: ${p.serviceFile} (in container)`,
            `Target: incus container ${INCUS_CONTAINER}`,
          ),
        stderr: (p) =>
          lines(
            `error: system unit ${p.serviceFile} not found in container ${INCUS_CONTAINER}; run luna-server-install inside the container first`,
          ),
        incusCalls: 1,
      },
    )
  })

  describe("the two exemptions (:478)", () => {
    // A dry run prints the plan and touches nothing, so a missing unit must not
    // block the inspection - and it must not shell out to incus either.
    parity(
      "--dry-run skips the unit check entirely",
      { ...base, incusContainer: INCUS_CONTAINER, incusRc: 1, unitExists: false, dryRun: true },
      {
        rc: 0,
        stdout: (p) =>
          lines(
            head,
            `Repo (host git mount): ${p.hostRepoDir}`,
            `Repo (in-container):   ${CONTAINER_REPO_DIR}`,
            `Service: ${p.serviceFile} (in container)`,
            `Target: incus container ${INCUS_CONTAINER}`,
            "Target ref: origin/master",
          ),
        bunBin: BUN_BIN_INCUS,
        incusCalls: 0,
      },
    )

    parity("--materialize skips the unit check entirely", { ...base, unitExists: false, materializeOnly: true }, {
      rc: 0,
      stdout: (p) =>
        lines(head, `Repo: ${p.hostRepoDir}`, `Service: ${p.serviceFile}`, "Target: bare host", "Target ref: origin/master"),
      bunBin: TEST_BUN_PATH,
    })
  })

  describe("default-ref resolution (:510-521)", () => {
    parity("an explicit --ref passes through verbatim", { ...base, ref: "origin/next/s22d" }, {
      rc: 0,
      stdout: (p) =>
        lines(head, `Repo: ${p.hostRepoDir}`, `Service: ${p.serviceFile}`, "Target: bare host", "Target ref: origin/next/s22d"),
      ref: "origin/next/s22d",
      gitCalls: 0,
    })

    // The two spellings the S22d spec calls out as the ones where REF and the
    // post-apply HEAD separate: neither may be normalised here.
    parity("an ABBREVIATED sha --ref is not normalised", { ...base, ref: "a1b2c3d" }, {
      rc: 0,
      stdout: (p) =>
        lines(head, `Repo: ${p.hostRepoDir}`, `Service: ${p.serviceFile}`, "Target: bare host", "Target ref: a1b2c3d"),
      ref: "a1b2c3d",
    })

    parity("an UPPERCASE 40-hex --ref is not case-folded", { ...base, ref: "A".repeat(40) }, {
      rc: 0,
      stdout: (p) =>
        lines(
          head,
          `Repo: ${p.hostRepoDir}`,
          `Service: ${p.serviceFile}`,
          "Target: bare host",
          `Target ref: ${"A".repeat(40)}`,
        ),
      ref: "A".repeat(40),
    })

    parity("no --ref resolves to origin/<current branch>", { ...base, ref: "", gitBranch: "next/s22d" }, {
      rc: 0,
      stdout: (p) =>
        lines(head, `Repo: ${p.hostRepoDir}`, `Service: ${p.serviceFile}`, "Target: bare host", "Target ref: origin/next/s22d"),
      ref: "origin/next/s22d",
      gitCalls: 1,
    })

    // A detached checkout answers the literal string HEAD, which must NOT
    // become the ref `origin/HEAD`.
    parity("a DETACHED checkout falls back to origin/master", { ...base, ref: "", gitBranch: "HEAD" }, {
      rc: 0,
      stdout: (p) =>
        lines(head, `Repo: ${p.hostRepoDir}`, `Service: ${p.serviceFile}`, "Target: bare host", "Target ref: origin/master"),
      ref: "origin/master",
      gitCalls: 1,
    })

    // `2>/dev/null || true` makes a git failure indistinguishable from an empty
    // answer, and both fall back.
    parity("a FAILING git falls back to origin/master", { ...base, ref: "", gitRc: 128, gitBranch: "unused" }, {
      rc: 0,
      stdout: (p) =>
        lines(head, `Repo: ${p.hostRepoDir}`, `Service: ${p.serviceFile}`, "Target: bare host", "Target ref: origin/master"),
      ref: "origin/master",
      gitCalls: 1,
    })

    // The ref is resolved HOST-side in both topologies (:501-502): incus mode
    // still reads HOST_REPO_DIR's HEAD, never the container's.
    parity("incus mode resolves the default ref host-side", { ...base, incusContainer: INCUS_CONTAINER, ref: "", gitBranch: "master" }, {
      rc: 0,
      stdout: (p) =>
        lines(
          head,
          `Repo (host git mount): ${p.hostRepoDir}`,
          `Repo (in-container):   ${CONTAINER_REPO_DIR}`,
          `Service: ${p.serviceFile} (in container)`,
          `Target: incus container ${INCUS_CONTAINER}`,
          "Target ref: origin/master",
        ),
      ref: "origin/master",
      gitCalls: 1,
    })
  })

  describe("profile is interpolated, not assumed", () => {
    parity("a non-default profile reaches the banner", { ...base, profile: "stable" }, {
      rc: 0,
      stdout: (p) =>
        lines(
          "-> Updating Luna server profile: stable",
          `Repo: ${p.hostRepoDir}`,
          `Service: ${p.serviceFile}`,
          "Target: bare host",
          "Target ref: origin/master",
        ),
    })
  })
})

/**
 * The parity suite above drives everything through `runPreflightSync` with
 * EVERY seam overridden (see `runTs`'s `opts` literal), which is exactly
 * right for proving the PORT matches bash - but it means the module's own
 * unexported real-world defaults (`realGitCurrentBranch`,
 * `realContainerFileExists`) and the `:512` `dirExists` guard in front of
 * them never run under any test. These describes close that gap by calling
 * the exported functions with seams DELIBERATELY left unset, so the real
 * default implementations execute for real.
 */
describe("preflight: the real default seams and the guard in front of them", () => {
  describe("resolveDefaultRefSync's :512 guard", () => {
    // Reached only when a caller invokes resolveDefaultRefSync directly with
    // a repo dir that fails the `[[ -d "$HOST_REPO_DIR/.git" ]]` test -
    // impossible to observe through runPreflightSync, since its own clone
    // check (:468) already refuses before resolveDefaultRefSync is called.
    it("never calls gitCurrentBranch when the host repo has no .git dir", () => {
      const gitCalls: string[] = []
      const ref = resolveDefaultRefSync({
        ref: "",
        hostRepoDir: "/nonexistent-host-repo-dir-for-preflight-guard-test",
        dirExists: () => false,
        gitCurrentBranch: (dir) => {
          gitCalls.push(dir)
          return "should-never-be-read"
        },
      })
      expect(ref).toBe("origin/master")
      expect(gitCalls, "the :512 guard must skip the git read entirely when .git is absent").toStrictEqual([])
    })
  })

  describe("the default git seam (realGitCurrentBranch)", () => {
    // The literal bash oracle for :513-518, run through REAL bash and REAL
    // git rather than transcribed, so this stays a parity assertion and not
    // a restatement of the port's own logic.
    const bashOracle = (hostRepoDir: string): string => {
      const r = spawnSync(
        "bash",
        [
          "-c",
          'CUR="$(git -C "$1" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"; if [[ -n "$CUR" && "$CUR" != "HEAD" ]]; then printf "origin/%s" "$CUR"; else printf "origin/master"; fi',
          "--",
          hostRepoDir,
        ],
        { encoding: "utf8" },
      )
      return r.stdout
    }

    const commit = (dir: string): void => {
      spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: dir })
      spawnSync("git", ["config", "user.name", "test"], { cwd: dir })
      writeFileSync(join(dir, "f"), "x")
      spawnSync("git", ["add", "f"], { cwd: dir })
      spawnSync("git", ["commit", "-q", "-m", "x"], { cwd: dir })
    }

    it("a real checked-out branch matches the bash oracle", () => {
      const dir = makeTempDir("deploy-cli-preflight-git-oracle-branch-")
      spawnSync("git", ["init", "-q"], { cwd: dir })
      commit(dir)
      spawnSync("git", ["checkout", "-q", "-b", "feat-oracle-branch"], { cwd: dir })
      // No gitCurrentBranch override: this is the real default seam.
      const ref = resolveDefaultRefSync({ ref: "", hostRepoDir: dir })
      expect(ref).toBe(bashOracle(dir))
      expect(ref).toBe("origin/feat-oracle-branch")
    })

    it("a detached HEAD matches the bash oracle (falls back to origin/master)", () => {
      const dir = makeTempDir("deploy-cli-preflight-git-oracle-detached-")
      spawnSync("git", ["init", "-q"], { cwd: dir })
      commit(dir)
      const sha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim()
      spawnSync("git", ["checkout", "-q", sha], { cwd: dir })
      const ref = resolveDefaultRefSync({ ref: "", hostRepoDir: dir })
      expect(ref).toBe(bashOracle(dir))
      expect(ref).toBe("origin/master")
    })

    // An unborn branch (no commits yet): `git rev-parse --abbrev-ref HEAD`
    // exits 128 but STILL prints "HEAD\n" to stdout, so this is the one real
    // scenario that discriminates the dropped `r.status !== 0` guard AND the
    // dropped stripTrailingNewlines call at once - without either, the raw
    // "HEAD\n" survives comparison against the literal string "HEAD" and the
    // ref comes out as "origin/HEAD\n" instead of falling back.
    it("an unborn branch matches the bash oracle without an embedded newline", () => {
      const dir = makeTempDir("deploy-cli-preflight-git-oracle-unborn-")
      spawnSync("git", ["init", "-q"], { cwd: dir })
      const ref = resolveDefaultRefSync({ ref: "", hostRepoDir: dir })
      expect(ref).toBe(bashOracle(dir))
      expect(ref).toBe("origin/master")
    })
  })

  describe("the default incus seam (realContainerFileExists)", () => {
    // A stub `incus` on PATH standing in for the real binary: it answers
    // `exec <container> -- test -f <path>` (argv positions 1/2/4/6) by really
    // testing the path, so this proves the port maps exit-0 to `true` and a
    // nonzero exit to `false` - not one hardcoded polarity that happens to
    // pass under a mocked seam, which is what let the inverted mutant escape.
    const stubBinDir = makeTempDir("deploy-cli-preflight-incus-stub-")
    writeFileSync(
      join(stubBinDir, "incus"),
      "#!/bin/sh\n# emulate: incus exec <container> -- test -f <path>\nif [ -f \"$6\" ]; then exit 0; else exit 1; fi\n",
      { mode: 0o755 },
    )

    const withStubIncus = <T,>(fn: () => T): T => {
      const original = process.env.PATH ?? ""
      process.env.PATH = `${stubBinDir}:${original}`
      try {
        return fn()
      } finally {
        process.env.PATH = original
      }
    }

    it("maps a unit PRESENT in the container (exit 0) to true, no refusal", () => {
      const dir = makeTempDir("deploy-cli-preflight-incus-present-")
      const unit = join(dir, "unit.service")
      writeFileSync(unit, "[Unit]\n")
      const refusal = withStubIncus(() =>
        unitPreflightSync({
          dryRun: false,
          materializeOnly: false,
          supervisor: "systemd",
          incusContainer: "some-container",
          systemdUser: false,
          launchdPlist: "/unused",
          serviceFile: unit,
          userUnitFile: "/unused",
        }),
      )
      expect(refusal).toBeUndefined()
    })

    it("maps a unit MISSING in the container (nonzero exit) to false, a refusal", () => {
      const dir = makeTempDir("deploy-cli-preflight-incus-missing-")
      const unit = join(dir, "does-not-exist.service")
      const refusal = withStubIncus(() =>
        unitPreflightSync({
          dryRun: false,
          materializeOnly: false,
          supervisor: "systemd",
          incusContainer: "some-container",
          systemdUser: false,
          launchdPlist: "/unused",
          serviceFile: unit,
          userUnitFile: "/unused",
        }),
      )
      expect(refusal?.check).toBe("unit")
      expect(refusal?.message).toBe(unitRefusalMessages.incus(unit, "some-container"))
    })

    // The two tests above both hardcode "some-container" as the argument AND
    // as the only container name the stub ever sees, so a default that
    // silently substituted some OTHER fixed container name for whatever the
    // caller passed would still pass them both - the container argument
    // itself is never actually exercised. This test uses a SEPARATE stub
    // that only answers about the file when it is invoked for the exact
    // container the test asked about, so a default that forwards a
    // hardcoded stand-in container instead of the caller's own argument
    // gets refused even though the real unit file genuinely exists.
    it("forwards the CALLER's own container argument to incus, not a hardcoded stand-in", () => {
      const expectedContainer = "expected-container-xyz"
      const altBinDir = makeTempDir("deploy-cli-preflight-incus-argcheck-bin-")
      writeFileSync(
        join(altBinDir, "incus"),
        // $2 is the container position in `incus exec <container> -- test -f <path>`.
        `#!/bin/sh\nif [ "$2" != "${expectedContainer}" ]; then exit 1; fi\nif [ -f "$6" ]; then exit 0; else exit 1; fi\n`,
        { mode: 0o755 },
      )
      const dir = makeTempDir("deploy-cli-preflight-incus-argcheck-unit-")
      const unit = join(dir, "unit.service")
      writeFileSync(unit, "[Unit]\n")
      const original = process.env.PATH ?? ""
      process.env.PATH = `${altBinDir}:${original}`
      try {
        const refusal = unitPreflightSync({
          dryRun: false,
          materializeOnly: false,
          supervisor: "systemd",
          incusContainer: expectedContainer,
          systemdUser: false,
          launchdPlist: "/unused",
          serviceFile: unit,
          userUnitFile: "/unused",
        })
        expect(refusal, "the real default must send the caller's own container, not a hardcoded one").toBeUndefined()
      } finally {
        process.env.PATH = original
      }
    })

    // bash's own `incus exec` answers with SOME exit code for every failure
    // mode - missing binary, daemon down, unknown container, a transient
    // 125-class incus error - and only exit 0 means "unit present". A status
    // mapping spelled as "anything but the known-absent code counts as
    // present" fails OPEN on every one of those, which is the worst
    // direction for a check that runs before the update lock is taken. incus
    // being entirely absent from PATH (verified above: `which incus` finds
    // nothing on this host) is the simplest REAL way to produce a status this
    // suite's other two incus scenarios (0 and 1) never do: spawnSync's ENOENT
    // leaves `status` at `null`.
    it("fails CLOSED (refuses) when incus itself cannot even be spawned, never fail-open", () => {
      const dir = makeTempDir("deploy-cli-preflight-incus-enoent-")
      const unit = join(dir, "unit.service")
      writeFileSync(unit, "[Unit]\n") // the file genuinely exists; only the "incus" spawn fails
      const emptyBinDir = makeTempDir("deploy-cli-preflight-incus-enoent-bin-")
      const original = process.env.PATH ?? ""
      process.env.PATH = emptyBinDir
      try {
        const refusal = unitPreflightSync({
          dryRun: false,
          materializeOnly: false,
          supervisor: "systemd",
          incusContainer: "some-container",
          systemdUser: false,
          launchdPlist: "/unused",
          serviceFile: unit,
          userUnitFile: "/unused",
        })
        expect(refusal?.check).toBe("unit")
      } finally {
        process.env.PATH = original
      }
    })
  })

  describe("the default git-failure guard on realGitCurrentBranch", () => {
    // Every REAL git failure this repo can produce prints either "" or the
    // literal "HEAD" on stdout (proven above against the unborn-branch case
    // and against a repo whose current branch's ref was deliberately
    // corrupted: `git rev-parse --abbrev-ref HEAD` still answers "HEAD" with
    // exit 128), and resolveDefaultRefSync already treats both the same as a
    // detached checkout - so no REAL git invocation can discriminate the
    // `if (r.status !== 0) return ""` guard from its removal. A binary put on
    // PATH ahead of the real `git` can, though, and that is exactly what a
    // wrapped or shimmed `git` (a corporate git-proxy, a pre-commit shim, a
    // broken PATH ordering) could do in production: exit non-zero while still
    // printing something on stdout. The guard's whole job is to make sure
    // THAT stdout is never trusted, which only shows up once something
    // actually prints on a failing exit.
    const stubBinDir = makeTempDir("deploy-cli-preflight-git-stub-")
    writeFileSync(
      join(stubBinDir, "git"),
      "#!/bin/sh\nprintf 'custom-branch\\n'\nexit 1\n",
      { mode: 0o755 },
    )

    it("does not trust stdout from a git invocation that exits non-zero", () => {
      const dir = makeTempDir("deploy-cli-preflight-git-guard-")
      mkdirSync(join(dir, ".git"), { recursive: true })
      const original = process.env.PATH ?? ""
      process.env.PATH = `${stubBinDir}:${original}`
      try {
        // No gitCurrentBranch override: this drives the real default seam
        // through a real spawnSync("git", ...) call.
        const ref = resolveDefaultRefSync({ ref: "", hostRepoDir: dir })
        expect(ref).toBe("origin/master")
      } finally {
        process.env.PATH = original
      }
    })
  })

  describe("the default fileExists seam (realFileExists)", () => {
    // bash's `[[ -f "$SERVICE_FILE" ]]` is false for a directory; a port that
    // accepted any existing filesystem node would pass the unit-existence
    // preflight on a host where something else (a stray mkdir, a bind mount)
    // put a directory at the unit path, and hand back a silent half-deploy.
    it("does not treat a DIRECTORY at the unit path as an existing unit file", () => {
      const dir = makeTempDir("deploy-cli-preflight-fileexists-dir-")
      const unitPath = join(dir, "looks-like-a-unit.service")
      mkdirSync(unitPath)
      // fileExists DELIBERATELY left unset: this drives the real
      // statSync-based default, not an injected seam.
      const refusal = unitPreflightSync({
        dryRun: false,
        materializeOnly: false,
        supervisor: "systemd",
        incusContainer: "",
        systemdUser: false,
        launchdPlist: "/unused",
        serviceFile: unitPath,
        userUnitFile: "/unused",
      })
      expect(refusal?.check).toBe("unit")
      expect(refusal?.message).toBe(unitRefusalMessages.system(unitPath))
    })

    // bash's `[[ -f ]]` FOLLOWS symlinks, and a symlinked unit is not
    // hypothetical here: `systemctl enable` and this module's own advertised
    // "cp or symlink your unit" wording (see unitRefusalMessages.systemdUser
    // above) both produce one. A default that switched to lstat semantics
    // would refuse a perfectly real, symlinked unit with an operator-hostile
    // "not found" message.
    it("follows a SYMLINK to a real unit file, matching bash's [[ -f ]]", () => {
      const dir = makeTempDir("deploy-cli-preflight-fileexists-symlink-")
      const realUnit = join(dir, "real.service")
      writeFileSync(realUnit, "[Unit]\n")
      const linkedUnit = join(dir, "linked.service")
      symlinkSync(realUnit, linkedUnit)
      // fileExists DELIBERATELY left unset: this drives the real
      // statSync-based default, not an injected seam.
      const refusal = unitPreflightSync({
        dryRun: false,
        materializeOnly: false,
        supervisor: "systemd",
        incusContainer: "",
        systemdUser: false,
        launchdPlist: "/unused",
        serviceFile: linkedUnit,
        userUnitFile: "/unused",
      })
      expect(refusal).toBeUndefined()
    })
  })

  describe("the default dirExists seam (realDirExists)", () => {
    // NOT hypothetical: a git worktree's `.git` is a regular FILE (a gitdir
    // pointer), never a directory - and this very worktree is one. bash's
    // `[[ -d ]]` is false there and refuses "is not a git clone"; a port that
    // accepted any existing node at that path would proceed to mutate a
    // worktree checkout that isn't a git dir by that name at all.
    it("refuses a repo whose .git is a FILE, not a directory (a real git worktree shape)", () => {
      const dir = makeTempDir("deploy-cli-preflight-direxists-worktree-")
      writeFileSync(join(dir, ".git"), "gitdir: /some/real/worktrees/foo\n")
      // dirExists DELIBERATELY left unset: this drives the real
      // statSync-based default, not an injected seam.
      const outcome = runPreflightSync({
        profile: "dev",
        incusContainer: "",
        supervisor: "systemd",
        systemdUser: false,
        hostRepoDir: dir,
        containerRepoDir: dir,
        serviceFile: "/unused",
        userUnitFile: "/unused",
        launchdLabel: "unused",
        launchdPlist: "/unused",
        uid: "0",
        dryRun: false,
        materializeOnly: false,
        ref: "",
        bunBinIncus: "/unused",
        print: () => undefined,
        findBun: () => "/unused",
      })
      expect(outcome.ok).toBe(false)
      if (outcome.ok) throw new Error("expected a refusal")
      expect(outcome.check).toBe("git-clone")
      expect(outcome.message).toBe(notAGitCloneMessage(dir))
    })

    // The other side of the same coin: bash's `[[ -d ]]` FOLLOWS symlinks, so
    // a `.git` that is a symlink to a real directory (not the gitdir-pointer
    // FILE shape above) must still pass. A default that switched to lstat
    // semantics would refuse a perfectly real clone whose `.git` happens to
    // be a symlink.
    it("follows a SYMLINK-to-directory .git, matching bash's [[ -d ]]", () => {
      const dir = makeTempDir("deploy-cli-preflight-direxists-symlink-")
      const realGitDir = join(dir, "real-git-dir")
      mkdirSync(realGitDir, { recursive: true })
      symlinkSync(realGitDir, join(dir, ".git"))
      // dirExists DELIBERATELY left unset: this drives the real
      // statSync-based default, not an injected seam.
      const outcome = runPreflightSync({
        profile: "dev",
        incusContainer: "",
        supervisor: "systemd",
        systemdUser: false,
        hostRepoDir: dir,
        containerRepoDir: dir,
        serviceFile: "/unused",
        userUnitFile: "/unused",
        launchdLabel: "unused",
        launchdPlist: "/unused",
        uid: "0",
        dryRun: true,
        materializeOnly: false,
        ref: "irrelevant",
        bunBinIncus: "/unused",
        print: () => undefined,
        findBun: () => "/unused",
      })
      expect(outcome.ok, "a symlinked .git dir must not read as 'not a git clone'").toBe(true)
    })
  })
})
