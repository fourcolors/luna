import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { afterEach, describe, expect, it } from "vitest"

const repoRoot = new URL("..", import.meta.url).pathname
const tempDirs: string[] = []

const makeTempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-deploy-test-"))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const runScript = (
  script: string,
  args: ReadonlyArray<string>,
  options: { readonly env?: Record<string, string | undefined> } = {},
) => {
  const env = {
    ...process.env,
    ...options.env,
  }
  return spawnSync("bash", [join(repoRoot, script), ...args], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
  })
}

describe("deployment scripts", () => {
  it("container creation is a no-op when the Incus instance already exists", () => {
    const temp = makeTempDir()
    const bin = join(temp, "bin")
    const log = join(temp, "incus.log")
    mkdirSync(bin)
    writeFileSync(join(bin, "incus"), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${log}"
cmd="\${1:-}"
if [[ "$#" -gt 0 ]]; then shift; fi
case "$cmd" in
  info) exit 0 ;;
  storage)
    [[ "\${1:-} \${2:-}" == "show default" ]] && exit 0
    ;;
  network)
    [[ "\${1:-} \${2:-}" == "show incusbr0" ]] && exit 0
    ;;
  profile)
    if [[ "\${1:-} \${2:-} \${3:-} \${4:-} \${5:-}" == "device get default root pool" ]]; then
      printf 'default\\n'
      exit 0
    fi
    if [[ "\${1:-} \${2:-} \${3:-} \${4:-} \${5:-}" == "device get default root path" ]]; then
      printf '/\\n'
      exit 0
    fi
    if [[ "\${1:-} \${2:-} \${3:-} \${4:-} \${5:-}" == "device get default eth0 network" ]]; then
      printf 'incusbr0\\n'
      exit 0
    fi
    ;;
esac
exit 1
`)
    const chmod = spawnSync("chmod", ["+x", join(bin, "incus")])
    expect(chmod.status).toBe(0)

    const statePath = join(temp, "state")
    const result = runScript("scripts/luna-container-create", [
      "--name",
      "luna-dev",
      "--repo-path",
      join(temp, "repo"),
      "--state-path",
      statePath,
    ], {
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
      },
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("already exists; leaving it unchanged")
    expect(result.stdout).toContain("--replace")
    expect(existsSync(statePath)).toBe(false)
    const incusLog = existsSync(log) ? readFileSync(log, "utf8") : ""
    expect(incusLog).toContain("info luna-dev")
    expect(incusLog).not.toContain("storage show default")
    expect(incusLog).not.toContain("network show incusbr0")
    expect(incusLog).not.toContain("profile device get default")
    expect(incusLog).not.toContain("init images:ubuntu/24.04/cloud luna-dev")
    expect(incusLog).not.toContain("config device add")
  })

  it("container dry-run emits an Incus plan without leaking the UI token", () => {
    const temp = makeTempDir()
    const token = "test-token-1234567890-secret"

    const result = runScript("scripts/luna-container-create", [
      "--dry-run",
      "--profile",
      "dev",
      "--name",
      "luna-dev",
      "--repo-path",
      join(temp, "repo"),
      "--state-path",
      join(temp, "state"),
      "--host",
      "jax-box",
      "--host-ws-port",
      "5753",
      "--host-control-port",
      "5754",
      "--token",
      token,
    ])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("incus init images:ubuntu/24.04/cloud luna-dev")
    expect(result.stdout).toContain("Branch: dev")
    expect(result.stdout).toContain("git clone --branch dev")
    expect(result.stdout).toContain("security.nesting=true")
    expect(result.stdout).toContain("listen=tcp:0.0.0.0:5753")
    expect(result.stdout).toContain("connect=tcp:127.0.0.1:4753")
    expect(result.stdout).toContain("path=/root/luna")
    expect(result.stdout).toContain("LUNA_DEV_WS_URL=ws://jax-box:5753/ui")
    expect(result.stdout).not.toContain(token)
    expect(result.stdout).toContain("<redacted>")
  })

  it("container branch defaults keep stable on master and dev on dev", () => {
    const temp = makeTempDir()
    const token = "test-token-1234567890-secret"

    const stable = runScript("scripts/luna-container-create", [
      "--dry-run",
      "--profile",
      "stable",
      "--name",
      "luna-stable",
      "--repo-path",
      join(temp, "stable", "repo"),
      "--state-path",
      join(temp, "stable", "state"),
      "--token",
      token,
    ])
    const dev = runScript("scripts/luna-container-create", [
      "--dry-run",
      "--profile",
      "dev",
      "--name",
      "luna-dev",
      "--repo-path",
      join(temp, "dev", "repo"),
      "--state-path",
      join(temp, "dev", "state"),
      "--token",
      token,
    ])

    expect(stable.status).toBe(0)
    expect(stable.stdout).toContain("Branch: master")
    expect(stable.stdout).toContain("git clone --branch master")
    expect(dev.status).toBe(0)
    expect(dev.stdout).toContain("Branch: dev")
    expect(dev.stdout).toContain("git clone --branch dev")
  })

  it("container creation fails before mutation when Incus is unavailable", () => {
    const temp = makeTempDir()

    const result = runScript("scripts/luna-container-create", [
      "--name",
      "luna-test",
      "--repo-path",
      join(temp, "repo"),
      "--state-path",
      join(temp, "state"),
    ], {
      env: {
        PATH: "/usr/bin:/bin",
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("Incus CLI not found")
  })

  it("server install dry-run renders the systemd service and preserves token secrecy", () => {
    const temp = makeTempDir()
    const token = "server-token-1234567890-secret"

    const result = runScript("scripts/luna-server-install", [
      "--dry-run",
      "--profile",
      "stable",
      "--repo-dir",
      join(temp, "repo"),
      "--luna-home",
      join(temp, "state"),
      "--service-dir",
      join(temp, "systemd"),
      "--token",
      token,
      "--skip-deps",
      "--no-enable",
    ], {
      env: {
        LUNA_TEST_BUN_PATH: "/root/.bun/bin/bun",
      },
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("WorkingDirectory=" + join(temp, "repo"))
    expect(result.stdout).toContain("EnvironmentFile=" + join(temp, "state", ".env"))
    expect(result.stdout).toContain("ExecStart=/root/.bun/bin/bun run --filter @luna/ui-web server:chat")
    expect(result.stdout).toContain("LUNA_REPO_ROOT=" + join(temp, "repo"))
    expect(result.stdout).toContain("UI_WS_TOKEN=<redacted>")
    expect(result.stdout).not.toContain(token)
  })

  it("server install validates the repo before installing host dependencies", () => {
    const temp = makeTempDir()
    const bin = join(temp, "bin")
    const log = join(temp, "apt.log")
    mkdirSync(bin)
    writeFileSync(join(bin, "apt-get"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${log}"
exit 0
`)
    const chmod = spawnSync("chmod", ["+x", join(bin, "apt-get")])
    expect(chmod.status).toBe(0)

    const result = runScript("scripts/luna-server-install", [
      "--repo-dir",
      join(temp, "missing-repo"),
      "--luna-home",
      join(temp, "state"),
      "--token",
      "server-token-1234567890-secret",
    ], {
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("is not a git clone")
    expect(existsSync(log)).toBe(false)
  })

  it("local installer dry-run uses the real GitHub repository and installs the chat CLI wrapper", () => {
    const temp = makeTempDir()

    const result = runScript("install.sh", [
      "--dry-run",
      "--luna-dir",
      join(temp, "repo"),
      "--bin-dir",
      join(temp, "bin"),
    ], {
      env: {
        LUNA_TEST_BUN_PATH: "/opt/homebrew/bin/bun",
      },
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("https://github.com/fourcolors/luna.git")
    expect(result.stdout).not.toContain("example-org")
    expect(result.stdout).toContain("run --cwd")
    expect(result.stdout).toContain("@luna/agent-cli")
    expect(result.stdout).toContain("luna chat")
  })

  it("script entrypoints are executable", () => {
    for (const script of [
      "install.sh",
      "scripts/luna-container-create",
      "scripts/luna-server-install",
    ]) {
      const mode = statSync(join(repoRoot, script)).mode
      expect(mode & 0o111).not.toBe(0)
    }
  })
})
