import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { afterEach, describe, expect, it } from "vitest"

const repoRoot = new URL("..", import.meta.url).pathname
const tempDirs: string[] = []

const makeTempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-restart-channel-test-"))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

// A hermetic stub bin so the suite runs on macOS (no systemctl/incus/journalctl).
// Every external the script reaches is faked deterministically:
//   - systemctl / incus: log `$*` to their own file, exit 0. The dev channel runs
//     `incus exec luna-dev -- systemctl ...`, so for dev the stop/start verbs land
//     in incus.log (the incus stub does NOT re-exec systemctl); for stable they
//     land in systemctl.log directly.
//   - curl: logs its args to curl.log (so a test can assert the /healthz URL +
//     port the script probes) and prints 200 so the post-start health check
//     passes (exit 0).
//   - ss: header line only → 0 established connections by default (the guard is
//     also bypassed by --yes; this keeps count_connections deterministic). With
//     opts.establishedOnPort set, it emits ONE ESTABLISHED row ONLY when queried
//     for that port — so a test can prove the guard watches the right port and
//     refuses the restart (exit 2) without --yes.
//   - journalctl: exit 0 (the script already wraps the journal dump in `|| true`).
//   - sleep: LOG the requested seconds and return immediately (no real wait), so
//     the suite never incurs the script's settle or post-start `sleep 2`. Tests
//     assert against sleep.log instead of wall-clock time — the settle-wiring
//     test checks that `sleep` was invoked with the configured duration, which
//     validates the wiring deterministically without the delay.
const makeStubBin = (
  root: string,
  opts: { readonly stopExitCode?: number; readonly establishedOnPort?: number } = {},
) => {
  const bin = join(root, "bin")
  mkdirSync(bin, { recursive: true })
  const systemctlLog = join(root, "systemctl.log")
  const incusLog = join(root, "incus.log")
  const sleepLog = join(root, "sleep.log")
  const curlLog = join(root, "curl.log")
  const stopExitCode = opts.stopExitCode ?? 0
  const establishedOnPort = opts.establishedOnPort

  // `stop` exits with stopExitCode (default 0) so a test can prove a FAILING stop
  // still proceeds to start (the `|| true` guard); every other verb exits 0.
  writeFileSync(
    join(bin, "systemctl"),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${systemctlLog}"\ncase "$1" in\n  stop) exit ${stopExitCode} ;;\n  *) exit 0 ;;\nesac\n`,
  )
  writeFileSync(
    join(bin, "incus"),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${incusLog}"\nexit 0\n`,
  )
  writeFileSync(
    join(bin, "curl"),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${curlLog}"\nprintf '200\\n'\nexit 0\n`,
  )
  // ss prints a header line always (the script skips it with `tail -n +2`). When
  // establishedOnPort is set, it appends ONE ESTABLISHED row, but ONLY when the
  // query targets that port (`( sport = :<port> )`) — so the row is invisible
  // unless the script actually asked about that port, which is what proves the
  // guard reads the channel's correct port.
  const ssEstablishedRow =
    establishedOnPort === undefined
      ? ""
      : `case "$*" in\n  *:${establishedOnPort}*) printf 'ESTAB 0 0 127.0.0.1:${establishedOnPort} 127.0.0.1:54321\\n' ;;\nesac\n`
  writeFileSync(
    join(bin, "ss"),
    `#!/usr/bin/env bash\nprintf 'State Recv-Q Send-Q Local Peer\\n'\n${ssEstablishedRow}exit 0\n`,
  )
  writeFileSync(
    join(bin, "journalctl"),
    `#!/usr/bin/env bash\nexit 0\n`,
  )
  // No-op sleep that records the seconds it was asked to wait, so tests stay fast
  // but can still assert the settle was invoked with the right duration.
  writeFileSync(
    join(bin, "sleep"),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${sleepLog}"\nexit 0\n`,
  )

  for (const name of ["systemctl", "incus", "curl", "ss", "journalctl", "sleep"]) {
    chmodSync(join(bin, name), 0o755)
  }

  return { bin, systemctlLog, incusLog, sleepLog, curlLog }
}

const runRestart = (
  args: ReadonlyArray<string>,
  env: Record<string, string>,
  bin: string,
) =>
  spawnSync("bash", [join(repoRoot, "scripts/restart-channel.sh"), ...args], {
    cwd: repoRoot,
    // Stub bin FIRST so our fakes shadow any real tools; default the settle to 0
    // so the suite never sleeps the 6s production default (individual tests
    // override it — see the "settle actually runs" regression).
    env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, LUNA_RESTART_SETTLE_SECS: "0", ...env },
    encoding: "utf8",
  })

