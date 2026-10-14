import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { spawn, spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

// scripts/laya-env decides whether the pid in its pidfile is really the sidecar
// before signalling it. These tests pin that decision, including the macOS
// shapes that broke the first version: a framework-build Python shows argv[0]
// as `.../Python.app/Contents/MacOS/Python` (capital P), and a checkout or
// LUNA_HOME path containing a space cannot be recovered by splitting `ps`
// output on spaces.

const repoRoot = new URL("..", import.meta.url).pathname
const realScript = join(repoRoot, "scripts", "laya-env")
const tempDirs: string[] = []
const children: number[] = []

afterEach(() => {
  for (const pid of children.splice(0)) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // already gone
    }
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const makeTempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-laya-env-"))
  tempDirs.push(dir)
  return dir
}

// A checkout whose path contains a space, holding a copy of laya-env plus a
// stand-in sidecar (a bash loop, so its argv stays [interpreter, SIDECAR]).
// The venv's python is a wrapper that re-execs bash under FAKE_ARGV0, which is
// how a framework Python presents itself to ps and /proc.
const makeFixture = () => {
  const root = makeTempDir()
  const scripts = join(root, "my repo", "scripts")
  mkdirSync(scripts, { recursive: true })
  const script = join(scripts, "laya-env")
  copyFileSync(realScript, script)
  chmodSync(script, 0o755)
  const sidecar = join(scripts, "laya-rerank-server")
  writeFileSync(sidecar, "#!/usr/bin/env bash\nwhile :; do sleep 0.2; done\n")
  chmodSync(sidecar, 0o755)

  const home = join(root, "luna home")
  const venvBin = join(home, "laya-env", "venv", "bin")
  mkdirSync(venvBin, { recursive: true })
  const python = join(venvBin, "python")
  writeFileSync(python, '#!/usr/bin/env bash\nexec -a "${FAKE_ARGV0:-$0}" bash "$@"\n')
  chmodSync(python, 0o755)
  return { script, sidecar, home, pidfile: join(home, "laya-env", "laya-rerank-server.pid") }
}

const runEnv = (
  fx: ReturnType<typeof makeFixture>,
  args: ReadonlyArray<string>,
  extraEnv: Record<string, string> = {},
) =>
  spawnSync("bash", [fx.script, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      LUNA_HOME: fx.home,
      // Nothing listens here, so status' health probe is deterministic.
      LUNA_LAYA_URL: "http://127.0.0.1:1",
      ...extraEnv,
    },
  })

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const pidFrom = (out: string) => {
  const m = /pid (\d+)/.exec(out)
  if (!m) throw new Error(`no pid in output: ${out}`)
  const pid = Number(m[1])
  children.push(pid)
  return pid
}

describe("laya-env command_is_sidecar (Darwin ps string)", () => {
  // SIDECAR is derived from the sourced script's own location unless overridden.
  const sidecar = join(repoRoot, "scripts", "laya-rerank-server")

  const check = (cmd: string, sidecarOverride?: string) =>
    spawnSync(
      "bash",
      ["-c", `source "$1"; if [ -n "$3" ]; then SIDECAR="$3"; fi; command_is_sidecar "$2"`, "_", realScript, cmd, sidecarOverride ?? ""],
      { encoding: "utf8", env: { ...process.env, LUNA_HOME: "/nonexistent" } },
    ).status === 0

  it("accepts a lowercase venv python", () => {
    expect(check(`/h/.luna/laya-env/venv/bin/python ${sidecar}`)).toBe(true)
    expect(check(`/h/venv/bin/python3.12 ${sidecar}`)).toBe(true)
  })

  it("accepts a macOS framework Python (capital P)", () => {
    const fw = "/opt/homebrew/Cellar/python@3.12/3.12.4/Frameworks/Python.framework/Versions/3.12/Resources/Python.app/Contents/MacOS/Python"
    expect(check(`${fw} ${sidecar}`)).toBe(true)
  })

  it("accepts spaces in the interpreter path", () => {
    expect(check(`/Users/x/My Projects/venv/bin/python ${sidecar}`)).toBe(true)
  })

  it("accepts a SIDECAR path containing a space", () => {
    const spaced = "/Users/x/My Projects/luna/scripts/laya-rerank-server"
    expect(check(`/v/bin/python ${spaced}`, spaced)).toBe(true)
  })

  it("rejects a non-python process that merely names the sidecar", () => {
    expect(check(`vim ${sidecar}`)).toBe(false)
    expect(check(`tail -f ${sidecar}`)).toBe(false)
    expect(check(`/usr/bin/python3 -c x ${sidecar}.bak`)).toBe(false)
    expect(check("/usr/bin/python3 /other/script")).toBe(false)
    expect(check("")).toBe(false)
  })
})

describe("laya-env pidfile identity (end to end)", () => {
  it("drops a stale pidfile naming an unrelated live process and never signals it", () => {
    const fx = makeFixture()
    const victim = spawn("sleep", ["60"], { stdio: "ignore", detached: true })
    victim.unref()
    children.push(victim.pid!)
    mkdirSync(join(fx.home, "laya-env"), { recursive: true })
    writeFileSync(fx.pidfile, `${victim.pid}\n`)

    const stop = runEnv(fx, ["stop"])
    expect(stop.stdout).toContain("not running")
    expect(existsSync(fx.pidfile)).toBe(false)
    expect(alive(victim.pid!)).toBe(true)
  }, 20_000)

  for (const [label, argv0] of [
    ["lowercase venv python", undefined],
    ["framework Python.app (capital P)", "/opt/py/Python.framework/Versions/3.12/Resources/Python.app/Contents/MacOS/Python"],
  ] as const) {
    it(`tracks and stops a real sidecar launched as ${label}, in a path with spaces`, () => {
      const fx = makeFixture()
      const env = argv0 ? { FAKE_ARGV0: argv0 } : { FAKE_ARGV0: join(fx.home, "laya-env", "venv", "bin", "python") }

      const start = runEnv(fx, ["start"], env)
      expect(start.status).toBe(0)
      const pid = pidFrom(start.stdout)

      const status = runEnv(fx, ["status"], env)
      expect(status.stdout).toContain(`running (pid ${pid})`)
      expect(existsSync(fx.pidfile)).toBe(true)

      const stop = runEnv(fx, ["stop"], env)
      expect(stop.stdout).toContain(`stopped (pid ${pid})`)
      expect(alive(pid)).toBe(false)
    }, 30_000)
  }
})
