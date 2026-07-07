/**
 * Phase 1b.3 — luna-doctor runtime self-validation tests.
 *
 * luna-doctor checks that what the registry DECLARES about a server's runtime
 * matches what is actually running on the host.  It uses LUNA_TEST_* seams
 * (mirroring luna-deploy.sh / luna-autodeploy) so these tests run without a
 * real incus container or systemd.
 *
 * Scenarios covered:
 *   1. incus runtime: in-container unit active + bare-host unit inactive → PASS
 *   2. incus runtime: in-container unit INACTIVE → FAIL LOUDLY
 *   3. incus runtime: bare-host unit ACTIVE (P_INCUS="" regression) → FAIL LOUDLY
 *   4. bareFolder runtime: bare-host unit active → PASS
 *   5. bareFolder runtime: bare-host unit inactive → FAIL
 *   6. F5 rail: timer present for timer=false profile → FAIL
 *   7. F5 rail: timer absent for timer=false profile → PASS
 *   8. Unknown profile → exit 2
 *   9. All-profiles scan (--all / no arg with registry): runs all profiles
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { afterEach, describe, expect, it } from "vitest"

const repoRoot = new URL("..", import.meta.url).pathname
const FIXTURE = join(repoRoot, "test/fixtures/servers.toml")
const LUNA_DOCTOR = join(repoRoot, "scripts/luna-doctor")

const tempDirs: string[] = []
const makeTempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-doctor-test-"))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * Run luna-doctor with the given profile (or no arg for --all scan),
 * injecting test seams via environment variables.
 *
 * Seam variables:
 *   LUNA_TEST_DOCTOR_INCUS_ACTIVE   — "true"/"false" — incus exec is-active result
 *   LUNA_TEST_DOCTOR_HOST_ACTIVE    — "true"/"false" — bare-host is-active result
 *   LUNA_TEST_DOCTOR_TIMER_PRESENT  — "true"/"false" — autodeploy timer presence
 */
