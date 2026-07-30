import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { afterEach, describe, expect, it } from "vitest"

const root = new URL("..", import.meta.url).pathname
const guardian = join(root, "scripts/luna-guardian")
const fixture = join(root, "test/fixtures/servers.toml")
const dirs: string[] = []

const writeSystemctlStub = (bin: string) => {
  const path = join(bin, "systemctl")
  writeFileSync(path, `#!/usr/bin/env bash
set -u
state="$LUNA_TEST_SYSTEMCTL_STATE"
units="$LUNA_TEST_SYSTEMD_DIR"
mkdir -p "$state"
cmd="\${1:-}"; shift || true
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
    *) echo "" ;;
  esac
}
case "$cmd" in
  daemon-reload) exit 0 ;;
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
  start)
    unit="$1"
    if [[ "$unit" == luna-guardian-*.service && -n "\${LUNA_TEST_ACCEPT_SHA:-}" ]]; then
      profile="\${unit#luna-guardian-}"; profile="\${profile%.service}"
      status="$LUNA_GUARDIAN_STATE_DIR/status-$profile"
      count_file="$state/cycles-$profile"
      count="$(cat "$count_file" 2>/dev/null || echo 0)"; count=$((count + 1)); echo "$count" > "$count_file"
      mkdir -p "$LUNA_GUARDIAN_STATE_DIR"
      printf 'profile=%s\ncompleted_at=%s\nrepo_sha=%s\nengine_sha=%s\noutcome=healthy\nconsecutive_healthy=%s\n' \
        "$profile" "$(date +%s)" "$LUNA_TEST_ACCEPT_SHA" "$LUNA_TEST_ACCEPT_SHA" "$count" > "$status"
    fi
    exit 0
    ;;
  list-unit-files)
    unit="$1"; [[ -f "$units/$unit" ]] && printf '%s enabled\n' "$unit"
    ;;
  *) exit 0 ;;
esac
`)
  spawnSync("chmod", ["+x", path])
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

const writeStub = (path: string, body: string) => {
  writeFileSync(path, body)
  spawnSync("chmod", ["+x", path])
}

const headSha = () =>
  spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim()

// A hermetic guardian: the engine is a *copy* of scripts/ whose luna-autodeploy
// is a recording stub, and the registry declares no incus container so
// diagnose() can never reach the live luna-stable container. This is the only
// way to exercise check_profile's destructive `--force` branch without invoking
// the real updater against the production deploy.
type Harness = {
  temp: string
  guardian: string
  state: string
  calls: string
  env: NodeJS.ProcessEnv
}

const makeHarness = (label: string): Harness => {
  const temp = mkdtempSync(join(tmpdir(), label))
  dirs.push(temp)
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
  writeStub(join(bin, "mv"), `#!/usr/bin/env bash
if [[ -n "\${LUNA_TEST_MV_FAIL_GLOB:-}" ]]; then
  for a in "$@"; do
    case "$a" in
      \${LUNA_TEST_MV_FAIL_GLOB}) printf 'mv: simulated failure: %s\\n' "$a" >&2; exit 1 ;;
    esac
  done
fi
exec /bin/mv "$@"
`)
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

const installHarness = (h: Harness) => {
  const install = spawnSync("bash", [h.guardian, "install", "stable"], {
    cwd: root,
    encoding: "utf8",
    env: { ...h.env, LUNA_TEST_RUNTIME_MATCHES_CHECKOUT: "true" },
  })
  expect(install.status, install.stdout + install.stderr).toBe(0)
  rmSync(h.calls, { force: true })
}

const runCheck = (h: Harness, seam: string, extra: Record<string, string> = {}) =>
  spawnSync("bash", [h.guardian, "check", "stable"], {
    cwd: root,
    encoding: "utf8",
    env: { ...h.env, LUNA_TEST_RUNTIME_MATCHES_CHECKOUT: seam, ...extra },
  })

const forceCalls = (h: Harness) =>
  (existsSync(h.calls) ? readFileSync(h.calls, "utf8") : "")
    .split("\n")
    .filter((line) => line.includes("--force"))

const repairCalls = (h: Harness) =>
  (existsSync(h.calls) ? readFileSync(h.calls, "utf8") : "")
    .split("\n")
    .filter((line) => line.includes("--repair"))

const allCalls = (h: Harness) =>
  (existsSync(h.calls) ? readFileSync(h.calls, "utf8") : "").split("\n").filter(Boolean)

const journalPath = (h: Harness) => join(h.state, "health-stable")

const seedJournal = (h: Harness, fields: Record<string, string | number>) => {
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const journalValue = (h: Harness, key: string) => {
  const match = readFileSync(journalPath(h), "utf8").match(new RegExp(`^${key}=(.*)$`, "m"))
  return match ? match[1] : ""
}

const incidentCount = (h: Harness) => {
  const dir = join(h.state, "incidents", "stable")
  return existsSync(dir) ? readdirSync(dir).length : 0
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
  const temp = mkdtempSync(join(tmpdir(), "luna-classify-"))
  dirs.push(temp)
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

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("luna-guardian", () => {
  it("units-only reconciliation never mutates state or restarts", () => {
    const temp = mkdtempSync(join(tmpdir(), "luna-units-test-"))
    dirs.push(temp)
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
    expect(result.stdout).not.toContain("filter @luna/ui-web build")
    expect(result.stdout).not.toContain("systemctl restart")
    expect(existsSync(join(temp, "state"))).toBe(false)
  })

  it("is executable and syntactically valid", () => {
    expect(spawnSync("bash", ["-n", guardian]).status).toBe(0)
    expect(spawnSync("test", ["-x", guardian]).status).toBe(0)
    const source = readFileSync(guardian, "utf8")
    expect(source).toContain("refresh_guardian_if_needed")
    expect(source).toContain("if runtime_health; then refresh_guardian_if_needed")
  })

  it("installs an immutable engine and independent timer/alert units", () => {
    const temp = mkdtempSync(join(tmpdir(), "luna-guardian-test-"))
    dirs.push(temp)
    const bin = join(temp, "bin")
    const units = join(temp, "systemd")
    const pins = join(temp, "pins")
    const state = join(temp, "state")
    const lunaHome = join(temp, "luna-home")
    const systemctlState = join(temp, "systemctl-state")
    mkdirSync(bin, { recursive: true })
    mkdirSync(units, { recursive: true })
    writeSystemctlStub(bin)

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
      },
    })

    expect(result.status, result.stdout + result.stderr).toBe(0)
    const current = join(pins, "current-stable")
    expect(existsSync(current)).toBe(true)
    expect(existsSync(join(current, ".complete"))).toBe(true)
    expect(existsSync(join(current, "luna-update-server"))).toBe(true)
    expect(existsSync(join(current, "luna-pager"))).toBe(true)
    expect(existsSync(join(current, "luna-doctor"))).toBe(true)

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

  it("replaces the pin symlink on re-install instead of nesting it in the old engine", () => {
    const temp = mkdtempSync(join(tmpdir(), "luna-guardian-reinstall-"))
    dirs.push(temp)
    const bin = join(temp, "bin")
    const units = join(temp, "systemd")
    const pins = join(temp, "pins")
    mkdirSync(bin, { recursive: true })
    mkdirSync(units, { recursive: true })
    writeSystemctlStub(bin)

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
    }

    for (const attempt of ["first", "second"]) {
      const run = spawnSync("bash", [guardian, "install", "stable"], { cwd: root, encoding: "utf8", env })
      expect(run.status, `${attempt}: ${run.stdout}${run.stderr}`).toBe(0)
    }

    // The pin must still be a symlink resolving to an engine@ directory —
    // installed_engine_sha() reads it to decide whether the release is healthy.
    const engines = readdirSync(pins).filter((name) => name.startsWith("engine@"))
    expect(engines).toHaveLength(1)
    const resolved = spawnSync("readlink", ["-f", join(pins, "current-stable")], { encoding: "utf8" })
    expect(resolved.stdout.trim()).toBe(join(pins, engines[0]))

    // A dereferenced `mv` would have dropped the temp link inside the engine.
    const leaked = readdirSync(join(pins, engines[0])).filter((name) => name.startsWith("current-"))
    expect(leaked).toEqual([])
  })

  it("refuses installation when the registry disables the timer", () => {
    const temp = mkdtempSync(join(tmpdir(), "luna-guardian-disabled-"))
    dirs.push(temp)
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
    dirs.push(temp)
    const bin = join(temp, "bin")
    const units = join(temp, "systemd")
    const registry = join(temp, "servers.toml")
    const state = join(temp, "state")
    mkdirSync(bin, { recursive: true })
    mkdirSync(units, { recursive: true })
    writeSystemctlStub(bin)
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

  it("defers adoption while an update transaction is pending", () => {
    const temp = mkdtempSync(join(tmpdir(), "luna-guardian-pending-"))
    dirs.push(temp)
    const update = join(temp, "update")
    mkdirSync(update)
    writeFileSync(join(update, "transaction-stable"), "phase=checkout\n")

    const result = spawnSync("bash", [guardian, "adopt", "stable"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        LUNA_SERVERS_CONFIG: fixture,
        LUNA_TEST_STAT_MODE: "600",
        LUNA_UPDATE_STATE_DIR: update,
        LUNA_GUARDIAN_PIN_BASE: join(temp, "pins"),
      },
    })

    expect(result.status, result.stdout + result.stderr).toBe(10)
    expect(result.stdout).toContain("update transaction pending")
    expect(existsSync(join(temp, "pins"))).toBe(false)
  })

  it("defers adoption when runtime does not prove checkout HEAD", () => {
    const temp = mkdtempSync(join(tmpdir(), "luna-guardian-mismatch-"))
    dirs.push(temp)
    const result = spawnSync("bash", [guardian, "adopt", "stable"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        LUNA_SERVERS_CONFIG: fixture,
        LUNA_TEST_STAT_MODE: "600",
        LUNA_TEST_RUNTIME_MATCHES_CHECKOUT: "false",
        LUNA_UPDATE_STATE_DIR: join(temp, "update"),
        LUNA_GUARDIAN_PIN_BASE: join(temp, "pins"),
      },
    })
    expect(result.status, result.stdout + result.stderr).toBe(10)
    expect(result.stdout).toContain("runtime does not prove checkout HEAD")
    expect(existsSync(join(temp, "pins"))).toBe(false)
  })

  it("defers pin publication while the updater owns the shared profile lock", () => {
    const temp = mkdtempSync(join(tmpdir(), "luna-guardian-update-lock-"))
    dirs.push(temp)
    const update = join(temp, "update")
    const lock = join(update, "lock-stable")
    mkdirSync(lock, { recursive: true })
    const fingerprint = spawnSync("ps", ["-p", String(process.pid), "-o", "lstart="], {
      encoding: "utf8",
    }).stdout.replace(/\n/g, "")
    writeFileSync(join(lock, "owner"), `pid=${process.pid}\nfingerprint=${fingerprint}\n`)

    const result = spawnSync("bash", [guardian, "adopt", "stable"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        LUNA_SERVERS_CONFIG: fixture,
        LUNA_TEST_STAT_MODE: "600",
        LUNA_TEST_RUNTIME_MATCHES_CHECKOUT: "true",
        LUNA_UPDATE_STATE_DIR: update,
        LUNA_GUARDIAN_PIN_BASE: join(temp, "pins"),
      },
    })

    expect(result.status, result.stdout + result.stderr).toBe(10)
    expect(result.stderr).toContain("update lock is held")
    expect(existsSync(join(temp, "pins"))).toBe(false)
  })

  it("cannot report success when legacy timer retirement fails", () => {
    const temp = mkdtempSync(join(tmpdir(), "luna-guardian-handoff-"))
    dirs.push(temp)
    const bin = join(temp, "bin")
    const units = join(temp, "systemd")
    mkdirSync(bin, { recursive: true })
    mkdirSync(units, { recursive: true })
    writeFileSync(join(units, "luna-autodeploy-stable.timer"), "legacy\n")
    writeFileSync(join(units, "luna-autodeploy-stable.service"), "legacy\n")
    writeSystemctlStub(bin)

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
      },
    })
    expect(retry.status, retry.stdout + retry.stderr).toBe(0)
    expect(existsSync(join(units, "luna-autodeploy-stable.timer"))).toBe(false)
  })

  it("publishes one complete engine under simultaneous profile installs", () => {
    const temp = mkdtempSync(join(tmpdir(), "luna-guardian-concurrent-"))
    dirs.push(temp)
    const bin = join(temp, "bin")
    const units = join(temp, "systemd")
    const pins = join(temp, "pins")
    mkdirSync(bin, { recursive: true })
    mkdirSync(units, { recursive: true })
    writeSystemctlStub(bin)
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
    dirs.push(temp)
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
    const h = makeHarness("luna-guardian-debounce-")
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
    const h = makeHarness("luna-guardian-cooldown-")
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
    const h = makeHarness("luna-guardian-unknown-")
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
    const h = makeHarness("luna-guardian-unknown-page-")
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
    const healthy = makeHarness("luna-guardian-journal-healthy-")
    installHarness(healthy)
    runCheck(healthy, "false")
    runCheck(healthy, "false")
    expect(journalValue(healthy, "consecutive_negative")).toBe("2")
    const ok = runCheck(healthy, "true")
    expect(ok.status, ok.stdout + ok.stderr).toBe(0)
    expect(journalValue(healthy, "consecutive_negative")).toBe("0")
    expect(journalValue(healthy, "consecutive_unknown")).toBe("0")

    // (b) a record older than the freshness window is not evidence.
    const stale = makeHarness("luna-guardian-journal-stale-")
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
    const rebuilt = makeHarness("luna-guardian-journal-sha-")
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
    const gone = makeHarness("luna-guardian-journal-missing-")
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
    const h = makeHarness("luna-guardian-aging-")
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
    const h = makeHarness("luna-guardian-skew-")
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
    const h = makeHarness("luna-guardian-unwritable-")
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
    const h = makeHarness("luna-guardian-unknown-escalate-")
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
    const h = makeHarness("luna-guardian-from-timer-")
    installHarness(h)

    expect(runCheck(h, "false").status).toBe(0)
    expect(allCalls(h)).toEqual(["stable --from-timer"])

    expect(runCheck(h, "inconclusive").status).toBe(0)
    expect(allCalls(h)).toEqual(["stable --from-timer", "stable --from-timer"])
    expect(forceCalls(h)).toEqual([])
  })

  // ── phase 2: escalation goes through the guarded --repair ladder ──────────

  it("escalation constructs --repair with exact argv", () => {
    const h = makeHarness("luna-guardian-repair-argv-")
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
    const h = makeHarness("luna-guardian-repair-defer-")
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
    const h = makeHarness("luna-guardian-repair-lock-")
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
    const h = makeHarness("luna-guardian-repair-fail-")
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
    const h = makeHarness("luna-guardian-gentle-")
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
    const h = makeHarness("luna-guardian-exit-criterion-")
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
})
