/**
 * Golden parity for bash-lib.ts (S22d PR1): the seam that shells out to the
 * co-pinned scripts/lib/luna-deploy.sh for the four functions the binary does
 * not port.
 *
 * HOW THE ORACLE IS BUILT, AND WHY IT IS NOT AN awk EXTRACTION. Every other
 * suite in this directory awk-extracts one function out of
 * scripts/luna-update-server and stubs its collaborators, because the function
 * under test lives inside a 2000-line script that cannot be sourced. These four
 * live in a library that the engine ITSELF sources whole
 * (scripts/luna-update-server:39-41), and each one leans on siblings in the
 * same file - luna_validate_profile calls luna_die (:6),
 * luna_configure_claude_executable calls luna_env_value, luna_remove_env,
 * luna_find_claude_executable and luna_upsert_env (:124-148). Stubbing those
 * would replace the very code whose fidelity is in question. So the oracle
 * sources the REAL lib from the repo and calls the function exactly as the
 * engine's call sites do (:248, :529, :1245, :1248), which is a strictly
 * stronger oracle than an extraction. awk still appears below, in a separate
 * guard that pins the operator-facing literals inside luna-deploy.sh so a
 * comparison can never silently degrade into "two empty strings matched".
 *
 * THE TWO DRIVES ARE GENUINELY DIFFERENT PROGRAMS. The oracle spawns bash
 * against the repo's lib. The port resolves its lib from
 * LUNA_DEPLOY_BASH_ENGINE, pointed at a PIN DIRECTORY that mirrors what
 * luna_pin_engine publishes (the bash engine plus a lib/ beside it) and holds
 * its own COPY of luna-deploy.sh. That difference is asserted, not assumed:
 * "sources the PINNED lib, not the repo's" below patches the copy and proves
 * the port's output follows the copy.
 *
 * WHAT IS COMPARED. Exit code, byte-exact stdout, byte-exact stderr, and - for
 * the only function that writes - the resulting .env bytes and its mode. Paths
 * are masked by fixture root before comparison (each drive gets its own root
 * from makeFixturePair, so an unmasked diff would fail on temp-dir names rather
 * than on behaviour), which is the same masking discipline the assembly-level
 * differ uses for the journal's updated_at.
 */
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import {
  BASH_ENGINE_ENV,
  type BashCall,
  defaultIsReadableFile,
  libFileFor,
  lunaDieLine,
  makeSpawnBashRunner,
  resolveBashLib,
  spawnBashSync,
} from "../../src/update/bash-lib.js"
import { type Fixture, cleanupTempDirs, makeFixturePair, makeLightFixture } from "./bash-fixtures.js"
import { repoRoot } from "./temp-dirs.js"

afterAll(cleanupTempDirs)

/**
 * Spawn bash by ABSOLUTE path. Several scenarios below pin PATH to an empty
 * directory (that is how `luna_find_bun`'s `command -v bun` arm is made to
 * fail deterministically on a developer Mac that has bun installed), and a
 * PATH-resolved "bash" would then fail to spawn at all.
 */
const BASH = existsSync("/bin/bash") ? "/bin/bash" : "/usr/bin/bash"
const REPO_LIB = join(repoRoot, "scripts/lib/luna-deploy.sh")

interface Run {
  readonly status: number
  readonly stdout: string
  readonly stderr: string
}

/**
 * The oracle: source the REAL repo lib and call the function with the caller's
 * values as POSITIONAL PARAMETERS.
 *
 * `set -uo pipefail` and not `-e`: the engine runs under `set -euo pipefail`
 * (scripts/luna-update-server:37), but with `-e` a function that legitimately
 * returns 1 (luna_env_value on an absent key, :99) would kill the shell before
 * its rc could be read, and the rc is exactly what this suite compares. The
 * same choice rollback-parity.test.ts makes.
 */
const runOracle = (fn: string, args: ReadonlyArray<string>, env: Record<string, string>): Run => {
  const script = `set -uo pipefail\nsource ${JSON.stringify(REPO_LIB)}\n${fn} "$@"\n`
  const r = spawnSync(BASH, ["-c", script, "bash", ...args], { env, encoding: "utf8" })
  return { status: r.status ?? 127, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
}

/** A pin dir shaped like luna_pin_engine's output: the bash engine plus lib/ beside it. */
interface Pin {
  readonly engine: string
  readonly libFile: string
}

const makePin = (root: string): Pin => {
  const dir = join(root, "deploy-engine@pinned")
  mkdirSync(join(dir, "lib"), { recursive: true })
  const engine = join(dir, "luna-update-server")
  writeFileSync(engine, "#!/usr/bin/env bash\nexit 0\n")
  chmodSync(engine, 0o755)
  const libFile = join(dir, "lib", "luna-deploy.sh")
  writeFileSync(libFile, readFileSync(REPO_LIB, "utf8"))
  return { engine, libFile }
}

/** Resolve the port's BashLib over a pin + a pinned environment, failing loudly if it refuses. */
const openPort = (pin: Pin, env: Record<string, string>) => {
  const resolved = resolveBashLib({
    env: (name) => (name === BASH_ENGINE_ENV ? pin.engine : env[name]),
    isReadableFile: defaultIsReadableFile,
    runBash: makeSpawnBashRunner(env, BASH),
  })
  if (!resolved.ok) throw new Error(`resolveBashLib refused unexpectedly: ${resolved.errorLine}`)
  return resolved.lib
}

/** Fixture roots differ per drive by design; mask them so the diff is about behaviour. */
const mask = (text: string, root: string): string => text.split(root).join("<ROOT>")

/**
 * The environment BOTH drives run under. `process.env` is the base because the
 * production runner passes the parent's environment verbatim, but DRY_RUN is
 * pinned explicitly on every call so a developer's ambient value can never make
 * one drive take luna_configure_claude_executable's early return (:130-132).
 */
const baseEnv = (
  fx: { readonly temp: string; readonly bin: string },
  extra: Record<string, string> = {},
): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.LUNA_TEST_BUN_PATH
  delete env.DRY_RUN
  delete env[BASH_ENGINE_ENV]
  env.PATH = `${fx.bin}:/usr/bin:/bin`
  env.HOME = fx.temp
  return { ...env, ...extra }
}

