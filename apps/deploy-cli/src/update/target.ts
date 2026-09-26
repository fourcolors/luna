/**
 * The execution waist: a port of `run_target`, `run_target_capture`,
 * `git_target` and `git_target_capture` (scripts/luna-update-server:352-398),
 * the four functions through which every subprocess the update transaction
 * runs must pass.
 *
 * WHY THIS MODULE EXISTS AT ALL, AND WHY IT IS ONE MODULE. Three shipped
 * primitives each documented the SAME hole from their own side and each
 * deferred it:
 *
 *   - readiness.ts:43-47 - "OUT OF SCOPE, deliberately: the
 *     `run_target_capture` incus routing. The probes arrive here as injected
 *     functions, so the caller decides whether a curl runs on the host or
 *     inside a container."
 *   - restart.ts:12-19 - "Bare-host / systemd-supervisor scope only ... the
 *     incus run_target routing [is] out of scope for this port."
 *   - session-guard.ts:117-127 - the is-active fallback "stays host-scoped,
 *     by contrast: bash's own fallback routes through run_target_capture
 *     (scripts/luna-update-server:365-371) ... this is a documented scope
 *     gap, not a silent one."
 *
 * Each of those is the same missing decision: does this command run here, or
 * inside `incus exec`? Ported three times it would be three chances to get
 * the split wrong; ported once it is a single seam that all three primitives'
 * callers fill from, which is exactly the shape bash has. So the caller each
 * of those headers points at is this file.
 *
 * THE SPLIT IS THE CONTRACT: git ALWAYS runs on the HOST, everything else
 * routes through the container when one is set (scripts/luna-update-server:
 * 373-383). In incus mode the container sees the repo through a bind-mount,
 * so a host-side git mutating $HOST_REPO_DIR is already mutating the very
 * files the container reads; routing git through `incus exec` would instead
 * demand a git inside the container and operate on the in-container path,
 * which is wrong twice over. Meanwhile bun/systemctl/curl MUST run inside the
 * container, because that is where the server process, its node_modules and
 * its loopback ports live. Getting this backwards does not fail loudly - it
 * silently deploys into the wrong filesystem - which is why the two argv
 * builders below (`targetArgv`, `gitArgv`) are exported as pure functions and
 * diffed against the real bash rather than merely being exercised.
 *
 * NO MUTATING GIT COMMAND APPEARS IN THIS FILE. `gitTargetSync` takes the
 * subcommand from its caller and builds only the `-C <host repo>` /
 * `--git-dir <mirror>` prefix. The one destructive git invocation the
 * transaction performs lives in exactly one greppable file (apply-inplace.ts),
 * so an auditor asking "what can move this checkout?" gets one answer from
 * one grep. This waist deliberately stays incapable of answering that
 * question on its own.
 *
 * DRY-RUN IS luna_run's, NOT OURS (scripts/lib/luna-deploy.sh:8-18). Under
 * dry-run the mutating arms PRINT the would-be command and execute nothing,
 * and the printed line is byte-exact operator-facing output: a literal `+`,
 * then one space and one `printf %q`-quoted argument each. `quoteForLunaRun`
 * below is a port of bash's %q rather than a JSON/POSIX quoter, because an
 * operator diffing a binary dry-run against a bash host's dry-run reads those
 * lines literally. See its own doc for the one input where bash 3.2 and bash
 * 5.x disagree with each other.
 *
 * THE CAPTURE ARMS ARE DELIBERATELY NOT DRY-RUN AWARE, and this asymmetry is
 * load-bearing rather than an oversight in the bash: `run_target_capture`
 * (:365-371) and `git_target_capture` (:392-398) call the command DIRECTLY,
 * never through luna_run. They are read-only probes - is-active, NRestarts,
 * MainPID, /healthz, /readyz, rev-parse - whose value the script then branches
 * on. A dry-run-aware capture would return an empty string to a caller that
 * parses it, and the transaction would then reason about a build sha, a unit
 * state or a restart count that it never actually read.
 *
 * STDOUT DISPOSITION MIRRORS bash's `$( )`. The mutating arms let the child
 * write straight to the engine's own stdout/stderr (bash runs them bare); the
 * capture arms take stdout back as a string because every bash call site wraps
 * them in command substitution. That is what `SpawnOptions.capture` selects.
 * Command substitution ALSO strips trailing newlines, and this module does NOT
 * do that stripping for you: callers strip with session-guard.ts's
 * `stripTrailingNewlines`, which is the one place that behaviour is stated, and
 * `.trim()` is the wrong tool there (see queryUnitStateSync's own note).
 *
 * VOCABULARY WARNING. `LAYOUT` in bash is "inplace" or "releases"
 * (scripts/luna-update-server:199), and `TargetContext.layout` keeps those
 * exact spellings. rollback.ts's own discriminant spells its non-releases arm
 * "bare" (rollback.ts:115-116) because it is describing a bare-host rollback,
 * not a repo layout. The two are different vocabularies for different
 * questions; do not pass one where the other is expected.
 *
 * SCOPE. This module ports the waist and nothing above it. It does not decide
 * whether a topology should be delegated to the bash engine (config.ts owns
 * that), it does not resolve HOST_REPO_DIR / CONTAINER_REPO_DIR (config.ts
 * again, from scripts/luna-update-server:305-341), and it holds no state
 * between calls: a `TargetContext` is data a caller assembled once and passes
 * back in, so no second, independently-resolved notion of "the target" can
 * exist - the same non-decoupling restart.ts's header states in full.
 */
