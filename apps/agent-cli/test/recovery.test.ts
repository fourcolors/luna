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
})