// ---------------------------------------------------------------------------
// resolution: happens in preflight, BEFORE the lock, and refuses loudly
// ---------------------------------------------------------------------------

describe("resolveBashLib", () => {
  /** A runner that must never be reached: resolution is metadata-only. */
  const explodingRunner = (call: BashCall): never => {
    throw new Error(`resolveBashLib spawned bash before it had a lib: ${JSON.stringify(call)}`)
  }

  it("derives dirname($LUNA_DEPLOY_BASH_ENGINE)/lib/luna-deploy.sh, the layout luna_pin_engine publishes", () => {
    const fx = makeLightFixture({ readyAtTarget: true, readyAtPrev: true })
    const pin = makePin(fx.temp)
    const resolved = resolveBashLib({
      env: () => pin.engine,
      isReadableFile: defaultIsReadableFile,
      runBash: explodingRunner,
    })
    expect(resolved.ok).toBe(true)
    if (resolved.ok) {
      expect(resolved.lib.libFile).toBe(pin.libFile)
      expect(resolved.lib.libFile).toBe(libFileFor(pin.engine))
      expect(resolved.lib.bashEngine).toBe(pin.engine)
    }
  })

  it("refuses with exit 1 and a luna_die-shaped line when the variable is unset", () => {
    const resolved = resolveBashLib({
      env: () => undefined,
      isReadableFile: () => true,
      runBash: explodingRunner,
    })
    expect(resolved.ok).toBe(false)
    if (!resolved.ok) {
      expect(resolved.exitCode).toBe(1)
      expect(resolved.errorLine.startsWith("error: ")).toBe(true)
      expect(resolved.errorLine).toContain(BASH_ENGINE_ENV)
      // The prefix is the one luna_die writes (scripts/lib/luna-deploy.sh:6),
      // so an operator cannot tell a binary refusal from a bash one.
      expect(resolved.errorLine).toBe(lunaDieLine(resolved.errorLine.slice("error: ".length)))
    }
  })

  it("treats an EMPTY variable as unset rather than resolving /lib/luna-deploy.sh", () => {
    const resolved = resolveBashLib({
      env: () => "",
      isReadableFile: () => true,
      runBash: explodingRunner,
    })
    expect(resolved.ok).toBe(false)
    if (!resolved.ok) expect(resolved.errorLine).toContain("is not set")
  })

  it("refuses when the lib beside the pinned engine is missing or unreadable", () => {
    const fx = makeLightFixture({ readyAtTarget: true, readyAtPrev: true })
    const engine = join(fx.temp, "no-lib-here", "luna-update-server")
    const resolved = resolveBashLib({
      env: () => engine,
      isReadableFile: defaultIsReadableFile,
      runBash: explodingRunner,
    })
    expect(resolved.ok).toBe(false)
    if (!resolved.ok) {
      expect(resolved.exitCode).toBe(1)
      // The line names BOTH the derived path and the variable it came from:
      // an operator debugging this has no other way to see the derivation.
      expect(resolved.errorLine).toContain(libFileFor(engine))
      expect(resolved.errorLine).toContain(`${BASH_ENGINE_ENV}=${engine}`)
    }
  })

  it("checks the DERIVED lib path for readability, never the engine path itself", () => {
    // resolveBashLib exists to catch a lib that is missing OR unreadable
    // BESIDE an engine that is itself perfectly fine (a partial rsync that
    // copied the engine but not lib/, or a mode-000 lib after an interrupted
    // write). If the readability predicate were ever pointed at `engine`
    // instead of the derived `libFile`, this exact scenario - a real,
    // readable engine file whose sibling lib/luna-deploy.sh does not exist at
    // all - would resolve OK. The lock would then be taken, and the first
    // delegated call (luna_validate_profile) would die with a bare 127 well
    // after the loud, pre-lock refusal this function exists to give instead.
    const fx = makeLightFixture({ readyAtTarget: true, readyAtPrev: true })
    const dir = join(fx.temp, "engine-without-lib")
    mkdirSync(dir, { recursive: true })
    const engine = join(dir, "luna-update-server")
    writeFileSync(engine, "#!/usr/bin/env bash\nexit 0\n")
    chmodSync(engine, 0o755)
    // No lib/ directory at all beside it, so the two paths disagree: the
    // engine is readable, its derived lib is not even present.
    expect(defaultIsReadableFile(engine)).toBe(true)
    const resolved = resolveBashLib({
      env: () => engine,
      isReadableFile: defaultIsReadableFile,
      runBash: explodingRunner,
    })
    expect(resolved.ok).toBe(false)
    if (!resolved.ok) expect(resolved.errorLine).toContain(libFileFor(engine))
  })

  it("creates nothing on disk, so it is safe to call before the lock exists", () => {
    const fx = makeLightFixture({ readyAtTarget: true, readyAtPrev: true })
    const probe = join(fx.temp, "lock-probe")
    mkdirSync(probe)
    const before = spawnSync("ls", ["-a", probe], { encoding: "utf8" }).stdout
    for (const engine of [undefined, "", join(probe, "missing", "luna-update-server")]) {
      resolveBashLib({
        env: () => engine,
        isReadableFile: defaultIsReadableFile,
        runBash: explodingRunner,
      })
    }
    expect(spawnSync("ls", ["-a", probe], { encoding: "utf8" }).stdout).toBe(before)
  })

  it("sources the PINNED lib, not the repo's - the whole reason the variable exists", () => {
    const fx = makeLightFixture({ readyAtTarget: true, readyAtPrev: true })
    const pin = makePin(fx.temp)
    // Patch the COPY. If the port were sourcing scripts/lib/luna-deploy.sh
    // directly (or deriving the lib from its own argv[0]), this sentinel could
    // not appear - and a delegated run and an in-binary run would be able to
    // execute different bytes without anything noticing.
    const patched = readFileSync(pin.libFile, "utf8").replace(
      "profile must contain only letters",
      "PINNED-COPY-SENTINEL: profile must contain only letters",
    )
    expect(patched).toContain("PINNED-COPY-SENTINEL")
    writeFileSync(pin.libFile, patched)
    const env = baseEnv(fx)
    const lib = openPort(pin, env)
    const result = lib.validateProfile("not a profile")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.stderr).toContain("PINNED-COPY-SENTINEL")
  })
})