import { spawnSync } from "node:child_process"

/** bash's `LAYOUT` values, verbatim (scripts/luna-update-server:199 and the releases fork at :323-341). Not to be confused with rollback.ts's "bare" | "releases". */
export type Layout = "inplace" | "releases"

export interface CommandResult {
  /**
   * The child's exit status, or null when it was killed by a signal (bash
   * would report 128+signal there; the default spawn passes Node's null
   * through rather than inventing a number, and every caller in this slice
   * tests `!== 0`, which treats null as failure exactly as bash's non-zero
   * would).
   */
  readonly status: number | null
  /** Empty unless the call requested capture; see SpawnOptions.capture. */
  readonly stdout: string
}

export interface SpawnOptions {
  /**
   * True for the `run_target_capture` / `git_target_capture` arms, whose bash
   * call sites all sit inside `$( )`; false for the mutating arms, which let
   * the child write to the engine's own stdout. See this module's header.
   */
  readonly capture: boolean
}

/**
 * The single injected subprocess seam - the same shape restart.ts draws around
 * `runSystemctl` and session-guard.ts around `queryActiveWsCount`. Receives the
 * FULLY RESOLVED argv (already `incus exec`-wrapped, already carrying git's
 * `-C`/`--git-dir` prefix), so a test can assert on exactly what would have
 * been executed without a container, a systemd or a repo in sight.
 */
export type SpawnTarget = (argv: ReadonlyArray<string>, opts: SpawnOptions) => CommandResult

export interface TargetContext {
  /** `INCUS_CONTAINER` (scripts/luna-update-server:62); "" means bare host. Non-empty routes every non-git command through `incus exec`. */
  readonly incusContainer: string
  /** `DRY_RUN` (:63). Affects the mutating arms only - see this module's header. */
  readonly dryRun: boolean
  /** `LAYOUT` (:199). Selects which git the git arms address. */
  readonly layout: Layout
  /** `HOST_REPO_DIR` (:305-341): where host-side git runs. */
  readonly hostRepoDir: string
  /**
   * `MIRROR_GIT` (:206 initialises it to "", :329 sets it under the releases
   * layout). Read only when `layout` is "releases". A releases context built
   * without it reproduces bash's own behaviour - an empty `--git-dir`
   * argument - rather than throwing: this waist is not the validator, and
   * inventing a refusal here would diverge from the oracle it is diffed
   * against.
   */
  readonly mirrorGit?: string | undefined
  /** Defaults to the real subprocess runner below. Injected in tests; see SpawnTarget. */
  readonly spawn?: SpawnTarget | undefined
  /** Where luna_run's dry-run line goes. Defaults to the process's own stdout, matching bash's `printf`. */
  readonly writeStdout?: ((text: string) => void) | undefined
}

// --- printf %q ---------------------------------------------------------------

/**
 * Characters bash's `sh_backslash_quote` escapes wherever they appear
 * (lib/sh/shquote.c's bstab), verified empirically against both bash 3.2.57
 * and bash 5.3 by quoting every ASCII code point in isolation and mid-string.
 * `#` and `~` are POSITIONAL and are handled separately below; tab and newline
 * are listed for fidelity to the table even though a string containing either
 * takes the ANSI-C arm before this one is consulted.
 */
const BACKSLASH_ESCAPED = new Set([
  " ", "\t", "\n", "'", '"', "\\", "|", "&", ";", "(", ")", "<", ">",
  "!", "*", "?", "[", "]", "$", "`", "^", "{", "}", ",",
])

