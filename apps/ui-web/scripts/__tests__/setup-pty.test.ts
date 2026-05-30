import { describe, expect, it } from "vitest"
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
})