// ---------------------------------------------------------------------------
// makeSpawnBashRunner: MUST spawn a NON-login shell (fidelity detail 2, header)
// ---------------------------------------------------------------------------

describe("makeSpawnBashRunner", () => {
  it("spawns bash -c, never -lc - a login shell would source the container's profile files", () => {
    // A non-login shell (`-c`) reads none of bash's per-login startup files;
    // a login shell (`-lc`) sources /etc/profile then the first existing of
    // ~/.bash_profile, ~/.bash_login, ~/.profile. If the runner ever
    // regressed to `-lc`, this sentinel would leak into the child's
    // environment - the exact way the header's fidelity detail 2 says a `-l`
    // here would silently change what luna_find_claude_executable resolves
    // against a container's PATH.
    const fx = makeLightFixture({ readyAtTarget: true, readyAtPrev: true })
    const home = join(fx.temp, "login-shell-probe-home")
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, ".bash_profile"), "export LOGIN_SHELL_PROBE_SENTINEL=leaked\n")
    const env = baseEnv(fx, { HOME: home })
    delete env.BASH_ENV
    const runner = makeSpawnBashRunner(env, BASH)
    const result = runner({ script: 'printf %s "${LOGIN_SHELL_PROBE_SENTINEL:-absent}"\n', args: [], env: {} })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe("absent")
  })

  it("surfaces an unspawnable bash (ENOENT) as status 127, never coerced to a false success", () => {
    // A REAL spawn against a path that does not exist: spawnSync reports this
    // with status: null, exactly the shape `?? 127` exists to catch. If that
    // fallback were ever coerced to 0 instead, a missing pinned bash engine
    // would report every delegated call - luna_validate_profile included - as
    // rc 0, i.e. "succeeded", with nothing downstream able to tell the
    // difference from a real success.
    const fx = makeLightFixture({ readyAtTarget: true, readyAtPrev: true })
    const runner = makeSpawnBashRunner(baseEnv(fx), join(fx.temp, "no-such-bash-binary"))
    const result = runner({ script: "true\n", args: [], env: {} })
    expect(result.status).toBe(127)
    expect(result.stdout).toBe("")
  })
})

// ---------------------------------------------------------------------------
// spawnBashSync: the ONE production entry point that injects NOTHING - every
// other describe block in this file drives makeSpawnBashRunner with an
// injected env and an injected bashPath, which means the two defaults
// spawnBashSync itself relies on (`makeSpawnBashRunner(process.env)`, and the
// un-overridden `bashPath = "bash"` default parameter that call leaves in
// place) are exercised by nothing else in this suite. These two tests drive
// spawnBashSync directly - no wrapper, no injected collaborator - mutating
// and restoring the REAL process.env, so a wrong default can only be caught
// by a genuine spawn of the genuine binary.
// ---------------------------------------------------------------------------

