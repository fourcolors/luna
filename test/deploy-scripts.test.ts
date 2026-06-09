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
    // Hermetic default: pin the bind/listen auto-resolver to its loopback
    // fallback so the suite never depends on whether THIS machine has a tailnet
    // up (luna_resolve_bind_addr shells out to `tailscale` only when this is
    // unset). Tests that exercise tailnet detection override this with an IP.
    LUNA_TAILSCALE_IP: "",
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
    // BLOCKER #25: the host-proxy listen auto-resolves — the host's Tailscale IP
    // if a tailnet is present, else LOOPBACK (never the public wildcard). The
    // test harness pins LUNA_TAILSCALE_IP="" (no tailnet), so this exercises the
    // loopback fallback; the tailnet-detected path has its own test below.
    expect(result.stdout).toContain("listen=tcp:127.0.0.1:5753")
    expect(result.stdout).not.toContain("listen=tcp:0.0.0.0:5753")
    expect(result.stdout).toContain("connect=tcp:127.0.0.1:4753")
    expect(result.stdout).toContain("path=/root/luna")
    expect(result.stdout).toContain("LUNA_DEV_WS_URL=ws://jax-box:5753/ui")
    // The in-container chat server also binds loopback (the Incus proxy is the
    // sole ingress and targets 127.0.0.1) — never 0.0.0.0.
    expect(result.stdout).toContain("LUNA_UI_WS_HOST=127.0.0.1")
    expect(result.stdout).not.toContain("LUNA_UI_WS_HOST=0.0.0.0")
    // The loopback fallback warns the operator the server is local-only (so a
    // missing tailnet is never a silent surprise) — but it is NOT the public
    // 0.0.0.0 "no transport confidentiality" warning.
    expect(result.stderr).toContain("no Tailscale interface detected")
    expect(result.stderr).not.toContain("NO transport confidentiality")
    expect(result.stdout).not.toContain(token)
    expect(result.stdout).toContain("<redacted>")
  })

  it("container auto-resolves the host-proxy listen to the Tailscale IP when a tailnet is present", () => {
    const temp = makeTempDir()
    const token = "test-token-1234567890-secret"

    const result = runScript(
      "scripts/luna-container-create",
      [
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
      ],
      // A tailnet IS present (CGNAT 100.64.0.0/10): the host proxy binds it so
      // tailnet peers reach the server out of the box — the primary deployment.
      { env: { LUNA_TAILSCALE_IP: "100.64.0.7" } },
    )

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("listen=tcp:100.64.0.7:5753")
    expect(result.stdout).toContain("listen=tcp:100.64.0.7:5754")
    expect(result.stdout).not.toContain("listen=tcp:127.0.0.1:5753")
    // The in-container bind stays loopback (the proxy targets 127.0.0.1).
    expect(result.stdout).toContain("LUNA_UI_WS_HOST=127.0.0.1")
    // Binding the tailnet is safe + intended: no fallback warn, no public warn.
    expect(result.stderr).not.toContain("no Tailscale interface detected")
    expect(result.stderr).not.toContain("NO transport confidentiality")
  })

  it("container --i-understand-public opts into a 0.0.0.0 proxy listen with a loud warning", () => {
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
      "--i-understand-public",
    ])

    expect(result.status).toBe(0)
    // The conscious opt-in restores the public wildcard listen...
    expect(result.stdout).toContain("listen=tcp:0.0.0.0:5753")
    expect(result.stdout).toContain("listen=tcp:0.0.0.0:5754")
    // ...and prints the loud one-line transport-security warning (to stderr, so
    // it never collides with the stdout plan and never carries the token).
    expect(result.stderr).toContain("0.0.0.0")
    expect(result.stderr).toContain("NO transport confidentiality")
    expect(result.stderr).toContain("Tailscale")
    expect(result.stderr).not.toContain(token)
    // The in-container bind stays loopback regardless of host-proxy exposure.
    expect(result.stdout).toContain("LUNA_UI_WS_HOST=127.0.0.1")
  })

  it("container --listen-addr 0.0.0.0 (explicit) is honored AND warned about", () => {
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
      "--host-ws-port",
      "5753",
      "--host-control-port",
      "5754",
      "--token",
      token,
      "--listen-addr",
      "0.0.0.0",
    ])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("listen=tcp:0.0.0.0:5753")
    expect(result.stderr).toContain("NO transport confidentiality")
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

  it("container creation fails early when the in-container install never rendered its systemd unit", () => {
    const temp = makeTempDir()
    const bin = join(temp, "bin")
    const repo = join(temp, "repo")
    const state = join(temp, "state")
    mkdirSync(bin, { recursive: true })
    mkdirSync(join(repo, ".git"), { recursive: true })
    // A permissive fake incus: succeeds for the whole orchestration EXCEPT it
    // reports the in-container install never created /root/.luna/.env. `info`
    // with no arg passes the daemon-reachable probe; `info <instance>` fails so
    // the instance is treated as new (not an early no-op exit). `config set`
    // reads the cloud-init heredoc off stdin so the piped write can't SIGPIPE
    // the script under pipefail.
    writeFileSync(join(bin, "incus"), `#!/usr/bin/env bash
set -uo pipefail
cmd="\${1:-}"
if [[ "$#" -gt 0 ]]; then shift; fi
case "$cmd" in
  info)
    # No remaining arg → daemon reachability probe (succeed). With an instance
    # name → existence probe (fail, so the instance is treated as new).
    [[ "$#" -eq 0 ]] && exit 0
    exit 1
    ;;
  storage) exit 0 ;;
  network) exit 0 ;;
  profile)
    case "$*" in
      "device get default root pool") printf 'default\\n'; exit 0 ;;
      "device get default root path") printf '/\\n'; exit 0 ;;
      "device get default eth0 network") printf 'incusbr0\\n'; exit 0 ;;
    esac
    exit 0
    ;;
  config)
    [[ "\${1:-}" == "set" ]] && cat >/dev/null
    exit 0
    ;;
  exec)
    case "$*" in
      # Install failed before write_service → no unit under /etc/systemd/system.
      # /root/.luna/.env DOES exist (host-written + bind-mounted), so it must NOT
      # be what gates the check — only the in-container-FS unit is a valid signal.
      *"test -f /etc/systemd/system/"*) exit 1 ;;
    esac
    exit 0
    ;;
  *) exit 0 ;;
esac
`)
    const chmod = spawnSync("chmod", ["+x", join(bin, "incus")])
    expect(chmod.status).toBe(0)

    const result = runScript("scripts/luna-container-create", [
      "--profile",
      "dev",
      "--name",
      "luna-dev",
      "--repo-path",
      repo,
      "--state-path",
      state,
      "--token",
      "test-token-1234567890-secret",
      "--skip-clone",
    ], {
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("In-container luna-server-install failed")
    expect(result.stderr).toContain("incus logs")
  })

  it("container creation writes a new UI_WS_TOKEN without leaking it to stdout/stderr", () => {
    const temp = makeTempDir()
    const bin = join(temp, "bin")
    const repo = join(temp, "repo")
    const state = join(temp, "state")
    const token = "test-container-token-sentinel-88888888"
    mkdirSync(bin, { recursive: true })
    mkdirSync(join(repo, ".git"), { recursive: true })
    // Fully permissive fake incus: the entire non-dry-run orchestration succeeds
    // (info no-arg = daemon reachable; info <instance> = new; config set drains
    // the cloud-init heredoc off stdin; every exec/probe — including the post-
    // cloud-init `test -f /etc/systemd/system/<service>` install-success check —
    // returns 0) so the script reaches the real token-write codepath and exits 0.
    writeFileSync(join(bin, "incus"), `#!/usr/bin/env bash
set -uo pipefail
cmd="\${1:-}"
if [[ "$#" -gt 0 ]]; then shift; fi
case "$cmd" in
  info)
    [[ "$#" -eq 0 ]] && exit 0
    exit 1
    ;;
  storage) exit 0 ;;
  network) exit 0 ;;
  profile)
    case "$*" in
      "device get default root pool") printf 'default\\n'; exit 0 ;;
      "device get default root path") printf '/\\n'; exit 0 ;;
      "device get default eth0 network") printf 'incusbr0\\n'; exit 0 ;;
    esac
    exit 0
    ;;
  config)
    [[ "\${1:-}" == "set" ]] && cat >/dev/null
    exit 0
    ;;
  *) exit 0 ;;
esac
`)
    const chmod = spawnSync("chmod", ["+x", join(bin, "incus")])
    expect(chmod.status).toBe(0)

    const result = runScript("scripts/luna-container-create", [
      "--profile",
      "dev",
      "--name",
      "luna-dev",
      "--repo-path",
      repo,
      "--state-path",
      state,
      "--token",
      token,
      "--skip-clone",
    ], {
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
      },
    })

    expect(result.status, result.stderr).toBe(0)
    // The token lands only in the chmod-600 .env, never on the console.
    expect(result.stdout).not.toContain(token)
    expect(result.stderr).not.toContain(token)
    expect(readFileSync(join(state, ".env"), "utf8")).toContain(
      `UI_WS_TOKEN=${token}`,
    )
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
    expect(result.stdout).toContain("EnvironmentFile=-" + join(temp, "state", ".env"))
    expect(result.stdout).toContain("ExecStart=/root/.bun/bin/bun run scripts/chat-server.ts")
    // #28: HOME and PATH are load-bearing — systemd 259 sets neither for a root
    // system service, so omitting them silently lands the server in setup-mode.
    expect(result.stdout).toContain("Environment=HOME=")
    expect(result.stdout).toContain("Environment=PATH=/root/.bun/bin:")
    expect(result.stdout).toContain("Environment=CLAUDE_CONFIG_DIR=" + join(temp, "state", "claude"))
    expect(result.stdout).toContain("StandardOutput=append:" + join(temp, "state", "logs", "luna-chat-server.log"))
    expect(result.stdout).toContain("StandardError=append:" + join(temp, "state", "logs", "luna-chat-server-error.log"))
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
    // BLOCKER #25: the chat-server bind auto-resolves — the host's Tailscale IP
    // if a tailnet is present, else LOOPBACK. The harness pins LUNA_TAILSCALE_IP=""
    // (no tailnet), so this exercises the loopback fallback. It warns the server
    // is local-only, but never the public 0.0.0.0 "no transport confidentiality".
    expect(result.stdout).toContain("LUNA_UI_WS_HOST=127.0.0.1")
    expect(result.stdout).not.toContain("LUNA_UI_WS_HOST=0.0.0.0")
    expect(result.stderr).toContain("no Tailscale interface detected")
    expect(result.stderr).not.toContain("NO transport confidentiality")
  })

  it("server install auto-resolves the bind to the Tailscale IP when a tailnet is present", () => {
    const temp = makeTempDir()
    const token = "server-token-1234567890-secret"

    const result = runScript(
      "scripts/luna-server-install",
      [
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
        "--no-start",
      ],
      {
        env: {
          LUNA_TEST_BUN_PATH: "/root/.bun/bin/bun",
          // A tailnet IS present: a fresh bare-host install serves tailnet peers
          // out of the box without any flag — the primary remote deployment.
          LUNA_TAILSCALE_IP: "100.64.0.7",
        },
      },
    )

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("LUNA_UI_WS_HOST=100.64.0.7")
    expect(result.stdout).not.toContain("LUNA_UI_WS_HOST=127.0.0.1")
    // Binding the tailnet is safe + intended: no fallback warn, no public warn.
    expect(result.stderr).not.toContain("no Tailscale interface detected")
    expect(result.stderr).not.toContain("NO transport confidentiality")
    expect(result.stderr).not.toContain(token)
  })

  it("server install --i-understand-public binds 0.0.0.0 with a loud warning", () => {
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
      "--no-start",
      "--i-understand-public",
    ], {
      env: {
        LUNA_TEST_BUN_PATH: "/root/.bun/bin/bun",
      },
    })

    expect(result.status).toBe(0)
    // The conscious opt-in restores the public wildcard bind...
    expect(result.stdout).toContain("LUNA_UI_WS_HOST=0.0.0.0")
    // ...and prints the loud one-line transport-security warning to stderr (so
    // it never collides with the stdout plan and never carries the token).
    expect(result.stderr).toContain("0.0.0.0")
    expect(result.stderr).toContain("NO transport confidentiality")
    expect(result.stderr).toContain("Tailscale")
    expect(result.stderr).not.toContain(token)
  })

  it("server install --bind-host 0.0.0.0 (explicit) is honored AND warned about", () => {
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
      "--no-start",
      "--bind-host",
      "0.0.0.0",
    ], {
      env: {
        LUNA_TEST_BUN_PATH: "/root/.bun/bin/bun",
      },
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("LUNA_UI_WS_HOST=0.0.0.0")
    expect(result.stderr).toContain("NO transport confidentiality")
  })

  it("server install honors an explicit LUNA_UI_WS_HOST env (loopback stays quiet)", () => {
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
      "--no-start",
    ], {
      env: {
        LUNA_TEST_BUN_PATH: "/root/.bun/bin/bun",
        LUNA_UI_WS_HOST: "127.0.0.1",
      },
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("LUNA_UI_WS_HOST=127.0.0.1")
    expect(result.stderr).not.toContain("NO transport confidentiality")
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

  it("server install is idempotent — a second run on the same box changes nothing", () => {
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

    const args = [
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
    ]
    const env = {
      PATH: `${bin}:/usr/bin:/bin`,
      LUNA_TEST_BUN_PATH: bun,
    }

    const first = runScript("scripts/luna-server-install", args, { env })
    expect(first.status, first.stderr).toBe(0)
    // First run repairs the stale executable override.
    expect(first.stderr).toContain("removing stale LUNA_CLAUDE_CODE_EXECUTABLE")
    const envAfterFirst = readFileSync(join(state, ".env"), "utf8")
    const serviceFile = join(serviceDir, "luna-chat-server.service")
    const serviceAfterFirst = readFileSync(serviceFile, "utf8")
    expect(envAfterFirst).toContain(`LUNA_CLAUDE_CODE_EXECUTABLE=${bundledClaude}`)

    const second = runScript("scripts/luna-server-install", args, { env })
    expect(second.status, second.stderr).toBe(0)
    // Nothing stale remains, so the repair message must NOT reappear.
    expect(second.stderr).not.toContain("removing stale")
    // State is byte-for-byte identical after the second run.
    expect(readFileSync(join(state, ".env"), "utf8")).toBe(envAfterFirst)
    expect(readFileSync(serviceFile, "utf8")).toBe(serviceAfterFirst)
  })

  it("server install writes a new UI_WS_TOKEN without leaking it to stdout/stderr", () => {
    const temp = makeTempDir()
    const repo = join(temp, "repo")
    const state = join(temp, "state")
    const serviceDir = join(temp, "systemd")
    const bin = join(temp, "bin")
    const bun = join(bin, "bun")
    const token = "test-server-token-sentinel-99999999"
    mkdirSync(join(repo, ".git"), { recursive: true })
    mkdirSync(state, { recursive: true })
    mkdirSync(bin, { recursive: true })
    writeFileSync(bun, "#!/usr/bin/env bash\nexit 0\n")
    writeFileSync(join(bin, "systemctl"), "#!/usr/bin/env bash\nexit 0\n")
    spawnSync("chmod", ["+x", bun, join(bin, "systemctl")])
    // No pre-existing .env → the script takes the real token-write codepath.

    const result = runScript("scripts/luna-server-install", [
      "--profile",
      "stable",
      "--repo-dir",
      repo,
      "--luna-home",
      state,
      "--service-dir",
      serviceDir,
      "--token",
      token,
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
    // The token is written to the chmod-600 .env, never echoed to the console.
    expect(result.stdout).not.toContain(token)
    expect(result.stderr).not.toContain(token)
    expect(readFileSync(join(state, ".env"), "utf8")).toContain(
      `UI_WS_TOKEN=${token}`,
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

  it("ssh recovery start-commands restart as stop -> settle -> start, not a fast restart", () => {
    // Regression for the 2026-06-08 SQLITE_CANTOPEN deploy bug class: a fast
    // `systemctl restart` can start the new chat-server before the outgoing one
    // releases its DuckDB/SQLite WAL/SHM handles. The recovery defaults restart as
    // a clean stop -> settle (6s) -> start instead. Each profile keeps its own
    // systemd scope: stable = `--user`, dev = the in-container unit via incus exec
    // (the `;` sequence survives the .env round-trip and runs in both local and
    // ssh recovery modes).
    const temp = makeTempDir()

    const result = runScript("install.sh", [
      "--dry-run",
      "--luna-dir",
      join(temp, "repo"),
      "--bin-dir",
      join(temp, "bin"),
      "--enable-ssh-recovery",
    ], {
      env: {
        LUNA_TEST_BUN_PATH: "/opt/homebrew/bin/bun",
      },
    })

    expect(result.status).toBe(0)
    // Stable: --user scope, stop -> settle -> start.
    expect(result.stdout).toContain(
      "LUNA_STABLE_START_COMMAND=systemctl --user stop luna-chat-server.service; sleep 6; systemctl --user start luna-chat-server.service",
    )
    // Dev: in-container unit via incus exec, host-side settle between the execs.
    expect(result.stdout).toContain(
      "LUNA_DEV_START_COMMAND=incus exec luna-dev -- systemctl stop luna-dev-chat-server.service; sleep 6; incus exec luna-dev -- systemctl start luna-dev-chat-server.service",
    )
    // Neither default may be a fast `systemctl restart` (the bug).
    expect(result.stdout).not.toContain("LUNA_STABLE_START_COMMAND=systemctl --user restart")
    expect(result.stdout).not.toContain("LUNA_DEV_START_COMMAND=incus exec luna-dev -- systemctl restart")
  })

  it("installer honors a localhost stable override without leaking jax-box", () => {
    const temp = makeTempDir()

    const result = runScript("install.sh", [
      "--dry-run",
      "--luna-dir",
      join(temp, "repo"),
      "--bin-dir",
      join(temp, "bin"),
      "--stable-url",
      "ws://127.0.0.1:4753/ui",
      "--stable-fallback-url",
      "ws://127.0.0.1:4753/ui",
    ], {
      env: {
        LUNA_TEST_BUN_PATH: "/opt/homebrew/bin/bun",
      },
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("LUNA_STABLE_WS_URL=ws://127.0.0.1:4753/ui")
    expect(result.stdout).toContain("LUNA_STABLE_FALLBACK_WS_URL=ws://127.0.0.1:4753/ui")
    // The stable URL lines must not carry jax-box (the dev lines still may —
    // there is no local dev server to point at, see install-mac.command option 1).
    expect(result.stdout).not.toContain("LUNA_STABLE_WS_URL=ws://jax-box")
    expect(result.stdout).not.toContain("LUNA_STABLE_FALLBACK_WS_URL=ws://jax-box")
  })

  it("desktop install points the CLI at the local server, not jax-box", () => {
    const script = readFileSync(join(repoRoot, "install-mac.command"), "utf8")
    // A "Complete Desktop Install" runs the chat server locally, so the CLI must
    // be pointed at 127.0.0.1 — not install.sh's remote jax-box default (finding
    // #4). Override BOTH the primary and fallback URL or the fallback re-leaks
    // jax-box.local as the CLI's second connection target.
    expect(script).toContain("--stable-url ws://127.0.0.1:4753/ui")
    expect(script).toContain("--stable-fallback-url ws://127.0.0.1:4753/ui")
  })

  it("desktop install probes/serves the Vite UI on the correct port (5174, not 5173)", () => {
    const script = readFileSync(join(repoRoot, "install-mac.command"), "utf8")
    // Pre-existing bug the review caught: vite.config.ts binds the dev server on
    // 5174, but the installer probed/polled/opened 5173 (which Vite never bound).
    // All five references corrected to 5174.
    expect(script).not.toContain("5173")
    expect(script).toContain("http://localhost:5174")
    expect(script).toContain('ensure_port_free 5174 "Vite Web UI" "$LUNA_DIR"')
    // Decision latch (#3): keep the plain Vite dev server, NOT dev:preview —
    // `vite preview` is not a production server and would bake the token into
    // on-disk dist/. Do not let a refactor silently re-introduce it.
    expect(script).not.toContain("dev:preview")
  })

  it("desktop install writes only the canonical UI_WS_TOKEN, not a redundant LUNA_STABLE_UI_WS_TOKEN", () => {
    const script = readFileSync(join(repoRoot, "install-mac.command"), "utf8")
    // Finding #6: UI_WS_TOKEN is the canonical single-box token. The server reads
    // it (resolveUiWsToken) and the CLI's stable profile resolves the SAME value
    // via its UI_WS_TOKEN dotenv fallback — so the second hand-synced awk write of
    // LUNA_STABLE_UI_WS_TOKEN was pure duplication. Keep the canonical write;
    // drop the redundant one. (Readers still accept the old name for back-compat,
    // so existing on-disk .env files keep working — that invariant is unchanged.)
    expect(script).toContain('print "UI_WS_TOKEN=" token')
    // The redundant awk WRITE of LUNA_STABLE_UI_WS_TOKEN must be gone. We forbid
    // the awk print statement specifically (not any mention) so the documenting
    // comment that names LUNA_STABLE_UI_WS_TOKEN's remote-client role can stay.
    expect(script).not.toContain('print "LUNA_STABLE_UI_WS_TOKEN=" token')
    expect(script).not.toContain('index($0, "LUNA_STABLE_UI_WS_TOKEN=")')
  })

  it("anchors the token-seed guard so a profiled LUNA_*_UI_WS_TOKEN line can't suppress the canonical write", () => {
    const script = readFileSync(join(repoRoot, "install-mac.command"), "utf8")
    // Finding #6 follow-up: now that UI_WS_TOKEN is the SOLE canonical write, the
    // "do we already have a token?" guard must anchor ^UI_WS_TOKEN=. An unanchored
    // substring match also matches LUNA_STABLE_UI_WS_TOKEN= / LUNA_DEV_UI_WS_TOKEN=,
    // so a pre-existing .env carrying only a profiled name would skip the seed and
    // boot the server with NO UI_WS_TOKEN (resolveUiWsToken then throws).
    expect(script).toContain('grep -q "^UI_WS_TOKEN="')
    expect(script).not.toContain('grep -q "UI_WS_TOKEN="')
  })

  it("gen-token.sh emits a clean 32-char lowercase-hex token (SIGPIPE-safe, actually random)", () => {
    const result = runScript("scripts/lib/gen-token.sh", [])
    expect(result.status).toBe(0)
    // Clean 32-char hex — NOT the old `tr | head` pipeline that tripped
    // `set -o pipefail` and appended a constant fallback suffix.
    expect(result.stdout.trim()).toMatch(/^[a-f0-9]{32}$/)
    // Two runs must differ — proves it is real randomness, not a constant.
    const second = runScript("scripts/lib/gen-token.sh", [])
    expect(second.stdout.trim()).not.toBe(result.stdout.trim())
  })

  describe("port-guard (finding #7: no blind kill -9 on port conflict)", () => {
    const LIB = join(repoRoot, "scripts/lib/port-guard.sh")

    // Source the lib in a fresh bash and run `body`. Mocks for lsof/ps/kill can
    // be defined inside `body` BEFORE behavior runs — shell functions shadow the
    // builtins/PATH, so signals and lookups are observable without real processes.
    const runGuard = (
      body: string,
      opts: { readonly input?: string; readonly env?: Record<string, string | undefined> } = {},
    ) =>
      spawnSync("bash", ["-c", `set -uo pipefail; source "${LIB}"; ${body}`], {
        cwd: repoRoot,
        encoding: "utf8",
        input: opts.input,
        env: { ...process.env, ...opts.env },
      })

    // Guard with `command -v` so a missing matcher prints MISSING (not FOREIGN) —
    // otherwise the "foreign" tests would pass for the wrong reason (undefined
    // function → `if` falls to `else` → FOREIGN). MISSING fails every assertion.
    const verdict =
      'command -v port_guard_is_luna_cmd >/dev/null || { echo MISSING; exit 0; }; '
      + 'if port_guard_is_luna_cmd "$CMD" "$DIR"; then echo LUNA; else echo FOREIGN; fi'

    it("recognizes THIS install's chat-server as Luna", () => {
      const result = runGuard(verdict, {
        env: {
          CMD: "bun run --cwd /Users/me/luna/apps/ui-web scripts/chat-server.ts",
          DIR: "/Users/me/luna",
        },
      })
      expect(result.stdout.trim()).toBe("LUNA")
    })

    it("treats the real Tailscale IPNExtension as foreign — never killable", () => {
      const result = runGuard(verdict, {
        env: {
          // The actual command holding :4753 on Mr. Cobb's Mac (captured via ps).
          CMD: '/Applications/Tailscale.app/Contents/PlugIns/IPNExtension.appex/Contents/MacOS/IPNExtension -AppleLanguages ("en-US")',
          DIR: "/Users/me/luna",
        },
      })
      expect(result.stdout.trim()).toBe("FOREIGN")
    })

    it("treats a chat-server from a DIFFERENT install dir as foreign", () => {
      const result = runGuard(verdict, {
        env: {
          CMD: "bun run --cwd /Users/other/luna/apps/ui-web scripts/chat-server.ts",
          DIR: "/Users/me/luna",
        },
      })
      expect(result.stdout.trim()).toBe("FOREIGN")
    })

    it("recognizes THIS install's vite web UI dev server as Luna", () => {
      const result = runGuard(verdict, {
        env: {
          CMD: "bun run --cwd /Users/me/luna/apps/ui-web dev",
          DIR: "/Users/me/luna",
        },
      })
      expect(result.stdout.trim()).toBe("LUNA")
    })

    const rcOf = (r: { stdout: string }) => r.stdout.match(/rc=(\d+)/)?.[1]
    const DIR = "/Users/me/luna"
    const LUNA_CMD = "bun run --cwd /Users/me/luna/apps/ui-web scripts/chat-server.ts"
    const TAILSCALE_CMD =
      '/Applications/Tailscale.app/Contents/PlugIns/IPNExtension.appex/Contents/MacOS/IPNExtension -AppleLanguages ("en-US")'

    it("leaves a free port alone — never signals anything", () => {
      const temp = makeTempDir()
      const log = join(temp, "kill.log")
      // No conflicting (loopback/wildcard) listener on the port → nothing to do.
      const result = runGuard(
        `LOG="${log}"; : > "$LOG"\n`
        + `port_guard_conflicting_pid() { return 0; }\n` // empty → no conflict
        + `ps() { echo "$LUNA_CMD"; }\n`
        + `kill() { echo "kill $*" >> "$LOG"; }\n`
        + `ensure_port_free 4753 "Chat" "$DIR"; echo "rc=$?"`,
        { env: { DIR, LUNA_CMD } },
      )
      expect(rcOf(result)).toBe("0")
      expect(readFileSync(log, "utf8")).toBe("") // no kill of any kind
    })

    it("REFUSES a foreign holder (Tailscale) — never sends a signal", () => {
      const temp = makeTempDir()
      const log = join(temp, "kill.log")
      const result = runGuard(
        // A loopback/wildcard listener exists (conflicting PID) but ps reveals it
        // is foreign → refuse without signalling.
        `LOG="${log}"; : > "$LOG"\n`
        + `port_guard_conflicting_pid() { echo 28274; }\n`
        + `ps() { echo "$FOREIGN_CMD"; }\n`
        + `kill() { echo "kill $*" >> "$LOG"; }\n`
        + `ensure_port_free 4753 "Chat" "$DIR"; echo "rc=$?"`,
        { env: { DIR, FOREIGN_CMD: TAILSCALE_CMD } },
      )
      expect(rcOf(result)).toBe("1") // refused → caller aborts
      expect(readFileSync(log, "utf8")).toBe("") // Tailscale is NEVER signalled
      expect(result.stderr).toContain("held by another process")
      expect(result.stderr).toContain("IPNExtension")
    })

    it("stops a stale Luna gracefully — SIGTERM, no SIGKILL when it exits", () => {
      const temp = makeTempDir()
      const log = join(temp, "kill.log")
      const result = runGuard(
        // conflicting_pid → the stale PID; the port-free re-check → free (TERM worked).
        `LOG="${log}"; : > "$LOG"\n`
        + `port_guard_conflicting_pid() { echo 28274; }\n`
        + `port_guard_port_free() { return 0; }\n` // free after SIGTERM
        + `ps() { echo "$LUNA_CMD"; }\n`
        + `kill() { echo "kill $*" >> "$LOG"; }\n`
        + `ensure_port_free 4753 "Chat" "$DIR"; echo "rc=$?"`,
        { input: "y\n", env: { DIR, LUNA_CMD, LUNA_PORT_GUARD_TIMEOUT: "3" } },
      )
      expect(rcOf(result)).toBe("0")
      const killed = readFileSync(log, "utf8")
      expect(killed).toContain("kill -TERM 28274")
      expect(killed).not.toContain("-KILL")
      expect(killed).not.toContain("-9")
    })

    it("escalates to SIGKILL only when a stale Luna refuses to exit", () => {
      const temp = makeTempDir()
      const log = join(temp, "kill.log")
      const killed = join(temp, "killed.flag")
      const result = runGuard(
        // Port stays held (not free) until a SIGKILL is observed (stateful mock).
        `LOG="${log}"; : > "$LOG"\n`
        + `port_guard_conflicting_pid() { echo 28274; }\n`
        + `port_guard_port_free() { [[ -f "${killed}" ]] && return 0 || return 1; }\n`
        + `ps() { echo "$LUNA_CMD"; }\n`
        + `kill() { echo "kill $*" >> "$LOG"; case "$*" in *-KILL*) : > "${killed}" ;; esac; }\n`
        + `ensure_port_free 4753 "Chat" "$DIR"; echo "rc=$?"`,
        { input: "y\n", env: { DIR, LUNA_CMD, LUNA_PORT_GUARD_TIMEOUT: "1" } },
      )
      expect(rcOf(result)).toBe("0")
      const signals = readFileSync(log, "utf8")
      expect(signals).toContain("kill -TERM 28274") // graceful first
      expect(signals).toContain("kill -KILL 28274") // then escalate
    })

    // Unit-level: port_guard_conflicting_pid reads the real bind ADDRESS from an
    // lsof LISTEN listing and classifies it. A loopback (127.0.0.1 / [::1]) or
    // wildcard (* / 0.0.0.0 / [::]) bind WOULD block a fresh LOCAL bind → return
    // its PID. A specific non-loopback address (a Tailscale tailnet IP) would NOT
    // → return empty. Mocks lsof to emit a realistic macOS LISTEN row; the field
    // layout ($2=PID, $9=NAME=addr:port, $10=(LISTEN)) was captured live.
    const conflictPid = (name: string) =>
      runGuard(
        `lsof() { printf '%s\\n' `
        + `"COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME" `
        + `"bun 41589 me 7u IPv4 0x0 0t0 TCP ${name} (LISTEN)"; }\n`
        + `port_guard_conflicting_pid 4753`,
      ).stdout.trim()

    it("port_guard_conflicting_pid: a loopback/wildcard bind conflicts (returns the PID)", () => {
      expect(conflictPid("127.0.0.1:4753")).toBe("41589") // loopback v4
      expect(conflictPid("[::1]:4753")).toBe("41589") //     loopback v6
      expect(conflictPid("*:5174")).toBe("41589") //         vite wildcard
      expect(conflictPid("0.0.0.0:5174")).toBe("41589") //   wildcard v4
      expect(conflictPid("[::]:5174")).toBe("41589") //      wildcard v6
    })

    it("port_guard_conflicting_pid: a tailnet-only listener does NOT conflict (empty)", () => {
      expect(conflictPid("100.79.223.97:4753")).toBe("") //               Tailscale v4
      expect(conflictPid("[fd7a:115c:a1e0::5c01:df9a]:4753")).toBe("") // Tailscale v6
    })

    it("port_guard_conflicting_pid: scans PAST leading tailnet rows to a later loopback row", () => {
      // The real :4753 listing on a Tailscale box: two tailnet rows BEFORE the
      // loopback row (captured live). The classifier must scan past the
      // non-conflicting rows and still return the loopback PID — not short-circuit
      // empty on the first row, and not return Tailscale's PID.
      const result = runGuard(
        `lsof() { printf '%s\\n' `
        + `"COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME" `
        + `"IPNExtens 28274 me 28u IPv4 0x0 0t0 TCP 100.79.223.97:4753 (LISTEN)" `
        + `"IPNExtens 28274 me 30u IPv6 0x0 0t0 TCP [fd7a:115c:a1e0::5c01:df9a]:4753 (LISTEN)" `
        + `"bun 41589 me 7u IPv4 0x0 0t0 TCP 127.0.0.1:4753 (LISTEN)"; }\n`
        + `port_guard_conflicting_pid 4753`,
      )
      expect(result.stdout.trim()).toBe("41589") // the loopback bun, not Tailscale 28274
    })

    it("install-mac.command wires the guard and no longer blind-kills", () => {
      const script = readFileSync(join(repoRoot, "install-mac.command"), "utf8")
      expect(script).toContain("source scripts/lib/port-guard.sh")
      expect(script).toContain('ensure_port_free 4753 "Luna Chat Server" "$LUNA_DIR"')
      expect(script).toContain('ensure_port_free 5174 "Vite Web UI" "$LUNA_DIR"')
      // The dangerous old behavior must be gone for good (finding #7).
      expect(script).not.toContain("kill -9")
      expect(script).not.toContain("check_port")
    })
  })

  describe("luna-deploy env writes are atomic (finding: cross-filesystem mv)", () => {
    const LIB = join(repoRoot, "scripts/lib/luna-deploy.sh")

    // Source the lib in a fresh bash, mock `mktemp` to record the argument it is
    // invoked with (while delegating to the real binary), then run `body`. A
    // non-atomic write calls `mktemp` with NO argument → the temp file lands in
    // the system temp dir (a different filesystem from the target), so the
    // follow-up `mv` is a copy-then-delete that can lose the .env on a crash.
    // The fix passes `mktemp "$env_file.XXXXXXXX"` so the temp file is created
    // beside the target and the rename is atomic.
    const runDeploy = (body: string, env: Record<string, string | undefined>) =>
      spawnSync(
        "bash",
        [
          "-c",
          `set -uo pipefail; source "${LIB}"\n`
          + `mktemp() { printf '%s\\n' "$*" >> "$MKTEMP_LOG"; command mktemp "$@"; }\n`
          + body,
        ],
        { cwd: repoRoot, encoding: "utf8", env: { ...process.env, ...env } },
      )

    it("upsert creates its temp file beside the target .env (same filesystem)", () => {
      const temp = makeTempDir()
      const envFile = join(temp, ".env")
      const mktempLog = join(temp, "mktemp-args.log")

      const result = runDeploy(
        `luna_upsert_env "$ENV_FILE" FOO bar; echo "rc=$?"`,
        { ENV_FILE: envFile, MKTEMP_LOG: mktempLog },
      )

      expect(result.stdout).toContain("rc=0")
      // Every mktemp call must target the .env's own directory, never the
      // empty-arg (system temp) form.
      const args = readFileSync(mktempLog, "utf8").trim().split("\n").filter(Boolean)
      expect(args.length).toBeGreaterThan(0)
      for (const arg of args) {
        expect(arg.startsWith(envFile)).toBe(true)
      }
      // The write itself must still be correct.
      expect(readFileSync(envFile, "utf8")).toContain("FOO=bar")
    })

    it("remove creates its temp file beside the target .env (same filesystem)", () => {
      const temp = makeTempDir()
      const envFile = join(temp, ".env")
      const mktempLog = join(temp, "mktemp-args.log")
      writeFileSync(envFile, ["FOO=bar", "BAZ=qux", ""].join("\n"))

      const result = runDeploy(
        `luna_remove_env "$ENV_FILE" FOO; echo "rc=$?"`,
        { ENV_FILE: envFile, MKTEMP_LOG: mktempLog },
      )

      expect(result.stdout).toContain("rc=0")
      const args = readFileSync(mktempLog, "utf8").trim().split("\n").filter(Boolean)
      expect(args.length).toBeGreaterThan(0)
      for (const arg of args) {
        expect(arg.startsWith(envFile)).toBe(true)
      }
      // The removal itself must still be correct.
      const written = readFileSync(envFile, "utf8")
      expect(written).not.toContain("FOO=bar")
      expect(written).toContain("BAZ=qux")
    })
  })

  describe("launchd-plist (finding #2: supervise the desktop chat server)", () => {
    const LIB = join(repoRoot, "scripts/lib/launchd-plist.sh")
    const BUN = "/Users/me/.bun/bin/bun"
    const DIR = "/Users/me/luna"
    const HOME = "/Users/me/.luna"

    const render = () =>
      spawnSync(
        "bash",
        ["-c", `set -euo pipefail; source "${LIB}"; render_launchd_plist "${BUN}" "${DIR}" "${HOME}"`],
        { cwd: repoRoot, encoding: "utf8" },
      )

    it("uses the exact label control.restart kickstarts (com.user.luna-chat-server)", () => {
      const r = render()
      expect(r.status).toBe(0)
      expect(r.stdout).toContain("<key>Label</key>")
      expect(r.stdout).toContain("<string>com.user.luna-chat-server</string>")
    })

    it("launches the chat server via bun with the right cwd", () => {
      const r = render()
      expect(r.stdout).toContain(`<string>${BUN}</string>`)
      expect(r.stdout).toContain(`<string>${DIR}/apps/ui-web</string>`)
      expect(r.stdout).toContain("<string>scripts/chat-server.ts</string>")
    })

    it("supervises via KeepAlive SuccessfulExit=false — NOT systemd's Restart key", () => {
      const r = render()
      expect(r.stdout).toContain("<key>KeepAlive</key>")
      expect(r.stdout).toContain("<key>SuccessfulExit</key>")
      expect(r.stdout).toContain("<key>RunAtLoad</key>")
      // launchd has no `Restart`/`OnFailure` key — that was the sketch's systemd-ism.
      expect(r.stdout).not.toContain("OnFailure")
      expect(r.stdout).not.toContain("<key>Restart</key>")
    })

    it("routes logs to the luna home and sets LUNA_HOME / CLAUDE_CONFIG_DIR / PATH", () => {
      const r = render()
      expect(r.stdout).toContain(`<string>${HOME}/logs/server.log</string>`)
      expect(r.stdout).toContain("<key>LUNA_HOME</key>")
      expect(r.stdout).toContain(`<string>${HOME}</string>`)
      expect(r.stdout).toContain("<key>CLAUDE_CONFIG_DIR</key>")
      expect(r.stdout).toContain(`<string>${HOME}/claude</string>`)
      expect(r.stdout).toContain("<key>PATH</key>")
    })

    it("emits a plist that passes plutil -lint (valid property list)", () => {
      const r = render()
      const tmp = makeTempDir()
      const plistPath = join(tmp, "luna.plist")
      writeFileSync(plistPath, r.stdout)
      const lint = spawnSync("plutil", ["-lint", plistPath], { encoding: "utf8" })
      expect(lint.status, lint.stdout + lint.stderr).toBe(0)
      expect(lint.stdout).toContain("OK")
    })

    it("desktop install supervises the chat server via launchd, not unsupervised nohup", () => {
      const script = readFileSync(join(repoRoot, "install-mac.command"), "utf8")
      expect(script).toContain("source scripts/lib/launchd-plist.sh")
      expect(script).toContain("render_launchd_plist")
      // Modern launchctl (bootstrap/bootout, not the deprecated load/unload) into
      // the gui/<uid> domain that control.restart's kickstart targets.
      expect(script).toContain("launchctl bootstrap")
      expect(script).toContain("launchctl bootout")
      expect(script).toContain("com.user.luna-chat-server")
      // The old UNSUPERVISED nohup launch of the chat server must be gone (the
      // Vite UI may still use nohup — this only targets the chat-server line).
      expect(script).not.toMatch(/nohup bun run [^\n]*chat-server\.ts/)
    })
  })

  describe("luna-moon native widget (install option 4)", () => {
    it("install-mac.command wires option 4 for the moon widget (cargo tauri dev + cargo-tauri check)", () => {
      const script = readFileSync(join(repoRoot, "install-mac.command"), "utf8")
      // Option 4 must check for cargo and cargo-tauri prerequisites.
      expect(script).toContain("cargo-tauri")
      expect(script).toContain("cargo tauri dev")
      // The option must show a user-visible label identifying it as the moon widget path.
      expect(script).toContain("Luna Moon")
    })

    it("moon widget Rust backend emits the luna-config startup event", () => {
      const rustSrc = readFileSync(
        join(repoRoot, "apps/ui-moon-tauri/src-tauri/src/main.rs"),
        "utf8",
      )
      // The Rust backend must emit a "luna-config" event seeding the token from
      // ~/.luna/.env so the widget connects without manual settings-panel input.
      expect(rustSrc).toContain('"luna-config"')
      expect(rustSrc).toContain("UI_WS_TOKEN=")
    })

    it("moon widget frontend listens for the luna-config event and seeds localStorage", () => {
      const html = readFileSync(
        join(repoRoot, "apps/ui-moon-tauri/frontend/index.html"),
        "utf8",
      )
      // The JS must listen for the Tauri event and save the token to localStorage
      // so re-launches remember it without re-emitting.
      expect(html).toContain("listen('luna-config'")
      expect(html).toContain("luna_ws_token")
      // The __TAURI__ guard must be present so the page still loads in a plain browser.
      expect(html).toContain("window.__TAURI__")
    })
  })

  it("script entrypoints are executable", () => {
    for (const script of [
      "install.sh",
      "install-mac.command",
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
