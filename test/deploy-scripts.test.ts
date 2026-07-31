import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { afterEach, describe, expect, it } from "vitest"
import { makeRestrictedBin } from "./helpers/guardian-harness"

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

// Hermetic bun seam (the HOST_ENV_TESTS follow-up in vitest.config.ts): an
// executable stub for LUNA_TEST_BUN_PATH, so rendered plans/units derive from
// the fixture instead of naming a path only some hosts have (/root/.bun on
// Linux roots, /opt/homebrew on Macs). The dry-run installers skip the -x
// check today, but the stub is real so that can change without breaking tests.
const makeBunStub = (temp: string) => {
  const bin = join(temp, "stub-bin")
  mkdirSync(bin, { recursive: true })
  const bun = join(bin, "bun")
  writeFileSync(bun, "#!/usr/bin/env bash\nexit 0\n")
  expect(spawnSync("chmod", ["+x", bun]).status).toBe(0)
  return { bin, bun }
}

const writePermissiveSystemctl = (bin: string) => {
  writeFileSync(join(bin, "systemctl"), [
    '#!/usr/bin/env bash',
    'set -u',
    'units="${LUNA_TEST_SYSTEMD_DIR:-/etc/systemd/system}"',
    'cmd="${1:-}"; shift || true',
    'case "$cmd" in',
    '  show)',
    '    unit="$1"; shift; prop=""',
    '    while [[ $# -gt 0 ]]; do case "$1" in -p) prop="$2"; shift 2 ;; *) shift ;; esac; done',
    '    case "$unit:$prop" in',
    '      luna-guardian-*.timer:LoadState) [[ -f "$units/$unit" ]] && echo loaded || echo not-found ;;',
    '      luna-guardian-*.timer:UnitFileState) echo enabled ;;',
    '      luna-guardian-*.timer:ActiveState) echo active ;;',
    '      luna-autodeploy-*.timer:LoadState) [[ -f "$units/$unit" ]] && echo loaded || echo not-found ;;',
    '      luna-autodeploy-*.timer:UnitFileState) [[ -f "$units/$unit" ]] && echo enabled || echo disabled ;;',
    '      luna-autodeploy-*.timer:ActiveState) [[ -f "$units/$unit" ]] && echo active || echo inactive ;;',
    '      *) echo "" ;;',
    '    esac',
    '    ;;',
    '  *) exit 0 ;;',
    'esac',
    '',
  ].join('\n'))
  expect(spawnSync("chmod", ["+x", join(bin, "systemctl")]).status).toBe(0)
}