describe("spawnBashSync: the production entry point, with nothing injected", () => {
  it("forwards the REAL process.env, not an empty environment", () => {
    // `makeSpawnBashRunner(process.env)` is the whole contract here: if it
    // were ever `makeSpawnBashRunner({})`, this variable - set on the actual
    // process.env, exactly as a real deploy's shell environment would carry
    // UI_WS_TOKEN or PATH - would never reach the spawned bash at all.
    const marker = "LUNA_BASH_LIB_ENV_FORWARD_SENTINEL"
    const value = `sentinel-${Date.now()}`
    const original = process.env[marker]
    process.env[marker] = value
    try {
      const result = spawnBashSync({
        script: `printf %s "\${${marker}:-absent}"\n`,
        args: [],
        env: {},
      })
      expect(result.status).toBe(0)
      expect(result.stdout).toBe(value)
    } finally {
      if (original === undefined) delete process.env[marker]
      else process.env[marker] = original
    }
  })

  it("spawns the literal binary `bash`, the un-overridden default parameter", () => {
    // A PATH directory that resolves `bash` (a shim that re-execs the real
    // bash on this machine) but carries no `sh` at all. If the production
    // default were ever "sh" instead of "bash", spawnSync would report ENOENT
    // against this PATH and surface as status 127 rather than running the
    // script - the same 127-not-a-false-success shape the ENOENT test above
    // pins for an unspawnable absolute path, but here for the bare command
    // name spawnBashSync actually uses.
    //
    // This has to override the real process.env.PATH (rather than, say, pass
    // an empty env to force the lookup): the previous test proved
    // spawnBashSync forwards process.env, and libuv only falls back to its
    // OS-default search path when PATH is entirely ABSENT from the child's
    // env - an explicit PATH that merely lacks the binary gets no such
    // fallback, which is exactly what makes a PATH override load-bearing here.
    const fx = makeLightFixture({ readyAtTarget: true, readyAtPrev: true })
    const shimDir = join(fx.temp, "bash-only-on-this-path")
    mkdirSync(shimDir, { recursive: true })
    writeFileSync(join(shimDir, "bash"), `#!/bin/sh\nexec ${BASH} "$@"\n`)
    chmodSync(join(shimDir, "bash"), 0o755)
    const originalPath = process.env.PATH
    process.env.PATH = shimDir
    try {
      const result = spawnBashSync({ script: 'printf %s "ran-as-bash"\n', args: [], env: {} })
      expect(result.status).toBe(0)
      expect(result.stdout).toBe("ran-as-bash")
    } finally {
      process.env.PATH = originalPath
    }
  })
})

// ---------------------------------------------------------------------------
// scriptFor: a lib that vanishes between resolveBashLib and the call must
// fail through `exit 127`, never by falling through to run the function name
// as an ordinary (undefined) command
// ---------------------------------------------------------------------------

describe("a lib that vanishes after resolution", () => {
  it("fails the call with exit 127 and bash's OWN source-failed line, never an extra 'command not found'", () => {
    const fx = makeLightFixture({ readyAtTarget: true, readyAtPrev: true })
    const env = baseEnv(fx)
    // isReadableFile lies "yes" the way a real TOCTOU race would: resolveBashLib
    // proved the file readable, but by the time `call()` spawns bash it is
    // gone - the one case the header's "IT FAILS LOUDLY, BEFORE THE LOCK"
    // preflight check cannot itself prevent.
    const engine = join(fx.temp, "vanished-pin", "luna-update-server")
    const resolved = resolveBashLib({
      env: () => engine,
      isReadableFile: () => true,
      runBash: makeSpawnBashRunner(env, BASH),
    })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    const result = resolved.lib.validateProfile("stable")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.exitCode).toBe(127)
    expect(result.stderr).toContain("No such file or directory")
    // Without the `|| exit 127` arm, the failed `source` falls through into
    // running `luna_validate_profile` as an ordinary command name - also
    // 127, but with this extra line, and for a call whose real success is
    // silent stdout it is the only visible sign anything went wrong beyond
    // the bare exit code.
    expect(result.stderr).not.toContain("command not found")
  })

  /**
   * FINDBUN NEEDS THE SAME FIXTURE, and it is the more dangerous of the two.
   *
   * Every luna_find_bun parity case asserts `oracle.status === 0` before
   * comparing, and the real bash helper (scripts/lib/luna-deploy.sh:441-455)
   * always returns 0 - its last arm is an unverified
   * `printf '%s\n' "$HOME/.bun/bin/bun"`. So nothing anywhere drove findBun
   * down its failure branch, and the `r.status === 0` discriminator could be
   * replaced by a constant `true` with the whole suite still green.
   *
   * WHY THAT IS WORSE THAN IT LOOKS. findBun's result becomes a path the
   * deploy then EXECUTES. preflight.ts declares its seam as
   * `findBun: () => string`, which structurally discards the ok flag, so a
   * broken discriminator does not surface as an error - it yields
   * `{ ok: true, path: "" }` and hands BUN_BIN="" to the deploy. preflight.ts
   * gave findBun no default precisely to prevent that ("a wrong silent default
   * there would hand the deploy a bun that does not exist").
   *
   * The nonzero case is not hypothetical: it is the 127 that scriptFor's
   * `source "$1" || exit 127` arm exists to produce when the co-pinned lib
   * vanishes mid-run, which is exactly the fixture above.
   */
  it("reports findBun as FAILED when the call cannot run, never as a success carrying an empty path", () => {
    const fx = makeLightFixture({ readyAtTarget: true, readyAtPrev: true })
    const engine = join(fx.temp, "vanished-pin", "luna-update-server")
    const resolved = resolveBashLib({
      env: () => engine,
      isReadableFile: () => true,
      runBash: makeSpawnBashRunner(baseEnv(fx), BASH),
    })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return

    const result = resolved.lib.findBun()
    expect(result.ok, "a failed find_bun must not read as success").toBe(false)
    if (result.ok) return
    expect(result.exitCode).toBe(127)
  })
})

