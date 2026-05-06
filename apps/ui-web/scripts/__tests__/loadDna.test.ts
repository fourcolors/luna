/**
 * §2.4 — loadDna helper unit tests.
 *
 * Verifies that:
 *   1. loadDna returns the trimmed file content when DNA.md exists.
 *   2. loadDna throws when DNA.md is missing (loud failure = correct behaviour
 *      for a misconfigured Luna boot).
 *
 * loadDna lives in dna-loader.ts (zero non-node deps) and is re-exported
 * from dev-server-chat.ts so both import paths are valid. Tests use the
 * direct path to avoid pulling in the full server dependency tree.
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { loadDna } from "../dna-loader.js"

describe("loadDna", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "luna-loadDna-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("loadDna: returns file content when DNA.md exists", () => {
    // DNA.md is expected 3 levels UP from scriptDir.
    // scriptDir = <tmpDir>/apps/ui-web/scripts → DNA.md at <tmpDir>/DNA.md
    const scriptDir = path.join(tmpDir, "apps", "ui-web", "scripts")
    fs.mkdirSync(scriptDir, { recursive: true })

    const dnaContent = "You are **Luna** — a modular, locally-hosted AI agent framework."
    fs.writeFileSync(path.join(tmpDir, "DNA.md"), `  ${dnaContent}  `)

    const result = loadDna(scriptDir)
    expect(result).toBe(dnaContent)
  })

  it("loadDna: throws when DNA.md is missing", () => {
    expect(() => loadDna("/nonexistent/path")).toThrow()
  })
})