/** bash's `ansic_quote` named escapes (lib/sh/strtrans.c). Note ESC is `\E`, not `\e`. */
const ANSIC_NAMED = new Map<number, string>([
  [0x07, "\\a"], [0x08, "\\b"], [0x09, "\\t"], [0x0a, "\\n"],
  [0x0b, "\\v"], [0x0c, "\\f"], [0x0d, "\\r"], [0x1b, "\\E"],
])

/** C0 controls, DEL and the C1 range are what drives bash's `ansic_shouldquote` in a UTF-8 locale; everything at or above U+00A0 printed raw in both bashes tested (`hié` stays `hié`). */
const isPrintableCodePoint = (cp: number): boolean => cp >= 0x20 && cp !== 0x7f && !(cp >= 0x80 && cp <= 0x9f)

const utf8Bytes = (ch: string): ReadonlyArray<number> => Array.from(new TextEncoder().encode(ch))

const ansicQuote = (value: string): string => {
  let out = "$'"
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0
    const named = ANSIC_NAMED.get(cp)
    if (named !== undefined) out += named
    else if (ch === "'") out += "\\'"
    else if (ch === "\\") out += "\\\\"
    else if (isPrintableCodePoint(cp)) out += ch
    // bash quotes BYTES, so a non-printable code point becomes one octal
    // escape per UTF-8 byte rather than one per code point.
    else for (const b of utf8Bytes(ch)) out += `\\${b.toString(8).padStart(3, "0")}`
  }
  return `${out}'`
}

const backslashQuote = (value: string): string => {
  const chars = Array.from(value)
  let out = ""
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i] as string
    const prev = i === 0 ? undefined : (chars[i - 1] as string)
    // `#` only opens a comment in the first position; `~` only expands at the
    // start of a word or right after `=`/`:` (bash 5's shquote.c). Both are
    // left raw elsewhere, which is why `a#b` and `a~b` come back unquoted.
    if (ch === "#") out += i === 0 ? "\\#" : "#"
    else if (ch === "~") out += i === 0 || prev === "=" || prev === ":" ? "\\~" : "~"
    else if (BACKSLASH_ESCAPED.has(ch)) out += `\\${ch}`
    else out += ch
  }
  return out
}

/**
 * `printf '%q'` (bash builtins/printf.def): empty string becomes `''`, a string
 * containing any non-printable character takes the ANSI-C `$'...'` arm, and
 * everything else is backslash-escaped per the table above.
 *
 * ONE DOCUMENTED CROSS-VERSION DIVERGENCE, outside anything the deploy path
 * passes, pinned by target-parity.test.ts rather than hidden: a leading `~`
 * (or one right after `=`/`:`) is escaped by bash 5.x and NOT by bash 3.2.57
 * (`\~lead` vs `~lead`). This port follows bash 5.x, the version
 * `#!/usr/bin/env bash` resolves to on every host and runner this engine
 * targets, and no argv on the deploy path - paths, refs, unit names, flags -
 * begins with a tilde. Stating it is cheaper than someone re-deriving it from
 * a red test on an old macOS bash.
 *
 * The ANSI-C arm needs NO such caveat: 3.2.57 and 5.3 were compared on
 * control characters, multibyte text and embedded quotes through luna_run's
 * own `printf ' %q'` and agree byte for byte.
 */
export const quoteForLunaRun = (value: string): string => {
  if (value === "") return "''"
  for (const ch of value) {
    if (!isPrintableCodePoint(ch.codePointAt(0) ?? 0)) return ansicQuote(value)
  }
  return backslashQuote(value)
}

/**
 * luna_run's dry-run line, byte-exact (scripts/lib/luna-deploy.sh:9-15):
 * `printf '+'`, then `printf ' %q'` per argument, then a newline. Includes the
 * trailing newline, so a caller writes it verbatim.
 */
export const lunaRunLine = (argv: ReadonlyArray<string>): string =>
  `+${argv.map((a) => ` ${quoteForLunaRun(a)}`).join("")}\n`

// --- the four arms -----------------------------------------------------------

/**
 * `run_target`'s dispatch, as a pure function (scripts/luna-update-server:
 * 352-358): `incus exec <container> -- <argv...>` when a container is set,
 * otherwise argv untouched. The `--` separator is part of the contract, not
 * decoration - without it `incus exec` swallows the payload's own flags.
 */
