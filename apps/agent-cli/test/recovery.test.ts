import { spawnSync } from "node:child_process"
import { describe, expect, it } from "vitest"
import { buildRecoveryCommand, runRecovery } from "../src/chat/recovery.js"

describe("buildRecoveryCommand", () => {
  it("builds local commands through the shell", () => {
    expect(
      buildRecoveryCommand({ mode: "local", command: "bun run server" }),
    ).toEqual({ command: "bun run server", args: [], shell: true })
  })

  it("builds ssh commands without a shell", () => {
    expect(
      buildRecoveryCommand({
        mode: "ssh",
        target: "root@example.test",
        command: "systemctl restart luna",
      }),
    ).toEqual({
      command: "ssh",
      args: ["root@example.test", "systemctl restart luna"],
      shell: false,
    })
  })
})

/**
 * A NOTE ON THE BUDGETS BELOW.
 *
 * Every timeoutMs here except the timeout test's own is a HANG GUARD, not an
 * assertion about speed. They used to be 1_000, and that made them latency
 * assertions nobody intended: runRecovery reports `exitCode: null` when it
 * times out (recovery.ts: `exitCode: timedOut ? null : exitCode`), so a slow
 * spawn surfaced as "expected null to be +0" - which reads like a broken exit
 * code, not a missed deadline.
 *
 * It was rare enough to look like noise and real enough to fail a full run.
 * Measured on this machine, the 70KB node spawn takes ~37ms idle and ~186ms
 * median / 458ms worst under a loaded suite - roughly half the old budget, so
 * a heavier burst tips it over.
 *
 * 8_000 sits under vitest's 10_000 testTimeout, so a genuine hang still fails
 * here (with vitest's own message as the backstop) while ordinary scheduling
 * jitter cannot. The one test that IS about timing keeps its 50ms, because
 * there the deadline is the subject.
 */
const HANG_GUARD_MS = 8_000

describe("runRecovery", () => {
  it("returns a no-op result for none mode", async () => {
    await expect(
      runRecovery({ mode: "none", command: null, target: null, timeoutMs: 50 }),
    ).resolves.toEqual({ ran: false, exitCode: null, timedOut: false, stderr: "" })
  })

  it("captures success exit codes", async () => {
    await expect(
      runRecovery({ mode: "local", command: "printf ok >&2", timeoutMs: HANG_GUARD_MS }),
    ).resolves.toEqual({ ran: true, exitCode: 0, timedOut: false, stderr: "ok" })
  })

  it("captures nonzero exit codes and stderr", async () => {
    await expect(
      runRecovery({ mode: "local", command: "printf failure >&2; exit 7", timeoutMs: HANG_GUARD_MS }),
    ).resolves.toEqual({ ran: true, exitCode: 7, timedOut: false, stderr: "failure" })
  })

  it("bounds large stderr output", async () => {
    const result = await runRecovery({
      mode: "local",
      command: "node -e \"process.stderr.write('x'.repeat(70000))\"",
      timeoutMs: HANG_GUARD_MS,
    })

    expect(result.ran).toBe(true)
    // Asserted BEFORE the exit code, and with a message, so a future budget
    // problem says so instead of masquerading as a wrong exit code.
    expect(result.timedOut, "spawn exceeded the hang guard - a budget problem, not an exit-code one").toBe(false)
    expect(result.exitCode).toBe(0)
    expect(result.stderr.length).toBeLessThan(66_000)
    expect(result.stderr).toContain("[truncated ")
  })

  it("times out and kills local shell process groups", async () => {
    const marker = `luna-recovery-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const command = `bash -c 'trap "" TERM; sleep 10' ${marker}`

    const startedAt = Date.now()
    const result = await runRecovery({ mode: "local", command, timeoutMs: 50 })

    expect(Date.now() - startedAt).toBeLessThan(2_000)
    expect(result.ran).toBe(true)
    expect(result.exitCode).toBeNull()
    expect(result.timedOut).toBe(true)

    const ps = spawnSync("ps", ["-eo", "pid,pgid,ppid,stat,etime,cmd"], {
      encoding: "utf8",
    })
    expect(ps.stdout).not.toContain(marker)
  })
})
