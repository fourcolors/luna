/**
 * clipboard.test.ts — backend selection + writeToClipboard behavior.
 *
 * Uses stubbed spawn + osc52 writer so tests don't actually touch the system
 * clipboard or rely on pbcopy/xclip being installed.
 */
import { describe, expect, it, vi } from "vitest"
import {
  chooseClipboardBackend,
  writeToClipboard,
  type ClipboardDeps,
  type ClipboardEnv,
} from "./clipboard.js"

const makeDeps = (overrides: Partial<ClipboardDeps> = {}): ClipboardDeps & {
  spawnCalls: Array<{ cmd: string; args: readonly string[]; stdin: string }>
  osc52Calls: string[]
} => {
  const spawnCalls: Array<{ cmd: string; args: readonly string[]; stdin: string }> = []
  const osc52Calls: string[] = []
  return {
    spawn: overrides.spawn ?? (async (cmd, args, stdin) => {
      spawnCalls.push({ cmd, args, stdin })
      return { ok: true } as const
    }),
    osc52: overrides.osc52 ?? ((esc) => {
      osc52Calls.push(esc)
    }),
    spawnCalls,
    osc52Calls,
  }
}

describe("chooseClipboardBackend", () => {
  it("darwin → pbcopy", () => {
    expect(chooseClipboardBackend({ platform: "darwin", env: {} })).toBe("pbcopy")
  })

  it("linux + WAYLAND_DISPLAY → wl-copy", () => {
    expect(
      chooseClipboardBackend({
        platform: "linux",
        env: { WAYLAND_DISPLAY: "wayland-0" },
      }),
    ).toBe("wl-copy")
  })

  it("linux + DISPLAY (no Wayland) → xclip", () => {
    expect(
      chooseClipboardBackend({ platform: "linux", env: { DISPLAY: ":0" } }),
    ).toBe("xclip")
  })

  it("linux + no DISPLAY and no WAYLAND_DISPLAY → osc52", () => {
    expect(chooseClipboardBackend({ platform: "linux", env: {} })).toBe("osc52")
  })

  it("Wayland takes precedence over DISPLAY", () => {
    expect(
      chooseClipboardBackend({
        platform: "linux",
        env: { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" },
      }),
    ).toBe("wl-copy")
  })

  it("other platforms → osc52", () => {
    expect(
      chooseClipboardBackend({ platform: "win32" as NodeJS.Platform, env: {} }),
    ).toBe("osc52")
  })

  it("ignores empty-string env vars", () => {
    expect(
      chooseClipboardBackend({
        platform: "linux",
        env: { WAYLAND_DISPLAY: "", DISPLAY: "" },
      }),
    ).toBe("osc52")
  })
})

describe("writeToClipboard", () => {
  const envDarwin: ClipboardEnv = { platform: "darwin", env: {} }
  const envSshLinux: ClipboardEnv = { platform: "linux", env: {} }

  it("empty text → not-ok with descriptive error", async () => {
    const deps = makeDeps()
    const r = await writeToClipboard("", envDarwin, deps)
    expect(r).toEqual({ ok: false, via: "none", error: "nothing to copy" })
    expect(deps.spawnCalls).toHaveLength(0)
    expect(deps.osc52Calls).toHaveLength(0)
  })

  it("darwin → spawns pbcopy with the payload on stdin", async () => {
    const deps = makeDeps()
    const r = await writeToClipboard("hello", envDarwin, deps)
    expect(r).toEqual({ ok: true, via: "pbcopy" })
    expect(deps.spawnCalls).toEqual([{ cmd: "pbcopy", args: [], stdin: "hello" }])
    expect(deps.osc52Calls).toHaveLength(0)
  })

  it("linux X11 → spawns xclip with -selection clipboard", async () => {
    const deps = makeDeps()
    const r = await writeToClipboard("hi", { platform: "linux", env: { DISPLAY: ":0" } }, deps)
    expect(r).toEqual({ ok: true, via: "xclip" })
    expect(deps.spawnCalls).toEqual([
      { cmd: "xclip", args: ["-selection", "clipboard"], stdin: "hi" },
    ])
  })

  it("SSH (no DISPLAY) → emits OSC 52 escape, no spawn", async () => {
    const deps = makeDeps()
    const r = await writeToClipboard("payload", envSshLinux, deps)
    expect(r).toEqual({ ok: true, via: "osc52" })
    expect(deps.spawnCalls).toHaveLength(0)
    expect(deps.osc52Calls).toHaveLength(1)
    const esc = deps.osc52Calls[0]!
    expect(esc.startsWith("\x1b]52;c;")).toBe(true)
    expect(esc.endsWith("\x07")).toBe(true)
    // Decode the base64 payload back out and verify round-trip.
    const b64 = esc.slice("\x1b]52;c;".length, -1)
    expect(Buffer.from(b64, "base64").toString("utf8")).toBe("payload")
  })

  it("spawn failure falls back to OSC 52", async () => {
    const fakeSpawn = vi.fn(async () => ({ ok: false as const, error: "pbcopy: not found" }))
    const deps = makeDeps({ spawn: fakeSpawn })
    const r = await writeToClipboard("x", envDarwin, deps)
    expect(r).toEqual({ ok: true, via: "osc52" })
    expect(fakeSpawn).toHaveBeenCalledOnce()
    expect(deps.osc52Calls).toHaveLength(1)
  })

  it("unicode round-trips via OSC 52", async () => {
    const deps = makeDeps()
    await writeToClipboard("héllo 🌙", envSshLinux, deps)
    const esc = deps.osc52Calls[0]!
    const b64 = esc.slice("\x1b]52;c;".length, -1)
    expect(Buffer.from(b64, "base64").toString("utf8")).toBe("héllo 🌙")
  })
})
