/**
 * capabilities-staleness.test.ts
 *
 * Guards against vendor/capabilities.js drifting from its source in
 * packages/capabilities. Shells out to `bun run bundle:capabilities` with a
 * BUNDLE_OUT_FILE env override so we can write to a temp path and compare the
 * result byte-for-byte against the committed file — without clobbering it.
 *
 * If this test fails, run `bun run bundle:capabilities` to regenerate.
 */
import { describe, it, expect, afterAll } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { execFileSync } from "node:child_process"

const repoRoot = path.resolve(__dirname, "../../..")
const committedPath = path.resolve(__dirname, "../frontend/vendor/capabilities.js")

// Resolve the bun binary via PATH so we don't hardcode ~/.bun/bin/bun.
function bunBin(): string {
  try {
    return execFileSync("which", ["bun"], { encoding: "utf8" }).trim()
  } catch {
    return "bun"
  }
}

/**
 * THE COMPARISON IS ONLY MEANINGFUL ON THE PINNED bun (issue #523).
 *
 * The bundle embeds bun's own bundler prelude, which changes between bun
 * versions - so a fresh build on any other bun differs from the committed file
 * in helper functions that have nothing to do with capabilities. This test was
 * red for every developer whose bun was not CI's, and worse, its failure
 * message told them to regenerate: doing that on an unpinned bun rewrites the
 * artifact with the wrong prelude and turns CI red for everyone else. The
 * remediation advice was actively harmful to the exact audience that saw it.
 *
 * So the version is read from the workflow that pins it, rather than being
 * duplicated here where it would silently rot.
 */
const pinnedBunVersion = (): string => {
  const wf = fs.readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8")
  const m = wf.match(/bun-version:\s*"([^"]+)"/)
  if (m === null) throw new Error("could not read the pinned bun-version from .github/workflows/ci.yml")
  return m[1]
}

const localBunVersion = (): string => {
  try {
    return execFileSync(bunBin(), ["--version"], { encoding: "utf8" }).trim()
  } catch {
    return ""
  }
}

describe("vendor/capabilities.js staleness guard", () => {
  const tmpFile = path.join(os.tmpdir(), `capabilities-staleness-${process.pid}.js`)
  const pinned = pinnedBunVersion()
  const local = localBunVersion()
  // Loud, not silent: a skip that says nothing is how a guard quietly stops
  // guarding. This names both versions so the reason is obvious at a glance.
  const skipReason =
    local === "" ? "bun not found on PATH"
    : local !== pinned ? `local bun ${local} differs from the CI-pinned ${pinned}; the bundler prelude differs by version, so a byte comparison is meaningless here. Do NOT run \`bun run bundle:capabilities\` to "fix" this - on an unpinned bun that breaks CI for everyone else.`
    : ""

  // Say it out loud. A guard that quietly stops guarding is worse than one
  // that fails, because nothing ever prompts anyone to look at it again.
  if (skipReason !== "") {
    console.warn(`[capabilities-staleness] SKIPPED: ${skipReason}`)
  }

  afterAll(() => {
    try { fs.unlinkSync(tmpFile) } catch { /* already gone */ }
  })

  it.skipIf(skipReason !== "")(
    "is byte-identical to a fresh build — if this fails, run `bun run bundle:capabilities`",
    () => {
      execFileSync(
        bunBin(),
        ["apps/ui-moon-tauri/scripts/bundle-capabilities.ts"],
        {
          cwd: repoRoot,
          env: { ...process.env, BUNDLE_OUT_FILE: tmpFile },
          stdio: "pipe",
        },
      )

      const fresh = fs.readFileSync(tmpFile, "utf8")
      const committed = fs.readFileSync(committedPath, "utf8")

      expect(
        fresh,
        "vendor/capabilities.js is stale - run `bun run bundle:capabilities` to regenerate",
      ).toBe(committed)
    },
    30_000,
  )
})
