/**
 * agent-seed-installer.test.ts — pins for the versioned, crash-safe agent
 * seed install (agent sidebar S6).
 *
 * The load-bearing pins: idempotence (a second run is a byte-level no-op),
 * the operator's-file rule (a modified file is NEVER overwritten, even by
 * an upgrade), and the crash-heal (a seeded file with no manifest stamp is
 * adopted, not orphaned).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  installAgentSeeds,
  SEED_MANIFEST_NAME,
} from "../agent-seed-installer.js"

let root: string
let seedsDir: string
let targetDir: string

const seed = (name: string, content: string) => writeFileSync(join(seedsDir, name), content)
const target = (name: string) => readFileSync(join(targetDir, name), "utf8")
const manifest = () =>
  JSON.parse(readFileSync(join(targetDir, SEED_MANIFEST_NAME), "utf8")) as {
    version: number
    files: Record<string, string>
  }

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agent-seeds-"))
  seedsDir = join(root, "seeds")
  targetDir = join(root, "agents")
  mkdirSync(seedsDir, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("installAgentSeeds", () => {
  it("fresh install: writes every seed (README excluded), stamps the manifest", () => {
    seed("advisor.md", "ADVISOR-V1")
    seed("auditor.md", "AUDITOR-V1")
    seed("README.md", "docs — never installed")
    const r = installAgentSeeds(seedsDir, targetDir)
    expect(r.installed.sort()).toEqual(["advisor.md", "auditor.md"])
    expect(r.errors).toEqual([])
    expect(target("advisor.md")).toBe("ADVISOR-V1")
    expect(Object.keys(manifest().files).sort()).toEqual(["advisor.md", "auditor.md"])
  })

  it("second run is a complete no-op", () => {
    seed("advisor.md", "ADVISOR-V1")
    installAgentSeeds(seedsDir, targetDir)
    const before = manifest()
    const r = installAgentSeeds(seedsDir, targetDir)
    expect(r).toEqual({ installed: [], upgraded: [], kept: [], adopted: [], errors: [] })
    expect(manifest()).toEqual(before)
  })

  it("upgrades OUR unmodified file when the bundled seed changes", () => {
    seed("advisor.md", "ADVISOR-V1")
    installAgentSeeds(seedsDir, targetDir)
    seed("advisor.md", "ADVISOR-V2")
    const r = installAgentSeeds(seedsDir, targetDir)
    expect(r.upgraded).toEqual(["advisor.md"])
    expect(target("advisor.md")).toBe("ADVISOR-V2")
  })

  it("NEVER touches an operator-modified file — not even on a seed upgrade", () => {
    seed("advisor.md", "ADVISOR-V1")
    installAgentSeeds(seedsDir, targetDir)
    writeFileSync(join(targetDir, "advisor.md"), "OPERATOR EDITED THIS")
    seed("advisor.md", "ADVISOR-V2")
    const r = installAgentSeeds(seedsDir, targetDir)
    expect(r.kept).toEqual(["advisor.md"])
    expect(r.upgraded).toEqual([])
    expect(target("advisor.md")).toBe("OPERATOR EDITED THIS")
  })

  it("pre-existing operator file with no stamp is kept, never adopted", () => {
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(join(targetDir, "advisor.md"), "OPERATOR'S OWN ADVISOR")
    seed("advisor.md", "ADVISOR-V1")
    const r = installAgentSeeds(seedsDir, targetDir)
    expect(r.kept).toEqual(["advisor.md"])
    expect(target("advisor.md")).toBe("OPERATOR'S OWN ADVISOR")
  })

  it("crash heal: a byte-identical file without a stamp is ADOPTED into the manifest", () => {
    // Simulates the crash window (file written, manifest write never ran)
    // and the manual `cp seeds/agents/*.md ~/.luna/agents/` path alike.
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(join(targetDir, "advisor.md"), "ADVISOR-V1")
    seed("advisor.md", "ADVISOR-V1")
    const r = installAgentSeeds(seedsDir, targetDir)
    expect(r.adopted).toEqual(["advisor.md"])
    expect(manifest().files["advisor.md"]).toBeDefined()
    // And the adoption makes future upgrades flow.
    seed("advisor.md", "ADVISOR-V2")
    expect(installAgentSeeds(seedsDir, targetDir).upgraded).toEqual(["advisor.md"])
  })

  it("files the seeds do not own are never listed or touched", () => {
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(join(targetDir, "my-custom-agent.md"), "MINE")
    seed("advisor.md", "ADVISOR-V1")
    const r = installAgentSeeds(seedsDir, targetDir)
    expect(target("my-custom-agent.md")).toBe("MINE")
    expect([...r.installed, ...r.upgraded, ...r.kept, ...r.adopted]).not.toContain(
      "my-custom-agent.md",
    )
  })

  it("a corrupt manifest degrades to the adopt/keep rules instead of throwing", () => {
    seed("advisor.md", "ADVISOR-V1")
    installAgentSeeds(seedsDir, targetDir)
    writeFileSync(join(targetDir, SEED_MANIFEST_NAME), "{not json")
    const r = installAgentSeeds(seedsDir, targetDir)
    expect(r.errors).toEqual([])
    expect(r.adopted).toEqual(["advisor.md"]) // byte-identical → re-stamped
  })

  it("an unreadable seeds dir reports an error and installs nothing", () => {
    const r = installAgentSeeds(join(root, "nope"), targetDir)
    expect(r.errors.length).toBe(1)
    expect(r.installed).toEqual([])
  })
})
