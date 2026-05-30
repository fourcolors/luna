import { type ChildProcess, spawn } from "node:child_process"

export interface SetupPty {
  readonly write: (utf8: string) => void
  readonly resize: (cols: number, rows: number) => void
  readonly close: () => void
}
export interface SpawnSetupPtyOpts {
  /** Shell command to run inside the pty (e.g. `'<claudeExe>' setup-token`). */
  readonly command: string
  readonly onData: (base64: string) => void
  readonly onExit: (code: number) => void
  readonly _spawn?: typeof spawn // test seam
}

/**
 * Run `command` inside a real pty via `script` (allocates a TTY and streams
 * output without a native node-pty dependency).
 *
 * Platform differences:
 *   - Linux (util-linux): `script -qec <cmd> /dev/null`
 *     The `-c` flag accepts a shell string and `-e` propagates the child's
 *     exit code. This is the production target (Luna runs on Linux containers).
 *   - macOS (BSD script): `script -qe` requires a controlling TTY in the
 *     parent process, which is not available when spawned by the Node/Bun
 *     runtime (tcgetattr/ioctl fails with ENOTSUP). On macOS — used only for
 *     local development and CI — we fall back to `sh -c` directly. This
 *     forgoes the pty allocation on the dev machine; the real pty path runs
 *     in the Linux container (production target).
 *
 * The stdout/stderr streams are captured and forwarded as base64 chunks via
 * onData; write() pipes keystrokes to stdin of the spawned process.
 */
export const spawnSetupPty = (opts: SpawnSetupPtyOpts): SetupPty => {
  const spawnFn = opts._spawn ?? spawn

  // macOS BSD `script` cannot allocate a pty when there is no controlling
  // terminal in the parent (the Node/Bun process). Fall back to plain sh.
  const [cmd, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["sh", ["-c", opts.command]]
      : ["script", ["-qec", opts.command, "/dev/null"]]

  const child: ChildProcess = spawnFn(cmd, args, {
    env: { ...process.env, TERM: "xterm-256color" },
  })
  child.stdout?.on("data", (b: Buffer) => opts.onData(b.toString("base64")))
  child.stderr?.on("data", (b: Buffer) => opts.onData(b.toString("base64")))
  // stdin is an async stream: writing after the child exits / closes its end
  // emits an 'error' event that would otherwise become an uncaught exception
  // and could crash the process. Swallow it — best-effort.
  child.stdin?.on("error", () => { /* best-effort: stdin may close when the child exits */ })
  child.on("exit", (code) => opts.onExit(code ?? 1))
  return {
    write: (utf8) => { child.stdin?.write(utf8) },
    resize: (_cols, _rows) => {
      // best-effort: util-linux `script` fixes the pty winsize at creation and
      // does not expose the pty fd, so a live resize would need TIOCSWINSZ we
      // can't reach. Intentional no-op; the terminal renders at the pty's
      // creation size. (A true resize would require a real pty lib.)
    },
    close: () => { try { child.kill() } catch { /* best-effort */ } },
  }
}
