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

describe("runRecovery", () => {
  it("returns a no-op result for none mode", async () => {
    await expect(
      runRecovery({ mode: "none", command: null, target: null, timeoutMs: 50 }),
    ).resolves.toEqual({ ran: false, exitCode: null, timedOut: false, stderr: "" })
  })

  it("captures success exit codes", async () => {
    await expect(
      runRecovery({ mode: "local", command: "printf ok >&2", timeoutMs: 1_000 }),
    ).resolves.toEqual({ ran: true, exitCode: 0, timedOut: false, stderr: "ok" })
  })

  it("captures nonzero exit codes and stderr", async () => {
    await expect(
      runRecovery({ mode: "local", command: "printf failure >&2; exit 7", timeoutMs: 1_000 }),
    ).resolves.toEqual({ ran: true, exitCode: 7, timedOut: false, stderr: "failure" })
  })

  it("bounds large stderr output", async () => {
    const result = await runRecovery({
      mode: "local",
      command: "node -e \"process.stderr.write('x'.repeat(70000))\"",
      timeoutMs: 1_000,
    })

    expect(result.ran).toBe(true)
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
