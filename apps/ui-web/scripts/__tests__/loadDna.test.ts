/**
 * §2.4 — loadDna helper unit tests.
 *
 * Verifies that:
 *   1. loadDna returns the trimmed file content when DNA.md exists.
 *   2. loadDna throws when DNA.md is missing (loud failure = correct behaviour
 *      for a misconfigured Luna boot).
 *
 * loadDna lives in dna-loader.ts (zero non-node deps) and is re-exported
 * from chat-server.ts so both import paths are valid. Tests use the
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

    // Pass null to bypass ~/.luna/DNA.md so we exercise the repo-relative path.
    const result = loadDna(scriptDir, null)
    expect(result).toBe(dnaContent)
  })

  it("loadDna: throws when DNA.md is missing", () => {
    // Pass null to bypass ~/.luna/DNA.md — only the repo-relative path is checked.
    expect(() => loadDna("/nonexistent/path", null)).toThrow()
  })

  it("loadDna: personal ~/.luna/DNA.md takes precedence over repo DNA.md", () => {
    // Both a personal override and a repo DNA.md exist; personal wins.
    const scriptDir = path.join(tmpDir, "apps", "ui-web", "scripts")
    fs.mkdirSync(scriptDir, { recursive: true })

    const repoDna = "You are **Luna** — generic repo identity."
    fs.writeFileSync(path.join(tmpDir, "DNA.md"), repoDna)

    const personalDna = "You are **Jax** — the Chairman's personal AI agent."
    const personalPath = path.join(tmpDir, "personal-DNA.md")
    fs.writeFileSync(personalPath, `  ${personalDna}  `)

    const result = loadDna(scriptDir, personalPath)
    expect(result).toBe(personalDna)
    expect(result).not.toContain("Luna")
  })

  it("loadDna: falls back to repo DNA.md when personal path does not exist", () => {
    // Personal path is provided but the file is absent — fall through to repo.
    const scriptDir = path.join(tmpDir, "apps", "ui-web", "scripts")
    fs.mkdirSync(scriptDir, { recursive: true })

    const repoDna = "You are **Luna** — generic repo identity."
    fs.writeFileSync(path.join(tmpDir, "DNA.md"), repoDna)

    const absentPersonal = path.join(tmpDir, "nonexistent-personal-DNA.md")
    const result = loadDna(scriptDir, absentPersonal)
    expect(result).toBe(repoDna)
  })
})
