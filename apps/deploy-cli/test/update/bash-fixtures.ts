/**
 * Hermetic bash-side fixture for the golden parity harness: builds on the
 * shared git/makeDeployRepo/makeStubBin fixture (test/helpers/
 * update-server-fixtures.ts - a pure move of what used to be private to
 * test/update-server.test.ts, so this file no longer needs its own ~150-line
 * trimmed duplicate of them) plus the runUpdate pattern below.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { makeDeployRepo, makeStubBin } from "../../../../test/helpers/update-server-fixtures.js"
import { cleanupTempDirs as sharedCleanupTempDirs, makeTempDir as sharedMakeTempDir, repoRoot } from "./temp-dirs.js"

export const cleanupTempDirs = sharedCleanupTempDirs
// Shared by both the S22a journal-parity suite and the S22b restart/
// session-guard parity suite below - not journal-specific despite the file's
// own S22a origin, so a leaked temp dir points at the right suite.
const makeTempDir = (): string => sharedMakeTempDir("deploy-cli-update-parity-")

/** The SYSTEM unit file the script's user-unit guard requires (scripts/luna-update-server's user-unit-out-of-scope refusal). */
const writeUnit = (serviceDir: string, name = "luna-chat-server.service"): void => {
  mkdirSync(serviceDir, { recursive: true })
  writeFileSync(join(serviceDir, name), "[Unit]\n")
}

/** Single source of truth for the readiness/ws port every fixture pins, so `--readiness-port` (in args, below) and `readinessPort` (on Fixture, for a caller building a SessionGuardOptions) can never drift apart. */
export const READINESS_PORT = 4753

interface RunResult {
  readonly status: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
}

export const runUpdate = (args: ReadonlyArray<string>, env: Record<string, string | undefined>): RunResult => {
  const r = spawnSync("bash", [join(repoRoot, "scripts/luna-update-server"), ...args], {
    cwd: repoRoot,
    env: { ...process.env, LUNA_RESTART_SETTLE_SECS: "0", LUNA_TEST_WS_COUNT: "0", ...env },
    encoding: "utf8",
  })
  return { status: r.status, signal: r.signal, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
}

/** A fully wired fixture: deploy repo + stub bin + unit + the args/env every runUpdate call in this suite shares. */
export interface Fixture {
  readonly temp: string
  readonly work: string
  readonly prevSha: string
  readonly targetSha: string
  readonly updateState: string
  readonly serviceName: string
  readonly readinessPort: number
  readonly bin: string
  readonly systemctlLog: string
  readonly args: ReadonlyArray<string>
  readonly env: Record<string, string | undefined>
}

export const makeFixture = (
  opts: { readonly readyAtTarget: boolean; readonly readyAtPrev: boolean; readonly isActive?: string },
): Fixture => {
  const temp = makeTempDir()
  const { work, prevSha, targetSha } = makeDeployRepo(temp)
  const serviceDir = join(temp, "systemd")
  const updateState = join(temp, "update-state")
  const serviceName = "luna-chat-server.service"
  writeUnit(serviceDir, serviceName)
  const { bin, systemctlLog } = makeStubBin(temp, { repo: work, prevSha, targetSha, ...opts })
  return {
    temp,
    work,
    prevSha,
    targetSha,
    updateState,
    serviceName,
    readinessPort: READINESS_PORT,
    bin,
    systemctlLog,
    args: [
      // Pin every value the bash script would otherwise resolve from
      // ambient LUNA_* env (PROFILE/SUPERVISOR/READINESS_PORT) so a
      // developer's or CI runner's real env can never redirect this fixture
      // at the wrong journal path, unit name, or supervisor backend - the
      // fixture's own writeUnit()/journalPath assume profile "stable".
      "--profile", "stable",
      "--repo-dir", work,
      "--ref", "origin/master",
      "--luna-home", join(temp, "state"),
      "--service-dir", serviceDir,
      "--readiness-timeout", "2",
      "--readiness-interval", "0.3",
      "--readiness-port", String(READINESS_PORT),
      "--supervisor", "systemd",
    ],
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      LUNA_TEST_BUN_PATH: join(bin, "bun"),
      LUNA_UPDATE_STATE_DIR: updateState,
    },
  }
}

/** The pieces of `Fixture` a TS-only scenario (no `runUpdate` call) ever consumes. */
export interface LightFixture {
  readonly temp: string
  readonly serviceName: string
  readonly readinessPort: number
  readonly bin: string
  readonly systemctlLog: string
}

/**
 * A TS-only fixture path (FIX10): every scenario in restart-guard-parity.test.ts
 * that never calls `runUpdate` - it only drives `restartServiceSync`/
 * `restartSessionGuardSync`/`queryActiveWsCountSync` directly against the
 * stub `systemctl` binary - still paid for `makeFixture`'s full
 * `makeDeployRepo` (git init + a bare origin + a seed clone + two commits +
 * a push + a second clone + a checkout, ~15 subprocesses) despite consuming
 * only `.bin`/`.serviceName`/`.readinessPort`/`.systemctlLog` from the
 * result. `makeStubBin`'s own `curl` stub interpolates `repo`/`prevSha`/
 * `targetSha` into its script TEXT but never validates them at fixture-
 * build time - a TS-only scenario never executes that stub (it never spawns
 * `curl` at all), so placeholder strings are exactly as good as a real repo
 * here. `makeFixture` (above) stays the one used by every scenario that
 * actually calls `runUpdate` against the real bash script.
 */
export const makeLightFixture = (
  opts: { readonly readyAtTarget: boolean; readonly readyAtPrev: boolean; readonly isActive?: string },
): LightFixture => {
  const temp = makeTempDir()
  const serviceName = "luna-chat-server.service"
  const { bin, systemctlLog } = makeStubBin(temp, {
    repo: join(temp, "unused-repo"),
    prevSha: "unused-prev-sha",
    targetSha: "unused-target-sha",
    ...opts,
  })
  return { temp, serviceName, readinessPort: READINESS_PORT, bin, systemctlLog }
}
