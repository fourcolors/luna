import { describe, expect, it } from "vitest"
import { BUILTIN_SKILLS } from "./builtin-skills.js"

describe("BUILTIN_SKILLS", () => {
  it("has unique ids", () => {
    const ids = BUILTIN_SKILLS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("gives every skill a description, trigger hint, and body", () => {
    for (const s of BUILTIN_SKILLS) {
      expect(s.source).toBe("builtin")
      expect(s.description.trim().length).toBeGreaterThan(0)
      expect(s.whenToUse.trim().length).toBeGreaterThan(0)
      expect(s.body.trim().length).toBeGreaterThan(0)
    }
  })

  it("ships screenshot-intake, which persists images out of the temp folder", () => {
    const skill = BUILTIN_SKILLS.find((s) => s.id === "screenshot-intake")
    expect(skill).toBeDefined()
    expect(skill?.body).toContain(".workspace/attachments/")
    expect(skill?.body).toContain("CREATE TABLE IF NOT EXISTS attachments")
  })
})
