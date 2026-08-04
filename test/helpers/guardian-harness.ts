/**
 * Shared guardian test harness — a PURE MOVE of the private helpers that
 * lived at the top of test/guardian.test.ts (phase 5, W1), so that other
 * suites (releases-layout, deploy-scripts, update-server) can build hermetic
 * fixtures from the same audited pieces instead of growing divergent copies.
 *
 * Three deliberate additions beyond the move:
 *   - writeSystemctlStub answers `is-active` with
 *     "${LUNA_TEST_SYSTEMCTL_IS_ACTIVE:-active}" (the old stub fell through
 *     to exit-0-no-output, which luna_runtime_unit_state_class reads as
 *     INCONCLUSIVE — unusable for driving the REAL wait_runtime_healthy loop).
 *     The variable lives only inside this test-owned stub, never in
 *     production scripts.
 *   - makeConvergedHarness accepts { layout: "releases" } to build a
 *     temp-local deploy root (mirror.git + releases/<sha> + current symlink)
 *     whose registry declares deploy.layout = "releases", closing the same
 *     refresh gate the inplace variant closes.
 *   - processFingerprint / makeRestrictedBin / releaseManifest: hermeticity
 *     utilities (fingerprints matching the scripts' /proc-first protocol, a
 *     PATH containing exactly the named tools, and the recursive release
 *     manifest moved from test/releases-layout.test.ts).
 *
 * Helpers cannot auto-register vitest hooks: each suite must wire
 * `afterEach(cleanupTracked)` itself.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { expect } from "vitest"

const root = new URL("../..", import.meta.url).pathname

const dirs: string[] = []

/** Register a temp dir for removal by cleanupTracked(). Returns the path. */
export const trackDir = (path: string) => {
  dirs.push(path)
  return path
}

/** Remove every tracked dir. Suites wire this as their afterEach themselves. */
export const cleanupTracked = () => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}

export const writeSystemctlStub = (bin: string) => {
  const path = join(bin, "systemctl")
  writeFileSync(path, `#!/usr/bin/env bash
set -u
state="$LUNA_TEST_SYSTEMCTL_STATE"
units="$LUNA_TEST_SYSTEMD_DIR"
mkdir -p "$state"
cmd="\${1:-}"; shift || true
# Convergence-test recorder: every systemctl invocation, one line each, so a
# test can assert a converged tick performed ZERO reload/enable/disable/start/
# stop calls (show reads are allowed and recorded too).
printf '%s %s\\n' "$cmd" "$*" >> "$state/invocations.log"
prop_value() {
  unit="$1"; prop="$2"
  case "$unit:$prop" in
    luna-guardian-*.timer:LoadState) [[ -f "$units/$unit" ]] && echo loaded || echo not-found ;;
    luna-guardian-*.timer:UnitFileState) [[ -f "$state/guardian-enabled" ]] && echo enabled || echo disabled ;;
    luna-guardian-*.timer:ActiveState) [[ -f "$state/guardian-active" ]] && echo active || echo inactive ;;
    luna-autodeploy-*.timer:LoadState) [[ -f "$units/$unit" ]] && echo loaded || echo not-found ;;
    luna-autodeploy-*.timer:UnitFileState) [[ -f "$units/$unit" ]] && echo enabled || echo disabled ;;
    luna-autodeploy-*.timer:ActiveState) [[ -f "$units/$unit" ]] && echo active || echo inactive ;;
    luna-guardian-*.service:Result) echo success ;;
    luna-guardian-*.service:ExecStart)
      profile="\${unit#luna-guardian-}"; profile="\${profile%.service}"
      echo "{ path=$LUNA_GUARDIAN_PIN_BASE/current-$profile/luna-guardian ; argv[]=$LUNA_GUARDIAN_PIN_BASE/current-$profile/luna-guardian check $profile ; }"
      ;;
    *:NeedDaemonReload) [[ -f "$state/needs-reload" ]] && echo yes || echo no ;;
    *) echo "" ;;
  esac
}
case "$cmd" in
  daemon-reload) rm -f "$state/needs-reload"; exit 0 ;;
  enable)
    unit="\${@: -1}"
    [[ "$unit" == luna-guardian-*.timer ]] && touch "$state/guardian-enabled" "$state/guardian-active"
    exit 0
    ;;
  disable)
    unit="\${@: -1}"
    if [[ "$unit" == luna-autodeploy-*.timer && "\${LUNA_TEST_LEGACY_DISABLE_FAIL:-false}" == true ]]; then exit 1; fi
    [[ "$unit" == luna-guardian-*.timer ]] && rm -f "$state/guardian-enabled" "$state/guardian-active"
    exit 0
    ;;
  show)
    unit="$1"; shift; prop=""
    while [[ $# -gt 0 ]]; do case "$1" in -p) prop="$2"; shift 2 ;; *) shift ;; esac; done
    prop_value "$unit" "$prop"
    ;;
  is-active) printf '%s\\n' "\${LUNA_TEST_SYSTEMCTL_IS_ACTIVE:-active}"; exit 0 ;;
  start)
    unit="$1"
    if [[ "$unit" == luna-guardian-*.service && -n "\${LUNA_TEST_ACCEPT_SHA:-}" ]]; then
      profile="\${unit#luna-guardian-}"; profile="\${profile%.service}"
      status="$LUNA_GUARDIAN_STATE_DIR/status-$profile"
      count_file="$state/cycles-$profile"
      count="$(cat "$count_file" 2>/dev/null || echo 0)"; count=$((count + 1)); echo "$count" > "$count_file"
      mkdir -p "$LUNA_GUARDIAN_STATE_DIR"
      printf 'profile=%s\ncompleted_at=%s\nrepo_sha=%s\nengine_sha=%s\noutcome=healthy\nconsecutive_healthy=%s\n' \\
        "$profile" "$(date +%s)" "$LUNA_TEST_ACCEPT_SHA" "$LUNA_TEST_ACCEPT_SHA" "$count" > "$status"
    fi
    exit 0
    ;;
  list-unit-files)
    unit="$1"; [[ -f "$units/$unit" ]] && printf '%s enabled\\n' "$unit"
    ;;
  *) exit 0 ;;
esac
`)
  spawnSync("chmod", ["+x", path])
}

