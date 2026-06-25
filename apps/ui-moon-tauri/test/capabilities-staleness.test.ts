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

describe("vendor/capabilities.js staleness guard", () => {
  const tmpFile = path.join(os.tmpdir(), `capabilities-staleness-${process.pid}.js`)

  afterAll(() => {
    try { fs.unlinkSync(tmpFile) } catch { /* already gone */ }
  })

  it(
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
