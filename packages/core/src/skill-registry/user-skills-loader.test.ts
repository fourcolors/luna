/**
 * user-skills-loader tests — frontmatter parsing, directory scanning,
 * and the registry sync (add/update/remove/conflict + toggle survival
 * across re-registration, which leans on the registry's live disabled-set).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Effect } from "effect"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  SkillRegistry,
  type SkillManifest,
} from "./skill-registry.js"
import {
  parseSkillMd,
  scanUserSkills,
  syncUserSkills,
} from "./user-skills-loader.js"

const MD = (front: string, body = "Do the thing.\nStep by step.") =>
  `---\n${front}\n---\n${body}\n`

describe("parseSkillMd", () => {
  it("parses full frontmatter into a user-sourced manifest", () => {
    const { manifest } = parseSkillMd(
      MD(
        [
          "name: Git Ops",
          "description: Branch & PR workflows.",
          "whenToUse: Any git task.",
          "category: workflow",
          "tags: git, vcs",
        ].join("\n"),
      ),
      "git-ops",
    )
    expect(manifest).toMatchObject({
      id: "git-ops",
      name: "Git Ops",
      description: "Branch & PR workflows.",
      whenToUse: "Any git task.",
      category: "workflow",
      tags: ["git", "vcs"],
      source: "user",
    })
    expect(manifest?.body).toContain("Do the thing.")
  })

  it("defaults: name=id, whenToUse=description, category=other; bracket tags parse", () => {
    const { manifest } = parseSkillMd(
      MD("description: Minimal skill.\ntags: [a, b]"),
      "minimal",
    )
    expect(manifest).toMatchObject({
      name: "minimal",
      whenToUse: "Minimal skill.",
      category: "other",
      tags: ["a", "b"],
    })
  })

  it("rejects: bad id, missing description, empty body, unknown category coerced", () => {
    expect(parseSkillMd(MD("description: x"), "Bad_ID!").manifest).toBeNull()
    expect(parseSkillMd(MD("name: NoDesc"), "nodesc").manifest).toBeNull()
    expect(parseSkillMd("---\ndescription: x\n---\n   \n", "emptybody").manifest).toBeNull()
    expect(
      parseSkillMd(MD("description: x\ncategory: nonsense"), "weird").manifest
        ?.category,
    ).toBe("other")
  })
})

describe("scanUserSkills", () => {
  const dir = join(tmpdir(), `luna-user-skills-${process.pid}-${Date.now()}`)

  beforeEach(() => {
    mkdirSync(join(dir, "good"), { recursive: true })
    writeFileSync(join(dir, "good", "SKILL.md"), MD("description: A good skill."))
    mkdirSync(join(dir, "broken"), { recursive: true })
    writeFileSync(join(dir, "broken", "SKILL.md"), MD("name: no description here"))
    mkdirSync(join(dir, "no-skill-file"), { recursive: true })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("collects valid manifests, warns on broken, skips dirs without SKILL.md", () => {
    const scan = scanUserSkills(dir)
    expect(scan.manifests.map((m) => m.id)).toEqual(["good"])
    expect(scan.warnings.join(" ")).toContain("broken")
  })

  it("missing root dir → empty scan, no warnings", () => {
    const scan = scanUserSkills(join(dir, "does-not-exist"))
    expect(scan).toEqual({ manifests: [], warnings: [] })
  })
})

describe("syncUserSkills", () => {
  const builtin: SkillManifest = {
    id: "shadow-me",
    name: "Built-in",
    description: "A built-in skill.",
    whenToUse: "Always.",
    category: "other",
    tags: [],
    source: "builtin",
    body: "BUILTIN-BODY",
  }
  const user = (id: string, body = `USER-${id}`): SkillManifest => ({
    id,
    name: `User ${id}`,
    description: `User skill ${id}.`,
    whenToUse: `When ${id}.`,
    category: "other",
    tags: [],
    source: "user",
    body,
  })

  it("new skills register ENABLED by default (2026-07-22 decision, supersedes prior quarantine-on-create); explicit operator disable still survives re-sync", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const reg = yield* SkillRegistry

        // `approvedIds` is accepted but no longer gates anything — both a
        // previously-known id and a brand-new one register enabled.
        const summary = yield* syncUserSkills(
          reg,
          { manifests: [user("previously-approved"), user("brand-new")], warnings: [] },
          { approvedIds: new Set(["previously-approved"]) },
        )
        expect(summary.quarantined).toEqual([])
        const cat = yield* reg.catalog()
        expect(cat.find((e) => e.id === "previously-approved")?.enabled).toBe(true)
        expect(cat.find((e) => e.id === "brand-new")?.enabled).toBe(true)
        expect(reg.promptSnapshotSync()).toContain("USER-brand-new")

        // Operator can still explicitly disable a skill; that choice is
        // durable and must survive the next sync round (live disabled-set,
        // unchanged from before).
        yield* reg.setEnabled("brand-new", false)
        const round2 = yield* syncUserSkills(
          reg,
          { manifests: [user("previously-approved"), user("brand-new")], warnings: [] },
          { approvedIds: new Set(["previously-approved", "brand-new"]) },
        )
        expect(round2.quarantined).toEqual([])
        expect(
          (yield* reg.catalog()).find((e) => e.id === "brand-new")?.enabled,
        ).toBe(false)
      }).pipe(Effect.provide(SkillRegistry.Default)),
    )
  })

  it("add / update / remove / conflict, with toggle state surviving re-registration", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const reg = yield* SkillRegistry

        // Round 1: two user skills + a conflict with the builtin id.
        let summary = yield* syncUserSkills(reg, {
          manifests: [user("alpha"), user("beta"), user("shadow-me")],
          warnings: [],
        })
        expect(summary).toMatchObject({ added: 2, updated: 0, removed: 0 })
        expect(summary.conflicts).toEqual(["shadow-me"])
        // builtin untouched by the conflicting user skill
        expect(yield* reg.body("shadow-me")).toBe("BUILTIN-BODY")

        // Operator disables beta via settings.
        yield* reg.setEnabled("beta", false)
        expect(reg.promptSnapshotSync()).not.toContain("USER-beta")

        // Round 2: alpha edited, beta unchanged, gamma new.
        summary = yield* syncUserSkills(reg, {
          manifests: [user("alpha", "USER-alpha-v2"), user("beta"), user("gamma")],
          warnings: [],
        })
        expect(summary).toMatchObject({ added: 1, updated: 1, removed: 0 })
        expect(yield* reg.body("alpha")).toBe("USER-alpha-v2")
        // beta is STILL disabled (live disabled-set honored on no-op rounds)
        const beta = (yield* reg.catalog()).find((e) => e.id === "beta")
        expect(beta?.enabled).toBe(false)

        // Round 3: beta's file EDITED while disabled → re-registered, must
        // re-enter DISABLED (the bug the live disabled-set exists to kill).
        summary = yield* syncUserSkills(reg, {
          manifests: [user("alpha", "USER-alpha-v2"), user("beta", "USER-beta-v2"), user("gamma")],
          warnings: [],
        })
        expect(summary).toMatchObject({ added: 0, updated: 1, removed: 0 })
        const betaAfter = (yield* reg.catalog()).find((e) => e.id === "beta")
        expect(betaAfter?.enabled).toBe(false)
        expect(reg.promptSnapshotSync()).not.toContain("USER-beta-v2")

        // Round 4: alpha + beta deleted from disk.
        summary = yield* syncUserSkills(reg, {
          manifests: [user("gamma")],
          warnings: [],
        })
        expect(summary).toMatchObject({ added: 0, updated: 0, removed: 2 })
        const ids = (yield* reg.catalog()).map((e) => e.id).sort()
        expect(ids).toEqual(["gamma", "shadow-me"])
      }).pipe(
        Effect.provide(SkillRegistry.layer({ seeds: [builtin] })),
      ),
    )
  })
})
