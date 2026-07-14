import { describe, expect, it } from "vitest"
import {
  buildDoctorWorkflowPayload,
  doctorRunStateDir,
  doctorWorkflowJobId,
} from "./workflow-payload.js"
import type { DoctorFinding } from "./types.js"

const finding: DoctorFinding = {
  id: "find-abc",
  source: "manual",
  severity: "error",
  summary: "max_turns exhaustion",
  patient: { kind: "job", id: "sched-weekly" },
  evidence: { fail_streak: 5 },
  suggestedRemedy: "patch",
  autoEligible: true,
}

describe("buildDoctorWorkflowPayload", () => {
  it("builds a shell-only workflow diagnose→backup→apply→verify→finalize", () => {
    const p = buildDoctorWorkflowPayload(finding, 1, {
      cliPath: "/repo/apps/ui-web/scripts/luna-doctor-workflow.ts",
      lunaHome: "/tmp/luna-home",
      bunBin: "bun",
    })
    expect(p.source).toBe("doctor-workflow")
    expect(p.label).toBe("doctor")
    expect(p.halt_on_failure).toBe(true)
    expect(p.doctor_attempt).toBe(1)
    expect(p.finding.patient.id).toBe("sched-weekly")
    expect(p.steps).toHaveLength(5)
    expect(p.steps.every((s) => s.kind === "shell")).toBe(true)
    const diagnose = p.steps[0] as { kind: "shell"; cmd: string }
    expect(diagnose.cmd).toContain("diagnose")
    expect(diagnose.cmd).toContain("finding.json")
    expect(diagnose.cmd).toContain("luna-doctor-workflow.ts")
    const backup = p.steps[1] as { kind: "shell"; cmd: string }
    expect(backup.cmd).toContain("backup")
    expect((p.steps[2] as { cmd: string }).cmd).toContain("apply")
  })

  it("state dir is stable for finding+attempt", () => {
    const a = doctorRunStateDir(finding, 2, "/tmp/h")
    const b = doctorRunStateDir(finding, 2, "/tmp/h")
    expect(a).toBe(b)
    expect(a).toContain("sched-weekly")
    expect(a).toContain("a2")
  })

  it("job id is unique-ish and doctor-prefixed", () => {
    const id = doctorWorkflowJobId(finding, 1)
    expect(id.startsWith("doctor-")).toBe(true)
    expect(id).toContain("sched-weekly")
  })
})