describe("restart-channel.sh", () => {
  it("passes `bash -n` (syntax smoke)", () => {
    const r = spawnSync("bash", ["-n", join(repoRoot, "scripts/restart-channel.sh")], {
      encoding: "utf8",
    })
    expect(r.status, r.stderr).toBe(0)
  })

  it("stable restart is a clean stop -> start (NOT a fast `systemctl restart`)", () => {
    // Regression for the 2026-06-08 stable-deploy incident: a fast `systemctl
    // restart` started the new chat-server before the outgoing one released its
    // DuckDB/SQLite WAL/SHM handles → SQLITE_CANTOPEN on boot. The fix restarts
    // as stop -> settle -> start with NO fast restart.
    const temp = makeTempDir()
    const { bin, systemctlLog } = makeStubBin(temp)

    const r = runRestart(["stable", "--yes"], {}, bin)

    expect(r.status, r.stdout + r.stderr).toBe(0)
    const sys = readFileSync(systemctlLog, "utf8")
    // No fast restart — that overlapping stop+start was the bug.
    expect(sys).not.toContain("restart luna-chat-server.service")
    // Clean stop happens, and BEFORE the start.
    const stopIdx = sys.indexOf("stop luna-chat-server.service")
    const startIdx = sys.indexOf("start luna-chat-server.service")
    expect(stopIdx).toBeGreaterThanOrEqual(0)
    expect(startIdx).toBeGreaterThan(stopIdx)
  })

  it("stable guard + health target the stable WS port (4753), not dev's control port (5754)", () => {
    // Regression: the stable branch hardcoded PORT/HEALTH_URL=5754, which is
    // DEV's *control* port (host 5754 -> luna-dev:4754), not the stable
    // WebSocket port. Two consequences this test locks down:
    //   1. the issue-#24 connection guard counted ESTABLISHED sessions on a port
    //      no stable operator ever uses → it saw ~0 and NEVER refused;
    //   2. the post-restart health probe verified dev's control server instead of
    //      the stable chat-server.
    // Both must target 4753 — the stable WS port where operator chats live AND
    // /healthz is served (mirroring the dev branch's PORT=5753, its WS port).
    const temp = makeTempDir()
    const { bin, curlLog } = makeStubBin(temp)

    const r = runRestart(["stable", "--yes"], {}, bin)

    expect(r.status, r.stdout + r.stderr).toBe(0)
    // The status line reports the guarded port — it must be 4753, never 5754.
    expect(r.stdout).toContain("port 4753")
    expect(r.stdout).not.toContain("port 5754")
    // The health probe hit the stable WS port's /healthz, not 5754. (curl logs
    // its args, so this asserts the actual URL the script built from HEALTH_URL.)
    const curls = readFileSync(curlLog, "utf8")
    expect(curls).toContain("127.0.0.1:4753/healthz")
    expect(curls).not.toContain("5754")
  })

  it("stable guard REFUSES (exit 2) on a live session on 4753 — and would not on 5754 (issue #24)", () => {
    // Prove the guard actually watches 4753: with one ESTABLISHED row on 4753 and
    // NO --yes, the script must refuse rather than kill the operator's live chat.
    // The ss stub emits that row ONLY when queried for `:4753`, so a pass means
    // the script asked ss about the right port. (With the old PORT=5754, ss would
    // report 0 established and the guard would wave the restart through — the dead-
    // guard bug.)
    const temp = makeTempDir()
    const { bin, systemctlLog } = makeStubBin(temp, { establishedOnPort: 4753 })

    const r = runRestart(["stable"], {}, bin)

    expect(r.status).toBe(2)
    expect(r.stderr).toContain("active connection(s) on port 4753")
    // It refused BEFORE touching the service — no stop/start ran.
    const sys = existsSync(systemctlLog) ? readFileSync(systemctlLog, "utf8") : ""
    expect(sys).not.toContain("stop luna-chat-server.service")
    expect(sys).not.toContain("start luna-chat-server.service")
  })

  it("dev restart is a clean stop -> start inside the container (NOT a fast restart)", () => {
    const temp = makeTempDir()
    const { bin, incusLog } = makeStubBin(temp)

    const r = runRestart(["dev", "--yes"], {}, bin)

    expect(r.status, r.stdout + r.stderr).toBe(0)
    // The dev channel routes systemctl through `incus exec luna-dev -- ...`, so
    // the stop/start verbs land in the incus log.
    const incus = readFileSync(incusLog, "utf8")
    expect(incus).not.toContain("restart luna-dev-chat-server.service")
    const stopIdx = incus.indexOf("exec luna-dev -- systemctl stop luna-dev-chat-server.service")
    const startIdx = incus.indexOf("exec luna-dev -- systemctl start luna-dev-chat-server.service")
    expect(stopIdx).toBeGreaterThanOrEqual(0)
    expect(startIdx).toBeGreaterThan(stopIdx)
  })

  it("dev guard + health target the dev WS port (5753), not its control port (5754)", () => {
    // Symmetric lock for the dev branch (the stable branch had the WS-vs-control
    // port bug; pin dev too so the same class can't reappear here). Dev's guard +
    // /healthz must use 5753 (its WS port), NEVER 5754 (dev's control port) or the
    // stable candidate container's 6753. This is the port pairing the stable
    // branch's fix is "mirroring", so it must itself be locked.
    const temp = makeTempDir()
    const { bin, curlLog } = makeStubBin(temp)

    const r = runRestart(["dev", "--yes"], {}, bin)

    expect(r.status, r.stdout + r.stderr).toBe(0)
    expect(r.stdout).toContain("port 5753")
    expect(r.stdout).not.toContain("port 5754")
    const curls = readFileSync(curlLog, "utf8")
    expect(curls).toContain("127.0.0.1:5753/healthz")
    expect(curls).not.toContain("5754")
  })

  it("settles between stop and start when LUNA_RESTART_SETTLE_SECS > 0", () => {
    // Prove the settle knob is wired: the script announces it AND actually invokes
    // `sleep` with the configured duration. We assert against the (stubbed) sleep's
    // log rather than wall-clock time — deterministic and fast, but still
    // non-vacuous (a missing/zero settle would not log a `5`). It is also HOST-side:
    // even on the dev channel (which runs `incus exec`), the settle is the host
    // script's own sleep, not one inside the container.
    const temp = makeTempDir()
    const { bin, sleepLog } = makeStubBin(temp)

    const r = runRestart(["dev", "--yes"], { LUNA_RESTART_SETTLE_SECS: "5" }, bin)

    expect(r.status, r.stdout + r.stderr).toBe(0)
    expect(r.stdout).toContain("settling 5s")
    // `sleep 5` (the settle) was actually invoked — distinct from the post-start
    // `sleep 2` health gap, which is also logged.
    const sleeps = readFileSync(sleepLog, "utf8").split("\n").filter(Boolean)
    expect(sleeps).toContain("5")
    expect(sleeps).toContain("2")
  })

  it("skips the settle wait entirely when LUNA_RESTART_SETTLE_SECS=0", () => {
    const temp = makeTempDir()
    const { bin, sleepLog } = makeStubBin(temp)

    const r = runRestart(["stable", "--yes"], { LUNA_RESTART_SETTLE_SECS: "0" }, bin)

    expect(r.status, r.stdout + r.stderr).toBe(0)
    expect(r.stdout).not.toContain("settling")
    // The settle sleep never ran — the only sleep is the post-start `sleep 2`.
    const sleeps = readFileSync(sleepLog, "utf8").split("\n").filter(Boolean)
    expect(sleeps).toEqual(["2"])
  })

  it("warns LOUDLY (does not silently skip) on an invalid LUNA_RESTART_SETTLE_SECS, still starts", () => {
    // Mirrors scripts/luna-update-server's hardening: a bare `sleep "$bad" || true`
    // would skip the settle SILENTLY and reintroduce the WAL/SHM race with no
    // operator signal. An invalid value must WARN and still proceed to start.
    const temp = makeTempDir()
    const { bin, systemctlLog } = makeStubBin(temp)

    const r = runRestart(["stable", "--yes"], { LUNA_RESTART_SETTLE_SECS: "abc" }, bin)

    expect(r.status, r.stdout + r.stderr).toBe(0)
    expect(r.stderr).toContain("not a non-negative number of seconds")
    // The settle was skipped (no settling line) but start STILL ran.
    expect(r.stdout).not.toContain("settling")
    const sys = readFileSync(systemctlLog, "utf8")
    expect(sys).toContain("start luna-chat-server.service")
  })

  it("a FAILING stop still proceeds to start (does NOT leave the service down)", () => {
    // Decomposing the atomic `restart` into stop -> settle -> start opens a
    // stopped-but-not-started window: under `set -e`, a non-zero stop would abort
    // BEFORE start and leave the service down — worse than the old atomic restart.
    // The `|| true` on stop closes that: start runs regardless (it is idempotent).
    const temp = makeTempDir()
    const { bin, systemctlLog } = makeStubBin(temp, { stopExitCode: 1 })

    const r = runRestart(["stable", "--yes"], {}, bin)

    // Script did not abort despite stop exiting non-zero.
    expect(r.status, r.stdout + r.stderr).toBe(0)
    const sys = readFileSync(systemctlLog, "utf8")
    // start STILL ran (and after the failed stop).
    const stopIdx = sys.indexOf("stop luna-chat-server.service")
    const startIdx = sys.indexOf("start luna-chat-server.service")
    expect(stopIdx).toBeGreaterThanOrEqual(0)
    expect(startIdx).toBeGreaterThan(stopIdx)
  })
})
