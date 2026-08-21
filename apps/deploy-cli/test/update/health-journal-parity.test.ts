/**
 * Golden parity harness for guardian's health-debounce journal: sources the
 * REAL scripts/luna-guardian (via its documented sourcing test seam) and
 * calls health_journal_write directly, then diffs the resulting bytes
 * against apps/deploy-cli/src/update/health-journal.ts's own writer/reader.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { readKeyValue } from "../../src/update/atomic-file.js"
import { healthJournalPath, writeHealthJournalSync } from "../../src/update/health-journal.js"
import { cleanupTempDirs, makeRepo, makeTempDir, runGuardianSourced } from "./guardian-fixtures.js"

afterEach(cleanupTempDirs)

describe("health journal byte-parity: bash health_journal_write vs health-journal.ts", () => {
  it("matches byte-for-byte for a non-zero strike record with explicit last_repair_at/negative_at", () => {
    const root = makeTempDir()
    const { dir: repo, sha } = makeRepo(root)
    const stateDir = join(root, "state")
    const pinBase = join(root, "pins")

    const bash = runGuardianSourced("health_journal_write stable 3 1 1700000000 1700000500", { repo, stateDir, pinBase })
    expect(bash.status, bash.stdout + bash.stderr).toBe(0)

    const bashPath = healthJournalPath(stateDir, "stable")
    const raw = readFileSync(bashPath)
    expect(readKeyValue(bashPath, "repo_sha")).toBe(sha)
    expect(readKeyValue(bashPath, "consecutive_negative")).toBe("3")
    expect(readKeyValue(bashPath, "negative_at")).toBe("1700000500")
    expect(readKeyValue(bashPath, "consecutive_unknown")).toBe("1")
    expect(readKeyValue(bashPath, "last_repair_at")).toBe("1700000000")

    const tsPath = join(root, "ts-health")
    writeHealthJournalSync(tsPath, {
      profile: "stable",
      updatedAt: Number(readKeyValue(bashPath, "updated_at")),
      repoSha: sha,
      consecutiveNegative: 3,
      negativeAt: 1_700_000_500,
      consecutiveUnknown: 1,
      lastRepairAt: 1_700_000_000,
    })
    expect(readFileSync(tsPath).equals(raw)).toBe(true)
  })

  it("matches byte-for-byte for the all-zero record health_journal_write defaults to", () => {
    const root = makeTempDir()
    const { dir: repo, sha } = makeRepo(root)
    const stateDir = join(root, "state")
    const pinBase = join(root, "pins")

    // HJ_LAST_REPAIR/HJ_NEGATIVE_AT default to 0 (module-level globals) when
    // args 4/5 are omitted - scripts/luna-guardian:394's `"${4:-$HJ_LAST_REPAIR}"`.
    const bash = runGuardianSourced("health_journal_write stable 0 0", { repo, stateDir, pinBase })
    expect(bash.status, bash.stdout + bash.stderr).toBe(0)

    const bashPath = healthJournalPath(stateDir, "stable")
    const raw = readFileSync(bashPath)

    const tsPath = join(root, "ts-health")
    writeHealthJournalSync(tsPath, {
      profile: "stable",
      updatedAt: Number(readKeyValue(bashPath, "updated_at")),
      repoSha: sha,
      consecutiveNegative: 0,
      negativeAt: 0,
      consecutiveUnknown: 0,
      lastRepairAt: 0,
    })
    expect(readFileSync(tsPath).equals(raw)).toBe(true)
  })
})
