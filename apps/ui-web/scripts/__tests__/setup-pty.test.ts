import { describe, expect, it } from "vitest"
import { EventEmitter } from "node:events"
import type { spawn } from "node:child_process"
import { spawnSetupPty } from "../setup-pty.js"

describe("spawnSetupPty", () => {
  it("streams pty output and reports exit", async () => {
    const chunks: string[] = []
    const exit = await new Promise<number>((resolve) => {
      spawnSetupPty({
        command: "printf PTYHELLO; exit 0", // benign stand-in for `<claude> setup-token`
        onData: (b64) => chunks.push(Buffer.from(b64, "base64").toString()),
        onExit: (code) => resolve(code),
      })
    })
    expect(exit).toBe(0)
    expect(chunks.join("")).toContain("PTYHELLO")
  })

  it("reports exit(1) on a spawn 'error' event instead of crashing", () => {
    // A spawn failure (e.g. util-linux `script` missing in the container) makes
    // Node emit an 'error' event on the ChildProcess — NOT 'exit'/'close'.
    // With no 'error' handler this becomes an uncaught exception that crashes
    // the setup-mode server. The pty must instead degrade to onExit(1).
    const fakeChild = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter
      stderr: EventEmitter
      stdin: EventEmitter & { write: (s: string) => void }
      kill: () => void
    }
    fakeChild.stdout = new EventEmitter()
    fakeChild.stderr = new EventEmitter()
    fakeChild.stdin = Object.assign(new EventEmitter(), { write: () => {} })
    fakeChild.kill = () => {}

    let exitCode: number | null = null
    spawnSetupPty({
      command: "irrelevant",
      onData: () => {},
      onExit: (code) => {
        exitCode = code
      },
      _spawn: (() => fakeChild) as unknown as typeof spawn,
    })

    // Simulate the spawn failure. With the fix this is handled → onExit(1);
    // without it, emitting 'error' with no listener throws (the crash).
    fakeChild.emit("error", new Error("spawn script ENOENT"))
    expect(exitCode).toBe(1)
  })
})
