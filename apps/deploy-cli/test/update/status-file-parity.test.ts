/**
 * Golden parity harness for the guardian status heartbeat: sources the REAL
 * scripts/luna-guardian (via its documented sourcing test seam) and calls
 * write_guardian_status directly, then diffs the resulting bytes against
 * apps/deploy-cli/src/update/status-file.ts's own writer/reader.
 *
 * Also proves the acceptance criterion scripts/luna-guardian-remote-check
 * depends on: its `value()` sed idiom (guardian-remote-check:34) reads a
 * TS-authored status file unchanged, for every field it consumes.
 */
import { mkdirSync, readFileSync, symlinkSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { readKeyValue } from "../../src/update/atomic-file.js"
import { statusFilePath, writeGuardianStatusSync } from "../../src/update/status-file.js"
import { cleanupTempDirs, makeRepo, makeTempDir, runGuardianSourced, sedValue } from "./guardian-fixtures.js"

/** installed_engine_sha (scripts/luna-guardian:246-251) resolves `$PIN_BASE/current-<profile>` -> `engine@<sha>`. */
const seedEnginePin = (pinBase: string, profile: string, sha: string): void => {
  const engineDir = join(pinBase, `engine@${sha}`)
  mkdirSync(engineDir, { recursive: true })
  symlinkSync(engineDir, join(pinBase, `current-${profile}`))
}

afterEach(cleanupTempDirs)

describe("status file byte-parity: bash write_guardian_status vs status-file.ts", () => {
  it("matches byte-for-byte for a fresh healthy heartbeat (no prior record, no engine pin)", () => {
    const root = makeTempDir()
    const { dir: repo, sha } = makeRepo(root)
    const stateDir = join(root, "state")
    const pinBase = join(root, "pins")

    const bash = runGuardianSourced("write_guardian_status stable healthy true", { repo, stateDir, pinBase })
    expect(bash.status, bash.stdout + bash.stderr).toBe(0)

    const bashPath = statusFilePath(stateDir, "stable")
    const raw = readFileSync(bashPath)

    // No engine pin exists, so engine_sha is empty and repo_sha != engine_sha
    // -> consecutive_healthy stays 0; proof=true with no prior record -> 1.
    expect(readKeyValue(bashPath, "repo_sha")).toBe(sha)
    expect(readKeyValue(bashPath, "engine_sha")).toBe("")
    expect(readKeyValue(bashPath, "outcome")).toBe("healthy")
    expect(readKeyValue(bashPath, "consecutive_healthy")).toBe("0")
    expect(readKeyValue(bashPath, "consecutive_runtime_healthy")).toBe("1")

    const tsPath = join(root, "ts-status")
    writeGuardianStatusSync(tsPath, {
      profile: "stable",
      completedAt: Number(readKeyValue(bashPath, "completed_at")),
      repoSha: sha,
      engineSha: "",
      outcome: "healthy",
      consecutiveHealthy: 0,
      consecutiveRuntimeHealthy: 1,
    })
    expect(readFileSync(tsPath).equals(raw)).toBe(true)
  })

  it("matches byte-for-byte when the engine pin matches HEAD (accrues consecutive_healthy)", () => {
    const root = makeTempDir()
    const { dir: repo, sha } = makeRepo(root)
    const stateDir = join(root, "state")
    const pinBase = join(root, "pins")
    seedEnginePin(pinBase, "stable", sha)

    const bash = runGuardianSourced("write_guardian_status stable healthy true", { repo, stateDir, pinBase })
    expect(bash.status, bash.stdout + bash.stderr).toBe(0)

    const bashPath = statusFilePath(stateDir, "stable")
    const raw = readFileSync(bashPath)
    expect(readKeyValue(bashPath, "engine_sha")).toBe(sha)
    expect(readKeyValue(bashPath, "consecutive_healthy")).toBe("1")

    const tsPath = join(root, "ts-status")
    writeGuardianStatusSync(tsPath, {
      profile: "stable",
      completedAt: Number(readKeyValue(bashPath, "completed_at")),
      repoSha: sha,
      engineSha: sha,
      outcome: "healthy",
      consecutiveHealthy: 1,
      consecutiveRuntimeHealthy: 1,
    })
    expect(readFileSync(tsPath).equals(raw)).toBe(true)
  })
})

describe("scripts/luna-guardian-remote-check's sed parsing reads a binary-written status file unchanged", () => {
  it("extracts every field guardian-remote-check reads from a TS-authored status file", () => {
    const root = makeTempDir()
    const path = join(root, "status-stable")
    // status-file.ts never validates these as hex, so any string round-trips
    // through sed unchanged; makeRepo()'s real commit sha is used anyway so
    // no literal here needs to look sha-shaped for the test to mean what it says.
    const { sha } = makeRepo(root)
    writeGuardianStatusSync(path, {
      profile: "stable",
      completedAt: 1_700_000_123,
      repoSha: sha,
      engineSha: sha,
      outcome: "healthy",
      consecutiveHealthy: 7,
      consecutiveRuntimeHealthy: 9,
    })

    // Exactly the fields guardian-remote-check's value() calls read (scripts/luna-guardian-remote-check:46).
    expect(sedValue(path, "completed_at")).toBe("1700000123")
    expect(sedValue(path, "repo_sha")).toBe(sha)
    expect(sedValue(path, "engine_sha")).toBe(sha)
    expect(sedValue(path, "outcome")).toBe("healthy")
    expect(sedValue(path, "consecutive_healthy")).toBe("7")
  })

  it("extracts an empty engine_sha as empty, not a parse error", () => {
    const root = makeTempDir()
    const path = join(root, "status-stable")
    const { sha } = makeRepo(root)
    writeGuardianStatusSync(path, {
      profile: "stable",
      completedAt: 1,
      repoSha: sha,
      engineSha: "",
      outcome: "healthy",
      consecutiveHealthy: 0,
      consecutiveRuntimeHealthy: 0,
    })
    // sedValue() alone reads back "" both when the key is absent and when
    // its value is empty, so it cannot fail if writeGuardianStatusSync
    // silently dropped the `engine_sha=` line entirely - assert the raw line
    // is present so this test means what its name says.
    expect(readFileSync(path, "utf8")).toContain("engine_sha=\n")
    expect(sedValue(path, "engine_sha")).toBe("")
  })
})