const runDoctor = (
  profile: string | null,
  seams: {
    incusActive?: boolean
    hostActive?: boolean
    timerPresent?: boolean
    registryFile?: string
    embedder?: "reachable" | "unreachable"
    extraEnv?: Record<string, string>
  } = {},
) => {
  const env: Record<string, string | undefined> = {
    ...process.env,
    LUNA_TEST_WS_COUNT: "0",
    LUNA_TAILSCALE_IP: "",
    LUNA_SERVERS_CONFIG: seams.registryFile ?? FIXTURE,
    LUNA_TEST_STAT_MODE: "600",
    ...seams.extraEnv,
  }
  if (seams.incusActive !== undefined) {
    env.LUNA_TEST_DOCTOR_INCUS_ACTIVE = String(seams.incusActive)
  }
  if (seams.hostActive !== undefined) {
    env.LUNA_TEST_DOCTOR_HOST_ACTIVE = String(seams.hostActive)
  }
  if (seams.timerPresent !== undefined) {
    env.LUNA_TEST_DOCTOR_TIMER_PRESENT = String(seams.timerPresent)
  }
  if (seams.embedder !== undefined) {
    env.LUNA_TEST_DOCTOR_EMBEDDER = seams.embedder
  }

  const args = profile != null ? [profile] : []
  return spawnSync("bash", [LUNA_DOCTOR, ...args], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Incus runtime — nominal pass (declared == real)
// ─────────────────────────────────────────────────────────────────────────────

describe("incus runtime — declared==real → PASS", () => {
  it("stable (incus luna-stable): container active + host inactive → exit 0", () => {
    // Phase 1b fixture: stable is now incus runtime. Auto-update default-on:
    // stable has deploy.timer=true, so F5 no longer requires timer absence.
    const result = runDoctor("stable", {
      incusActive: true,   // in-container unit IS active
      hostActive: false,   // bare-host unit is NOT active (correct)
      timerPresent: true,  // autodeploy timer installed (the new default)
    })
    expect(result.status, `stderr: ${result.stderr}`).toBe(0)
    expect(result.stdout).toContain("All declared==real checks PASSED")
    expect(result.stdout).toContain("in-container unit")
    expect(result.stdout).toContain("correctly inactive")
    expect(result.stdout).toContain("timer presence not checked")
  })

  it("dev (incus luna-dev): container active + host inactive → exit 0", () => {
    // dev has deploy.timer=true, so F5 rail does NOT check timer absence.
    const result = runDoctor("dev", {
      incusActive: true,
      hostActive: false,
    })
    expect(result.status, `stderr: ${result.stderr}`).toBe(0)
    expect(result.stdout).toContain("All declared==real checks PASSED")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. Incus runtime — container unit NOT active → FAIL
// ─────────────────────────────────────────────────────────────────────────────

describe("incus runtime — container unit inactive → FAIL LOUDLY", () => {
  it("stable (incus): container unit inactive → exit 1 with loud error", () => {
    const result = runDoctor("stable", {
      incusActive: false,  // container NOT serving the unit
      hostActive: false,
      timerPresent: false,
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("FAIL")
    expect(result.stderr).toContain("in-container unit")
    expect(result.stderr).toContain("NOT active")
    expect(result.stderr).toContain("luna-stable")
    expect(result.stderr).toContain("FAILED")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. Incus runtime — bare-host unit IS active (P_INCUS="" regression) → FAIL
// ─────────────────────────────────────────────────────────────────────────────

describe("incus runtime — bare-host unit active = P_INCUS=\"\" regression → FAIL LOUDLY", () => {
  it("stable (incus): bare-host unit active → exit 1 naming the regression explicitly", () => {
    // This is the scenario that 1b.3 is designed to detect:
    // registry says incus but the service is actually running bare-host.
    // This is the P_INCUS="" bug class.
    const result = runDoctor("stable", {
      incusActive: true,   // container also claims active (simulates partial mess)
      hostActive: true,    // bare-host IS active — this is the regression
      timerPresent: false,
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("FAIL")
    expect(result.stderr).toContain("P_INCUS")
    expect(result.stderr).toContain("bare-host")
    expect(result.stderr).toContain("FAILED")
  })

  it("stable (incus): bare-host active only (container inactive) → exit 1, both checks fail", () => {
    const result = runDoctor("stable", {
      incusActive: false,  // container NOT active
      hostActive: true,    // bare-host IS active — full P_INCUS="" regression
      timerPresent: false,
    })
    expect(result.status).toBe(1)
    // Both the container check and the host check should fail
    expect(result.stderr).toContain("FAIL")
    expect(result.stderr).toContain("NOT active")      // container check
    expect(result.stderr).toContain("P_INCUS")         // host active check names the bug class
    expect(result.stderr).toContain("FAILED")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. bareFolder runtime — nominal pass
// ─────────────────────────────────────────────────────────────────────────────

describe("bareFolder runtime — declared==real → PASS", () => {
  it("bareFolder: bare-host unit active → exit 0", () => {
    // Use a custom registry with stable as bareFolder (no container key)
    const temp = makeTempDir()
    const reg = join(temp, "servers.toml")
    writeFileSync(
      reg,
      [
        `kind = "registry"`,
        `[[server]]`,
        `name = "stable"`,
        `update.params.hostRepoDir = "/root/luna/stable/repo"`,
        `update.params.ref = "origin/master"`,
        `ports.proxy = 4753`,
        `deploy.timer = false`,
        // NO runtime.target.incus.container → bareFolder
      ].join("\n") + "\n",
    )
    const result = runDoctor("stable", {
      registryFile: reg,
      hostActive: true,
      timerPresent: false,
    })
    expect(result.status, `stderr: ${result.stderr}`).toBe(0)
    expect(result.stdout).toContain("All declared==real checks PASSED")
    expect(result.stdout).toContain("bare-host unit")
    expect(result.stdout).toContain("active")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. bareFolder runtime — bare-host unit inactive → FAIL
// ─────────────────────────────────────────────────────────────────────────────

describe("bareFolder runtime — bare-host unit inactive → FAIL", () => {
  it("bareFolder: bare-host unit inactive → exit 1", () => {
    const temp = makeTempDir()
    const reg = join(temp, "servers.toml")
    writeFileSync(
      reg,
      [
        `kind = "registry"`,
        `[[server]]`,
        `name = "stable"`,
        `update.params.hostRepoDir = "/root/luna/stable/repo"`,
        `update.params.ref = "origin/master"`,
        `ports.proxy = 4753`,
        `deploy.timer = false`,
      ].join("\n") + "\n",
    )
    const result = runDoctor("stable", {
      registryFile: reg,
      hostActive: false,
      timerPresent: false,
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("FAIL")
    expect(result.stderr).toContain("NOT active")
    expect(result.stderr).toContain("FAILED")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. F5 rail — timer present for timer=false profile → FAIL
// ─────────────────────────────────────────────────────────────────────────────

// Auto-update is default-on, so the shared fixture ships stable with
// deploy.timer=true. The F5 rail still guards profiles that OPTED OUT —
// exercise it with an explicit timer=false registry.
const makeTimerOptOutRegistry = () => {
  const dir = makeTempDir()
  const file = join(dir, "servers.toml")
  writeFileSync(
    file,
    [
      `kind = "registry"`,
      `[[server]]`,
      `name = "stable"`,
      `update.params.hostRepoDir = "/root/luna/stable/repo"`,
      `update.params.ref = "origin/master"`,
      `runtime.target.incus.container = "luna-stable"`,
      `ports.proxy = 4753`,
      `deploy.timer = false`,
    ].join("\n") + "\n",
  )
  return file
}

describe("F5 rail — timer present for timer=false profile", () => {
  it("stable opted out (timer=false): autodeploy timer IS present → exit 1 with F5 VIOLATION", () => {
    const result = runDoctor("stable", {
      incusActive: true,
      hostActive: false,
      timerPresent: true,  // timer is present — this violates the opt-out rail
      registryFile: makeTimerOptOutRegistry(),
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("F5 VIOLATION")
    expect(result.stderr).toContain("luna-autodeploy-stable.timer")
    expect(result.stderr).toContain("deploy.timer=false")
    expect(result.stderr).toContain("FAILED")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 7. F5 rail — timer absent for timer=false profile → PASS
// ─────────────────────────────────────────────────────────────────────────────

describe("F5 rail — timer absent for timer=false profile → PASS", () => {
  it("stable opted out (timer=false): autodeploy timer absent → F5 check passes", () => {
    const result = runDoctor("stable", {
      incusActive: true,
      hostActive: false,
      timerPresent: false,
      registryFile: makeTimerOptOutRegistry(),
    })
    expect(result.status, `stderr: ${result.stderr}`).toBe(0)
    expect(result.stdout).toContain("correctly absent")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 7b. Embedder reachability probe (LUNA_EMBEDDER=ollama)
// ─────────────────────────────────────────────────────────────────────────────

describe("embedder reachability probe", () => {
  const ollamaEnv = {
    LUNA_EMBEDDER: "ollama",
    LUNA_OLLAMA_BASE_URL: "http://10.77.0.1:11434",
  }

  it("ollama reachable → PASS with embedder OK line", () => {
    const result = runDoctor("stable", {
      incusActive: true,
      hostActive: false,
      timerPresent: false,
      embedder: "reachable",
      extraEnv: ollamaEnv,
    })
    expect(result.status, `stderr: ${result.stderr}`).toBe(0)
    expect(result.stdout).toContain("embedder reachable")
    expect(result.stdout).toContain("http://10.77.0.1:11434")
  })

  it("ollama unreachable on incus profile → FAIL, hint names the CONTAINER (not the profile)", () => {
    // Regression: the diagnose hint used `incus exec $profile` (the bare
    // profile name) instead of the actual incus instance name from P_INCUS.
    const result = runDoctor("stable", {
      incusActive: true,
      hostActive: false,
      timerPresent: false,
      embedder: "unreachable",
      extraEnv: ollamaEnv,
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("embedder unreachable")
    expect(result.stderr).toContain("docs/runbooks/incus-fence-acl.md")
    // Fixture maps profile "stable" → container "luna-stable".
    expect(result.stderr).toContain("incus exec luna-stable --")
    expect(result.stderr).not.toContain("incus exec stable --")
  })

  it("ollama unreachable on bareFolder profile → FAIL with a plain curl hint (no incus exec)", () => {
    const temp = makeTempDir()
    const reg = join(temp, "servers.toml")
    writeFileSync(
      reg,
      [
        `kind = "registry"`,
        `[[server]]`,
        `name = "stable"`,
        `update.params.hostRepoDir = "/root/luna/stable/repo"`,
        `update.params.ref = "origin/master"`,
        `ports.proxy = 4753`,
        `deploy.timer = false`,
      ].join("\n") + "\n",
    )
    const result = runDoctor("stable", {
      registryFile: reg,
      hostActive: true,
      timerPresent: false,
      embedder: "unreachable",
      extraEnv: ollamaEnv,
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("embedder unreachable")
    expect(result.stderr).toContain("Diagnose: curl")
    expect(result.stderr).not.toContain("incus exec")
  })

  it("ollama without LUNA_OLLAMA_BASE_URL → INFO skip, no failure", () => {
    const result = runDoctor("stable", {
      incusActive: true,
      hostActive: false,
      timerPresent: false,
      extraEnv: { LUNA_EMBEDDER: "ollama" },
    })
    expect(result.status, `stderr: ${result.stderr}`).toBe(0)
    expect(result.stdout).toContain("LUNA_OLLAMA_BASE_URL is unset")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 8. Unknown profile → exit 2
// ─────────────────────────────────────────────────────────────────────────────

describe("unknown profile → exit 2", () => {
  it("unknown profile liay → exit 2 with clear error", () => {
    const result = runDoctor("liay")
    expect(result.status).toBe(2)
    expect(result.stderr).toContain("liay")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 9. All-profiles scan: no arg → validates all profiles in registry
// ─────────────────────────────────────────────────────────────────────────────

describe("all-profiles scan (no profile arg)", () => {
  it("no arg: validates all profiles in fixture → exit 0 when all pass", () => {
    // Fixture has stable (incus luna-stable) + dev (incus luna-dev).
    // Both are incus runtimes; seed both as passing.
    const result = runDoctor(null, {
      incusActive: true,
      hostActive: false,
      timerPresent: false,
    })
    expect(result.status, `stderr: ${result.stderr}`).toBe(0)
    expect(result.stdout).toContain("All declared==real checks PASSED")
    // Should mention both profiles
    expect(result.stdout).toContain("stable")
    expect(result.stdout).toContain("dev")
  })

  it("no arg: one profile fails → exit 1", () => {
    // Simulate the P_INCUS="" regression on stable only.
    // We can only set one global seam, so both profiles get the same seam —
    // but that's fine for this test: if hostActive=true, both fail.
    const result = runDoctor(null, {
      incusActive: false,
      hostActive: true,  // bare-host active = regression
      timerPresent: false,
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("FAILED")
  })
})