// A fully permissive fake incus + systemctl in `bin`: the entire non-dry-run
// container orchestration succeeds (info no-arg = daemon reachable; info
// <instance> = new; config set drains the cloud-init heredoc off stdin; every
// exec/probe returns 0) so the script reaches the host-side timer install.
const writePermissiveIncus = (bin: string) => {
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
  expect(spawnSync("chmod", ["+x", join(bin, "incus")]).status).toBe(0)
  writePermissiveSystemctl(bin)
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

  it("container dry-run --fence derives a reject range that excludes the gateway", () => {
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
      "--fence",
      "--fence-gateway",
      "10.77.0.1/24",
    ])

    expect(result.status, `stderr: ${result.stderr}`).toBe(0)
    expect(result.stdout).toContain("incus network acl create luna-dev-fence")
    // Allow-gateway rule is emitted first and pins the gateway /32...
    expect(result.stdout).toContain("destination=10.77.0.1/32")
    // ...and the reject destination is a range that EXCLUDES the gateway,
    // never the full subnet CIDR (the root-cause bug this PR fixes).
    expect(result.stdout).toContain("destination=10.77.0.2-10.77.0.254")
    expect(result.stdout).not.toContain("destination=10.77.0.0/24")
    expect(result.stdout).toContain("security.acls=luna-dev-fence")
  })

  it("container dry-run --fence emits two reject ranges for a mid-subnet gateway", () => {
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
      "--fence",
      "--fence-gateway",
      "10.77.0.10/24",
    ])

    expect(result.status, `stderr: ${result.stderr}`).toBe(0)
    expect(result.stdout).toContain("destination=10.77.0.1-10.77.0.9")
    expect(result.stdout).toContain("destination=10.77.0.11-10.77.0.254")
  })

  it("container --fence rejects a gateway with an out-of-range octet", () => {
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
      "--fence",
      "--fence-gateway",
      "10.77.0.300/24",
    ])

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("octet")
    expect(result.stderr).toContain("300")
  })

  it("container --fence rejects a gateway CIDR with a missing octet", () => {
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
      "--fence",
      "--fence-gateway",
      "10.77.0/24",
    ])

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("octet")
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

    // PATH contains EXACTLY the tools the script needs up to the incus
    // preflight — and no incus. The old PATH=/usr/bin:/bin found the real
    // /usr/bin/incus on jax-box, so the preflight PASSED and the script ran a
    // REAL network clone of fourcolors/luna before failing later.
    const restricted = makeRestrictedBin(temp, ["bash", "dirname", "sed", "tr"])
    const result = runScript("scripts/luna-container-create", [
      "--name",
      "luna-test",
      "--repo-path",
      join(temp, "repo"),
      "--state-path",
      join(temp, "state"),
    ], {
      env: {
        PATH: restricted,
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("Incus CLI not found")
    // Fails BEFORE mutation: no clone, no repo dir — the property in the name.
    expect(existsSync(join(temp, "repo"))).toBe(false)
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

    // Hermetic auto-update seams: the post-create timer install must never
    // touch the real /etc/luna or /etc/systemd/system, even when the suite
    // runs as root on a Linux box.
    const unitDir = join(temp, "units")
    mkdirSync(unitDir)
    writePermissiveSystemctl(bin)

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
        LUNA_SERVERS_CONFIG: join(temp, "etc-luna", "servers.toml"),
        LUNA_TEST_SYSTEMD_DIR: unitDir,
        LUNA_GUARDIAN_PIN_BASE: join(temp, "guardian-pins"),
        LUNA_GUARDIAN_STATE_DIR: join(temp, "guardian-state"),
        LUNA_UPDATE_STATE_DIR: join(temp, "update-state"),
        LUNA_TEST_RUNTIME_MATCHES_CHECKOUT: "true",
      },
    })

    expect(result.status, result.stderr).toBe(0)
    // The token lands only in the chmod-600 .env, never on the console.
    expect(result.stdout).not.toContain(token)
    expect(result.stderr).not.toContain(token)
    expect(readFileSync(join(state, ".env"), "utf8")).toContain(
      `UI_WS_TOKEN=${token}`,
    )
    // Default-on auto-update: provisioning seeded the registry from the repo
    // template and rendered + enabled the host-side autodeploy timer.
    const seeded = readFileSync(join(temp, "etc-luna", "servers.toml"), "utf8")
    expect(seeded).toContain('"registry"')
    // The ACTUAL --repo-path is rendered into the dev stanza's hostRepoDir so a
    // custom path never yields a timer pointing at a nonexistent repo.
    expect(seeded).toContain(`update.params.hostRepoDir         = "${repo}"`)
    // The stable stanza (a different profile) keeps the template default.
    expect(seeded).toContain(`"/root/luna/stable/repo"`)
    const service = readFileSync(join(unitDir, "luna-guardian-dev.service"), "utf8")
    expect(service).toMatch(/^ExecStart=.*luna-guardian check dev$/m)
    expect(service).toContain("OnFailure=luna-guardian-alert-dev.service")
    expect(readFileSync(join(unitDir, "luna-guardian-dev.timer"), "utf8")).toContain(
      "OnUnitInactiveSec=1min",
    )
    expect(result.stdout).toContain("Guardian enabled for 'dev'")
  })

  it("installs the timer when an existing registry's stanza already points at --repo-path", () => {
    const temp = makeTempDir()
    const bin = join(temp, "bin")
    const repo = join(temp, "repo")
    const state = join(temp, "state")
    const token = "test-container-token-sentinel-77777777"
    mkdirSync(bin, { recursive: true })
    mkdirSync(join(repo, ".git"), { recursive: true })
    writePermissiveIncus(bin)

    const unitDir = join(temp, "units")
    mkdirSync(unitDir)

    // Operator-owned registry already present (e.g. a prior profile on this
    // host) whose dev stanza already names THIS container's repo path.
    const registry = join(temp, "etc-luna", "servers.toml")
    mkdirSync(join(temp, "etc-luna"))
    writeFileSync(registry, `kind          = "registry"
schemaVersion = 1
host          = "jax-box"

[[server]]
name        = "dev"
enabled     = true
update.params.hostRepoDir         = "${repo}"
update.params.ref                 = "origin/dev"
runtime.target.incus.container    = "luna-dev"
ports.proxy = 4753
deploy.timer         = true
deploy.timerInterval = "3min"
deploy.autoUpdate    = true
`)
    spawnSync("chmod", ["600", registry])

    const result = runScript("scripts/luna-container-create", [
      "--profile", "dev",
      "--name", "luna-dev",
      "--repo-path", repo,
      "--state-path", state,
      "--token", token,
      "--skip-clone",
    ], {
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        LUNA_SERVERS_CONFIG: registry,
        LUNA_TEST_SYSTEMD_DIR: unitDir,
        LUNA_GUARDIAN_PIN_BASE: join(temp, "guardian-pins"),
        LUNA_GUARDIAN_STATE_DIR: join(temp, "guardian-state"),
        LUNA_UPDATE_STATE_DIR: join(temp, "update-state"),
        LUNA_TEST_RUNTIME_MATCHES_CHECKOUT: "true",
      },
    })

    expect(result.status, result.stderr).toBe(0)
    // The existing registry is never rewritten.
    expect(readFileSync(registry, "utf8")).toContain(
      `update.params.hostRepoDir         = "${repo}"`,
    )
    // The timer installs against the matching path.
    expect(result.stdout).toContain("Guardian enabled for 'dev'")
    const service = readFileSync(join(unitDir, "luna-guardian-dev.service"), "utf8")
    expect(service).toMatch(/^ExecStart=.*luna-guardian check dev$/m)
  })

  it("warns and skips the timer when an existing registry's stanza points elsewhere than --repo-path", () => {
    const temp = makeTempDir()
    const bin = join(temp, "bin")
    const repo = join(temp, "repo")
    const state = join(temp, "state")
    const token = "test-container-token-sentinel-66666666"
    mkdirSync(bin, { recursive: true })
    mkdirSync(join(repo, ".git"), { recursive: true })
    writePermissiveIncus(bin)

    const unitDir = join(temp, "units")
    mkdirSync(unitDir)

    // Existing registry whose dev stanza points at the template default, NOT at
    // this container's custom --repo-path.
    const staleRepo = "/root/luna/dev/repo"
    const registry = join(temp, "etc-luna", "servers.toml")
    mkdirSync(join(temp, "etc-luna"))
    writeFileSync(registry, `kind          = "registry"
schemaVersion = 1
host          = "jax-box"

[[server]]
name        = "dev"
enabled     = true
update.params.hostRepoDir         = "${staleRepo}"
update.params.ref                 = "origin/dev"
runtime.target.incus.container    = "luna-dev"
ports.proxy = 4753
deploy.timer         = true
deploy.timerInterval = "3min"
deploy.autoUpdate    = true
`)
    spawnSync("chmod", ["600", registry])

    const result = runScript("scripts/luna-container-create", [
      "--profile", "dev",
      "--name", "luna-dev",
      "--repo-path", repo,
      "--state-path", state,
      "--token", token,
      "--skip-clone",
    ], {
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        LUNA_SERVERS_CONFIG: registry,
        LUNA_TEST_SYSTEMD_DIR: unitDir,
      },
    })

    // The container itself is fine; only the timer is withheld.
    expect(result.status, result.stderr).toBe(0)
    // The warning names both the stale path and the actual --repo-path.
    expect(result.stderr).toContain(staleRepo)
    expect(result.stderr).toContain(repo)
    expect(result.stderr).toContain("luna-guardian install dev")
    // No timer installed, and the operator registry is left untouched.
    expect(result.stdout).not.toContain("Auto-update timer enabled for 'dev'")
    expect(existsSync(join(unitDir, "luna-autodeploy-dev.service"))).toBe(false)
    expect(readFileSync(registry, "utf8")).toContain(
      `update.params.hostRepoDir         = "${staleRepo}"`,
    )
  })

  it("container --no-auto-update skips the timer install and says how to enable it later", () => {
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
      "--no-auto-update",
    ])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("Guardian skipped (--no-auto-update)")
    expect(result.stdout).not.toMatch(/^\+ .*luna-guardian install stable$/m)
  })

  it("container dry-run plans the auto-update timer install by default", () => {
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
    ], {
      // Pin the registry path so the plan is identical whether or not the
      // machine running the suite has a real /etc/luna/servers.toml.
      env: { LUNA_SERVERS_CONFIG: join(temp, "etc-luna", "servers.toml") },
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/^\+ .*luna-guardian install stable$/m)
    // Registry absent at the pinned path → the plan includes seeding it.
    expect(result.stdout).toContain("seeds/servers.toml")
  })

  it("server install dry-run renders the systemd service and preserves token secrecy", () => {
    const temp = makeTempDir()
    const token = "server-token-1234567890-secret"
    const { bin, bun } = makeBunStub(temp)

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
        LUNA_TEST_BUN_PATH: bun,
      },
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("WorkingDirectory=" + join(temp, "repo", "apps", "ui-web"))
    expect(result.stdout).toContain("EnvironmentFile=-" + join(temp, "state", ".env"))
    expect(result.stdout).toContain("ExecStart=" + bun + " run scripts/chat-server.ts")
    // Liveness ladder L1: hang detection. Type=notify holds the unit in
    // `activating` until the app's READY=1; WatchdogSec restarts a
    // wedged-but-alive process; NotifyAccess=all because beats arrive from a
    // spawned systemd-notify child, not MainPID.
    expect(result.stdout).toContain("Type=notify")
    expect(result.stdout).toContain("NotifyAccess=all")
    expect(result.stdout).toContain("WatchdogSec=90")
    expect(result.stdout).toContain("TimeoutStartSec=60")
    expect(result.stdout).toContain("RestartSec=5")
    // Liveness ladder L2: crash-loop escalation fires the per-profile pager
    // unit. INVARIANT — the window must hold Burst cycles of the WORST
    // failure class or the loop never enters failed state and repeats
    // silently forever (the Sol failure mode):
    //   wedged-at-start cycle    = TimeoutStartSec + RestartSec       =  65s
    //   wedged-after-READY cycle = boot-to-READY + WatchdogSec + RestartSec ≈ 155s
    //   1800 >= 10 * 155 = 1550 ✓
    expect(result.stdout).toContain("StartLimitIntervalSec=1800")
    expect(result.stdout).toContain("StartLimitBurst=10")
    expect(result.stdout).toContain("OnFailure=luna-alert-luna-chat-server.service")
    // #28: HOME and PATH are load-bearing — systemd 259 sets neither for a root
    // system service, so omitting them silently lands the server in setup-mode.
    expect(result.stdout).toContain("Environment=HOME=")
    expect(result.stdout).toContain("Environment=PATH=" + bin + ":")
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

  it("server install dry-run renders the luna-alert@ pager unit alongside the service", () => {
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
    ], {
      env: {
        LUNA_TEST_BUN_PATH: makeBunStub(temp).bun,
      },
    })

    expect(result.status).toBe(0)
    // Non-stable profile → per-profile unit name flows into OnFailure=.
    expect(result.stdout).toContain("OnFailure=luna-alert-luna-dev-chat-server.service")
    // The pager unit is CONCRETE per profile (no %i template): dev + stable
    // co-installed on one host must not share a template whose baked-in
    // LUNA_HOME/pager.env belongs to whichever profile installed last.
    expect(result.stdout).toContain("Would write " + join(temp, "systemd", "luna-alert-luna-dev-chat-server.service"))
    expect(result.stdout).toContain("Description=Luna failure pager (luna-dev-chat-server)")
    expect(result.stdout).toContain("Type=oneshot")
    expect(result.stdout).toContain("ExecStart=" + join(temp, "repo", "scripts", "luna-pager") + " luna-dev-chat-server")
    expect(result.stdout).not.toContain("%i")
    // Pager env: dedicated token file, never Luna's own .env — provisioned
    // owner-only (the operator writes the token into it by hand later).
    expect(result.stdout).toContain("EnvironmentFile=-" + join(temp, "state", "pager.env"))
    expect(result.stdout).toContain("Environment=LUNA_HOME=" + join(temp, "state"))
    expect(result.stdout).toContain("chmod 600 " + join(temp, "state", "pager.env"))
    // Version-skew guard: the temp repo has no sd-notify.ts, so the installer
    // must warn that this checkout cannot satisfy the Type=notify unit.
    expect(result.stderr).toContain("sd-notify.ts")
  })

  it("does NOT emit the version-skew warning when the checkout has sd-notify.ts", () => {
    const temp = makeTempDir()
    // Provision the S1 marker file so the guard has nothing to warn about.
    mkdirSync(join(temp, "repo", "apps", "ui-web", "scripts"), { recursive: true })
    writeFileSync(join(temp, "repo", "apps", "ui-web", "scripts", "sd-notify.ts"), "// present")

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
    ], {
      env: {
        LUNA_TEST_BUN_PATH: makeBunStub(temp).bun,
      },
    })

    expect(result.status).toBe(0)
    expect(result.stderr).not.toContain("sd-notify.ts")
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
          LUNA_TEST_BUN_PATH: makeBunStub(temp).bun,
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
        LUNA_TEST_BUN_PATH: makeBunStub(temp).bun,
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
        LUNA_TEST_BUN_PATH: makeBunStub(temp).bun,
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
        LUNA_TEST_BUN_PATH: makeBunStub(temp).bun,
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
        LUNA_TEST_BUN_PATH: makeBunStub(temp).bun,
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
        LUNA_TEST_BUN_PATH: makeBunStub(temp).bun,
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
        LUNA_TEST_BUN_PATH: makeBunStub(temp).bun,
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
        LUNA_TEST_BUN_PATH: makeBunStub(temp).bun,
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
        LUNA_TEST_BUN_PATH: makeBunStub(temp).bun,
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
        LUNA_TEST_BUN_PATH: makeBunStub(temp).bun,
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
          // The actual command holding :4753 on a dev Mac (captured via ps).
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
      expect(conflictPid("100.x.y.z:4753")).toBe("") //                   Tailscale v4
      expect(conflictPid("[fd7a:115c::1]:4753")).toBe("") //              Tailscale v6
    })

    it("port_guard_conflicting_pid: scans PAST leading tailnet rows to a later loopback row", () => {
      // The real :4753 listing on a Tailscale box: two tailnet rows BEFORE the
      // loopback row (captured live). The classifier must scan past the
      // non-conflicting rows and still return the loopback PID — not short-circuit
      // empty on the first row, and not return Tailscale's PID.
      const result = runGuard(
        `lsof() { printf '%s\\n' `
        + `"COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME" `
        + `"IPNExtens 28274 me 28u IPv4 0x0 0t0 TCP 100.x.y.z:4753 (LISTEN)" `
        + `"IPNExtens 28274 me 30u IPv6 0x0 0t0 TCP [fd7a:115c::1]:4753 (LISTEN)" `
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

    it("supervises via KeepAlive=true (always respawn) — NOT systemd's Restart key", () => {
      const r = render()
      expect(r.stdout).toContain("<key>KeepAlive</key>")
      expect(r.stdout).toContain("<key>RunAtLoad</key>")
      // Sol-autopsy fix: `{SuccessfulExit=false}` treated a graceful
      // SIGTERM→exit(0) as "stay stopped" — the clean-exit loophole that kept
      // Sol dead for 50 days. KeepAlive must be the bare <true/> (parity with
      // systemd Restart=always); intentional stops use `launchctl bootout`.
      expect(r.stdout).not.toContain("<key>SuccessfulExit</key>")
      expect(r.stdout).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/)
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

    // The ONLY macOS-only case in this file: `plutil` ships with macOS and has
    // no Linux equivalent, so it cannot run on the Linux CI runner. Every other
    // test here shells out to bash/chmod/sed/awk, which are portable. Guarding
    // just this one is what lets the vitest step be a HARD GATE - see ci.yml.
    // It still runs (and must pass) on any macOS dev machine.
    it.skipIf(process.platform !== "darwin")("emits a plist that passes plutil -lint (valid property list)", () => {
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
    // Docs must show the SAFE restart: stop -> settle -> start, NOT a fast
    // `systemctl restart`. A fast restart can start the new chat-server before the
    // outgoing one releases its DuckDB/SQLite WAL/SHM handles, crashing the boot
    // with SQLITE_CANTOPEN (the 2026-06-08 stable-deploy incident).
    expect(docs).toContain("incus exec luna-stable -- systemctl stop luna-chat-server.service")
    expect(docs).toContain("incus exec luna-stable -- systemctl start luna-chat-server.service")
    expect(docs).not.toContain("incus exec luna-stable -- systemctl restart luna-chat-server.service")
    expect(docs).not.toContain("incus exec luna-dev -- systemctl restart luna-dev-chat-server.service")
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

  describe("luna-update-server supervisor abstraction", () => {
    // Shared helper: make a minimal git repo + a PATH shim directory with fake
    // executables that log their argv and emit canned output. Returns paths for
    // reuse across tests.
    const makeUpdateEnv = (temp: string) => {
      const repo = join(temp, "repo")
      const bin = join(temp, "bin")
      mkdirSync(join(repo, ".git"), { recursive: true })
      mkdirSync(bin, { recursive: true })
      // Phase-3 artifact-postcondition fixtures: the engine now verifies the
      // ui-web build artifact (and node_modules after a lockfile-changed
      // install) after every apply; the fake-git live runs here would
      // otherwise roll back on the dist probe.
      mkdirSync(join(repo, "node_modules"), { recursive: true })
      writeFileSync(join(repo, "node_modules", ".keep"), "keep\n")
      mkdirSync(join(repo, "apps", "ui-web", "dist"), { recursive: true })
      writeFileSync(join(repo, "apps", "ui-web", "dist", "index.html"), "<!doctype html>\n")
      return { repo, bin }
    }

    // Write a fake executable that logs all argv to a file and emits canned stdout.
    const writeFake = (
      path: string,
      body: string,
    ) => {
      writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`)
      spawnSync("chmod", ["+x", path])
    }

    // Run luna-update-server with given args+env, short-circuiting after the unit
    // existence check by injecting a fake git repo and fake binaries.
    const runUpdate = (
      temp: string,
      args: ReadonlyArray<string>,
      extraEnv: Record<string, string | undefined> = {},
    ) => {
      const { repo, bin } = makeUpdateEnv(temp)
      return spawnSync(
        "bash",
        [join(repoRoot, "scripts/luna-update-server"), ...args],
        {
          cwd: repoRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
            LUNA_TEST_BUN_PATH: join(bin, "bun"),
            LUNA_RESTART_SETTLE_SECS: "0",
            LUNA_READINESS_TIMEOUT: "2",
            LUNA_READINESS_INTERVAL: "1",
            // The engine's in-primitive session guard must never read the LIVE
            // host's socket table from a test; pin the count to idle.
            LUNA_TEST_WS_COUNT: "0",
            ...extraEnv,
          },
        },
      )
    }

    it("validation: --supervisor launchd --incus x exits non-zero with a clear message", () => {
      const temp = makeTempDir()
      const result = runUpdate(temp, [
        "--supervisor", "launchd",
        "--incus", "luna-stable",
        "--repo-dir", join(temp, "repo"),
        "--dry-run",
      ])
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain("launchd")
      expect(result.stderr).toContain("incus")
    })

    it("validation: --supervisor launchd --user exits non-zero with a clear message", () => {
      const temp = makeTempDir()
      const result = runUpdate(temp, [
        "--supervisor", "launchd",
        "--user",
        "--repo-dir", join(temp, "repo"),
        "--dry-run",
      ])
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain("launchd")
      expect(result.stderr).toContain("user")
    })

    it("validation: --user --incus x exits non-zero with a clear message", () => {
      const temp = makeTempDir()
      const result = runUpdate(temp, [
        "--user",
        "--incus", "luna-stable",
        "--repo-dir", join(temp, "repo"),
        "--dry-run",
      ])
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain("user")
      expect(result.stderr).toContain("incus")
    })

    it("--user routes systemctl --user for stop/start/is-active and defaults to $HOME/.config/systemd/user", () => {
      const temp = makeTempDir()
      const { repo, bin } = makeUpdateEnv(temp)

      // Fake git: succeeds for fetch, returns a stable HEAD sha, makes reset a no-op
      const gitLog = join(temp, "git.log")
      writeFake(join(bin, "git"), `
printf '%s\\n' "$*" >> "${gitLog}"
case "$*" in
  *"rev-parse HEAD"*) printf 'aabbcc111111\\n' ;;
  *"hash-object"*) printf 'deadbeef\\n' ;;
  *) true ;;
esac
exit 0
`)

      // Fake bun: no-op
      writeFake(join(bin, "bun"), `exit 0`)

      // Fake curl: returns 200 for healthz, 404 for readyz (old-server fallback = ready)
      writeFake(join(bin, "curl"), `
args="$*"
case "$args" in
  */healthz*) printf '200'; exit 0 ;;
  */readyz*)  printf '\\n404'; exit 0 ;;
  *) exit 0 ;;
esac
`)

      // Fake systemctl: log argv, emit canned responses
      const sctlLog = join(temp, "systemctl.log")
      writeFake(join(bin, "systemctl"), `
printf '%s\\n' "$*" >> "${sctlLog}"
case "$*" in
  *"is-active"*) printf 'active\\n'; exit 0 ;;
  *"--value"*)   printf '0\\n'; exit 0 ;;
  *) exit 0 ;;
