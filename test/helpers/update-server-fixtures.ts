/**
 * Shared update-server test fixture - a PURE MOVE of git/makeDeployRepo/
 * makeStubBin that lived at the top of test/update-server.test.ts (module-
 * private, so nothing outside that file could reuse them), so
 * apps/deploy-cli's TS-port parity harness (apps/deploy-cli/test/update/
 * bash-fixtures.ts) can build its hermetic fixtures from the SAME audited
 * pieces instead of a divergent ~150-line trimmed copy.
 *
 * No behavior changed in the move: this repo's 273-test hostenv suite
 * (test/deploy-scripts.test.ts 129 + test/guardian.test.ts 90 +
 * test/update-server.test.ts 54, its now-imported call sites unchanged) is
 * the proof this stayed outcome-identical.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

export const git = (cwd: string, ...args: ReadonlyArray<string>): string => {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" })
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`)
  }
  return r.stdout.trim()
}

// Build a deploy-style checkout: a local bare `origin` plus a working clone with
// TWO commits on master. This gives the script a REAL `git fetch origin` +
// `git reset --hard <ref>` to drive - no faking of git's internal state. Returns
// the working-clone path plus the two commit SHAs (prev = first, target = HEAD).
export const makeDeployRepo = (
  root: string,
  opts: { lockChanges?: boolean } = {},
): { readonly origin: string; readonly work: string; readonly prevSha: string; readonly targetSha: string } => {
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
  if (opts.lockChanges) {
    // Lockfile differs prev<->target so bun install (and its node_modules
    // postcondition) actually fires, instead of taking the "lockfile
    // unchanged" reuse path a plain call takes.
    writeFileSync(join(seed, "bun.lock"), "lock-v2\n")
  }
  // Default: same lockfile content as prev -> "lockfile unchanged" path for the happy test.
  git(seed, "add", "-A")
  git(seed, "commit", "--quiet", "-m", "target")
  const targetSha = git(seed, "rev-parse", "HEAD")
  git(seed, "remote", "add", "origin", origin)
  git(seed, "push", "--quiet", "origin", "master")

  // The deploy checkout starts at PREV (so an update to origin/master moves it
  // forward to target).
  git(root, "clone", "--quiet", origin, work)
  git(work, "config", "user.email", "t@example.test")
  git(work, "config", "user.name", "Test")
  git(work, "checkout", "--quiet", prevSha)

  // Phase-3 artifact-postcondition fixture: the engine now verifies that
  // `bun install` produced node_modules/. UNTRACKED files survive `git reset
  // --hard` in both directions, so every happy/rollback path stays green.
  mkdirSync(join(work, "node_modules"), { recursive: true })
  writeFileSync(join(work, "node_modules", ".keep"), "keep\n")

  return { origin, work, prevSha, targetSha }
}

export interface StubBinOptions {
  readonly repo: string
  readonly prevSha: string
  readonly targetSha: string
  readonly readyAtTarget: boolean
  readonly readyAtPrev: boolean
  // #28: simulate a deploy that boots (healthz 200) but lands in SETUP-mode at
  // the target SHA - /readyz reports mode=setup, so the deepened gate must FAIL.
  readonly setupAtTarget?: boolean
  // Legacy /readyz responses can omit the additive buildSha field. Forward
  // promotion must reject that ambiguity, while rollback may accept it.
  readonly omitBuildShaAtTarget?: boolean
  readonly omitBuildShaAtPrev?: boolean
  readonly mismatchBuildShaAtPrev?: boolean
  // Phase 2 session-guard matrix: when set, `systemctl is-active` answers
  // THIS string (may be empty) until the first `start` lands, then 'active'
  // - modelling a dead/activating unit that comes up after the restart.
  // Undefined keeps the legacy always-'active' behaviour.
  readonly isActive?: string
}

// Stub bin dir with deterministic systemctl/curl/bun. The readiness VERDICT is
// keyed off the repo's CURRENT HEAD (read live by the curl stub) compared to
// env-provided SHAs - so there is zero timing dependence:
//   READY_AT_TARGET=1 -> curl 200 when HEAD==target (happy path)
//   READY_AT_PREV=1   -> curl 200 when HEAD==prev   (rollback recovers)
// Each stub appends to its own log so the test can assert call counts/sequence.
export const makeStubBin = (
  root: string,
  opts: StubBinOptions,
): { readonly bin: string; readonly systemctlLog: string; readonly curlLog: string; readonly bunLog: string } => {
  const bin = join(root, "bin")
  mkdirSync(bin, { recursive: true })
  const systemctlLog = join(root, "systemctl.log")
  const curlLog = join(root, "curl.log")
  const bunLog = join(root, "bun.log")
  const startedMarker = join(root, "started.marker")

  // systemctl: is-active "active" (or opts.isActive until a start happened);
  // NRestarts always "0"; stop/start/daemon-reload just log. (Crash-loop
  // detection is exercised indirectly; here the verdict is driven purely by
  // curl so the tests stay deterministic.)
  const isActiveLine =
    opts.isActive === undefined
      ? `printf 'active\\n'`
      : `if [[ -f "${startedMarker}" ]]; then printf 'active\\n'; else printf '%s\\n' '${opts.isActive}'; fi`
  writeFileSync(
    join(bin, "systemctl"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${systemctlLog}"
case "$1" in
  is-active) ${isActiveLine}; exit 0 ;;
  start) : > "${startedMarker}"; exit 0 ;;
  show) printf '0\\n'; exit 0 ;;
  *) exit 0 ;;
esac
`,
  )

  // curl: read the repo's live HEAD; emit 200 only at the SHA(s) marked ready.
  // Answers BOTH /healthz (bare code) and /readyz (JSON body + newline + code),
  // mirroring the two curl -w contracts the readiness gate uses.
  writeFileSync(
    join(bin, "curl"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${curlLog}"
head="$(git -C "${opts.repo}" rev-parse HEAD 2>/dev/null || printf 'unknown')"
code='503'
mode='normal'
if [[ "$head" == "${opts.targetSha}" && "${opts.readyAtTarget ? "1" : "0"}" == "1" ]]; then
  code='200'
fi
if [[ "$head" == "${opts.prevSha}" && "${opts.readyAtPrev ? "1" : "0"}" == "1" ]]; then
  code='200'
fi
# #28: a deploy that boots into setup-mode answers /healthz 200 but /readyz setup.
if [[ "$head" == "${opts.targetSha}" && "${opts.setupAtTarget ? "1" : "0"}" == "1" ]]; then
  code='200'; mode='setup'
fi
if [[ "$*" == *"/readyz"* ]]; then
  # Mirror curl -sS -w '\\n%{http_code}' on /readyz: JSON body, newline, code.
  okbool='true'; [[ "$mode" == 'setup' ]] && okbool='false'
  if [[ "$head" == "${opts.targetSha}" && "${opts.omitBuildShaAtTarget ? "1" : "0"}" == "1" ]] ||
     [[ "$head" == "${opts.prevSha}" && "${opts.omitBuildShaAtPrev ? "1" : "0"}" == "1" ]]; then
    printf '{"status":"ok","mode":"%s","credentialOk":%s}\\n%s' "$mode" "$okbool" "$code"
  elif [[ "$head" == "${opts.prevSha}" && "${opts.mismatchBuildShaAtPrev ? "1" : "0"}" == "1" ]]; then
    printf '{"status":"ok","mode":"%s","credentialOk":%s,"buildSha":"deadbeef"}\\n%s' "$mode" "$okbool" "$code"
  else
    printf '{"status":"ok","mode":"%s","credentialOk":%s,"buildSha":"%s"}\\n%s' "$mode" "$okbool" "$head" "$code"
  fi
  exit 0
fi
# /healthz: mirror -o /dev/null -w '%{http_code}' -> print just the code. Exit 0 so
# the script's own [[ "$http" == "200" ]] gate (not curl's rc) decides.
printf '%s' "$code"
exit 0
`,
  )

  // bun: log the invocation so we can assert install fired ONLY when bun.lock
  // changed. Exit 0 (a real frozen install would succeed on an unchanged lock).
  writeFileSync(
    join(bin, "bun"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${bunLog}"
exit 0
`,
  )

  spawnSync("chmod", ["+x", join(bin, "systemctl"), join(bin, "curl"), join(bin, "bun")])
  return { bin, systemctlLog, curlLog, bunLog }
}