// ---------------------------------------------------------------------------
// defaultIsReadableFile: `[[ -r "$f" && -f "$f" ]]`, not just the -r half
// ---------------------------------------------------------------------------

describe("defaultIsReadableFile", () => {
  it("rejects a directory, even though a directory passes accessSync's R_OK check", () => {
    const fx = makeLightFixture({ readyAtTarget: true, readyAtPrev: true })
    const dir = join(fx.temp, "a-readable-directory")
    mkdirSync(dir, { recursive: true })
    expect(defaultIsReadableFile(dir)).toBe(false)
  })

  it("rejects a REGULAR file that is not readable (mode 000), the -r half of the check", () => {
    // The mirror of the directory case above: `isFile()` alone would pass a
    // mode-000 file straight through. Without the accessSync(R_OK) call, the
    // loud pre-lock refusal the header's "IT FAILS LOUDLY, BEFORE THE LOCK"
    // section is built on degrades into an obscure runtime failure once bash
    // itself tries (and fails) to read the file, after the lock is taken.
    const fx = makeLightFixture({ readyAtTarget: true, readyAtPrev: true })
    const file = join(fx.temp, "unreadable-lib.sh")
    writeFileSync(file, "#!/usr/bin/env bash\n")
    chmodSync(file, 0o000)
    try {
      expect(defaultIsReadableFile(file)).toBe(false)
    } finally {
      chmodSync(file, 0o644)
    }
  })
})

// ---------------------------------------------------------------------------
// luna_validate_profile (scripts/luna-update-server:248)
// ---------------------------------------------------------------------------

describe("luna_validate_profile: golden parity", () => {
  const fx = makeLightFixture({ readyAtTarget: true, readyAtPrev: true })
  const pin = makePin(fx.temp)
  const env = baseEnv(fx)
  const lib = openPort(pin, env)

  const parity = (name: string, profile: string, expectedOk: boolean) => {
    it(name, () => {
      const oracle = runOracle("luna_validate_profile", [profile], env)
      const port = lib.validateProfile(profile)
      expect(oracle.status === 0, `oracle rc ${oracle.status} (${oracle.stderr})`).toBe(expectedOk)
      expect(port.ok).toBe(expectedOk)
      if (!port.ok) {
        expect(port.exitCode).toBe(oracle.status)
        // Byte-exact, trailing newline included: the caller forwards these
        // bytes to stderr unmodified.
        expect(port.stderr).toBe(oracle.stderr)
      } else {
        expect(oracle.stdout).toBe("")
        expect(oracle.stderr).toBe("")
      }
    })
  }

  parity("accepts 'stable'", "stable", true)
  parity("accepts 'dev'", "dev", true)
  parity("accepts the full legal alphabet", "a.b_c-D9", true)
  parity("refuses the empty profile", "", false)
  parity("refuses a profile with a space", "bad profile", false)
  parity("refuses a path separator", "has/slash", false)
  parity("refuses a shell metacharacter", "dev;rm", false)

  it("refuses, rather than EXECUTES, a command-substitution profile", () => {
    const marker = join(fx.temp, "injection-marker")
    const profile = `$(touch ${marker})`
    const oracle = runOracle("luna_validate_profile", [profile], env)
    const port = lib.validateProfile(profile)
    expect(oracle.status).toBe(1)
    expect(port.ok).toBe(false)
    if (!port.ok) expect(port.stderr).toBe(oracle.stderr)
    // The value reaches bash as ONE inert positional parameter on both drives.
    // Interpolating it into the -c script text - the literal reading of the
    // spec's `bash -c 'source <lib> && <fn>'` shorthand - would have created it.
    expect(existsSync(marker)).toBe(false)
  })

  it("emits exactly the message that is IN luna-deploy.sh, awk-extracted", () => {
    // The guard against a degenerate comparison: both drives could agree on an
    // empty stderr if the function stopped refusing altogether.
    const body = spawnSync(
      BASH,
      ["-c", `awk '/^luna_validate_profile\\(\\)/{f=1} f{print} f && /^}$/{exit}' ${JSON.stringify(REPO_LIB)}`],
      { encoding: "utf8" },
    ).stdout
    expect(body).toContain("luna_die")
    expect(body).toContain("profile must contain only letters, numbers, dot, underscore, or dash")
    const port = lib.validateProfile("bad profile")
    expect(port.ok).toBe(false)
    if (!port.ok) {
      expect(port.stderr).toBe(
        `${lunaDieLine("profile must contain only letters, numbers, dot, underscore, or dash")}\n`,
      )
    }
  })
})

// ---------------------------------------------------------------------------
// luna_find_bun (scripts/luna-update-server:529)
// ---------------------------------------------------------------------------