esac
`)

      // Create the user unit file so preflight passes
      const userUnitDir = join(temp, "home", ".config", "systemd", "user")
      mkdirSync(userUnitDir, { recursive: true })
      const serviceFile = join(userUnitDir, "luna-chat-server.service")
      writeFileSync(serviceFile, "[Unit]\nDescription=Luna\n")

      const result = spawnSync(
        "bash",
        [join(repoRoot, "scripts/luna-update-server"),
          "--user",
          "--repo-dir", repo,
          "--luna-home", join(temp, "lunahome"),
          "--service-dir", userUnitDir,
          "--ref", "aabbcc111111",
        ],
        {
          cwd: repoRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: join(temp, "home"),
            PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
            LUNA_TEST_BUN_PATH: join(bin, "bun"),
            LUNA_RESTART_SETTLE_SECS: "0",
            LUNA_READINESS_TIMEOUT: "4",
            LUNA_READINESS_INTERVAL: "1",
            // Keep the in-primitive session guard off the live host's sockets.
            LUNA_TEST_WS_COUNT: "0",
          },
        },
      )

      // The script should succeed (fake is-active=active, curl 200 -> old-server 404 fallback)
      expect(result.status, result.stderr).toBe(0)

      // systemctl log must show --user for stop, start, daemon-reload, is-active
      const sctlLines = existsSync(sctlLog) ? readFileSync(sctlLog, "utf8") : ""
      expect(sctlLines).toContain("--user stop")
      expect(sctlLines).toContain("--user start")
      expect(sctlLines).toContain("--user daemon-reload")
      expect(sctlLines).toContain("--user is-active")
    })

    it("--supervisor launchd: dry-run prints bootout/bootstrap, not systemctl", () => {
      const temp = makeTempDir()
      const { repo, bin } = makeUpdateEnv(temp)
      // Inject a stub launchctl so the "launchctl required" preflight passes on
      // a Linux host (the comment always promised this; the stub was missing,
      // so the test died on `--supervisor launchd requires launchctl`). The
      // stub logs argv: dry-run may only SEE the binary via `command -v`,
      // never execute it.
      const launchctlLog = join(temp, "launchctl.log")
      writeFake(join(bin, "launchctl"), `printf '%s\\n' "$*" >> "${launchctlLog}"\nexit 0`)
      const result = spawnSync(
        "bash",
        [join(repoRoot, "scripts/luna-update-server"),
          "--supervisor", "launchd",
          "--repo-dir", repo,
          "--dry-run",
        ],
        {
          cwd: repoRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
            LUNA_RESTART_SETTLE_SECS: "0",
          },
        },
      )
      // dry-run exits 0
      expect(result.status, result.stderr).toBe(0)
      // Plan must mention launchd primitives
      expect(result.stdout).toContain("bootout")
      expect(result.stdout).toContain("bootstrap")
      expect(result.stdout).not.toContain("daemon-reload")
      // Dry-run never EXECUTES a mutating launchctl primitive. (It does run
      // ONE read-only `launchctl list` — sup_stop's pid capture sits before
      // its DRY_RUN branch — so "log absent" would be asserting a property
      // the engine does not have; the property that matters is that bootout/
      // bootstrap are only PRINTED, never run.)
      const launchctlCalls = (existsSync(launchctlLog) ? readFileSync(launchctlLog, "utf8") : "")
        .split("\n")
        .filter(Boolean)
      expect(launchctlCalls.filter((line) => !line.startsWith("list"))).toEqual([])
    })

    it("--supervisor launchd: parses a real \"PID\" = <n>; line, runs the death-poll, then bootout->bootstrap in order, tolerating bootout rc=3", () => {
      const temp = makeTempDir()
      const { repo, bin } = makeUpdateEnv(temp)

      // Fake git
      const gitLog = join(temp, "git.log")
      writeFake(join(bin, "git"), `
printf '%s\\n' "$*" >> "${gitLog}"
case "$*" in
  *"rev-parse HEAD"*) printf 'aabbcc222222\\n' ;;
  *"hash-object"*) printf 'deadbeef\\n' ;;
  *) true ;;
esac
exit 0
`)
      writeFake(join(bin, "bun"), `exit 0`)

      // Fake curl: healthz 200, readyz 404
      writeFake(join(bin, "curl"), `
case "$*" in
  */healthz*) printf '200'; exit 0 ;;
  */readyz*)  printf '\\n404'; exit 0 ;;
  *) exit 0 ;;
