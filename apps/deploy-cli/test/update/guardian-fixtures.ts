/**
 * Hermetic bash-side fixture for guardian's state-file writers
 * (write_guardian_status, health_journal_write). Unlike
 * scripts/luna-update-server, scripts/luna-guardian ships a sourcing guard
 * (`if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then ... fi` at its tail) that is
 * an explicit, documented test seam: "sourcing this file... exercises its
 * functions... against a controlled environment without ever reaching this
 * tail". This fixture uses exactly that seam - source the real script, then
 * call the target function directly with $P_REPO/$STATE_DIR pointed at a
 * temp fixture - rather than reimplementing or extracting its functions.
 */
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { cleanupTempDirs as sharedCleanupTempDirs, makeTempDir as sharedMakeTempDir, repoRoot } from "./temp-dirs.js"

const guardianScript = join(repoRoot, "scripts/luna-guardian")

export const cleanupTempDirs = sharedCleanupTempDirs
export const makeTempDir = (): string => sharedMakeTempDir("deploy-cli-guardian-parity-")

/**
 * Throws on a non-zero git exit rather than swallowing it, mirroring
 * bash-fixtures.ts's own `git()` helper. Without this, a failing `commit`
 * (e.g. under an ambient `commit.gpgsign=true` with no usable key) silently
 * leaves the repo at its pre-commit state, `rev-parse HEAD` still succeeds
 * against whatever HEAD already resolved to (`"HEAD"`'s own dangling-ref
 * value on a truly empty repo), and every parity test built on makeRepo()
 * stays green while proving nothing against a real commit.
 */
const git = (cwd: string, ...args: ReadonlyArray<string>): string => {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" })
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`)
  return r.stdout.trim()
}

/** A one-commit git repo, standing in for $P_REPO. */
export const makeRepo = (root: string): { dir: string; sha: string } => {
  const dir = join(root, "repo")
  mkdirSync(dir, { recursive: true })
  git(dir, "init", "-q")
  git(dir, "-c", "user.email=t@example.test", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init")
  const sha = git(dir, "rev-parse", "HEAD")
  return { dir, sha }
}

/**
 * Sources scripts/luna-guardian, sets $P_REPO, then runs `statement` (a
 * literal call against the sourced function, e.g.
 * `write_guardian_status stable healthy true`). STATE_DIR/PIN_BASE are read
 * by the sourced script from LUNA_GUARDIAN_STATE_DIR/LUNA_GUARDIAN_PIN_BASE
 * (its own top-level `"${VAR:-default}"` assignments, which run on source).
 */
export const runGuardianSourced = (
  statement: string,
  opts: { readonly repo: string; readonly stateDir: string; readonly pinBase: string },
): { readonly status: number | null; readonly stdout: string; readonly stderr: string } => {
  const script = `set -euo pipefail\nsource "${guardianScript}"\nP_REPO="${opts.repo}"\n${statement}\n`
  const r = spawnSync("bash", ["-c", script], {
    env: { ...process.env, LUNA_GUARDIAN_STATE_DIR: opts.stateDir, LUNA_GUARDIAN_PIN_BASE: opts.pinBase },
    encoding: "utf8",
  })
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
}

/** Runs the literal sed idiom scripts/luna-guardian-remote-check's `value()` uses (guardian-remote-check:34) against a local file - the "equivalent sed-level assertion" the S22a acceptance criterion allows in place of a live ssh round-trip. */
export const sedValue = (file: string, key: string): string => {
  const r = spawnSync("bash", ["-c", `sed -n "s/^${key}=//p" "$1" | head -1`, "bash", file], { encoding: "utf8" })
  if (r.status !== 0) throw new Error(`sed failed for key ${key}: ${r.stderr}`)
  return r.stdout.replace(/\n$/, "")
}
