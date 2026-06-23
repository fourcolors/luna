/**
 * Phase 1a + 1b — luna-registry.sh unit tests.
 *
 * Tests the data-driven server registry reader and its integration with
 * luna-autodeploy, including:
 *   - luna_load_server: field extraction, flag assembly, env overrides
 *   - GOLDEN (1b): stable now produces "--incus luna-stable" (NOT "--repo-dir")
 *     reflecting the real incus runtime empirically verified in 1b.1.
 *     The LUNA_REGISTRY_DISABLE=1 hardcoded fallback still uses --repo-dir
 *     (legacy bare-host path); the registry path is now the correct incus path.
 *   - dev golden: unchanged — still "--incus luna-dev"
 *   - Security: group/world-writable file refusal
 *   - Discriminator: kind != "registry" → hard fail
 *   - Unknown profile → exit 2
 *   - F5: install-timer for timer-not-allowed profile → rejected
 *   - F7: --validate checks existence via LUNA_TEST_* seams
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { afterEach, describe, expect, it } from "vitest"

const repoRoot = new URL("..", import.meta.url).pathname
const FIXTURE = join(repoRoot, "test/fixtures/servers.toml")
const LUNA_AUTODEPLOY = join(repoRoot, "scripts/luna-autodeploy")
const LUNA_REGISTRY = join(repoRoot, "scripts/lib/luna-registry.sh")

const tempDirs: string[] = []

const makeTempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-registry-test-"))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * Run luna_load_server <profile> and return the exported variables via
 * a small bash wrapper that prints them after sourcing the lib.
 */
const loadServer = (
  profile: string,
  options: {
    registryFile?: string
    statMode?: string
    extraEnv?: Record<string, string>
  } = {},
) => {
  const env = {
    ...process.env,
    LUNA_TEST_WS_COUNT: "0",
    LUNA_TAILSCALE_IP: "",
    LUNA_SERVERS_CONFIG: options.registryFile ?? FIXTURE,
    LUNA_TEST_STAT_MODE: options.statMode ?? "600",
    ...options.extraEnv,
  }
  // Build the bash command using string concatenation to avoid JS template
  // literal substitution on $P_REPO etc. — those are bash variables, not JS.
  const bashCmd = [
    "source " + LUNA_REGISTRY,
    "luna_load_server " + profile,
    'echo "P_REPO=$P_REPO"',
    'echo "P_BRANCH=$P_BRANCH"',
    'echo "P_INCUS=$P_INCUS"',
    'echo "P_PORT=$P_PORT"',
    'echo "P_TIMER_ALLOWED=$P_TIMER_ALLOWED"',
    'echo "P_SERVICE_NAME=$P_SERVICE_NAME"',
    'echo "P_UPDATE_ARGS=${P_UPDATE_ARGS[*]}"',
  ].join("; ")
  return spawnSync(
    "bash",
    ["-c", bashCmd],
    { cwd: repoRoot, env, encoding: "utf8" },
  )
}

/**
 * Create a shared dry-run environment (fake git repo + fake git binary).
 * Returns the temp dir and a runDryRun function bound to that dir.
 * Using a shared dir ensures both golden and registry runs use the SAME
 * repo path, making the golden byte-comparison valid.
 */
const makeDryRunEnv = (profile: string) => {
  const temp = makeTempDir()
  mkdirSync(join(temp, "repo", ".git"), { recursive: true })
  const fakeBin = join(temp, "bin")
  mkdirSync(fakeBin)
  writeFileSync(
    join(fakeBin, "git"),
    `#!/usr/bin/env bash\n` +
    `case "$*" in\n` +
    `  *"fetch origin"*) exit 0 ;;\n` +
    `  *"rev-parse HEAD") printf 'aaaaaaaaa\\n' ;;\n` +
    `  *"rev-parse origin/"*) printf 'bbbbbbbbb\\n' ;;\n` +
    `  *) /usr/bin/git "$@" ;;\n` +
    `esac\n`,
  )
  spawnSync("chmod", ["+x", join(fakeBin, "git")])
  return { temp, fakeBin }
}

/**
 * Run luna-autodeploy with a fake git (returns different SHAs so the
 * deploy path is taken) and luna-update-server stubbed out.
 * Returns the full stdout line content.
 */