esac
`)

      // Fake launchctl: log argv, simulate:
      //   list $LABEL: emit the REAL macOS-26 line format `\t"PID" = <n>;` so the
      //     engine's `sed -n 's/.*"PID" = \([0-9]*\);.*/\1/p'` actually yields a
      //     non-empty PID and the death-poll executes (regression for the prior
      //     `awk -F'"' '{print $4}'` bug, which extracted the EMPTY field after the
      //     closing quote and silently disabled the poll). The PID is a high,
      //     already-dead value (999999) so `kill -0` fails on the FIRST iteration
      //     and the poll completes instantly without hanging the test.
      //   bootout: return rc=3 (already stopped) to test tolerance
      //   print: return "state = running" (active)
      //   bootstrap: succeed
      const lctlLog = join(temp, "launchctl.log")
      writeFake(join(bin, "launchctl"), `
printf '%s\\n' "$*" >> "${lctlLog}"
case "$1" in
  list)
    # Real launchctl list output shape (tab-indented, "PID" = <n>;). 999999 is a
    # high unused PID -> kill -0 fails immediately -> the poll exits on iter 1.
    printf '{\n\t"PID" = 999999;\n\t"Label" = "com.user.luna-chat-server";\n};\n'
    exit 0
    ;;
  bootout)
    # rc=3 = "No such process" — must be tolerated
    exit 3
    ;;
  print)
    # Emit a print output with state = running (active) and runs = 0
    printf 'state = running\nruns = 0\n'
    exit 0
    ;;
  bootstrap)
    exit 0
    ;;
  *) exit 0 ;;
esac
`)

      // Create the plist file so preflight passes
      const plistDir = join(temp, "home", "Library", "LaunchAgents")
      const plistPath = join(plistDir, "com.user.luna-chat-server.plist")
      mkdirSync(plistDir, { recursive: true })
      writeFileSync(plistPath, `<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>com.user.luna-chat-server</string></dict></plist>`)

      const start = Date.now()
      const result = spawnSync(
        "bash",
        [join(repoRoot, "scripts/luna-update-server"),
          "--supervisor", "launchd",
          "--repo-dir", repo,
          "--luna-home", join(temp, "lunahome"),
          "--launchd-plist", plistPath,
          "--ref", "aabbcc222222",
        ],
        {
          cwd: repoRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: join(temp, "home"),
            PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
            LUNA_TEST_BUN_PATH: join(bin, "bun"),
            LUNA_RESTART_SETTLE_SECS: "0",
            LUNA_READINESS_TIMEOUT: "4",
            LUNA_READINESS_INTERVAL: "1",
          },
        },
      )
      const elapsedMs = Date.now() - start

      expect(result.status, result.stderr).toBe(0)
      // The poll must exit on the FIRST iteration (PID already dead), so the whole
      // run stays well under the 15s death-poll ceiling. If the PID parse silently
      // yielded empty the poll would be skipped (still fast) — but a future
      // regression that DID parse a live PID would hang ~15s; this guards the floor.
      expect(elapsedMs).toBeLessThan(14000)

      // launchctl log must show list (PID capture) BEFORE bootout BEFORE bootstrap.
      const lctlLines = existsSync(lctlLog) ? readFileSync(lctlLog, "utf8") : ""
      const listIdx = lctlLines.indexOf("list")
      const bootoutIdx = lctlLines.indexOf("bootout")
      const bootstrapIdx = lctlLines.indexOf("bootstrap")
      expect(listIdx).toBeGreaterThanOrEqual(0)
      expect(bootoutIdx).toBeGreaterThanOrEqual(0)
      expect(bootstrapIdx).toBeGreaterThanOrEqual(0)
      expect(listIdx).toBeLessThan(bootoutIdx)
      expect(bootoutIdx).toBeLessThan(bootstrapIdx)
    })

    it("the launchd PID parser extracts the integer from a real \"PID\" = <n>; line (airtight regression guard vs the awk-field bug)", () => {
      // The integration test above uses an already-dead PID, so it cannot DISTINGUISH
      // the fixed sed parser from the original buggy `awk -F'"' '{print $4}'` (both
      // make the poll finish fast). This is the airtight, timing-independent guard:
      // it asserts the SHIPPED sed parser yields the integer AND that the old awk form
      // yields EMPTY, against the exact macOS-26 line shape `\t"PID" = <n>;`. A
      // regression to the awk parser (which silently disabled the death-poll) fails here.
      const line = '\t"PID" = 1182;\n'
      const sed = spawnSync("sed", ["-n", 's/.*"PID" = \\([0-9]*\\);.*/\\1/p'], { input: line, encoding: "utf8" })
      expect(sed.stdout.trim()).toBe("1182")
      const awkBug = spawnSync("awk", ['-F"', '/"PID"/{print $4}'], { input: line, encoding: "utf8" })
      expect(awkBug.stdout.trim()).toBe("")
    })

    it("--supervisor launchd: a failed forward readiness probe actually drives the launchd rollback restart (2nd bootout->bootstrap), exiting 1", () => {
      // This test must NOT pass --no-rollback. With --no-rollback the engine calls
      // luna_die on readiness failure and NEVER reaches do_rollback, so the launchd
      // rollback path (a SECOND sup_stop/sup_start = bootout+bootstrap) would go
      // completely unexercised — a tautological "it failed" assertion. Here rollback
      // runs for real: we make the FORWARD probe fail and the ROLLBACK re-probe
      // succeed, then assert the launchctl log shows TWO bootout+bootstrap pairs and
      // the process exits 1 (rolled back to PREV, healthy).
      const temp = makeTempDir()
      const { repo, bin } = makeUpdateEnv(temp)

      // Fake git: forward ref and PREV differ so the rollback `reset --hard PREV`
      // is meaningful. Phase 3 asserts HEAD == target after every reset, so the
      // fake must MODEL the reset moving HEAD (a frozen HEAD would read as a
      // lying reset and correctly fail the postcondition): `reset --hard <sha>`
      // records the sha, and `rev-parse HEAD` answers the last recorded one.
      const headState = join(temp, "git-head.state")
      writeFake(join(bin, "git"), `
if [[ "$*" == *"reset --hard"* ]]; then
  for a in "$@"; do :; done   # last arg = target sha
  printf '%s' "$a" > "${headState}"
  exit 0
fi
case "$*" in
  *"rev-parse HEAD"*)
    if [[ -s "${headState}" ]]; then cat "${headState}"; printf '\\n'; else printf 'aabbcc333333\\n'; fi
    ;;
  *"hash-object"*) printf 'deadbeef\\n' ;;
  *) true ;;
esac
exit 0
`)
      writeFake(join(bin, "bun"), `exit 0`)

      // Stateful curl: /healthz returns 000 (fail) UNTIL the rollback restart has
      // happened, then 200. We key off a marker file the fake launchctl writes on
      // its SECOND bootstrap (= the rollback restart). readyz returns 404 once
      // healthz is 200 so the gate takes the old-server liveness-only fallback =
      // ready. This makes the forward probe fail and the rollback re-probe pass,
      // deterministically (no timing races — the marker is set by the restart).
      const rolledBackMarker = join(temp, "rolled-back.flag")
      writeFake(join(bin, "curl"), `
case "$*" in
  */healthz*)
    if [[ -f "${rolledBackMarker}" ]]; then printf '200'; exit 0; fi
    printf '000'; exit 1 ;;
  */readyz*)  printf '\\n404'; exit 0 ;;
  *) exit 1 ;;
esac
`)

      // launchctl: count bootstrap invocations; the 2nd (rollback restart) drops
      // the marker that flips curl to healthy. print always reports running so
      // is-active is "active" on BOTH probes — it is the curl gate that fails the
      // forward attempt and passes the rollback attempt. list emits a real
      // `"PID" = <n>;` line (dead PID) so the death-poll runs and exits instantly.
      const lctlLog = join(temp, "launchctl.log")
      const bootstrapCounter = join(temp, "bootstrap.count")
      writeFake(join(bin, "launchctl"), `
printf '%s\\n' "$*" >> "${lctlLog}"
case "$1" in
  list)
    printf '{\n\t"PID" = 999999;\n\t"Label" = "com.user.luna-chat-server";\n};\n'
    exit 0
    ;;
  bootout) exit 3 ;;
  print)  printf 'state = running\nruns = 0\n'; exit 0 ;;
  bootstrap)
    printf 'x' >> "${bootstrapCounter}"
    # On the 2nd bootstrap (the rollback restart) flip curl to healthy.
    if [[ "$(wc -c < "${bootstrapCounter}" | tr -d ' ')" -ge 2 ]]; then
      : > "${rolledBackMarker}"
    fi
    exit 0
    ;;
  *) exit 0 ;;
esac
`)

      const plistDir = join(temp, "home", "Library", "LaunchAgents")
      const plistPath = join(plistDir, "com.user.luna-chat-server.plist")
      mkdirSync(plistDir, { recursive: true })
      writeFileSync(plistPath, `<?xml version="1.0"?><plist version="1.0"><dict></dict></plist>`)

      const result = spawnSync(
        "bash",
        [join(repoRoot, "scripts/luna-update-server"),
          "--supervisor", "launchd",
          "--repo-dir", repo,
          "--luna-home", join(temp, "lunahome"),
          "--launchd-plist", plistPath,
          "--ref", "ffffff444444",
        ],
        {
          cwd: repoRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: join(temp, "home"),
            PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
            LUNA_TEST_BUN_PATH: join(bin, "bun"),
            LUNA_RESTART_SETTLE_SECS: "0",
            LUNA_READINESS_TIMEOUT: "2",
            LUNA_READINESS_INTERVAL: "1",
          },
        },
      )

      // Exit 1 = forward update failed but rollback recovered (the documented code).
      // NOT 2 (that is rollback-also-failed) and NOT 0 (forward succeeded).
      expect(result.status, result.stderr).toBe(1)
      // The rollback message must appear (proves do_rollback ran, not luna_die).
      expect(result.stderr).toMatch(/ROLL(ING|ED) BACK/i)

      // The launchd restart ran TWICE: once forward, once for the rollback. So the
      // log must carry >= 2 bootout AND >= 2 bootstrap — this is the real proof the
      // launchd rollback restart path executed (the whole point of the fix).
      const lctlLines = existsSync(lctlLog) ? readFileSync(lctlLog, "utf8") : ""
      const countOf = (needle: string) =>
        lctlLines.split("\n").filter((l) => l.startsWith(needle)).length
      expect(countOf("bootout")).toBeGreaterThanOrEqual(2)
      expect(countOf("bootstrap")).toBeGreaterThanOrEqual(2)
    })

    it("--supervisor launchd skips the session guard: a live session count does not defer the restart", () => {
      // launchd = the operator's own macOS laptop: no unattended caller exists
      // there and ss(8) is unavailable, so the guard must return 0 before it
      // consults anything. Pin a LIVE session count (which defers with exit 3
      // under systemd) and prove the launchd restart still proceeds to exit 0.
      const temp = makeTempDir()
      const { repo, bin } = makeUpdateEnv(temp)

      const gitLog = join(temp, "git.log")
      writeFake(join(bin, "git"), `
