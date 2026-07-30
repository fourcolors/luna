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
})
