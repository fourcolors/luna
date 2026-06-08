#!/usr/bin/env bun
/**
 * bump-moon.ts — move the Luna Moon version *triple* in lockstep and (optionally)
 * cut the `moon-v*` tag that triggers the macOS CI build+sign+publish pipeline
 * (`.github/workflows/release-moon.yml`).
 *
 * WHY THIS EXISTS
 * The Tauri app's version lives in THREE files that must always agree:
 *   - apps/ui-moon-tauri/package.json
 *   - apps/ui-moon-tauri/src-tauri/Cargo.toml
 *   - apps/ui-moon-tauri/src-tauri/tauri.conf.json
 * If they drift, the macOS build fails — but only AFTER the irreversible tag push,
 * forcing a `git tag -d` + `--delete` cleanup. The fix is twofold: (1) a single
 * writer that bumps all three atomically, and (2) a `--check` gate that CI runs on
 * every PR so drift is caught BEFORE any tag exists. The Mac build itself is fully
 * autonomous in CI (no local Mac needed) — the only missing piece was a safe bump.
 *
 * USAGE
 *   bun run scripts/bump-moon.ts --check                 # assert the 3 versions match (CI gate; exit 1 on drift)
 *   bun run scripts/bump-moon.ts <x.y.z>                 # rewrite all 3 to <x.y.z>
 *   bun run scripts/bump-moon.ts <x.y.z> --tag          # also: git commit the 3 files + annotated tag moon-v<x.y.z>
 *   bun run scripts/bump-moon.ts <x.y.z> --tag --push   # also: push the tag -> fires the macOS release CI
 *
 * --push is a "release that publishes to users" — keep it an operator-gated action.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { spawnSync } from "node:child_process"

export type Kind = "json" | "toml"
export interface VersionFile {
  readonly path: string
  readonly kind: Kind
}

/** The three files that carry the Moon version and MUST stay in lockstep. */
export const VERSION_FILES: readonly VersionFile[] = [
  { path: "apps/ui-moon-tauri/package.json", kind: "json" },
  { path: "apps/ui-moon-tauri/src-tauri/Cargo.toml", kind: "toml" },
  { path: "apps/ui-moon-tauri/src-tauri/tauri.conf.json", kind: "json" },
]

export const SEMVER = /^\d+\.\d+\.\d+$/

/* -------------------------------------------------------------------------- */
/* Pure helpers (unit-tested in test/bump-moon.test.ts)                        */
/* -------------------------------------------------------------------------- */

/** First version field. JSON: `"version": "x.y.z"`. TOML: a top-of-line `version = "x.y.z"` (the [package] version, NOT a dependency). */
export const extractVersion = (content: string, kind: Kind): string | null => {
  const re =
    kind === "json"
      ? /"version"\s*:\s*"(\d+\.\d+\.\d+)"/
      : /^version\s*=\s*"(\d+\.\d+\.\d+)"/m
  const m = content.match(re)
  return m ? (m[1] as string) : null
}

/** Replace ONLY the first version field, preserving surrounding formatting. */
export const replaceVersion = (content: string, kind: Kind, next: string): string => {
  const re =
    kind === "json"
      ? /("version"\s*:\s*")(\d+\.\d+\.\d+)(")/
      : /^(version\s*=\s*")(\d+\.\d+\.\d+)(")/m
  if (!re.test(content)) throw new Error(`no version field found (kind=${kind})`)
  return content.replace(re, (_m, a: string, _v: string, c: string) => `${a}${next}${c}`)
}

export interface VersionEntry extends VersionFile {
  readonly version: string | null
}

export interface SyncResult {
  readonly ok: boolean
  readonly entries: readonly VersionEntry[]
  readonly distinct: readonly string[]
}

