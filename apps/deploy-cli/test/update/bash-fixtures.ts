/**
 * Hermetic bash-side fixture for the golden parity harness: a scoped-down
 * copy of test/update-server.test.ts's own makeDeployRepo / makeStubBin /
 * runUpdate pattern (that file cannot be imported from here - its helpers
 * are private to that test module, and test/helpers/guardian-harness.ts, the
 * one shared harness file, does not export an update-server-specific rig).
 * Trimmed to exactly what proving journal byte-parity needs: a real git
 * checkout to drive `git fetch` / `git reset --hard` against, and
 * deterministic systemctl/curl/bun stubs so the readiness gate's verdict is
 * driven by the repo's own HEAD rather than by timing.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { cleanupTempDirs as sharedCleanupTempDirs, makeTempDir as sharedMakeTempDir, repoRoot } from "./temp-dirs.js"

export const cleanupTempDirs = sharedCleanupTempDirs
const makeTempDir = (): string => sharedMakeTempDir("deploy-cli-journal-parity-")

const git = (cwd: string, ...args: ReadonlyArray<string>): string => {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" })
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`)
  return r.stdout.trim()
}

/**
 * A deploy-style checkout: a local bare `origin` plus a working clone with
 * two commits on master (prevSha = first, targetSha = HEAD). The working
 * clone starts checked out at prevSha, so an update to origin/master moves
 * it forward - mirrors test/update-server.test.ts's makeDeployRepo.
 */
const makeDeployRepo = (root: string): { work: string; prevSha: string; targetSha: string } => {
  const origin = join(root, "origin.git")
  const work = join(root, "repo")
  mkdirSync(origin, { recursive: true })
  git(origin, "init", "--quiet", "--bare")

  const seed = join(root, "seed")
  mkdirSync(seed, { recursive: true })
  git(seed, "init", "--quiet")
  git(seed, "config", "user.email", "t@example.test")
  git(seed, "config", "user.name", "Test")
  git(seed, "checkout", "-q", "-B", "master")
  writeFileSync(join(seed, "file.txt"), "v1\n")
  writeFileSync(join(seed, "bun.lock"), "lock-v1\n")
  git(seed, "add", "-A")
  git(seed, "commit", "--quiet", "-m", "prev")
  const prevSha = git(seed, "rev-parse", "HEAD")
  writeFileSync(join(seed, "file.txt"), "v2\n")
  git(seed, "add", "-A")
  git(seed, "commit", "--quiet", "-m", "target")
  const targetSha = git(seed, "rev-parse", "HEAD")
  git(seed, "remote", "add", "origin", origin)
  git(seed, "push", "--quiet", "origin", "master")

  git(root, "clone", "--quiet", origin, work)
  git(work, "config", "user.email", "t@example.test")
  git(work, "config", "user.name", "Test")
  git(work, "checkout", "--quiet", prevSha)

  // bun install's node_modules postcondition: untracked, survives reset --hard both ways.
  mkdirSync(join(work, "node_modules"), { recursive: true })
  writeFileSync(join(work, "node_modules", ".keep"), "keep\n")

  return { work, prevSha, targetSha }
}

/**
 * Deterministic systemctl/curl/bun stubs. The readiness VERDICT is keyed off
 * the repo's live HEAD compared to the sha(s) marked ready, so there is no
 * timing dependence - mirrors test/update-server.test.ts's makeStubBin,
 * trimmed to the readyAtTarget/readyAtPrev axis this harness needs (no
 * setup-mode / buildSha-omission scenarios - those are readiness-gate
 * concerns out of scope for S22a).
 */
const makeStubBin = (
  root: string,
  opts: { readonly repo: string; readonly prevSha: string; readonly targetSha: string; readonly readyAtTarget: boolean; readonly readyAtPrev: boolean },
): { bin: string } => {
  const bin = join(root, "bin")
  mkdirSync(bin, { recursive: true })

  writeFileSync(
    join(bin, "systemctl"),
    `#!/usr/bin/env bash
case "$1" in
  is-active) printf 'active\\n'; exit 0 ;;
  show) printf '0\\n'; exit 0 ;;
  *) exit 0 ;;
esac
`,
  )

  writeFileSync(
    join(bin, "curl"),
    `#!/usr/bin/env bash
head="$(git -C "${opts.repo}" rev-parse HEAD 2>/dev/null || printf 'unknown')"
code='503'
if [[ "$head" == "${opts.targetSha}" && "${opts.readyAtTarget ? "1" : "0"}" == "1" ]]; then code='200'; fi
if [[ "$head" == "${opts.prevSha}" && "${opts.readyAtPrev ? "1" : "0"}" == "1" ]]; then code='200'; fi
if [[ "$*" == *"/readyz"* ]]; then
  printf '{"status":"ok","mode":"normal","credentialOk":true,"buildSha":"%s"}\\n%s' "$head" "$code"
  exit 0
fi
printf '%s' "$code"
exit 0
`,
  )

  writeFileSync(join(bin, "bun"), `#!/usr/bin/env bash\nexit 0\n`)

  spawnSync("chmod", ["+x", join(bin, "systemctl"), join(bin, "curl"), join(bin, "bun")])
  return { bin }
}

/** The SYSTEM unit file the script's user-unit guard requires (scripts/luna-update-server's user-unit-out-of-scope refusal). */
const writeUnit = (serviceDir: string, name = "luna-chat-server.service"): void => {
  mkdirSync(serviceDir, { recursive: true })
  writeFileSync(join(serviceDir, name), "[Unit]\n")
}

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
  readonly args: ReadonlyArray<string>
  readonly env: Record<string, string | undefined>
}

export const makeFixture = (opts: { readonly readyAtTarget: boolean; readonly readyAtPrev: boolean }): Fixture => {
  const temp = makeTempDir()
  const { work, prevSha, targetSha } = makeDeployRepo(temp)
  const serviceDir = join(temp, "systemd")
  const updateState = join(temp, "update-state")
  writeUnit(serviceDir)
  const { bin } = makeStubBin(temp, { repo: work, prevSha, targetSha, ...opts })
  return {
    temp,
    work,
    prevSha,
    targetSha,
    updateState,
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
      "--readiness-port", "4753",
      "--supervisor", "systemd",
    ],
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      LUNA_TEST_BUN_PATH: join(bin, "bun"),
      LUNA_UPDATE_STATE_DIR: updateState,
    },
  }
}
