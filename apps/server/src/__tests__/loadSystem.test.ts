/**
 * loadSystem helper unit tests.
 *
 * SYSTEM.md is the mechanics counterpart to DNA.md. Unlike DNA.md, it is
 * NOT required for boot — Luna runs identity-only if SYSTEM.md is absent.
 *
 * Verifies that:
 *   1. loadSystem returns trimmed file content when SYSTEM.md exists.
 *   2. loadSystem returns null when SYSTEM.md is missing
 *      (graceful degradation, not a thrown error).
 *   3. ~/.luna/SYSTEM.md takes precedence over the repo-relative file
 *      (personal-install override mirrors loadDna's resolution order).
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { loadSystem } from "../system-loader.js"

describe("loadSystem", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "luna-loadSystem-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("returns trimmed file content when SYSTEM.md exists in repo root", () => {
    const scriptDir = path.join(tmpDir, "apps", "ui-web", "scripts")
    fs.mkdirSync(scriptDir, { recursive: true })

    const systemContent = "# 🌙 Luna — SYSTEM\n\nMechanics doc."
    fs.writeFileSync(path.join(tmpDir, "SYSTEM.md"), `\n${systemContent}\n\n`)

    // Pass null to bypass ~/.luna/SYSTEM.md so we exercise the repo-relative path.
    const result = loadSystem(scriptDir, null)
    expect(result).toBe(systemContent)
  })

  it("returns null when SYSTEM.md is missing (non-fatal)", () => {
    const result = loadSystem("/nonexistent/path", null)
    expect(result).toBeNull()
  })

  it("personal SYSTEM.md takes precedence over repo SYSTEM.md", () => {
    const scriptDir = path.join(tmpDir, "apps", "ui-web", "scripts")
    fs.mkdirSync(scriptDir, { recursive: true })
    fs.writeFileSync(path.join(tmpDir, "SYSTEM.md"), "repo version")

    const personalPath = path.join(tmpDir, "personal-SYSTEM.md")
    fs.writeFileSync(personalPath, "personal override")

    const result = loadSystem(scriptDir, personalPath)
    expect(result).toBe("personal override")
  })
})