export const writeStub = (path: string, body: string) => {
  writeFileSync(path, body)
  spawnSync("chmod", ["+x", path])
}

// LUNA_TEST_FLIP_LIE_GLOB stubs perl's rename(2) the way LUNA_TEST_MV_LIE_GLOB
// stubs mv: exit 0 WITHOUT renaming when the invocation is luna_atomic_replace's
// `perl -e 'rename(...) ...'` and the LAST argument (the destination) matches
// the glob - the shape of the original engine-pin disaster, now aimed at the
// syscall the flip actually goes through, since luna_atomic_replace never
// shells out to mv. Passthrough resolves perl by NAME, never a baked absolute
// path: it strips its own directory from PATH (self-recursion guard) and lets
// the remaining PATH resolve `perl`, so a restricted PATH lacking perl fails
// rc=127 for real instead of the stub silently smuggling in a host perl the
// allowlist never granted.
export const writePerlStub = (bin: string) => {
  // Host precondition only - the stub itself resolves perl via PATH at runtime.
  if (!spawnSync("bash", ["-c", "command -v perl"], { encoding: "utf8" }).stdout.trim())
    throw new Error("writePerlStub: perl not found on host")
  writeStub(join(bin, "perl"), `#!/usr/bin/env bash
if [[ -n "\${LUNA_TEST_FLIP_LIE_GLOB:-}" && "$*" == *'rename('* ]]; then
  last="\${@: -1}"
  case "$last" in
    \${LUNA_TEST_FLIP_LIE_GLOB}) exit 0 ;;
  esac
fi
case "$0" in
  */*) self="\${0%/*}" ;;
  *) self="" ;;
esac
# $0 with no slash leaves self empty, so the strip below would remove
# nothing and exec could re-enter this same stub forever. Depth marker
# survives exec (env is preserved) but never a fresh fork, so it only
# trips on that self-exec loop, not on separate sequential invocations.
if [[ -n "\${_LUNA_PERL_STUB_GUARD:-}" ]]; then
  printf 'perl stub: PATH self-strip found no slash in \$0, refusing to re-exec\\n' >&2
  exit 127
fi
export _LUNA_PERL_STUB_GUARD=1
newpath=""
oldifs="$IFS"
IFS=':'
set -f
for entry in $PATH; do
  [[ "$entry" == "$self" ]] && continue
  newpath="\${newpath:+$newpath:}$entry"
done
set +f
IFS="$oldifs"
PATH="$newpath"
exec perl "$@"
`)
}

export const headSha = () =>
  spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim()

// A hermetic guardian: the engine is a *copy* of scripts/ whose luna-autodeploy
// is a recording stub, and the registry declares no incus container so
// diagnose() can never reach the live luna-stable container. This is the only
// way to exercise check_profile's destructive `--force` branch without invoking
// the real updater against the production deploy.
export type Harness = {
  temp: string
  guardian: string
  state: string
  calls: string
  env: NodeJS.ProcessEnv
}

