/**
 * ui-transport-staleness.test.ts
 *
 * Guards against vendor/ui-transport.js drifting from its source in
 * packages/ui-transport. Shells out to `bun run bundle:ui-transport` with a
 * BUNDLE_OUT_FILE env override so we can write to a temp path and compare the
 * result byte-for-byte against the committed file — without clobbering it.
 *
 * If this test fails, run `bun run bundle:ui-transport` to regenerate.
 */
import { describe, it, expect, afterAll } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { execFileSync } from "node:child_process"

const repoRoot = path.resolve(__dirname, "../../..")
const committedPath = path.resolve(__dirname, "../frontend/vendor/ui-transport.js")

// Resolve the bun binary via PATH so we don't hardcode ~/.bun/bin/bun.
function bunBin(): string {
  try {
    return execFileSync("which", ["bun"], { encoding: "utf8" }).trim()
  } catch {
    return "bun"
  }
}

describe("vendor/ui-transport.js staleness guard", () => {
  const tmpFile = path.join(os.tmpdir(), `ui-transport-staleness-${process.pid}.js`)

  afterAll(() => {
    try { fs.unlinkSync(tmpFile) } catch { /* already gone */ }
  })

  it(
    "is byte-identical to a fresh build — if this fails, run `bun run bundle:ui-transport`",
    () => {
      // Run the bundler script via bun, directing output to a temp file so
      // we don't overwrite the committed artifact during the test.
      execFileSync(
        bunBin(),
        ["apps/ui-moon-tauri/scripts/bundle-ui-transport.ts"],
        {
          cwd: repoRoot,
          env: { ...process.env, BUNDLE_OUT_FILE: tmpFile },
          stdio: "pipe",
        },
      )

      const fresh = fs.readFileSync(tmpFile, "utf8")
      const committed = fs.readFileSync(committedPath, "utf8")

      expect(fresh).toBe(
        committed,
        "vendor/ui-transport.js is stale — run `bun run bundle:ui-transport` to regenerate",
      )
    },
    // Bun.build can take several seconds; 30 s is ample for CI.
    30_000,
  )
})