const runDryRun = (
  profile: string,
  options: {
    disableRegistry?: boolean
    registryFile?: string
    statMode?: string
    extraEnv?: Record<string, string>
    // Optional: reuse a shared temp dir so two runs get the same repo path
    sharedEnv?: { temp: string; fakeBin: string }
  } = {},
) => {
  const { temp, fakeBin } = options.sharedEnv ?? makeDryRunEnv(profile)
  if (!options.sharedEnv) {
    // If we created it ourselves, register for cleanup
    tempDirs.push(temp)
  }

  // Profile-specific repo dir env
  const profileUpper = profile.toUpperCase().replace(/[^A-Z0-9]/g, "_")
  const repoEnvKey = `LUNA_${profileUpper}_REPO_DIR`

  const env: Record<string, string | undefined> = {
    ...process.env,
    LUNA_TEST_WS_COUNT: "0",
    LUNA_TAILSCALE_IP: "",
    [repoEnvKey]: join(temp, "repo"),
    PATH: `${fakeBin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    ...(options.disableRegistry ? { LUNA_REGISTRY_DISABLE: "1" } : {}),
    LUNA_SERVERS_CONFIG: options.registryFile ?? FIXTURE,
    LUNA_TEST_STAT_MODE: options.statMode ?? "600",
    ...options.extraEnv,
  }

  return spawnSync(
    "bash",
    [LUNA_AUTODEPLOY, profile, "--dry-run"],
    { cwd: repoRoot, env, encoding: "utf8" },
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// luna_load_server: field extraction
// ─────────────────────────────────────────────────────────────────────────────

describe("luna_load_server — field extraction", () => {
  it("stable: P_INCUS=luna-stable (incus runtime), P_UPDATE_ARGS has --incus not --repo-dir", () => {
    // Phase 1b: stable runs INSIDE the luna-stable incus container.
    // Empirically verified 1b.1: host service INACTIVE, container service ACTIVE,
    // host :4753 is incusd proxy, /root/luna/stable/repo bind-mounted to /root/luna.
    const result = loadServer("stable")
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toMatch(/^P_INCUS=luna-stable$/m)
    // Must have --incus
    expect(result.stdout).toContain("P_UPDATE_ARGS=--profile stable --incus luna-stable")
    // Must NOT have --repo-dir (bare-host invocation was the P_INCUS="" bug)
    expect(result.stdout).not.toContain("--repo-dir")
  })

  it("stable: assembles correct P_UPDATE_ARGS (1b: incus path)", () => {
    const result = loadServer("stable")
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain(
      "P_UPDATE_ARGS=--profile stable --incus luna-stable --ref origin/master",
    )
  })

  it("stable: P_BRANCH=master, P_PORT=4753, P_TIMER_ALLOWED=false", () => {
    const result = loadServer("stable")
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toMatch(/^P_BRANCH=master$/m)
    expect(result.stdout).toMatch(/^P_PORT=4753$/m)
    expect(result.stdout).toMatch(/^P_TIMER_ALLOWED=false$/m)
  })

  it("stable: P_SERVICE_NAME=luna-chat-server.service", () => {
    const result = loadServer("stable")
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toMatch(/^P_SERVICE_NAME=luna-chat-server\.service$/m)
  })

  it("dev: P_INCUS=luna-dev, P_UPDATE_ARGS has --incus not --repo-dir", () => {
    const result = loadServer("dev")
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toMatch(/^P_INCUS=luna-dev$/m)
    expect(result.stdout).toContain("P_UPDATE_ARGS=--profile dev --incus luna-dev")
    expect(result.stdout).not.toContain("--repo-dir")
  })

  it("dev: assembles correct P_UPDATE_ARGS", () => {
    const result = loadServer("dev")
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain(
      "P_UPDATE_ARGS=--profile dev --incus luna-dev --ref origin/dev",
    )
  })

  it("dev: P_BRANCH=dev, P_PORT=4753, P_TIMER_ALLOWED=true", () => {
    const result = loadServer("dev")
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toMatch(/^P_BRANCH=dev$/m)
    expect(result.stdout).toMatch(/^P_PORT=4753$/m)
    expect(result.stdout).toMatch(/^P_TIMER_ALLOWED=true$/m)
  })

  it("dev: P_SERVICE_NAME=luna-dev-chat-server.service", () => {
    const result = loadServer("dev")
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toMatch(/^P_SERVICE_NAME=luna-dev-chat-server\.service$/m)
  })

  it("env override: LUNA_STABLE_REPO_DIR wins over registry default (P_REPO is set; stable uses --incus)", () => {
    // Phase 1b: stable uses incus (not --repo-dir), so LUNA_STABLE_REPO_DIR still
    // overrides P_REPO (the host-side bind path) but P_UPDATE_ARGS uses --incus.
    const result = loadServer("stable", {
      extraEnv: { LUNA_STABLE_REPO_DIR: "/custom/stable/repo" },
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toMatch(/^P_REPO=\/custom\/stable\/repo$/m)
    // In 1b, stable uses --incus not --repo-dir
    expect(result.stdout).toContain("--incus luna-stable")
    expect(result.stdout).not.toContain("--repo-dir")
  })

  it("env override: LUNA_DEV_INCUS wins over registry incus container name", () => {
    const result = loadServer("dev", {
      extraEnv: { LUNA_DEV_INCUS: "luna-dev-custom" },
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toMatch(/^P_INCUS=luna-dev-custom$/m)
    expect(result.stdout).toContain("--incus luna-dev-custom")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// GOLDEN (1b): registry-driven DRY-RUN output assertions
//
// Phase 1b NOTE: stable is no longer byte-identical to the hardcoded fallback.
// The registry path is CORRECT (--incus luna-stable) while the hardcoded
// fallback remains the legacy bare-host bug (--repo-dir).  We no longer
// compare them — instead we assert the EXPECTED registry content directly.
// dev remains byte-identical between registry and hardcoded (both use incus).
// ─────────────────────────────────────────────────────────────────────────────

describe("GOLDEN (1b): registry-driven DRY-RUN output", () => {
  /**
   * Extract the DRY-RUN argv line from luna-autodeploy --dry-run output.
   * The line looks like:
   *   [autodeploy:stable] DRY-RUN: /path/to/luna-update-server --profile stable ...
   * We normalize the path prefix so comparisons are path-independent.
   */
  const extractDryRunLine = (stdout: string): string => {
    const match = stdout.match(/DRY-RUN: .+/)
    if (!match) throw new Error(`No DRY-RUN line found in:\n${stdout}`)
    // Normalize the absolute path to luna-update-server to just the filename
    // so the golden comparison doesn't depend on which worktree is used.
    return match[0].replace(/DRY-RUN: .+(luna-update-server)/, "DRY-RUN: luna-update-server")
  }

  it("stable: registry-driven DRY-RUN uses --incus luna-stable (1b: incus runtime)", () => {
    // Phase 1b: registry path is CORRECT (--incus luna-stable).
    // The hardcoded fallback (LUNA_REGISTRY_DISABLE=1) retains the legacy
    // bare-host path and is intentionally different — it is the rollback only.
    const sharedEnv = makeDryRunEnv("stable")
    const registry = runDryRun("stable", { disableRegistry: false, sharedEnv })

    expect(registry.status, `registry stderr: ${registry.stderr}`).toBe(0)

    const registryLine = extractDryRunLine(registry.stdout)

    // Must use incus (the real runtime)
    expect(registryLine).toContain("--profile stable --incus luna-stable --ref origin/master")
    // Must NOT use bare-host --repo-dir (that was the P_INCUS="" bug)
    expect(registryLine).not.toContain("--repo-dir")
  })

  it("stable: hardcoded fallback (DISABLE=1) still produces bare-host --repo-dir (legacy kill-switch path)", () => {
    // Verifies the kill-switch/rollback path is preserved and intentionally
    // differs from the registry path after 1b.
    const sharedEnv = makeDryRunEnv("stable")
    const fallback = runDryRun("stable", { disableRegistry: true, sharedEnv })

    expect(fallback.status, `fallback stderr: ${fallback.stderr}`).toBe(0)

    const fallbackLine = extractDryRunLine(fallback.stdout)

    expect(fallbackLine).toContain("--profile stable")
    expect(fallbackLine).toContain("--repo-dir")
    expect(fallbackLine).toContain("--ref origin/master")
    expect(fallbackLine).not.toContain("--incus")
  })

  it("dev: registry-driven DRY-RUN line is byte-identical to LUNA_REGISTRY_DISABLE=1 (dev unchanged)", () => {
    const sharedEnv = makeDryRunEnv("dev")
    const golden = runDryRun("dev", { disableRegistry: true, sharedEnv })
    const registry = runDryRun("dev", { disableRegistry: false, sharedEnv })

    expect(golden.status, `golden stderr: ${golden.stderr}`).toBe(0)
    expect(registry.status, `registry stderr: ${registry.stderr}`).toBe(0)

    const goldenLine = extractDryRunLine(golden.stdout)
    const registryLine = extractDryRunLine(registry.stdout)

    expect(registryLine).toBe(goldenLine)
    // Explicit content assertion (dev is unchanged from 1a)
    expect(registryLine).toContain("--profile dev")
    expect(registryLine).toContain("--incus luna-dev")
    expect(registryLine).toContain("--ref origin/dev")
    expect(registryLine).not.toContain("--repo-dir")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Security / discriminator checks
// ─────────────────────────────────────────────────────────────────────────────

describe("security and discriminator", () => {
  it("unknown profile → exit 2 with a clear error message", () => {
    const result = loadServer("liay")
    expect(result.status).toBe(2)
    expect(result.stderr).toContain("unknown profile")
    expect(result.stderr).toContain("liay")
  })

  it("group-writable file (mode 664) → refused, exit 2", () => {
    const result = loadServer("stable", { statMode: "664" })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain("REFUSING")
    expect(result.stderr).toContain("group/world-writable")
  })

  it("world-writable file (mode 622) → refused, exit 2", () => {
    const result = loadServer("stable", { statMode: "622" })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain("REFUSING")
    expect(result.stderr).toContain("group/world-writable")
  })

  it("mode 600 → accepted (no security rejection)", () => {
    const result = loadServer("stable", { statMode: "600" })
    expect(result.status).toBe(0)
    expect(result.stderr).not.toContain("REFUSING")
  })

  it("registry file with kind=bootstrap → hard fail, exit 2", () => {
    const temp = makeTempDir()
    const badRegistry = join(temp, "servers.toml")
    writeFileSync(
      badRegistry,
      `kind = "bootstrap"\n\n[[server]]\nname = "stable"\n`,
    )
    const result = loadServer("stable", { registryFile: badRegistry })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain("bootstrap")
    expect(result.stderr).toContain("registry")
  })

  it("registry file with no kind field → hard fail", () => {
    const temp = makeTempDir()
    const badRegistry = join(temp, "servers.toml")
    writeFileSync(badRegistry, `[[server]]\nname = "stable"\n`)
    const result = loadServer("stable", { registryFile: badRegistry })
    expect(result.status).toBe(2)
  })

  it("missing registry file → exit 2 with clear message", () => {
    const result = loadServer("stable", {
      registryFile: "/nonexistent/servers.toml",
    })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain("not found")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// F5: timer install guard
// ─────────────────────────────────────────────────────────────────────────────

describe("F5: timer install guard", () => {
  const runTimerInstall = (
    profile: string,
    options: { disableRegistry?: boolean; statMode?: string } = {},
  ) => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      LUNA_TEST_WS_COUNT: "0",
      LUNA_TAILSCALE_IP: "",
      LUNA_SERVERS_CONFIG: FIXTURE,
      LUNA_TEST_STAT_MODE: options.statMode ?? "600",
      ...(options.disableRegistry ? { LUNA_REGISTRY_DISABLE: "1" } : {}),
    }
    return spawnSync(
      "bash",
      [LUNA_AUTODEPLOY, "install-timer", profile],
      { cwd: repoRoot, env, encoding: "utf8" },
    )
  }

  it("install-timer stable (registry: timer=false) → rejected, exit 2", () => {
    const result = runTimerInstall("stable")
    expect(result.status).toBe(2)
    expect(result.stderr).toContain("timers are not allowed")
    expect(result.stderr).toContain("stable")
  })

  it("install-timer stable (kill-switch DISABLE=1) → still rejected by hardcoded fallback", () => {
    // The hardcoded fallback also sets P_TIMER_ALLOWED=false for stable,
    // so the production safety rail holds even without the registry.
    const result = runTimerInstall("stable", { disableRegistry: true })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain("timers are not allowed")
  })

  it("install-timer dev (registry: timer=true) → passes the F5 guard (may fail on systemctl)", () => {
    // We only care that the F5 guard passes — systemctl not being present is fine.
    const result = runTimerInstall("dev")
    // F5 guard must NOT fire
    expect(result.stderr).not.toContain("timers are not allowed")
    // Either succeeds or fails for a non-F5 reason (no systemctl on macOS)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// F7: --validate existence checks
// ─────────────────────────────────────────────────────────────────────────────

describe("F7: --validate existence checks", () => {
  const runValidate = (
    profile: string,
    seams: {
      repo?: boolean
      incus?: boolean
      service?: boolean
      statMode?: string
    } = {},
  ) => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      LUNA_TEST_WS_COUNT: "0",
      LUNA_TAILSCALE_IP: "",
      LUNA_SERVERS_CONFIG: FIXTURE,
      LUNA_TEST_STAT_MODE: seams.statMode ?? "600",
    }
    if (seams.repo !== undefined) env.LUNA_TEST_VALIDATE_REPO = String(seams.repo)
    if (seams.incus !== undefined) env.LUNA_TEST_VALIDATE_INCUS = String(seams.incus)
    if (seams.service !== undefined) env.LUNA_TEST_VALIDATE_SERVICE = String(seams.service)

    return spawnSync(
      "bash",
      [LUNA_AUTODEPLOY, profile, "--validate"],
      { cwd: repoRoot, env, encoding: "utf8" },
    )
  }

  it("stable: all checks pass via seams → exit 0 (1b: now includes incus check)", () => {
    // Phase 1b: stable has runtime.target.incus.container=luna-stable,
    // so --validate now also checks the incus container.
    const result = runValidate("stable", { repo: true, incus: true, service: true })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain("All checks passed")
  })

  it("stable: repo missing → exit 2 with FAIL message", () => {
    const result = runValidate("stable", { repo: false, incus: true, service: true })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain("FAIL")
    expect(result.stderr).toContain("repo")
  })

  it("stable: incus container missing → exit 2 with FAIL message (1b: luna-stable)", () => {
    // Phase 1b: stable uses incus, so a missing container is a validation failure.
    const result = runValidate("stable", { repo: true, incus: false, service: true })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain("FAIL")
    expect(result.stderr).toContain("luna-stable")
  })

  it("stable: service missing → exit 2 with FAIL message", () => {
    const result = runValidate("stable", { repo: true, incus: true, service: false })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain("FAIL")
    expect(result.stderr).toContain("luna-chat-server.service")
  })

  it("dev: all checks pass via seams → exit 0", () => {
    const result = runValidate("dev", { repo: true, incus: true, service: true })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain("All checks passed")
  })

  it("dev: incus container missing → exit 2 with FAIL message", () => {
    const result = runValidate("dev", { repo: true, incus: false, service: true })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain("FAIL")
    expect(result.stderr).toContain("luna-dev")
  })

  it("dev: repo missing → exit 2", () => {
    const result = runValidate("dev", { repo: false, incus: true, service: true })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain("FAIL")
  })

  it("validate unknown profile → exit 2", () => {
    const result = runValidate("liay", {})
    expect(result.status).toBe(2)
    // Either registry error or unknown profile message
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Kill-switch: LUNA_REGISTRY_DISABLE=1 forces hardcoded case
// ─────────────────────────────────────────────────────────────────────────────

describe("kill-switch LUNA_REGISTRY_DISABLE=1", () => {
  it("kill-switch + no registry file: stable still works (hardcoded fallback)", () => {
    const result = runDryRun("stable", {
      disableRegistry: true,
      registryFile: "/nonexistent/servers.toml",
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain("DRY-RUN")
    expect(result.stdout).toContain("--profile stable")
  })

  it("kill-switch + bad kind in registry: still uses hardcoded (registry not loaded)", () => {
    const temp = makeTempDir()
    const badRegistry = join(temp, "servers.toml")
    writeFileSync(badRegistry, `kind = "bootstrap"\n[[server]]\nname="stable"\n`)
    const result = runDryRun("stable", {
      disableRegistry: true,
      registryFile: badRegistry,
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain("DRY-RUN")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// FIX 1: duplicate key within a stanza → exit 2
// ─────────────────────────────────────────────────────────────────────────────

describe("FIX 1: duplicate key in stanza → fail-closed", () => {
  it("duplicate key (update.params.hostRepoDir appears twice) → exit 2 with clear message", () => {
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
        `update.params.hostRepoDir = "/root/luna/stable/repo2"`,  // duplicate!
        `deploy.timer = false`,
      ].join("\n") + "\n",
    )
    const result = loadServer("stable", { registryFile: reg })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain("duplicate key")
    expect(result.stderr).toContain("update.params.hostRepoDir")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// FIX 2: ownership check via LUNA_TEST_STAT_OWNER seam
// ─────────────────────────────────────────────────────────────────────────────

describe("FIX 2: owner-uid check → fail-closed", () => {
  it("registry file owned by a different uid → refused, exit 2", () => {
    // Use a uid that is guaranteed != EUID (0 if EUID>0, 65534 if EUID==0)
    const wrongUid = process.getuid?.() === 0 ? "65534" : "0"
    const result = loadServer("stable", {
      extraEnv: { LUNA_TEST_STAT_OWNER: wrongUid },
    })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain("REFUSING")
    expect(result.stderr).toContain("owner uid")
  })

  it("registry file owned by executing uid → accepted", () => {
    const myUid = String(process.getuid?.() ?? 0)
    const result = loadServer("stable", {
      extraEnv: { LUNA_TEST_STAT_OWNER: myUid },
    })
    expect(result.status, result.stderr).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// FIX 3: indented dotted keys parse correctly
// ─────────────────────────────────────────────────────────────────────────────

describe("FIX 3: indented dotted keys parse correctly", () => {
  it("indented dotted keys under [[server]] are parsed like column-0 keys", () => {
    const temp = makeTempDir()
    const reg = join(temp, "servers.toml")
    writeFileSync(
      reg,
      [
        `kind = "registry"`,
        `[[server]]`,
        `name = "stable"`,
        `  update.params.hostRepoDir = "/root/luna/stable/repo"`,  // indented
        `  update.params.ref = "origin/master"`,                  // indented
        `  deploy.timer = false`,                                   // indented
      ].join("\n") + "\n",
    )
    const result = loadServer("stable", { registryFile: reg })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toMatch(/^P_REPO=\/root\/luna\/stable\/repo$/m)
    expect(result.stdout).toMatch(/^P_BRANCH=master$/m)
    expect(result.stdout).toMatch(/^P_TIMER_ALLOWED=false$/m)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// FIX 4: charset and absolute-path validation → fail-closed
// ─────────────────────────────────────────────────────────────────────────────

describe("FIX 4: charset / format validation", () => {
  const makeReg = (overrides: { repoDir?: string; container?: string }) => {
    const temp = makeTempDir()
    const reg = join(temp, "servers.toml")
    const repoDir = overrides.repoDir ?? "/root/luna/dev/repo"
    const container = overrides.container ?? "luna-dev"
    writeFileSync(
      reg,
      [
        `kind = "registry"`,
        `[[server]]`,
        `name = "dev"`,
        `update.params.hostRepoDir = "${repoDir}"`,
        `update.params.ref = "origin/dev"`,
        `runtime.target.incus.container = "${container}"`,
        `deploy.timer = true`,
      ].join("\n") + "\n",
    )
    return reg
  }

  it("container name with invalid chars (space) → exit 2", () => {
    const result = loadServer("dev", { registryFile: makeReg({ container: "luna dev" }) })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain("container name")
    expect(result.stderr).toContain("invalid characters")
  })

  it("container name with invalid chars (semicolon) → exit 2", () => {
    const result = loadServer("dev", { registryFile: makeReg({ container: "luna;dev" }) })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain("invalid characters")
  })

  it("repo dir that is not absolute → exit 2", () => {
    const result = loadServer("dev", { registryFile: makeReg({ repoDir: "relative/path" }) })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain("not an absolute path")
  })

  it("valid container name and absolute repo dir → accepted", () => {
    const result = loadServer("dev", { registryFile: makeReg({}) })
    expect(result.status, result.stderr).toBe(0)
  })
})