export const makeHarness = (label: string): Harness => {
  const temp = mkdtempSync(join(tmpdir(), label))
  trackDir(temp)
  const bin = join(temp, "bin")
  const units = join(temp, "systemd")
  const scripts = join(temp, "scripts")
  const state = join(temp, "state")
  const calls = join(temp, "autodeploy-calls")
  const registry = join(temp, "servers.toml")
  mkdirSync(bin, { recursive: true })
  mkdirSync(units, { recursive: true })
  writeSystemctlStub(bin)
  writeStub(join(bin, "journalctl"), "#!/usr/bin/env bash\nexit 0\n")
  writeStub(join(bin, "curl"), "#!/usr/bin/env bash\nexit 7\n")
  // Inert unless LUNA_TEST_MV_FAIL_GLOB is set: lets a test make exactly the
  // health-journal rename fail, the way ENOSPC or an errors=remount-ro /var
  // does, without disturbing any other atomic rename in the tick.
  // LUNA_TEST_MV_LIE_GLOB is the nastier cousin: exit 0 WITHOUT executing -
  // the shape of the original engine-pin disaster, where mv "succeeded" and
  // did nothing. Covers the mv calls that remain (unit-file writes,
  // engine-pin staging); the pin-flip itself goes through luna_atomic_replace
  // (perl rename, never mv) - see writePerlStub / LUNA_TEST_FLIP_LIE_GLOB.
  writeStub(join(bin, "mv"), `#!/usr/bin/env bash
if [[ -n "\${LUNA_TEST_MV_FAIL_GLOB:-}" ]]; then
  for a in "$@"; do
    case "$a" in
      \${LUNA_TEST_MV_FAIL_GLOB}) printf 'mv: simulated failure: %s\\n' "$a" >&2; exit 1 ;;
    esac
  done
fi
if [[ -n "\${LUNA_TEST_MV_LIE_GLOB:-}" ]]; then
  for a in "$@"; do
    case "$a" in
      \${LUNA_TEST_MV_LIE_GLOB}) exit 0 ;;
    esac
  done
fi
exec /bin/mv "$@"
`)
  writePerlStub(bin)
  spawnSync("cp", ["-a", join(root, "scripts"), scripts])
  writeStub(
    join(scripts, "luna-autodeploy"),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "$LUNA_TEST_AUTODEPLOY_CALLS"\nexit 0\n`,
  )
  writeFileSync(
    registry,
    [
      `kind = "registry"`,
      `[[server]]`,
      `name = "stable"`,
      `update.params.hostRepoDir = "${root}"`,
      `update.params.ref = "origin/master"`,
      `ports.proxy = 4753`,
      `deploy.timer = true`,
    ].join("\n") + "\n",
  )
  return {
    temp,
    guardian: join(scripts, "luna-guardian"),
    state,
    calls,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      LUNA_SERVERS_CONFIG: registry,
      LUNA_TEST_STAT_MODE: "600",
      LUNA_HOME: join(temp, "luna-home"),
      LUNA_GUARDIAN_PIN_BASE: join(temp, "pins"),
      LUNA_GUARDIAN_STATE_DIR: state,
      LUNA_UPDATE_STATE_DIR: join(temp, "update"),
      LUNA_TEST_SYSTEMD_DIR: units,
      LUNA_TEST_SYSTEMCTL_STATE: join(temp, "systemctl-state"),
      LUNA_TEST_GUARDIAN_UNIT_HARDENED: "true",
      LUNA_TEST_AUTODEPLOY_CALLS: calls,
      LUNA_GUARDIAN_HEALTH_RETRY_DELAY: "0",
    },
  }
}

export const installHarness = (h: Harness) => {
  const install = spawnSync("bash", [h.guardian, "install", "stable"], {
    cwd: root,
    encoding: "utf8",
    env: { ...h.env, LUNA_TEST_RUNTIME_MATCHES_CHECKOUT: "true" },
  })
  expect(install.status, install.stdout + install.stderr).toBe(0)
  rmSync(h.calls, { force: true })
}

export const runCheck = (h: Harness, seam: string, extra: Record<string, string> = {}) =>
  spawnSync("bash", [h.guardian, "check", "stable"], {
    cwd: root,
    encoding: "utf8",
    env: { ...h.env, LUNA_TEST_RUNTIME_MATCHES_CHECKOUT: seam, ...extra },
  })

// ── phase 3: fully-converged harness ─────────────────────────────────────────
// makeHarness + three additions so a tick can be run exactly as production runs
// it and reach TOTAL convergence:
//   (a) the copied $temp tree is git-inited+committed, so the engine sha is a
//       real `git -C $temp rev-parse HEAD`;
//   (b) the registry's hostRepoDir is $temp itself, so P_REPO == the engine's
//       own repo and the pin engine@sha == P_REPO HEAD — closing the
//       refresh_guardian_if_needed gate;
//   (c) ticks are run FROM THE PIN ($pins/current-stable/luna-guardian),
//       modelling the production ExecStart; the pin contains the recording
//       stub luna-autodeploy copied from $temp/scripts.
//
// layout: "releases" (phase 5) builds the SAME convergence over a temp-local
// releases deploy root: hostRepoDir = <temp>/deploy/current, so the registry
// derives P_DEPLOY_ROOT = <temp>/deploy and forces P_REPO through the current
// symlink — `git -C deploy/current rev-parse HEAD` equals <temp> HEAD equals
// the pin's engine@<sha>, closing the refresh gate exactly as inplace does.
export const makeConvergedHarness = (
  label: string,
  opts: { layout?: "inplace" | "releases" } = {},
): Harness => {
  const h = makeHarness(label)
  spawnSync("git", ["-C", h.temp, "init", "-q"], { encoding: "utf8" })
  spawnSync("git", ["-C", h.temp, "-c", "user.email=t@t", "-c", "user.name=t",
    "commit", "-q", "--allow-empty", "-m", "engine"], { encoding: "utf8" })
  if (opts.layout === "releases") {
    const sha = spawnSync("git", ["-C", h.temp, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim()
    const deploy = join(h.temp, "deploy")
    const mirror = join(deploy, "mirror.git")
    const release = join(deploy, "releases", sha)
    mkdirSync(join(deploy, "releases"), { recursive: true })
    spawnSync("git", ["clone", "-q", "--bare", h.temp, mirror], { encoding: "utf8" })
    spawnSync("git", ["--git-dir", mirror, "config",
      "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"], { encoding: "utf8" })
    spawnSync("git", ["clone", "-q", "--no-checkout", "--local", mirror, release], { encoding: "utf8" })
    spawnSync("git", ["-C", release, "checkout", "-q", "--detach", sha], { encoding: "utf8" })
    writeFileSync(join(release, ".complete"), "")
    symlinkSync(`releases/${sha}`, join(deploy, "current"))
    writeFileSync(
      join(h.temp, "servers.toml"),
      [
        `kind = "registry"`,
        `[[server]]`,
        `name = "stable"`,
        `update.params.hostRepoDir = "${join(deploy, "current")}"`,
        `update.params.ref = "origin/master"`,
        `ports.proxy = 4753`,
        `deploy.timer = true`,
        `deploy.layout = "releases"`,
      ].join("\n") + "\n",
    )
  } else {
    writeFileSync(
      join(h.temp, "servers.toml"),
      [
        `kind = "registry"`,
        `[[server]]`,
        `name = "stable"`,
        `update.params.hostRepoDir = "${h.temp}"`,
        `update.params.ref = "origin/master"`,
        `ports.proxy = 4753`,
        `deploy.timer = true`,
      ].join("\n") + "\n",
    )
  }
  return h
}

export const pinnedGuardian = (h: Harness) =>
  join(h.env.LUNA_GUARDIAN_PIN_BASE as string, "current-stable", "luna-guardian")

// A tick exactly as production runs it: from the immutable pin, machine-driven.
export const runPinnedCheck = (h: Harness, extra: Record<string, string> = {}) =>
  spawnSync("bash", [pinnedGuardian(h), "check", "stable"], {
    cwd: root,
    encoding: "utf8",
    env: { ...h.env, LUNA_TEST_RUNTIME_MATCHES_CHECKOUT: "true", ...extra },
  })

export const invocationsLog = (h: Harness) =>
  join(h.env.LUNA_TEST_SYSTEMCTL_STATE as string, "invocations.log")

export const invocationLines = (h: Harness) =>
  (existsSync(invocationsLog(h)) ? readFileSync(invocationsLog(h), "utf8") : "")
    .split("\n")
    .filter(Boolean)

export const unitFiles = (h: Harness) =>
  ["luna-guardian-stable.service", "luna-guardian-alert-stable.service", "luna-guardian-stable.timer"]
    .map((name) => join(h.env.LUNA_TEST_SYSTEMD_DIR as string, name))

export const snapshotUnits = (h: Harness) =>
  unitFiles(h).map((path) => {
    const s = statSync(path)
    return { path, mtimeMs: s.mtimeMs, ino: s.ino, content: readFileSync(path, "utf8") }
  })

export const statusValue = (h: Harness, key: string) => {
  const file = join(h.state, "status-stable")
  const match = readFileSync(file, "utf8").match(new RegExp(`^${key}=(.*)$`, "m"))
  return match ? match[1] : ""
}

export const MUTATING_SYSTEMCTL = /^(daemon-reload|enable|disable|start|stop)\b/

export const forceCalls = (h: Harness) =>
  (existsSync(h.calls) ? readFileSync(h.calls, "utf8") : "")
    .split("\n")
    .filter((line) => line.includes("--force"))

export const repairCalls = (h: Harness) =>
  (existsSync(h.calls) ? readFileSync(h.calls, "utf8") : "")
    .split("\n")
    .filter((line) => line.includes("--repair"))

export const allCalls = (h: Harness) =>
  (existsSync(h.calls) ? readFileSync(h.calls, "utf8") : "").split("\n").filter(Boolean)

export const journalPath = (h: Harness) => join(h.state, "health-stable")

export const seedJournal = (h: Harness, fields: Record<string, string | number>) => {
  mkdirSync(h.state, { recursive: true })
  const record: Record<string, string | number> = {
    profile: "stable",
    updated_at: Math.floor(Date.now() / 1000),
    repo_sha: headSha(),
    consecutive_negative: 0,
    negative_at: 0,
    consecutive_unknown: 0,
    last_repair_at: 0,
    ...fields,
  }
  writeFileSync(
    journalPath(h),
    Object.entries(record).map(([key, value]) => `${key}=${value}`).join("\n") + "\n",
  )
}

export const journalValue = (h: Harness, key: string) => {
  const match = readFileSync(journalPath(h), "utf8").match(new RegExp(`^${key}=(.*)$`, "m"))
  return match ? match[1] : ""
}

export const incidentCount = (h: Harness) => {
  const dir = join(h.state, "incidents", "stable")
  return existsSync(dir) ? readdirSync(dir).length : 0
}

// ── phase 5 additions ────────────────────────────────────────────────────────

/**
 * The exact fingerprint the deploy scripts compute for a live pid — mirrors
 * guardian_process_fingerprint (scripts/luna-guardian) and process_fingerprint
 * (scripts/luna-update-server): prefer /proc/<pid>/stat starttime (field 20
 * after stripping pid + parenthesized comm), fall back to `ps -o lstart=`.
 * Tests that plant a lock owner MUST use this, or on Linux the script's
 * /proc-first read will mismatch a ps-format fingerprint and reap the lock as
 * stale — the exact host coupling behind two of the six formerly-failing tests.
 */
export const processFingerprint = (pid: number): string => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    const idx = stat.lastIndexOf(") ")
    if (idx !== -1) {
      const fields = stat.slice(idx + 2).trim().split(/\s+/)
      if (fields.length >= 20 && fields[19]) return fields[19]
    }
  } catch {
    // no /proc (macOS) — fall through to ps
  }
  return spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" })
    .stdout.replace(/\n/g, "")
}

/**
 * A bin directory containing symlinks to EXACTLY the named host binaries
 * (resolved via `command -v` at runtime). Setting PATH to only this dir proves
 * a script depends on nothing else — the "host binary missing" case becomes
 * constructible even on a host where the binary exists (e.g. incus on jax-box).
 */
export const makeRestrictedBin = (dir: string, tools: ReadonlyArray<string>) => {
  const bin = join(dir, "restricted-bin")
  mkdirSync(bin, { recursive: true })
  for (const tool of tools) {
    const real = spawnSync("bash", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim()
    if (!real) throw new Error(`makeRestrictedBin: required tool not found on host: ${tool}`)
    spawnSync("ln", ["-sf", real, join(bin, tool)])
  }
  return bin
}

/**
 * Recursive release manifest: nanosecond mtime + inode + size of EVERY file,
 * plus a content hash of every file. A single-file whole-second stat witness
 * is blind to in-run mutations (the happy path completes in ~330ms — any
 * write lands in the same epoch second) and to NEW files; this catches any
 * write anywhere in the tree, which is the actual "releases are immutable,
 * built once, never mutated" property.
 */
export const releaseManifest = (dir: string) =>
  spawnSync(
    "bash",
    ["-c", `cd "${dir}" && find . -type f -printf '%P %T@ %i %s\\n' | sort && find . -type f -print0 | sort -z | xargs -0 sha1sum`],
    { encoding: "utf8" },
  ).stdout
