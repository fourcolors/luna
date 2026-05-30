import { describe, expect, it } from "vitest"
import type { PtyOutputFrame, PtyInputFrame, PtyResizeFrame } from "../src/protocol.js"

describe("pty frames", () => {
  it("output (server→client), input + resize (client→server) have the expected shapes", () => {
    const out: PtyOutputFrame = { type: "pty-output", data: "aGk=" } // base64
    const inp: PtyInputFrame = { type: "pty-input", data: "y" }
    const rsz: PtyResizeFrame = { type: "pty-resize", cols: 80, rows: 24 }
    expect(out.type).toBe("pty-output")
    expect(inp.type).toBe("pty-input")
    expect(rsz.cols).toBe(80)
  })
})
