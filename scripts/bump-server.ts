#!/usr/bin/env bun
/**
 * bump-server.ts — bump the Luna server version and (optionally) cut the
 * `server-v*` annotated tag that triggers the release CI pipeline
 * (`.github/workflows/release-server.yml`).
 *
 * VERSION SOURCE OF TRUTH
 * The server ships as source (no binary build) so there is only ONE file
 * that needs to carry the version: `server.version.json` at the repo root.
 * `PKG_VERSION` in `packages/control-server/src/router.ts` is wired to read
 * this file at import time (so `control.status` + `control.version` return a
 * real semver, not the dead `"0.0.1"` literal).  Keeping a single JSON file
 * (rather than duplicating into every package.json) mirrors the simplest
 * possible extension of bump-moon.ts while avoiding the Moon-style "three
 * files that must agree" problem — a server has no Cargo.toml or Tauri config
 * to keep in lockstep.
 *
 * USAGE
 *   bun run scripts/bump-server.ts --check               # CI gate: version is valid semver (exit 1 if not)
 *   bun run scripts/bump-server.ts <x.y.z>               # rewrite server.version.json to <x.y.z>
 *   bun run scripts/bump-server.ts <x.y.z> --tag         # also: git commit + annotated tag server-v<x.y.z>
 *   bun run scripts/bump-server.ts <x.y.z> --tag --push  # also: push the tag → fires release-server.yml
 *
 * --push is operator-gated: it publishes a GitHub Release visible to all
 * self-hosters. Do not run it without reviewing the diff and intent.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

/** Path (relative to repo root) of the single server version file. */
export const VERSION_FILE = "server.version.json"

export const SEMVER = /^\d+\.\d+\.\d+$/

/* -------------------------------------------------------------------------- */
/* Pure helpers (unit-testable without side effects)                          */
/* -------------------------------------------------------------------------- */

/** Extract the `version` string from the JSON content. Returns null on failure. */
export const extractVersion = (content: string): string | null => {
  try {
    const parsed = JSON.parse(content) as unknown
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "version" in parsed &&
      typeof (parsed as Record<string, unknown>)["version"] === "string"
    ) {
      return (parsed as Record<string, string>)["version"] ?? null
    }
    return null
  } catch {
    return null
  }
}

/** Return a new JSON string with only the `version` field updated. Preserves trailing newline. */
export const replaceVersion = (content: string, next: string): string => {
  const parsed = JSON.parse(content) as Record<string, unknown>
  parsed["version"] = next
  return JSON.stringify(parsed, null, 2) + "\n"
}

export interface CheckResult {
  readonly ok: boolean
  readonly version: string | null
  readonly message: string
}

/** Pure: read the version from JSON content and validate it. */
export const checkVersion = (content: string): CheckResult => {
  const version = extractVersion(content)
  if (version === null) return { ok: false, version: null, message: `no valid "version" string in ${VERSION_FILE}` }
  if (!SEMVER.test(version)) return { ok: false, version, message: `"${version}" is not a valid x.y.z semver` }
  return { ok: true, version, message: `server version: ${version}` }
}

/* -------------------------------------------------------------------------- */
/* Impure CLI                                                                  */
/* -------------------------------------------------------------------------- */

const repoRoot = (): string => join(dirname(fileURLToPath(import.meta.url)), "..")

const git = (root: string, ...args: string[]): { ok: boolean; out: string } => {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" })
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() }
}

const die = (msg: string): never => {
  process.stderr.write(`bump-server: ${msg}\n`)
  process.exit(1)
}

const main = (): void => {
  const argv = process.argv.slice(2)
  const root = repoRoot()
  const flags = new Set(argv.filter((a) => a.startsWith("--")))
  const positional = argv.filter((a) => !a.startsWith("--"))

  const versionFilePath = join(root, VERSION_FILE)

  // --check: pure CI gate. Read defensively so a missing/unreadable
  // server.version.json fails the gate cleanly (exit 1 + clear message)
  // rather than throwing a raw stack trace.
  if (flags.has("--check")) {
    let content: string
    try {
      content = readFileSync(versionFilePath, "utf8")
    } catch (e) {
      return die(`cannot read ${VERSION_FILE} at ${versionFilePath}: ${e instanceof Error ? e.message : String(e)}`)
    }
    const result = checkVersion(content)
    if (!result.ok) die(result.message)
    process.stdout.write(`✓ ${result.message}\n`)
    return
  }

  // --push without --tag would rewrite the file then silently no-op (the push
  // only runs inside the --tag branch). Guard BEFORE any rewrite so the operator
  // gets a clear error instead of a half-applied bump.
  if (flags.has("--push") && !flags.has("--tag")) die("--push requires --tag")

  const next = positional[0]
  if (!next) die("usage: bump-server.ts <x.y.z> [--tag [--push]]  |  bump-server.ts --check")
  if (!SEMVER.test(next)) die(`'${next}' is not a valid x.y.z version`)

  // Rewrite server.version.json.
  const before = readFileSync(versionFilePath, "utf8")
  const after = replaceVersion(before, next)
  writeFileSync(versionFilePath, after)
  process.stdout.write(`  set ${next}  ${VERSION_FILE}\n`)

  // Post-write sanity check.
  const check = checkVersion(readFileSync(versionFilePath, "utf8"))
  if (!check.ok || check.version !== next) die(`post-write check failed (got "${check.version}") — aborting before any tag`)
  process.stdout.write(`✓ ${VERSION_FILE} now at ${next}\n`)

  if (!flags.has("--tag")) {
    process.stdout.write(`\nNext: review the diff, then re-run with --tag (and --push to release).\n`)
    return
  }

  const tag = `server-v${next}`
  if (git(root, "rev-parse", "-q", "--verify", `refs/tags/${tag}`).ok) die(`tag ${tag} already exists — pick a new version`)

  // Commit ONLY the version file. `--only <path>` stages and commits exactly
  // that path, ignoring anything else already staged — so a pre-staged change
  // can never sneak into the bump commit.
  const commit = git(root, "commit", "--only", VERSION_FILE, "-m", `chore(server): bump to ${next}`)
  if (!commit.ok) die(`git commit failed: ${commit.out}`)
  const tagged = git(root, "tag", "-a", tag, "-m", `Luna Server ${next}`)
  if (!tagged.ok) die(`git tag failed: ${tagged.out}`)
  process.stdout.write(`✓ committed + tagged ${tag}\n`)

  if (!flags.has("--push")) {
    process.stdout.write(`\nNext (operator-gated — this publishes a release): git push origin ${tag}\n`)
    return
  }
  const push = git(root, "push", "origin", tag)
  if (!push.ok) die(`git push failed: ${push.out}`)
  process.stdout.write(`✓ pushed ${tag} — release-server.yml will create a GitHub Release with server-latest.json.\n`)
}

// Only run the CLI when invoked directly (not when imported by tests).
if (import.meta.main) main()