describe("luna_find_bun: golden parity", () => {
  const fx = makeLightFixture({ readyAtTarget: true, readyAtPrev: true })
  const pin = makePin(fx.temp)
  /** PATH with no bun at all, so the `command -v bun` arm fails on any developer machine. */
  const emptyBin = join(fx.temp, "empty-bin")
  mkdirSync(emptyBin, { recursive: true })

  const parity = (name: string, env: Record<string, string>, expected: () => string) => {
    it(name, () => {
      const oracle = runOracle("luna_find_bun", [], env)
      const port = openPort(pin, env).findBun()
      expect(oracle.status).toBe(0)
      expect(port.ok).toBe(true)
      if (port.ok) {
        // `$(...)` strips trailing newlines; the raw oracle stdout carries one.
        expect(port.path).toBe(oracle.stdout.replace(/\n+$/, ""))
        expect(port.path).toBe(expected())
      }
    })
  }

  parity(
    "the LUNA_TEST_BUN_PATH seam wins over everything else",
    baseEnv(fx, { LUNA_TEST_BUN_PATH: join(fx.bin, "bun") }),
    () => join(fx.bin, "bun"),
  )

  // `printf '%s\n' "$LUNA_TEST_BUN_PATH"` adds exactly one trailing newline;
  // if the resolved VALUE itself already ends in a newline (env vars can
  // carry one - only NUL and '=' are forbidden), the real oracle's stdout
  // ends in TWO. `$(...)` strips ALL of them, which is what the header
  // claims and `.replace(/\n+$/, "")` implements; a single-newline strip
  // would leave a trailing blank line nothing in the fixture corpus above
  // could ever expose, because every other fixture value has zero embedded
  // newlines to begin with.
  parity(
    "strips ALL trailing newlines, not just one, when the resolved value itself ends in a newline",
    baseEnv(fx, { LUNA_TEST_BUN_PATH: `${join(fx.bin, "bun")}\n` }),
    () => join(fx.bin, "bun"),
  )

  // The mirror of the trailing-newlines case above, but for LEADING
  // whitespace: bash's `printf '%s\n'` preserves it verbatim, and
  // stripTrailingNewlines must too. `.trim()` at findBun's own call site
  // (rather than luna_env_value's) would pass every other fixture here since
  // none of them carry leading whitespace - this is the one case that
  // distinguishes the two implementations at THIS call site specifically.
  parity(
    "keeps LEADING whitespace from LUNA_TEST_BUN_PATH too - stripTrailingNewlines, not .trim(), at this call site",
    baseEnv(fx, { LUNA_TEST_BUN_PATH: `  ${join(fx.bin, "bun")}` }),
    () => `  ${join(fx.bin, "bun")}`,
  )

  parity(
    "otherwise `command -v bun` on PATH",
    baseEnv(fx),
    () => join(fx.bin, "bun"),
  )

  parity(
    "otherwise an executable $HOME/.bun/bin/bun",
    (() => {
      const home = join(fx.temp, "home-with-bun")
      mkdirSync(join(home, ".bun", "bin"), { recursive: true })
      const bun = join(home, ".bun", "bin", "bun")
      writeFileSync(bun, "#!/usr/bin/env bash\nexit 0\n")
      chmodSync(bun, 0o755)
      return baseEnv(fx, { PATH: emptyBin, HOME: home })
    })(),
    () => join(fx.temp, "home-with-bun", ".bun", "bin", "bun"),
  )

  parity(
    "and finally the unverified $HOME/.bun/bin/bun default - a PATH, not a promise",
    baseEnv(fx, { PATH: emptyBin, HOME: join(fx.temp, "home-without-bun") }),
    () => join(fx.temp, "home-without-bun", ".bun", "bin", "bun"),
  )
})

// ---------------------------------------------------------------------------
// luna_env_value (scripts/luna-update-server:1248, :845)
// ---------------------------------------------------------------------------

