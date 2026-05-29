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

  it("container dry-run writes an Incus runtime scope marker", () => {
    const temp = makeTempDir()
    const result = runScript("scripts/luna-container-create", [
      "--dry-run",
      "--profile",
      "stable",
      "--name",
      "luna-stable",
      "--repo-path",
      join(temp, "repo"),
      "--state-path",
      join(temp, "state"),
      "--token",
      "test-token-1234567890-secret",
    ])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("LUNA_PROFILE=stable")
    expect(result.stdout).toContain("LUNA_CHAT_SERVER_NAME=luna-chat-server")
    expect(result.stdout).toContain("LUNA_RUNTIME_SCOPE=incus-container")
  })

  it("container dry-run can configure an Ollama embedder without hardcoding local paths", () => {
    const temp = makeTempDir()
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
      "--token",
      "test-token-1234567890-secret",
      "--embedder",
      "ollama",
      "--ollama-base-url",
      "http://10.77.0.1:11434",
      "--ollama-embed-model",
      "qwen3-embedding:0.6b",
    ])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("LUNA_EMBEDDER=ollama")
    expect(result.stdout).toContain("LUNA_OLLAMA_BASE_URL=http://10.77.0.1:11434")
    expect(result.stdout).toContain("LUNA_OLLAMA_EMBED_MODEL=qwen3-embedding:0.6b")
  })

  it("container dry-run writes dev runtime metadata for the dev chat server", () => {
    const temp = makeTempDir()
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
      "--token",
      "test-token-1234567890-secret",
    ])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("LUNA_PROFILE=dev")
    expect(result.stdout).toContain("LUNA_CHAT_SERVER_NAME=luna-dev-chat-server")
    expect(result.stdout).toContain("LUNA_RUNTIME_SCOPE=incus-container")
    expect(result.stdout).toContain("LUNA_HOME=/root/.luna")
    expect(result.stdout).toContain("LUNA_DB_PATH=/root/.luna/luna.db")
    expect(result.stdout).toContain("LUNA_MEMORY_DB=/root/.luna/memory.db")
    expect(result.stdout).toContain("LUNA_ANALYTICS_DB_PATH=/root/.luna/analytics.duckdb")
    expect(result.stdout).toContain("LUNA_EVENTS_JSONL_PATH=/root/.luna/events.jsonl")
    expect(result.stdout).toContain("systemctl status luna-dev-chat-server.service")
  })

  it("container dry-run can enable dangerous local shell marker explicitly", () => {
    const temp = makeTempDir()
    const result = runScript("scripts/luna-container-create", [
      "--dry-run",
      "--profile",
      "stable",
      "--name",
      "luna-stable",
      "--repo-path",
      join(temp, "repo"),
      "--state-path",
      join(temp, "state"),
      "--token",
      "test-token-1234567890-secret",
      "--enable-dangerous-local-shell",
    ])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("touch")
    expect(result.stdout).toContain("allow-dangerous-local-shell")
    expect(result.stdout).toContain("LUNA_STABLE_DANGEROUS_AUTO_APPROVE_LOCAL_SHELL=1")
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
    expect(result.stdout).toContain("WorkingDirectory=" + join(temp, "repo", "apps", "ui-web"))
    expect(result.stdout).toContain("EnvironmentFile=" + join(temp, "state", ".env"))
    expect(result.stdout).toContain("ExecStart=/root/.bun/bin/bun run scripts/chat-server.ts")
    expect(result.stdout).toContain("LUNA_REPO_ROOT=" + join(temp, "repo"))
    expect(result.stdout).toContain("LUNA_PROFILE=stable")
    expect(result.stdout).toContain("LUNA_CHAT_SERVER_NAME=luna-chat-server")
    expect(result.stdout).toContain("LUNA_HOME=" + join(temp, "state"))
    expect(result.stdout).toContain("LUNA_DB_PATH=" + join(temp, "state", "luna.db"))
    expect(result.stdout).toContain("LUNA_MEMORY_DB=" + join(temp, "state", "memory.db"))
    expect(result.stdout).toContain("LUNA_ANALYTICS_DB_PATH=" + join(temp, "state", "analytics.duckdb"))
    expect(result.stdout).toContain("LUNA_EVENTS_JSONL_PATH=" + join(temp, "state", "events.jsonl"))
    expect(result.stdout).toContain("UI_WS_TOKEN=<redacted>")
    expect(result.stdout).not.toContain(token)
  })

  it("server install dry-run writes dev chat-server runtime metadata", () => {
    const temp = makeTempDir()

    const result = runScript("scripts/luna-server-install", [
      "--dry-run",
      "--profile",
      "dev",
      "--repo-dir",
      join(temp, "repo"),
      "--luna-home",
      join(temp, "state"),
      "--service-dir",
      join(temp, "systemd"),
      "--token",
      "server-token-1234567890-secret",
      "--skip-deps",
      "--no-enable",
      "--no-start",
    ], {
      env: {
        LUNA_TEST_BUN_PATH: "/root/.bun/bin/bun",
      },
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("Service: " + join(temp, "systemd", "luna-dev-chat-server.service"))
    expect(result.stdout).toContain("LUNA_PROFILE=dev")
    expect(result.stdout).toContain("LUNA_CHAT_SERVER_NAME=luna-dev-chat-server")
  })

  it("server install dry-run can configure an Ollama embedder", () => {
    const temp = makeTempDir()

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
      "server-token-1234567890-secret",
      "--skip-deps",
      "--no-enable",
      "--embedder",
      "ollama",
      "--ollama-base-url",
      "http://10.77.0.1:11434",
      "--ollama-embed-model",
      "embeddinggemma",
      "--ollama-probe-timeout-ms",
      "10000",
    ], {
      env: {
        LUNA_TEST_BUN_PATH: "/root/.bun/bin/bun",
      },
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("LUNA_EMBEDDER=ollama")
    expect(result.stdout).toContain("LUNA_OLLAMA_BASE_URL=http://10.77.0.1:11434")
    expect(result.stdout).toContain("LUNA_OLLAMA_EMBED_MODEL=embeddinggemma")
    expect(result.stdout).toContain("LUNA_OLLAMA_PROBE_TIMEOUT_MS=10000")
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

  it("server install tolerates cloud-init environments without HOME", () => {
    const temp = makeTempDir()

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
      "server-token-1234567890-secret",
      "--skip-deps",
      "--no-enable",
    ], {
      env: {
        HOME: undefined,
        PATH: "/usr/bin:/bin",
      },
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("ExecStart=/root/.bun/bin/bun run scripts/chat-server.ts")
  })

  it("server install replaces stale Claude Code overrides with the repo-bundled Linux binary", () => {
    const temp = makeTempDir()
    const repo = join(temp, "repo")
    const state = join(temp, "state")
    const serviceDir = join(temp, "systemd")
    const bin = join(temp, "bin")
    const bun = join(bin, "bun")
    const bundledClaude = join(
      repo,
      "node_modules",
      ".bun",
      "@anthropic-ai+claude-agent-sdk-linux-x64@0.2.119",
      "node_modules",
      "@anthropic-ai",
      "claude-agent-sdk-linux-x64",
      "claude",
    )
    mkdirSync(join(repo, ".git"), { recursive: true })
    mkdirSync(join(bundledClaude, ".."), { recursive: true })
    mkdirSync(state, { recursive: true })
    mkdirSync(bin, { recursive: true })
    writeFileSync(bun, "#!/usr/bin/env bash\nexit 0\n")
    writeFileSync(join(bin, "systemctl"), "#!/usr/bin/env bash\nexit 0\n")
    writeFileSync(bundledClaude, "#!/usr/bin/env bash\nexit 0\n")
    spawnSync("chmod", ["+x", bun, join(bin, "systemctl"), bundledClaude])
    writeFileSync(
      join(state, ".env"),
      [
        "UI_WS_TOKEN=server-token-1234567890-secret",
        "LUNA_CLAUDE_CODE_EXECUTABLE=/does/not/exist/claude",
        "",
      ].join("\n"),
    )

    const result = runScript("scripts/luna-server-install", [
      "--profile",
      "stable",
      "--repo-dir",
      repo,
      "--luna-home",
      state,
      "--service-dir",
      serviceDir,
      "--skip-deps",
      "--no-enable",
      "--no-start",
    ], {
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        LUNA_TEST_BUN_PATH: bun,
      },
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).toContain("removing stale LUNA_CLAUDE_CODE_EXECUTABLE")
    expect(readFileSync(join(state, ".env"), "utf8")).toContain(
      `LUNA_CLAUDE_CODE_EXECUTABLE=${bundledClaude}`,
    )
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
    expect(result.stdout).toContain("LUNA_STABLE_WS_URL=ws://jax-box:4753/ui")
    expect(result.stdout).toContain("LUNA_STABLE_FALLBACK_WS_URL=ws://jax-box.local:4753/ui")
    expect(result.stdout).toContain("LUNA_DEV_WS_URL=ws://jax-box:5753/ui")
    expect(result.stdout).toContain("LUNA_DEV_FALLBACK_WS_URL=ws://jax-box.local:5753/ui")
  })

  it("local installer can write generic SSH recovery fallbacks", () => {
    const temp = makeTempDir()

    const result = runScript("install.sh", [
      "--dry-run",
      "--luna-dir",
      join(temp, "repo"),
      "--bin-dir",
      join(temp, "bin"),
      "--enable-ssh-recovery",
      "--ssh-user",
      "admin",
      "--ssh-host",
      "primary.example.test",
      "--fallback-ssh-host",
      "lan.example.test",
    ], {
      env: {
        LUNA_TEST_BUN_PATH: "/opt/homebrew/bin/bun",
      },
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("LUNA_STABLE_START_MODE=ssh")
    expect(result.stdout).toContain("LUNA_STABLE_START_SSH=admin@primary.example.test")
    expect(result.stdout).toContain("LUNA_STABLE_FALLBACK_START_SSH=admin@lan.example.test")
    expect(result.stdout).toContain("LUNA_DEV_START_MODE=ssh")
    expect(result.stdout).toContain("LUNA_DEV_START_SSH=admin@primary.example.test")
    expect(result.stdout).toContain("LUNA_DEV_FALLBACK_START_SSH=admin@lan.example.test")
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

  it("jax-box docs use non-Tailscale-bound health probes", () => {
    const read = (path: string) => readFileSync(join(repoRoot, path), "utf8")
    const docs = [
      read("README.md"),
      read("docs/jax-box-deploy.md"),
    ].join("\n")

    expect(docs).not.toContain("tailscale ip")
    expect(docs).toContain("http://127.0.0.1:4753/healthz")
    expect(docs).toContain("http://127.0.0.1:5753/healthz")
    expect(docs).toContain("incus exec luna-stable -- systemctl restart luna-chat-server.service")
    expect(docs).not.toContain("systemctl --user restart luna-chat-server.service")
  })

  it("documents stable container cutover with candidate ports and rollback", () => {
    const read = (path: string) => readFileSync(join(repoRoot, path), "utf8")
    const readme = read("README.md")
    const install = read("docs/install.md")
    const runtime = read("docs/container-runtime.md")

    expect(readme).toContain("docs/container-runtime.md")
    expect(install).toContain("luna-stable")
    expect(install).toContain("--profile stable")
    expect(install).toContain("--host-ws-port 6753")
    expect(install).toContain("/root/luna/stable/repo")
    expect(install).toContain("/root/luna/dev/repo")

    expect(runtime).toContain("luna-stable")
    expect(runtime).toContain("--profile stable")
    expect(runtime).toContain("--host-ws-port 6753")
    expect(runtime).toContain("systemctl --user stop luna-chat-server.service")
    expect(runtime).toContain("systemctl stop luna-chat-server.service")
    expect(runtime).toContain("systemctl --user enable luna-chat-server.service")
    expect(runtime).toContain("systemctl enable luna-chat-server.service")
    expect(runtime).toContain("/root/.luna/stable-host-service-scope")
    expect(runtime).not.toContain("/tmp/luna-stable-service-scope")
    expect(runtime).toContain("incus config device remove luna-stable ws6753")
    expect(runtime).toContain("incus config device add luna-stable ws4753")
    expect(runtime).toContain("--enable-dangerous-local-shell")
    expect(runtime).toContain("not a filesystem sandbox")
    expect(runtime).toContain("rollback")
  })
})
