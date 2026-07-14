import { describe, expect, it, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { DoctorBackupStore } from "./backup-store.js"
import type { DoctorFinding } from "./types.js"

const finding = (id = "f1"): DoctorFinding => ({
  id,
  source: "manual",
  severity: "error",
  summary: "test",
  patient: { kind: "job", id: "sched-x" },
  evidence: {},
  suggestedRemedy: "patch",
  autoEligible: true,
})

describe("DoctorBackupStore", () => {
  let root: string
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it("creates a backup with manifest + before snapshot", () => {
    root = mkdtempSync(join(tmpdir(), "doctor-backup-"))
    const store = new DoctorBackupStore({ rootDir: root })
    const rec = store.create({
      finding: finding(),
      doctorAttempt: 1,
      remedyClass: "patch",
      before: { job: { id: "sched-x", payload: { max_turns: 1 } } },
      nowMs: 1_700_000_000_000,
    })
    expect(rec.manifest.id).toContain("sched-x")
    expect(rec.manifest.applyStatus).toBe("pending")
    const re = store.readManifest(rec.manifest.id)
    expect(re?.findingId).toBe("f1")
    const before = store.readBefore(rec.manifest.id) as {
      job: { id: string }
    }
    expect(before.job.id).toBe("sched-x")
  })

  it("updateApplyStatus and writeAfter work", () => {
    root = mkdtempSync(join(tmpdir(), "doctor-backup-"))
    const store = new DoctorBackupStore({ rootDir: root })
    const rec = store.create({
      finding: finding("f2"),
      doctorAttempt: 1,
      remedyClass: "patch",
      before: { x: 1 },
      nowMs: 1_700_000_000_001,
    })
    expect(store.updateApplyStatus(rec.manifest.id, "applied")).toBe(true)
    store.writeAfter(rec.manifest.id, { x: 2 })
    expect(store.readManifest(rec.manifest.id)?.applyStatus).toBe("applied")
  })
})