/** Pure: given the three files' contents, decide whether they are in sync. */
export const checkSync = (contents: ReadonlyMap<string, string>): SyncResult => {
  const entries: VersionEntry[] = VERSION_FILES.map((f) => ({
    ...f,
    version: extractVersion(contents.get(f.path) ?? "", f.kind),
  }))
  const found = entries.map((e) => e.version).filter((v): v is string => v !== null)
  const distinct = [...new Set(found)]
  const ok = found.length === VERSION_FILES.length && distinct.length === 1 && SEMVER.test(distinct[0] as string)
  return { ok, entries, distinct }
}

/* -------------------------------------------------------------------------- */
/* Impure CLI                                                                  */
/* -------------------------------------------------------------------------- */

const repoRoot = (): string => join(dirname(new URL(import.meta.url).pathname), "..")

const readContents = (root: string): Map<string, string> => {
  const m = new Map<string, string>()
  for (const f of VERSION_FILES) m.set(f.path, readFileSync(join(root, f.path), "utf8"))
  return m
}

const git = (root: string, ...args: string[]): { ok: boolean; out: string } => {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" })
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() }
}

const die = (msg: string): never => {
  process.stderr.write(`bump-moon: ${msg}\n`)
  process.exit(1)
}

const main = (): void => {
  const argv = process.argv.slice(2)
  const root = repoRoot()
  const flags = new Set(argv.filter((a) => a.startsWith("--")))
  const positional = argv.filter((a) => !a.startsWith("--"))

  // --check: pure gate for CI.
  if (flags.has("--check")) {
    const res = checkSync(readContents(root))
    for (const e of res.entries) process.stdout.write(`  ${e.version ?? "MISSING"}  ${e.path}\n`)
    if (!res.ok) die(`version drift — files disagree: [${res.distinct.join(", ") || "none"}]. All three must equal one x.y.z.`)
    process.stdout.write(`✓ moon version in sync: ${res.distinct[0]}\n`)
    return
  }

  const next = positional[0]
  if (!next) die("usage: bump-moon.ts <x.y.z> [--tag [--push]]  |  bump-moon.ts --check")
  if (!SEMVER.test(next as string)) die(`'${next}' is not a valid x.y.z version`)

  // Rewrite all three.
  for (const f of VERSION_FILES) {
    const p = join(root, f.path)
    const before = readFileSync(p, "utf8")
    const after = replaceVersion(before, f.kind, next as string)
    if (before !== after) writeFileSync(p, after)
    process.stdout.write(`  set ${next}  ${f.path}\n`)
  }

  // Re-read and assert the write produced a synced triple.
  const res = checkSync(readContents(root))
  if (!res.ok || res.distinct[0] !== next) die(`post-write check failed (got [${res.distinct.join(", ")}]) — aborting before any tag`)
  process.stdout.write(`✓ all three files now at ${next}\n`)

  if (!flags.has("--tag")) {
    process.stdout.write(`\nNext: review the diff, then re-run with --tag (and --push to release).\n`)
    return
  }

  const tag = `moon-v${next}`
  if (git(root, "rev-parse", "-q", "--verify", `refs/tags/${tag}`).ok) die(`tag ${tag} already exists — pick a new version`)

  const add = git(root, "add", ...VERSION_FILES.map((f) => f.path))
  if (!add.ok) die(`git add failed: ${add.out}`)
  const commit = git(root, "commit", "-m", `chore(ui-moon-tauri): bump to ${next}`)
  if (!commit.ok) die(`git commit failed: ${commit.out}`)
  const tagged = git(root, "tag", "-a", tag, "-m", `Luna Moon ${next}`)
  if (!tagged.ok) die(`git tag failed: ${tagged.out}`)
  process.stdout.write(`✓ committed + tagged ${tag}\n`)

  if (!flags.has("--push")) {
    process.stdout.write(`\nNext (operator-gated — this publishes to users): git push origin ${tag}\n`)
    return
  }
  const push = git(root, "push", "origin", tag)
  if (!push.ok) die(`git push failed: ${push.out}`)
  process.stdout.write(`✓ pushed ${tag} — macOS release CI (release-moon.yml) will build + sign + publish.\n`)
}

// Only run the CLI when invoked directly (not when imported by tests).
if (import.meta.main) main()