printf '%s\\n' "$*" >> "${gitLog}"
case "$*" in
  *"rev-parse HEAD"*) printf 'aabbcc555555\\n' ;;
  *"hash-object"*) printf 'deadbeef\\n' ;;
  *) true ;;
esac
exit 0
`)
      writeFake(join(bin, "bun"), `exit 0`)
      writeFake(join(bin, "curl"), `
case "$*" in
  */healthz*) printf '200'; exit 0 ;;
  */readyz*)  printf '\\n404'; exit 0 ;;
  *) exit 0 ;;
esac
`)
      const lctlLog = join(temp, "launchctl.log")
      writeFake(join(bin, "launchctl"), `
printf '%s\\n' "$*" >> "${lctlLog}"
case "$1" in
  list) printf '{\n\t"PID" = 999999;\n};\n'; exit 0 ;;
  bootout) exit 3 ;;
  print) printf 'state = running\nruns = 0\n'; exit 0 ;;
  bootstrap) exit 0 ;;
  *) exit 0 ;;
esac
`)
      const plistDir = join(temp, "home", "Library", "LaunchAgents")
      const plistPath = join(plistDir, "com.user.luna-chat-server.plist")
      mkdirSync(plistDir, { recursive: true })
      writeFileSync(plistPath, `<?xml version="1.0"?><plist version="1.0"><dict></dict></plist>`)

      const result = spawnSync(
        "bash",
        [join(repoRoot, "scripts/luna-update-server"),
          "--supervisor", "launchd",
          "--repo-dir", repo,
          "--luna-home", join(temp, "lunahome"),
          "--launchd-plist", plistPath,
          "--ref", "aabbcc555555",
        ],
        {
          cwd: repoRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: join(temp, "home"),
            PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
            LUNA_TEST_BUN_PATH: join(bin, "bun"),
            LUNA_RESTART_SETTLE_SECS: "0",
            LUNA_READINESS_TIMEOUT: "4",
            LUNA_READINESS_INTERVAL: "1",
            LUNA_TEST_WS_COUNT: "2",
          },
        },
      )

      expect(result.status, result.stderr).toBe(0)
      expect(result.stderr).not.toContain("DEFERRED by session guard")
      const lctlLines = existsSync(lctlLog) ? readFileSync(lctlLog, "utf8") : ""
      expect(lctlLines).toContain("bootout")
      expect(lctlLines).toContain("bootstrap")
    })
  })

  describe("luna_active_ws_count (shared connect-aware deferral helper)", () => {
    const LIB = join(repoRoot, "scripts/lib/luna-deploy.sh")

    // Source the lib in a bash snippet with LUNA_TEST_WS_COUNT pinned so the
    // test never calls ss(8) or incus and is hermetic in CI (where there are no
    // established sockets). The seam mirrors LUNA_TAILSCALE_IP / LUNA_TEST_BUN_PATH.
    const runWsCount = (
      port: string,
      env: Record<string, string | undefined> = {},
    ) =>
      spawnSync(
        "bash",
        ["-c", `set -uo pipefail; source "${LIB}"; luna_active_ws_count "${port}"`],
        { cwd: repoRoot, encoding: "utf8", env: { ...process.env, ...env } },
      )

    it("returns a pinned zero session count", () => {
      const result = runWsCount("19999", { LUNA_TEST_WS_COUNT: "0" })
      expect(result.status).toBe(0)
      expect(result.stdout.trim()).toBe("0")
    })

    it("returns the pinned value when LUNA_TEST_WS_COUNT is set to a digit string", () => {
      const result = runWsCount("4753", { LUNA_TEST_WS_COUNT: "3" })
      expect(result.status).toBe(0)
      expect(result.stdout.trim()).toBe("3")
    })

    it("returns unknown when LUNA_TEST_WS_COUNT is empty", () => {
      const result = runWsCount("4753", { LUNA_TEST_WS_COUNT: "" })
      expect(result.status).not.toBe(0)
      expect(result.stdout.trim()).toBe("")
    })

    it("returns unknown for a malformed session count", () => {
      const result = runWsCount("4753", { LUNA_TEST_WS_COUNT: "x7y" })
      expect(result.status).not.toBe(0)
      expect(result.stdout.trim()).toBe("")
    })

    // ── phase 2 hardening: an installed-but-failing ss must be UNKNOWN, not 0.
    // The count now authorizes restarts inside the deploy primitive, so the
    // fail-open `... | wc -l` pipeline (a failing ss piped into wc reads as
    // count 0) would have been a session-drop hole.
    const runWsCountWithSs = (ssBody: string) => {
      const temp = makeTempDir()
      const bin = join(temp, "bin")
      mkdirSync(bin, { recursive: true })
      writeFileSync(join(bin, "ss"), `#!/usr/bin/env bash\n${ssBody}\n`)
      spawnSync("chmod", ["+x", join(bin, "ss")])
      return spawnSync(
        "bash",
        ["-c", `set -uo pipefail; source "${LIB}"; luna_active_ws_count 4753`],
        {
          cwd: repoRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            LUNA_TEST_WS_COUNT: undefined, // exercise the REAL probe arm
            PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
          },
        },
      )
    }

    it("a present-but-FAILING ss reports UNKNOWN (non-zero exit, empty stdout), never 0", () => {
      const result = runWsCountWithSs(`exit 1`)
      expect(result.status).not.toBe(0)
      expect(result.stdout.trim()).toBe("")
    })

    it("an ss printing two connection rows counts 2", () => {
      const result = runWsCountWithSs(
        `printf 'ESTAB 0 0 127.0.0.1:4753 127.0.0.1:50001\\nESTAB 0 0 127.0.0.1:4753 127.0.0.1:50002\\n'`,
      )
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout.trim()).toBe("2")
    })

    it("an ss printing nothing with rc 0 counts 0 (genuinely idle)", () => {
      const result = runWsCountWithSs(`exit 0`)
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout.trim()).toBe("0")
    })
  })

  // ── phase 2: luna-autodeploy --force gating (human-only, reason-gated) ─────
  describe("luna-autodeploy --force gating", () => {
    const LUNA_AUTODEPLOY = join(repoRoot, "scripts/luna-autodeploy")

    // Registry + fake repo + fake git so a dry-run do_deploy proceeds to the
    // engine-argv echo without touching any real infrastructure.
    const makeAutodeployEnv = () => {
      const temp = makeTempDir()
      const repo = join(temp, "repo")
      mkdirSync(join(repo, ".git"), { recursive: true })
      const bin = join(temp, "bin")
      mkdirSync(bin, { recursive: true })
      const realGit = spawnSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim()
      writeFileSync(
        join(bin, "git"),
        `#!/usr/bin/env bash
case "$*" in
  *"fetch origin"*) exit 0 ;;
  *"rev-parse HEAD") printf 'aaaaaaaaa\\n' ;;
  *"rev-parse origin/"*) printf 'bbbbbbbbb\\n' ;;
  *) "${realGit}" "$@" ;;
esac
`,
      )
      spawnSync("chmod", ["+x", join(bin, "git")])
      const registry = join(temp, "servers.toml")
      writeFileSync(
        registry,
        [
          `kind = "registry"`,
          `[[server]]`,
          `name = "stable"`,
          `update.params.hostRepoDir = "${repo}"`,
          `update.params.ref = "origin/master"`,
          `ports.proxy = 4753`,
          `deploy.timer = true`,
        ].join("\n") + "\n",
      )
      const env: Record<string, string | undefined> = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        LUNA_SERVERS_CONFIG: registry,
        LUNA_TEST_STAT_MODE: "600",
        LUNA_TEST_WS_COUNT: "0",
        LUNA_FORCE_REASON: undefined,
      }
      return { temp, repo, bin, env }
    }

    const runAutodeploy = (
      args: ReadonlyArray<string>,
      env: Record<string, string | undefined>,
    ) => spawnSync("bash", [LUNA_AUTODEPLOY, ...args], { cwd: repoRoot, encoding: "utf8", env })

    it("bare --force with no reason is rejected (exit 2) and points at --repair", () => {
      const { env } = makeAutodeployEnv()
      const r = runAutodeploy(["stable", "--force"], env)
      expect(r.status, r.stdout + r.stderr).toBe(2)
      expect(r.stderr).toContain("requires an operator reason")
      expect(r.stderr).toContain("--repair")
    })

    it("--force 'why' --dry-run forwards a logged --operator-override to the engine", () => {
      const { env } = makeAutodeployEnv()
      const r = runAutodeploy(["stable", "--force", "why", "--dry-run"], env)
      expect(r.status, r.stdout + r.stderr).toBe(0)
      expect(r.stdout).toContain("FORCE by operator: why")
      expect(r.stdout).toContain("--operator-override")
      expect(r.stdout).toContain("why")
    })

    it("LUNA_FORCE_REASON satisfies the reason gate (--force --dry-run does not swallow the flag)", () => {
      const { env } = makeAutodeployEnv()
      const r = runAutodeploy(["stable", "--force", "--dry-run"], { ...env, LUNA_FORCE_REASON: "x" })
      expect(r.status, r.stdout + r.stderr).toBe(0)
      expect(r.stdout).toContain("FORCE by operator: x")
      expect(r.stdout).toContain("--operator-override")
    })

    it("--repair --force is rejected (exit 2): automation cannot hold the override", () => {
      const { env } = makeAutodeployEnv()
      const r = runAutodeploy(["stable", "--repair", "--force"], env)
      expect(r.status, r.stdout + r.stderr).toBe(2)
      expect(r.stderr).toContain("cannot be combined")
    })

    it("bare --allow-active with no reason is rejected (exit 2): the second override lever meets the same audit bar as --force", () => {
      const { env } = makeAutodeployEnv()
      const r = runAutodeploy(["stable", "--allow-active"], env)
      expect(r.status, r.stdout + r.stderr).toBe(2)
      expect(r.stderr).toContain("requires an operator reason")
      expect(r.stderr).toContain("--repair")
    })

    it("--allow-active 'why' --dry-run forwards a logged --operator-override carrying the reason", () => {
      const { env } = makeAutodeployEnv()
      const r = runAutodeploy(["stable", "--allow-active", "why", "--dry-run"], env)
      expect(r.status, r.stdout + r.stderr).toBe(0)
      expect(r.stdout).toContain("ALLOW-ACTIVE by operator: why")
      expect(r.stdout).toContain("--operator-override")
      expect(r.stdout).toContain("--allow-active: why")
    })

    it("LUNA_FORCE_REASON satisfies the --allow-active reason gate too", () => {
      const { env } = makeAutodeployEnv()
      const r = runAutodeploy(["stable", "--allow-active", "--dry-run"], { ...env, LUNA_FORCE_REASON: "x" })
      expect(r.status, r.stdout + r.stderr).toBe(0)
      expect(r.stdout).toContain("ALLOW-ACTIVE by operator: x")
      expect(r.stdout).toContain("--operator-override")
    })

    it("--repair --allow-active is rejected (exit 2): automation cannot hold the override", () => {
      const { env } = makeAutodeployEnv()
      const r = runAutodeploy(["stable", "--repair", "--allow-active"], env)
      expect(r.status, r.stdout + r.stderr).toBe(2)
      expect(r.stderr).toContain("cannot be combined")
    })
  })

  // ── phase 2: luna-autodeploy --repair ladder + engine-defer mapping ────────
  describe("luna-autodeploy --repair ladder", () => {
    // Mirror the guardian harness pattern: copy scripts/ to a temp dir, replace
    // luna-update-server with a recording stub whose per-call exit codes are
    // env-driven, and pin via LUNA_TEST_PIN_DIR so the pinned copy IS the stub.
    const makeRepairEnv = () => {
      const temp = makeTempDir()
      const scripts = join(temp, "scripts")
      spawnSync("cp", ["-a", join(repoRoot, "scripts"), scripts])
      const repo = join(temp, "repo")
      mkdirSync(join(repo, ".git"), { recursive: true })
      const engineCalls = join(temp, "engine-calls")
      writeFileSync(
        join(scripts, "luna-update-server"),
        `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$ENGINE_CALLS"
n="$(grep -c '' "$ENGINE_CALLS")"
var="ENGINE_RC_\${n}"
exit "\${!var:-0}"
`,
      )
      spawnSync("chmod", ["+x", join(scripts, "luna-update-server")])
      const bin = join(temp, "bin")
      mkdirSync(bin, { recursive: true })
      const realGit = spawnSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim()
      writeFileSync(
        join(bin, "git"),
        `#!/usr/bin/env bash
case "$*" in
  *"fetch origin"*) exit 0 ;;
  *"rev-parse HEAD") printf 'aaaaaaaaa\\n' ;;
  *"rev-parse origin/"*) printf 'bbbbbbbbb\\n' ;;
  *) "${realGit}" "$@" ;;
esac
`,
      )
      spawnSync("chmod", ["+x", join(bin, "git")])
      const registry = join(temp, "servers.toml")
      writeFileSync(
        registry,
        [
          `kind = "registry"`,
          `[[server]]`,
          `name = "stable"`,
          `update.params.hostRepoDir = "${repo}"`,
          `update.params.ref = "origin/master"`,
          `ports.proxy = 4753`,
          `deploy.timer = true`,
        ].join("\n") + "\n",
      )
      const env: Record<string, string | undefined> = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        LUNA_SERVERS_CONFIG: registry,
        LUNA_TEST_STAT_MODE: "600",
        LUNA_TEST_WS_COUNT: "0",
        LUNA_TEST_PIN_DIR: join(temp, "pins"),
        ENGINE_CALLS: engineCalls,
      }
      return { temp, scripts, engineCalls, env }
    }

    const engineCallLines = (engineCalls: string) =>
      (existsSync(engineCalls) ? readFileSync(engineCalls, "utf8") : "").split("\n").filter(Boolean)

    const runRepair = (
      h: ReturnType<typeof makeRepairEnv>,
      extraEnv: Record<string, string | undefined> = {},
      args: ReadonlyArray<string> = ["stable", "--repair"],
    ) =>
      spawnSync("bash", [join(h.scripts, "luna-autodeploy"), ...args], {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...h.env, ...extraEnv },
      })

    it("rung 1 success: exactly one engine call with --restart-only, exit 0", () => {
      const h = makeRepairEnv()
      const r = runRepair(h, { ENGINE_RC_1: "0" })
      expect(r.status, r.stdout + r.stderr).toBe(0)
      expect(r.stdout).toContain("REPAIRED by unit restart")
      const calls = engineCallLines(h.engineCalls)
      expect(calls).toHaveLength(1)
      expect(calls[0]).toContain("--restart-only")
    })

    it("rung 1 defer (rc 3): exit 3, NO rung 2 escalation", () => {
      const h = makeRepairEnv()
      const r = runRepair(h, { ENGINE_RC_1: "3" })
      expect(r.status, r.stdout + r.stderr).toBe(3)
      expect(r.stdout).toContain("DEFERRED by session guard")
      expect(engineCallLines(h.engineCalls)).toHaveLength(1)
    })

    it("rung 1 lock contention (rc 4): exit 4, NO rung 2, reported as contention — not a session-guard defer", () => {
      const h = makeRepairEnv()
      const r = runRepair(h, { ENGINE_RC_1: "4" })
      expect(r.status, r.stdout + r.stderr).toBe(4)
      expect(r.stdout).toContain("concurrent update holds the profile lock")
      expect(r.stdout).not.toContain("DEFERRED by session guard")
      expect(engineCallLines(h.engineCalls)).toHaveLength(1)
    })

    it("both rungs pin --ref to the checkout's CURRENT HEAD, never origin/<branch> (repair is not upgrade)", () => {
      // The fake git answers `rev-parse HEAD` with 'aaaaaaaaa'; the registry
      // stanza declares --ref origin/master. An unattended repair must rebuild
      // the deployed ref, not fetch-and-advance to whatever origin gained since
      // the last gentle tick (which would also ignore deploy.autoUpdate=false).
      const h = makeRepairEnv()
      const r = runRepair(h, { ENGINE_RC_1: "1", ENGINE_RC_2: "0" })
      expect(r.status, r.stdout + r.stderr).toBe(0)
      const calls = engineCallLines(h.engineCalls)
      expect(calls).toHaveLength(2)
      for (const call of calls) {
        expect(call).toContain("--ref aaaaaaaaa")
        expect(call).not.toContain("origin/master")
      }
    })

    it("rung 1 failure escalates to rung 2 (full redeploy, WITHOUT --restart-only), exit 0", () => {
      const h = makeRepairEnv()
      const r = runRepair(h, { ENGINE_RC_1: "1", ENGINE_RC_2: "0" })
      expect(r.status, r.stdout + r.stderr).toBe(0)
      expect(r.stdout).toContain("REPAIRED by full redeploy")
      const calls = engineCallLines(h.engineCalls)
      expect(calls).toHaveLength(2)
      expect(calls[0]).toContain("--restart-only")
      expect(calls[1]).not.toContain("--restart-only")
    })

    it("rung 2 rollback (rc 1) passes through as exit 1", () => {
      const h = makeRepairEnv()
      const r = runRepair(h, { ENGINE_RC_1: "1", ENGINE_RC_2: "1" })
      expect(r.status, r.stdout + r.stderr).toBe(1)
      expect(r.stderr).toContain("ROLLED BACK")
      expect(engineCallLines(h.engineCalls)).toHaveLength(2)
    })

    it("normal do_deploy maps an engine session-guard defer (rc 3) to a quiet exit 0", () => {
      const h = makeRepairEnv()
      const r = runRepair(h, { ENGINE_RC_1: "3" }, ["stable"])
      expect(r.status, r.stdout + r.stderr).toBe(0)
      expect(r.stdout).toContain("DEFERRED by engine session guard")
      expect(engineCallLines(h.engineCalls)).toHaveLength(1)
    })

    it("engine exit 0 without moving HEAD prints the deferral truth, never 'OK — now at' (exit 0)", () => {
      // The engine legitimately exits 0 on lock-contention deferral (nothing
      // mutated) and after journal recovery to an older target. The fake git
      // keeps HEAD at aaaaaaaaa while origin is bbbbbbbbb and the engine stub
      // exits 0 without touching anything — the old code printed a lying
      // "OK — now at bbbbbbbb" for exactly this state.
      const h = makeRepairEnv()
      const r = runRepair(h, { ENGINE_RC_1: "0" }, ["stable"])
      expect(r.status, r.stdout + r.stderr).toBe(0)
      expect(r.stdout).toContain("engine exit 0 without reaching bbbbbbbb")
      expect(r.stdout).not.toContain("OK — now at")
      expect(engineCallLines(h.engineCalls)).toHaveLength(1)
    })

    // ── luna_pin_engine fallback arms: every degraded path warns its own
    // message and falls back to the in-tree engine instead of misdiagnosing ──
    const writeExecStub = (path: string, body: string) => {
      writeFileSync(path, body)
      spawnSync("chmod", ["+x", path])
    }

    it("pin_engine: an unexecutable pinned copy warns 'is not executable' and falls back in-tree", () => {
      const h = makeRepairEnv()
      const bin = join(h.temp, "bin")
      // cp strips the exec bit on pin-dir targets (a noexec-ish landing zone),
      // and chmod +x on the same glob is a no-op — so the effect check, not the
      // chmod command, must catch it.
      writeExecStub(join(bin, "cp"), `#!/usr/bin/env bash
/bin/cp "$@"; rc=$?
if [[ -n "\${LUNA_TEST_PIN_BREAK:-}" ]]; then
  for a in "$@"; do case "$a" in */deploy-engine@*) [[ -f "$a" ]] && /bin/chmod a-x "$a" ;; esac; done
fi
exit $rc
`)
      writeExecStub(join(bin, "chmod"), `#!/usr/bin/env bash
if [[ -n "\${LUNA_TEST_PIN_BREAK:-}" ]]; then
  for a in "$@"; do case "$a" in */deploy-engine@*) exit 0 ;; esac; done
fi
exec /bin/chmod "$@"
`)
      const r = runRepair(h, { ENGINE_RC_1: "0", LUNA_TEST_PIN_BREAK: "1" })
      expect(r.status, r.stdout + r.stderr).toBe(0)
      expect(r.stderr).toContain("is not executable")
      expect(r.stderr).toContain("running in-tree engine")
      expect(engineCallLines(h.engineCalls)).toHaveLength(1)
    })

    it("pin_engine: a failed .complete marker write warns 'could not mark pin dir' and falls back in-tree", () => {
      const h = makeRepairEnv()
      const bin = join(h.temp, "bin")
      writeExecStub(join(bin, "touch"), `#!/usr/bin/env bash
if [[ -n "\${LUNA_TEST_TOUCH_FAIL_GLOB:-}" ]]; then
  for a in "$@"; do case "$a" in \${LUNA_TEST_TOUCH_FAIL_GLOB}) exit 1 ;; esac; done
fi
exec /bin/touch "$@"
`)
      const r = runRepair(h, { ENGINE_RC_1: "0", LUNA_TEST_TOUCH_FAIL_GLOB: "*/deploy-engine@*" })
      expect(r.status, r.stdout + r.stderr).toBe(0)
      expect(r.stderr).toContain("could not mark pin dir")
      expect(r.stderr).toContain("running in-tree engine")
      expect(engineCallLines(h.engineCalls)).toHaveLength(1)
    })

    it("pin_engine: a pin that vanishes before use warns 'vanished before use' and falls back in-tree", () => {
      const h = makeRepairEnv()
      const bin = join(h.temp, "bin")
      // A lying mv (exit 0 without publishing) leaves the final effect check
      // staring at an absent pin — the engine-pin-disaster shape, one level up.
      writeExecStub(join(bin, "mv"), `#!/usr/bin/env bash
if [[ -n "\${LUNA_TEST_MV_LIE_GLOB:-}" ]]; then
  for a in "$@"; do case "$a" in \${LUNA_TEST_MV_LIE_GLOB}) exit 0 ;; esac; done
fi
exec /bin/mv "$@"
`)
      const r = runRepair(h, { ENGINE_RC_1: "0", LUNA_TEST_MV_LIE_GLOB: "*/deploy-engine@*" })
      expect(r.status, r.stdout + r.stderr).toBe(0)
      expect(r.stderr).toContain("vanished before use")
      expect(r.stderr).toContain("running in-tree engine")
      expect(engineCallLines(h.engineCalls)).toHaveLength(1)
    })
  })

  // ── phase 3: migration marker + converged autodeploy ticks ─────────────────
  describe("luna-autodeploy convergence (phase 3)", () => {
    const LUNA_AUTODEPLOY_REAL = join(repoRoot, "scripts/luna-autodeploy")

    // Hermetic up-to-date environment: fake git answers the SAME sha for HEAD
    // and origin/<branch> (converged checkout), a stub guardian records adopt
    // invocations, and every state dir (guardian marker, update journal) is a
    // temp dir so nothing reads or mutates the real host.
    const makeConvergedAutodeployEnv = () => {
      const temp = makeTempDir()
      const repo = join(temp, "repo")
      mkdirSync(join(repo, ".git"), { recursive: true })
      mkdirSync(join(repo, "scripts"), { recursive: true })
      const adoptCalls = join(temp, "adopt-calls")
      // A successful adopt installs the guardian control plane; model that by
      // creating the timer unit file — the actual-state conjunct the migration
      // marker is validated against (the marker is a cache, not authority).
      writeFileSync(
        join(repo, "scripts", "luna-guardian"),
        `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${adoptCalls}"
if [[ "\${1:-}" == adopt ]]; then
  mkdir -p "$LUNA_TEST_SYSTEMD_DIR"
  : > "$LUNA_TEST_SYSTEMD_DIR/luna-guardian-\${2:?}.timer"
fi
exit 0
`,
      )
      const bin = join(temp, "bin")
      mkdirSync(bin, { recursive: true })
      writeFileSync(
        join(bin, "git"),
        `#!/usr/bin/env bash
case "$*" in
  *"fetch origin"*) exit 0 ;;
  *"rev-parse HEAD"|*"rev-parse origin/"*) printf 'aaaaaaaaa\\n' ;;
  *) exit 0 ;;
esac
`,
      )
      // mv stub, guardian-harness style: inert unless LUNA_TEST_MV_FAIL_GLOB
      // matches — lets one test make exactly the marker rename fail.
      writeFileSync(
        join(bin, "mv"),
        `#!/usr/bin/env bash
if [[ -n "\${LUNA_TEST_MV_FAIL_GLOB:-}" ]]; then
  for a in "$@"; do
    case "$a" in
      \${LUNA_TEST_MV_FAIL_GLOB}) printf 'mv: simulated failure: %s\\n' "$a" >&2; exit 1 ;;
    esac
  done
fi
exec /bin/mv "$@"
`,
      )
      spawnSync("chmod", ["+x", join(repo, "scripts", "luna-guardian"), join(bin, "git"), join(bin, "mv")])
      const registry = join(temp, "servers.toml")
      writeFileSync(
        registry,
        [
          `kind = "registry"`,
          `[[server]]`,
          `name = "stable"`,
          `update.params.hostRepoDir = "${repo}"`,
          `update.params.ref = "origin/master"`,
          `ports.proxy = 4753`,
          `deploy.timer = true`,
        ].join("\n") + "\n",
      )
      const guardianState = join(temp, "guardian-state")
      // Hermetic unit dir: the migration-marker validity check consults the
      // guardian timer unit file, which must never read the REAL host's
      // /etc/systemd/system.
      const systemdDir = join(temp, "systemd")
      mkdirSync(systemdDir, { recursive: true })
      const env: Record<string, string | undefined> = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        LUNA_SERVERS_CONFIG: registry,
        LUNA_TEST_STAT_MODE: "600",
        LUNA_TEST_WS_COUNT: "0",
        LUNA_TEST_RUNTIME_MATCHES_CHECKOUT: "true",
        LUNA_GUARDIAN_STATE_DIR: guardianState,
        LUNA_UPDATE_STATE_DIR: join(temp, "update-state"),
        LUNA_TEST_SYSTEMD_DIR: systemdDir,
      }
      return { temp, adoptCalls, guardianState, systemdDir, env }
    }

    const adoptCallLines = (path: string) =>
      (existsSync(path) ? readFileSync(path, "utf8") : "").split("\n").filter(Boolean)

    const runAutodeploy = (
      env: Record<string, string | undefined>,
      args: ReadonlyArray<string>,
      extraEnv: Record<string, string | undefined> = {},
    ) =>
      spawnSync("bash", [LUNA_AUTODEPLOY_REAL, ...args], {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...env, ...extraEnv },
      })

    it("migration marker lifecycle: adopt once, record durably, then silence forever", () => {
      const h = makeConvergedAutodeployEnv()
      const marker = join(h.guardianState, "migrated-stable")

      // Tick 1: migrates loudly, invokes adopt exactly once, records the marker.
      const first = runAutodeploy(h.env, ["stable", "--from-timer"])
      expect(first.status, first.stdout + first.stderr).toBe(0)
      expect(first.stdout).toContain("MIGRATING legacy timer")
      expect(adoptCallLines(h.adoptCalls)).toEqual(["adopt stable"])
      expect(existsSync(marker)).toBe(true)

      // Tick 2: prints NOTHING and does not re-invoke adopt.
      const second = runAutodeploy(h.env, ["stable", "--from-timer"])
      expect(second.status, second.stdout + second.stderr).toBe(0)
      expect(second.stdout).toBe("")
      expect(second.stderr).toBe("")
      expect(adoptCallLines(h.adoptCalls)).toEqual(["adopt stable"])
    })

    it("a failed marker write is loud, non-fatal, and retried next tick", () => {
      const h = makeConvergedAutodeployEnv()
      const marker = join(h.guardianState, "migrated-stable")

      const failed = runAutodeploy(h.env, ["stable", "--from-timer"], {
        LUNA_TEST_MV_FAIL_GLOB: "*migrated-stable*",
      })
      expect(failed.status, failed.stdout + failed.stderr).toBe(0)
      expect(failed.stderr).toContain("could not record guardian migration completion")
      expect(existsSync(marker)).toBe(false)
      expect(adoptCallLines(h.adoptCalls)).toEqual(["adopt stable"])

      // Marker missing -> the next tick re-verifies (re-adopts) and records.
      const retry = runAutodeploy(h.env, ["stable", "--from-timer"])
      expect(retry.status, retry.stdout + retry.stderr).toBe(0)
      expect(retry.stdout).toContain("MIGRATING legacy timer")
      expect(adoptCallLines(h.adoptCalls)).toEqual(["adopt stable", "adopt stable"])
      expect(existsSync(marker)).toBe(true)
    })

    it("a converged autodeploy tick is completely silent; a manual run keeps its feedback", () => {
      const h = makeConvergedAutodeployEnv()
      mkdirSync(h.guardianState, { recursive: true })
      writeFileSync(join(h.guardianState, "migrated-stable"), "profile=stable\nmigrated_at=1\n")
      writeFileSync(join(h.systemdDir, "luna-guardian-stable.timer"), "")

      // Up-to-date --from-timer with the marker present: total silence.
      const timerTick = runAutodeploy(h.env, ["stable", "--from-timer"])
      expect(timerTick.status, timerTick.stdout + timerTick.stderr).toBe(0)
      expect(timerTick.stdout).toBe("")
      expect(timerTick.stderr).toBe("")
      expect(adoptCallLines(h.adoptCalls)).toEqual([])

      // A MANUAL up-to-date run still tells the human it was a no-op.
      const manual = runAutodeploy(h.env, ["stable"])
      expect(manual.status, manual.stdout + manual.stderr).toBe(0)
      expect(manual.stdout).toContain("up to date at aaaaaaaa")
      expect(manual.stdout).toContain("no-op")
    })

    it("knob-off --from-timer runs are silent too", () => {
      const h = makeConvergedAutodeployEnv()
      // Rewrite the registry with deploy.autoUpdate=false.
      writeFileSync(
        join(h.temp, "servers.toml"),
        [
          `kind = "registry"`,
          `[[server]]`,
          `name = "stable"`,
          `update.params.hostRepoDir = "${join(h.temp, "repo")}"`,
          `update.params.ref = "origin/master"`,
          `ports.proxy = 4753`,
          `deploy.timer = true`,
          `deploy.autoUpdate = false`,
        ].join("\n") + "\n",
      )
      mkdirSync(h.guardianState, { recursive: true })
      writeFileSync(join(h.guardianState, "migrated-stable"), "profile=stable\nmigrated_at=1\n")
      writeFileSync(join(h.systemdDir, "luna-guardian-stable.timer"), "")

      const tick = runAutodeploy(h.env, ["stable", "--from-timer"])
      expect(tick.status, tick.stdout + tick.stderr).toBe(0)
      expect(tick.stdout).toBe("")
    })

    it("the migration marker is a cache, not authority: a vanished guardian control plane re-arms adoption", () => {
      // Units restored from a pre-migration backup (or an operator removing the
      // guardian and reinstalling the legacy timer): the marker survives in the
      // state dir while the guardian timer unit is GONE. Pre-fix the marker
      // alone suppressed re-adoption forever, silently — a self-healing
      // regression versus the pre-marker behaviour.
      const h = makeConvergedAutodeployEnv()
      mkdirSync(h.guardianState, { recursive: true })
      writeFileSync(join(h.guardianState, "migrated-stable"), "profile=stable\nmigrated_at=1\n")
      // No luna-guardian-stable.timer in the hermetic unit dir.

      const tick = runAutodeploy(h.env, ["stable", "--from-timer"])
      expect(tick.status, tick.stdout + tick.stderr).toBe(0)
      expect(tick.stdout).toContain("MIGRATING legacy timer")
      expect(adoptCallLines(h.adoptCalls)).toEqual(["adopt stable"])
      // Adopt reinstalled the control plane; the next tick is silent again.
      const second = runAutodeploy(h.env, ["stable", "--from-timer"])
      expect(second.status, second.stdout + second.stderr).toBe(0)
      expect(second.stdout).toBe("")
      expect(adoptCallLines(h.adoptCalls)).toEqual(["adopt stable"])
    })

    it("record_migration's mkdir-failure arm is loud, non-fatal, and re-verified next tick", () => {
      const h = makeConvergedAutodeployEnv()
      // A guardian state dir whose PARENT is a regular file: mkdir -p fails.
      const blocker = join(h.temp, "blocker")
      writeFileSync(blocker, "not a directory\n")
      const tick = runAutodeploy(h.env, ["stable", "--from-timer"], {
        LUNA_GUARDIAN_STATE_DIR: join(blocker, "state"),
      })
      expect(tick.status, tick.stdout + tick.stderr).toBe(0)
      expect(tick.stderr).toContain("could not record guardian migration completion")
      expect(adoptCallLines(h.adoptCalls)).toEqual(["adopt stable"])
    })

    it("install-timer verifies its enable postcondition; uninstall-timer converges to silence", () => {
      // Permissive stub (answers the correct states): green.
      const green = makeTempDir()
      const greenUnits = join(green, "units")
      const greenBin = join(green, "bin")
      mkdirSync(greenUnits, { recursive: true })
      mkdirSync(greenBin, { recursive: true })
      const greenLog = join(green, "systemctl.log")
      writeFileSync(
        join(greenBin, "systemctl"),
        `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${greenLog}"
case "$*" in
  *LoadState*) printf 'loaded\\n' ;;
  *UnitFileState*) printf 'enabled\\n' ;;
  *ActiveState*) printf 'active\\n' ;;
esac
exit 0
`,
      )
      spawnSync("chmod", ["+x", join(greenBin, "systemctl")])
      const baseEnv = {
        ...process.env,
        LUNA_TEST_WS_COUNT: "0",
        LUNA_TEST_STAT_MODE: "600",
        LUNA_SERVERS_CONFIG: join(repoRoot, "test/fixtures/servers.toml"),
      }
      const ok = spawnSync(
        "bash",
        [join(repoRoot, "scripts/luna-autodeploy"), "install-timer", "stable"],
        {
          cwd: repoRoot,
          encoding: "utf8",
          env: { ...baseEnv, PATH: `${greenBin}:${process.env.PATH}`, LUNA_TEST_SYSTEMD_DIR: greenUnits },
        },
      )
      expect(ok.status, ok.stdout + ok.stderr).toBe(0)
      expect(ok.stdout).toContain("installed + enabled")
      expect(ok.stderr).not.toContain("POSTCONDITION")

      // Wrong-state stub (enable visibly did not take): exit 2, POSTCONDITION.
      const bad = makeTempDir()
      const badUnits = join(bad, "units")
      const badBin = join(bad, "bin")
      mkdirSync(badUnits, { recursive: true })
      mkdirSync(badBin, { recursive: true })
      writeFileSync(
        join(badBin, "systemctl"),
        `#!/usr/bin/env bash
case "$*" in
  *LoadState*) printf 'loaded\\n' ;;
  *UnitFileState*) printf 'disabled\\n' ;;
  *ActiveState*) printf 'inactive\\n' ;;
esac
exit 0
`,
      )
      spawnSync("chmod", ["+x", join(badBin, "systemctl")])
      const fail = spawnSync(
        "bash",
        [join(repoRoot, "scripts/luna-autodeploy"), "install-timer", "stable"],
        {
          cwd: repoRoot,
          encoding: "utf8",
          env: { ...baseEnv, PATH: `${badBin}:${process.env.PATH}`, LUNA_TEST_SYSTEMD_DIR: badUnits },
        },
      )
      expect(fail.status, fail.stdout + fail.stderr).toBe(2)
      expect(fail.stderr).toContain("POSTCONDITION")
      expect(fail.stderr).toContain("loaded/enabled/active")

      // Converged-absent uninstall: nothing installed -> silent, zero reloads.
      const empty = makeTempDir()
      const emptyUnits = join(empty, "units")
      const emptyBin = join(empty, "bin")
      mkdirSync(emptyUnits, { recursive: true })
      mkdirSync(emptyBin, { recursive: true })
      const emptyLog = join(empty, "systemctl.log")
      writeFileSync(
        join(emptyBin, "systemctl"),
        `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${emptyLog}"
case "$*" in
  *LoadState*) printf 'not-found\\n' ;;
esac
exit 0
`,
      )
      spawnSync("chmod", ["+x", join(emptyBin, "systemctl")])
      const quiet = spawnSync(
        "bash",
        [join(repoRoot, "scripts/luna-autodeploy"), "uninstall-timer", "stable"],
        {
          cwd: repoRoot,
          encoding: "utf8",
          env: { ...baseEnv, PATH: `${emptyBin}:${process.env.PATH}`, LUNA_TEST_SYSTEMD_DIR: emptyUnits },
        },
      )
      expect(quiet.status, quiet.stdout + quiet.stderr).toBe(0)
      expect(quiet.stdout).toBe("")
      expect(quiet.stderr).toBe("")
      const invocations = existsSync(emptyLog) ? readFileSync(emptyLog, "utf8") : ""
      expect(invocations).not.toContain("daemon-reload")
      expect(invocations).not.toContain("disable")
    })

    it("install-timer exits 2 loudly when a unit write fails (service and timer arms)", () => {
      const makeMvFailEnv = () => {
        const temp = makeTempDir()
        const units = join(temp, "units")
        const bin = join(temp, "bin")
        mkdirSync(units, { recursive: true })
        mkdirSync(bin, { recursive: true })
        writeFileSync(
          join(bin, "systemctl"),
          `#!/usr/bin/env bash
case "$*" in
  *LoadState*) printf 'loaded\\n' ;;
  *UnitFileState*) printf 'enabled\\n' ;;
  *ActiveState*) printf 'active\\n' ;;
esac
exit 0
`,
        )
        writeFileSync(
          join(bin, "mv"),
          `#!/usr/bin/env bash
if [[ -n "\${LUNA_TEST_MV_FAIL_GLOB:-}" ]]; then
  for a in "$@"; do case "$a" in \${LUNA_TEST_MV_FAIL_GLOB}) exit 1 ;; esac; done
fi
exec /bin/mv "$@"
`,
        )
        spawnSync("chmod", ["+x", join(bin, "systemctl"), join(bin, "mv")])
        return { units, bin }
      }
      const baseEnv = {
        ...process.env,
        LUNA_TEST_WS_COUNT: "0",
        LUNA_TEST_STAT_MODE: "600",
        LUNA_SERVERS_CONFIG: join(repoRoot, "test/fixtures/servers.toml"),
      }
      for (const glob of ["*luna-autodeploy-stable.service*", "*luna-autodeploy-stable.timer*"]) {
        const { units, bin } = makeMvFailEnv()
        const r = spawnSync(
          "bash",
          [join(repoRoot, "scripts/luna-autodeploy"), "install-timer", "stable"],
          {
            cwd: repoRoot,
            encoding: "utf8",
            env: {
              ...baseEnv,
              PATH: `${bin}:${process.env.PATH}`,
              LUNA_TEST_SYSTEMD_DIR: units,
              LUNA_TEST_MV_FAIL_GLOB: glob,
            },
          },
        )
        expect(r.status, glob + ": " + r.stdout + r.stderr).toBe(2)
        expect(r.stderr, glob).toContain("cannot write")
        expect(r.stdout, glob).not.toContain("installed + enabled")
      }
    })
  })
})