export const targetArgv = (ctx: TargetContext, argv: ReadonlyArray<string>): ReadonlyArray<string> =>
  ctx.incusContainer !== "" ? ["incus", "exec", ctx.incusContainer, "--", ...argv] : [...argv]

/**
 * `git_target`'s dispatch (scripts/luna-update-server:384-390). Never wrapped
 * for incus at any layout - see this module's header. The releases arm
 * addresses the bare mirror, the only thing a fetch ever touches; the inplace
 * arm addresses the host checkout.
 */
export const gitArgv = (ctx: TargetContext, args: ReadonlyArray<string>): ReadonlyArray<string> =>
  ctx.layout === "releases"
    ? ["git", "--git-dir", ctx.mirrorGit ?? "", ...args]
    : ["git", "-C", ctx.hostRepoDir, ...args]

/**
 * The real subprocess runner. `capture` picks the stdout disposition bash's
 * call site implies (see this module's header); stderr always flows through to
 * the operator, matching bash in both arms. A spawn that never started (ENOENT
 * on the binary) reports 127, which is the status bash's own "command not
 * found" produces, so a caller cannot mistake an absent `incus` for a clean
 * run.
 */
export const defaultSpawnTarget: SpawnTarget = (argv, opts) => {
  const cmd = argv[0]
  // `luna_run` with no arguments expands `"$@"` to nothing and returns 0.
  if (cmd === undefined) return { status: 0, stdout: "" }
  const r = spawnSync(cmd, argv.slice(1), {
    encoding: "utf8",
    stdio: opts.capture ? ["inherit", "pipe", "inherit"] : ["inherit", "inherit", "inherit"],
  })
  if (r.error !== undefined) return { status: 127, stdout: "" }
  return { status: r.status, stdout: opts.capture ? (r.stdout ?? "") : "" }
}

const spawnOf = (ctx: TargetContext): SpawnTarget => ctx.spawn ?? defaultSpawnTarget
const writeOf = (ctx: TargetContext): ((text: string) => void) =>
  ctx.writeStdout ?? ((text) => { process.stdout.write(text) })

/**
 * `run_target` (scripts/luna-update-server:352-358): the mutating arm. Routes
 * through `incus exec` when a container is set, and through luna_run's
 * dry-run gate always - under dry-run it prints the resolved argv (INCLUDING
 * the `incus exec ... --` prefix, exactly as bash does, since luna_run is
 * handed the wrapped command) and reports success without executing.
 */
export const runTargetSync = (ctx: TargetContext, argv: ReadonlyArray<string>): CommandResult => {
  const resolved = targetArgv(ctx, argv)
  if (ctx.dryRun) {
    writeOf(ctx)(lunaRunLine(resolved))
    return { status: 0, stdout: "" }
  }
  return spawnOf(ctx)(resolved, { capture: false })
}

/**
 * `run_target_capture` (scripts/luna-update-server:365-371): the read-only
 * probe arm. Same container routing, NO dry-run gate - see this module's
 * header for why that asymmetry is deliberate. Returns stdout raw; trailing
 * newlines are the caller's to strip (session-guard.ts's
 * stripTrailingNewlines), because that is what `$( )` does at every bash call
 * site and doing it here would hide it.
 */
export const runTargetCaptureSync = (ctx: TargetContext, argv: ReadonlyArray<string>): CommandResult =>
  spawnOf(ctx)(targetArgv(ctx, argv), { capture: true })

/**
 * `git_target` (scripts/luna-update-server:384-390): host-side git, dry-run
 * aware via luna_run, never container-routed. The caller supplies the
 * subcommand; this function contributes only the repo/mirror prefix, which is
 * what keeps every destructive git invocation in one other file.
 */
export const gitTargetSync = (ctx: TargetContext, args: ReadonlyArray<string>): CommandResult => {
  const resolved = gitArgv(ctx, args)
  if (ctx.dryRun) {
    writeOf(ctx)(lunaRunLine(resolved))
    return { status: 0, stdout: "" }
  }
  return spawnOf(ctx)(resolved, { capture: false })
}

/**
 * `git_target_capture` (scripts/luna-update-server:392-398): host-side git
 * whose stdout the caller reads (rev-parse HEAD, rev-parse --verify). Runs
 * even under dry-run, for the same reason run_target_capture does: the
 * transaction branches on what it reads back.
 */
export const gitTargetCaptureSync = (ctx: TargetContext, args: ReadonlyArray<string>): CommandResult =>
  spawnOf(ctx)(gitArgv(ctx, args), { capture: true })