describe("luna_env_value: golden parity", () => {
  const fx = makeLightFixture({ readyAtTarget: true, readyAtPrev: true })
  const pin = makePin(fx.temp)
  const env = baseEnv(fx)
  const lib = openPort(pin, env)
  const envDir = join(fx.temp, "env-cases")
  mkdirSync(envDir, { recursive: true })

  const writeEnv = (name: string, body: string): string => {
    const path = join(envDir, name)
    writeFileSync(path, body, { mode: 0o600 })
    return path
  }

  const parity = (
    name: string,
    envFile: string,
    key: string,
    expected: { readonly found: boolean; readonly value: string },
  ) => {
    it(name, () => {
      const oracle = runOracle("luna_env_value", [envFile, key], env)
      const port = lib.envValue(envFile, key)
      expect(port.exitCode).toBe(oracle.status)
      expect(port.found).toBe(oracle.status === 0)
      expect(port.found).toBe(expected.found)
      // Command-substitution semantics, exactly as `claude_pin="$(...)"` at
      // scripts/luna-update-server:1248 reads it.
      expect(port.value).toBe(oracle.status === 0 ? oracle.stdout.replace(/\n+$/, "") : "")
      expect(port.value).toBe(expected.value)
      expect(port.stderr).toBe(oracle.stderr)
    })
  }

  const populated = writeEnv(
    "populated.env",
    "UI_WS_TOKEN=abc123\nLUNA_CLAUDE_CODE_EXECUTABLE=/usr/local/bin/claude\nEMPTY=\nWITH_EQUALS=a=b=c\nSPACED=   three leading spaces\n",
  )

  parity("reads a plain value", populated, "LUNA_CLAUDE_CODE_EXECUTABLE", {
    found: true,
    value: "/usr/local/bin/claude",
  })

  // `substr($0, length(key) + 2)` keeps everything after the FIRST '=' (:95),
  // so a value containing '=' survives intact.
  parity("keeps everything after the first '=' ", populated, "WITH_EQUALS", { found: true, value: "a=b=c" })

  // stripTrailingNewlines strips ONLY trailing newlines (command-substitution
  // semantics); `.trim()` would also eat this leading whitespace the bash
  // keeps, which is exactly the wrong call the header warns `.trim()` makes.
  parity("keeps LEADING whitespace in the value - stripTrailingNewlines, not .trim()", populated, "SPACED", {
    found: true,
    value: "   three leading spaces",
  })

  // Present-but-empty is rc 0, and that is NOT the same as absent: the host
  // arm's degrade check distinguishes them (:1252).
  parity("reports a present-but-EMPTY value as found", populated, "EMPTY", { found: true, value: "" })

  parity("reports an absent key as not found", populated, "NO_SUCH_KEY", { found: false, value: "" })

  parity("reports an absent FILE as not found", join(envDir, "does-not-exist.env"), "UI_WS_TOKEN", {
    found: false,
    value: "",
  })

  parity(
    "does not match a key that is only a PREFIX of a line",
    writeEnv("prefix.env", "LUNA_CLAUDE_CODE_EXECUTABLE_EXTRA=/nope\n"),
    "LUNA_CLAUDE_CODE_EXECUTABLE",
    { found: false, value: "" },
  )

  it("coerces value to empty on a nonzero exit even if the subprocess printed something first", () => {
    // Not reachable through the real awk (its only nonzero exit, the END
    // block's "found ? 0 : 1", never prints beforehand), so this drives the
    // injected `runBash` seam directly - the same seam
    // "a lib that vanishes after resolution" above uses - to prove the shape
    // the header's found/value distinction depends on: a partial-stdout-then-
    // fail subprocess (a real TOCTOU or an interrupted awk) must not leak the
    // partial bytes into `value` once `found` is false.
    const resolved = resolveBashLib({
      env: () => pin.engine,
      isReadableFile: defaultIsReadableFile,
      runBash: () => ({ status: 1, stdout: "leaked-partial-value\n", stderr: "" }),
    })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    const result = resolved.lib.envValue(populated, "UI_WS_TOKEN")
    expect(result.found).toBe(false)
    expect(result.exitCode).toBe(1)
    expect(result.value).toBe("")
  })
})

// ---------------------------------------------------------------------------
// luna_repin_claude_executable (scripts/luna-update-server:1262, HOST arm)
// ---------------------------------------------------------------------------

