import { describe, expect, it } from "vitest"
import {
  deriveSkillImprovementTargetId,
  isSkillImprovementAfter,
  MAX_SKILL_IMPROVEMENT_CHIPS,
  skillImprovementToPropose,
} from "./skill-chip.js"
import type { DreamOp } from "./types.js"

describe("skill-chip", () => {
  it("exports a positive night-wide chip budget", () => {
    expect(MAX_SKILL_IMPROVEMENT_CHIPS).toBe(3)
  })

  it("isSkillImprovementAfter accepts valid payloads", () => {
    expect(
      isSkillImprovementAfter({
        mode: "create",
        skillId: null,
        title: "Deploy runbook skill",
        detail: null,
        prompt: "Author a skill for deploy runbooks",
      }),
    ).toBe(true)
  })

  it("isSkillImprovementAfter rejects incomplete payloads", () => {
    expect(isSkillImprovementAfter({ mode: "create", title: "x" })).toBe(false)
    expect(isSkillImprovementAfter(null)).toBe(false)
  })

  it("maps create → create_skill with source dream", () => {
    const op: DreamOp = {
      kind: "skill_improvement",
      targetId: "skill-imp-abc",
      before: null,
      after: {
        mode: "create",
        skillId: null,
        title: "Deploy runbook skill",
        detail: "Codify the deploy checklist",
        prompt: "Write SKILL.md covering jax-box deploys",
      },
      rationale: "Operator repeated the same deploy steps thrice",
    }
    const input = skillImprovementToPropose(op, "thread-1")
    expect(input).not.toBeNull()
    expect(input!.source).toBe("dream")
    expect(input!.actionType).toBe("create_skill")
    expect(input!.threadId).toBe("thread-1")
    expect(input!.title).toBe("Deploy runbook skill")
    expect(input!.payload).toMatchObject({
      prompt: expect.stringContaining("Write SKILL.md covering jax-box deploys"),
    })
    expect((input!.payload as { prompt: string }).prompt).toContain(
      "Create a new Luna skill",
    )
  })

  it("maps update → task targeting the existing skill path", () => {
    const op: DreamOp = {
      kind: "skill_improvement",
      targetId: "deploy-runbook",
      before: null,
      after: {
        mode: "update",
        skillId: "deploy-runbook",
        title: "Tighten deploy skill",
        detail: null,
        prompt: "Add a rollback section",
      },
      rationale: "Rollback was missing last incident",
    }
    const input = skillImprovementToPropose(op, "t2")
    expect(input!.actionType).toBe("task")
    expect((input!.payload as { prompt: string }).prompt).toContain(
      "~/.luna/skills/deploy-runbook/SKILL.md",
    )
  })

  it("deriveSkillImprovementTargetId is stable for same content", () => {
    const a = deriveSkillImprovementTargetId("Hello", "Body")
    const b = deriveSkillImprovementTargetId("hello", "body")
    expect(a).toBe(b)
    expect(a.startsWith("skill-imp-")).toBe(true)
  })
})
