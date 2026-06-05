/**
 * clipboard.ts — cross-platform clipboard writer for the /copy slash command.
 *
 * Backend selection:
 *   - darwin            → `pbcopy`
 *   - linux + Wayland   → `wl-copy`
 *   - linux + X11       → `xclip -selection clipboard`
 *   - everywhere else (or local tool spawn fails)
 *                       → OSC 52 escape sequence written to stdout
 *
 * The OSC 52 fallback is what makes copy-from-SSH work without setting up
 * X forwarding: the terminal emulator (kitty, wezterm, iTerm2, recent
 * gnome-terminal, etc.) sees the escape and writes the payload to its own
 * clipboard buffer. Terminals that don't support OSC 52 will silently
 * ignore it, in which case the user gets no clipboard write but no crash
 * either — `writeToClipboard` still returns `{ ok: true, via: "osc52" }`
 * because we cannot detect the terminal's response.
 *
 * Side-effects (spawn / stdout write) are injected via `ClipboardDeps` so
 * the unit tests can stub them out.
 */

export type ClipboardBackend = "pbcopy" | "xclip" | "wl-copy" | "osc52"

export type ClipboardResult =
  | { readonly ok: true; readonly via: ClipboardBackend }
  | { readonly ok: false; readonly via: "none"; readonly error: string }

export type ClipboardEnv = {
  readonly platform: NodeJS.Platform
  readonly env: Readonly<Record<string, string | undefined>>
}

export type SpawnRunner = (
  cmd: string,
  args: readonly string[],
  stdin: string,
) => Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }>

export type Osc52Writer = (escape: string) => void

export type ClipboardDeps = {
  readonly spawn: SpawnRunner
  readonly osc52: Osc52Writer
}

/** Pure: pick the preferred backend for an environment. */
export const chooseClipboardBackend = (env: ClipboardEnv): ClipboardBackend => {
  if (env.platform === "darwin") return "pbcopy"
  if (env.platform === "linux") {
    if (env.env["WAYLAND_DISPLAY"] !== undefined && env.env["WAYLAND_DISPLAY"] !== "") {
      return "wl-copy"
    }
    if (env.env["DISPLAY"] !== undefined && env.env["DISPLAY"] !== "") {
      return "xclip"
    }
  }
  return "osc52"
}

const toOsc52 = (text: string): string => {
  const enc = Buffer.from(text, "utf8").toString("base64")
  // BEL terminator (0x07) — broader compat than ST (ESC \).
  return `\x1b]52;c;${enc}\x07`
}

/**
 * Write `text` to the system clipboard, falling back to OSC 52 when the
 * preferred local tool is unavailable. Always returns `ok: true` unless
 * the writer was empty/aborted; OSC 52 specifically can't confirm the
 * terminal accepted the bytes, but it's our best portable option.
 */
export const writeToClipboard = async (
  text: string,
  env: ClipboardEnv,
  deps: ClipboardDeps,
): Promise<ClipboardResult> => {
  if (text.length === 0) {
    return { ok: false, via: "none", error: "nothing to copy" }
  }

  const backend = chooseClipboardBackend(env)

  if (backend === "osc52") {
    deps.osc52(toOsc52(text))
    return { ok: true, via: "osc52" }
  }

  const args = backend === "xclip" ? ["-selection", "clipboard"] : []
  const result = await deps.spawn(backend, args, text)
  if (result.ok) return { ok: true, via: backend }

  // Local tool failed (not installed, exec error). Fall back to OSC 52 so the
  // user still has *some* path to clipboard, especially over SSH.
  deps.osc52(toOsc52(text))
  return { ok: true, via: "osc52" }
}

/* ----------------------------- prod wiring ------------------------------ */

/** Default spawn runner backed by node:child_process. */
export const makeSpawnRunner = (): SpawnRunner => async (cmd, args, stdin) => {
  const { spawn } = await import("node:child_process")
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args as string[], { stdio: ["pipe", "ignore", "pipe"] })
    } catch (e) {
      resolve({ ok: false, error: e instanceof Error ? e.message : String(e) })
      return
    }
    let err = ""
    child.stderr?.on("data", (d: Buffer) => {
      err += d.toString()
    })
    child.on("error", (e) => {
      resolve({ ok: false, error: e.message })
    })
    child.on("close", (code) => {
      if (code === 0) resolve({ ok: true })
      else resolve({ ok: false, error: err.trim().length > 0 ? err.trim() : `${cmd} exited ${code ?? "?"}` })
    })
    child.stdin?.write(stdin)
    child.stdin?.end()
  })
}

/** Default OSC 52 writer — writes to process.stdout. */
export const makeOsc52Writer = (): Osc52Writer => (escape) => {
  process.stdout.write(escape)
}