describe("luna_repin_claude_executable: golden parity (the host arm)", () => {
  /**
   * The only function here that WRITES, so each drive needs its own root:
   * makeFixturePair gives two identically-built fixtures with independent
   * temp dirs (and identical commit shas, which is what lets the .env bytes be
   * compared after masking).
   */
  const drive = (
    fx: Fixture,
    kind: "oracle" | "port",
    dryRun: boolean,
  ): Run & { readonly envBytes: string | null; readonly envMode: string | null } => {
    const env = baseEnv(fx, { DRY_RUN: dryRun ? "true" : "false" })
    let run: Run
    if (kind === "oracle") {
      run = runOracle("luna_repin_claude_executable", [fx.envFile, fx.work], env)
    } else {
      const pin = makePin(fx.temp)
      const r = openPort(pin, env).configureClaudeExecutable({
        envFile: fx.envFile,
        repoDir: fx.work,
        dryRun,
      })
      run = { status: r.exitCode, stdout: r.stdout, stderr: r.stderr }
    }
    return {
      ...run,
      envBytes: existsSync(fx.envFile) ? readFileSync(fx.envFile, "utf8") : null,
      // mode 600 is the posture luna_upsert_env enforces (luna-deploy.sh:48, :63);
      // a port that dropped it would leak a token-bearing file.
      envMode: existsSync(fx.envFile) ? (statSync(fx.envFile).mode & 0o777).toString(8) : null,
    }
  }

  const parity = (
    name: string,
    opts: Parameters<typeof makeFixturePair>[0],
    expected: {
      readonly status: number
      readonly stderrMatch?: RegExp
      readonly envMatch?: RegExp
      readonly envBytesNull?: boolean
    },
    dryRun = false,
  ) => {
    it(name, () => {
      const pair = makeFixturePair(opts)
      const oracle = drive(pair.bash, "oracle", dryRun)
      const port = drive(pair.binary, "port", dryRun)

      expect(oracle.status, `oracle stderr: ${oracle.stderr}`).toBe(expected.status)
      expect(port.status, `port stderr: ${port.stderr}`).toBe(expected.status)
      // Byte-exact once each drive's own root is masked out.
      expect(mask(port.stdout, pair.binary.temp)).toBe(mask(oracle.stdout, pair.bash.temp))
      expect(mask(port.stderr, pair.binary.temp)).toBe(mask(oracle.stderr, pair.bash.temp))
      // The artifact the function exists to produce.
      expect(port.envBytes === null ? null : mask(port.envBytes, pair.binary.temp)).toBe(
        oracle.envBytes === null ? null : mask(oracle.envBytes, pair.bash.temp),
      )
      expect(port.envMode).toBe(oracle.envMode)

      if (expected.stderrMatch) expect(mask(oracle.stderr, pair.bash.temp)).toMatch(expected.stderrMatch)
      if (expected.envMatch) expect(mask(oracle.envBytes ?? "", pair.bash.temp)).toMatch(expected.envMatch)
      if (expected.envBytesNull) expect(oracle.envBytes).toBeNull()
    })
  }

  parity(
    "an already-up-to-date pin is left alone (detected == old_pin, luna-deploy.sh:200-201)",
    { readyAtTarget: true, readyAtPrev: true, claude: { stub: "present", envPin: "detected" } },
    { status: 0, envMatch: /^LUNA_CLAUDE_CODE_EXECUTABLE=<ROOT>\/bin\/claude\n$/ },
  )

  parity(
    "a STALE pin is updated to the freshly-detected binary",
    { readyAtTarget: true, readyAtPrev: true, claude: { stub: "present", envPin: "stale" } },
    {
      status: 0,
      stderrMatch: /^warning: replacing stale claude pin: .*stale-claude -> .*\/claude\n$/,
      envMatch: /^LUNA_CLAUDE_CODE_EXECUTABLE=<ROOT>\/bin\/claude\n$/,
    },
  )

  parity(
    "a stale pin with NOTHING to re-detect is cleared and a degraded warning is emitted (rc still 0)",
    { readyAtTarget: true, readyAtPrev: true, claude: { stub: "absent", envPin: "stale" } },
    {
      status: 0,
      stderrMatch: /no usable claude binary found after bun install; clearing stale pin:/,
      envMatch: /^$/,
    },
  )

  parity(
    "no pin at all: detects claude on PATH and writes the key",
    { readyAtTarget: true, readyAtPrev: true, claude: { stub: "present" } },
    { status: 0, envMatch: /^LUNA_CLAUDE_CODE_EXECUTABLE=<ROOT>\/bin\/claude\n$/ },
  )

  parity(
    "no pin and no claude anywhere: writes nothing and still returns 0",
    { readyAtTarget: true, readyAtPrev: true, claude: { stub: "absent" } },
    { status: 0, envBytesNull: true },
  )

  parity(
    "DRY_RUN returns 0 immediately without touching the .env (luna-deploy.sh:192)",
    { readyAtTarget: true, readyAtPrev: true, claude: { stub: "present", envPin: "stale" } },
    {
      status: 0,
      // The stale pin survives untouched: no warning, no removal, no re-pin.
      stderrMatch: /^$/,
      envMatch: /^LUNA_CLAUDE_CODE_EXECUTABLE=<ROOT>\/stale-claude\n$/,
    },
    true,
  )

  it("propagates DRY_RUN explicitly, so an ambient value cannot silence a real re-pin", () => {
    // The parent environment claims a dry run; the request says otherwise, and
    // the request must win - otherwise a stray DRY_RUN in a guardian unit would
    // turn every re-pin into a silent no-op and reproduce the original incident.
    const pair = makeFixturePair({
      readyAtTarget: true,
      readyAtPrev: true,
      claude: { stub: "present", envPin: "stale" },
    })
    const fx = pair.binary
    const pin = makePin(fx.temp)
    const env = baseEnv(fx, { DRY_RUN: "true" })
    const result = openPort(pin, env).configureClaudeExecutable({
      envFile: fx.envFile,
      repoDir: fx.work,
      dryRun: false,
    })
    expect(result.ok).toBe(true)
    expect(result.stderr).toMatch(/replacing stale claude pin:/)
    expect(readFileSync(fx.envFile, "utf8")).toBe(`LUNA_CLAUDE_CODE_EXECUTABLE=${join(fx.bin, "claude")}\n`)
  })

  it("reports the subprocess's OWN nonzero rc, not a coerced success, when the write path fails", () => {
    const fx = makeLightFixture({ readyAtTarget: true, readyAtPrev: true })
    writeFileSync(join(fx.bin, "claude"), "#!/usr/bin/env bash\nexit 0\n")
    chmodSync(join(fx.bin, "claude"), 0o755)
    const pin = makePin(fx.temp)
    const env = baseEnv(fx)
    // luna_upsert_env's `mkdir -p "$(dirname "$env_file")"` cannot create a
    // child of a directory it has no write permission on, so every step of
    // the write path fails and the trailing `chmod 600 "$env_file"` - the
    // function's own last command - fails too; THAT is what the function's
    // return status echoes. Proven against the real lib below, not asserted
    // from reading the bash source.
    const badParent = join(fx.temp, "no-write-parent")
    mkdirSync(badParent, { recursive: true })
    chmodSync(badParent, 0o500)
    const envFile = join(badParent, "nested", ".env")
    const repoDir = join(fx.temp, "unused-repo")
    try {
      const oracle = runOracle("luna_repin_claude_executable", [envFile, repoDir], env)
      // Sanity: the scenario really does make the REAL lib fail; otherwise
      // this test would prove nothing about the port's fidelity to it.
      expect(oracle.status).not.toBe(0)
      const port = openPort(pin, env).configureClaudeExecutable({ envFile, repoDir, dryRun: false })
      expect(port.exitCode).toBe(oracle.status)
      expect(port.ok).toBe(false)
    } finally {
      chmodSync(badParent, 0o700)
    }
  })
})
