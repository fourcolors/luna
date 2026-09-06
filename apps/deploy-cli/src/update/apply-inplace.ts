/**
 * `apply_ref_inplace` (scripts/luna-update-server:1170-1254): the destructive
 * half of an inplace deploy, ported.
 *
 * THIS IS THE ONLY MODULE IN THE SLICE THAT MUTATES A CHECKOUT. Everything
 * else in `src/update/` either observes (probes, readiness, session-guard),
 * records (journal, lock, status-file) or orchestrates. Here a `git reset
 * --hard` runs against a live server's repo, so every branch below is written
 * to fail CLOSED: any step that cannot prove it did what it claimed returns a
 * typed failure and lets the caller roll back, rather than continuing on an
 * assumption.
 *
 * WHAT IT DOES NOT DO, and why the options record is as wide as it is. This
 * module spawns nothing, stats nothing, reads no environment variable and
 * writes to no stream it was not handed. `gitTarget`/`gitTargetCapture`/
 * `runTarget` are already target.ts's narrow waist; `lockfileHash`,
 * `onCheckout`, `dirExists`, `configureClaudeExecutable`, `repinClaudeExecutable`, `envValue`,
 * `commandExists` and `isExecutable` are the remaining collaborators bash
 * reaches through global state. Injecting all of them is what lets the parity
 * suite drive the REAL bash function and this function over one fixture and
 * diff the two, which is the only evidence that matters for a function whose
 * failure mode is "the wrong commit is now checked out on a production host".
 *
 * THE THREE REPO-DIR VALUES ARE NOT INTERCHANGEABLE. `hostRepoDir` (where git
 * runs) is not a field here at all - it is baked into the `gitTarget` closures
 * by the composition root - while `containerRepoDir` (bun, node_modules) and
 * `repoDir` (the host claude re-pin, bash's `$REPO_DIR` at :1245) both are.
 * On the inplace layout `:318-320` sets all three to the same string on a bare
 * host, so `repoDir` versus `hostRepoDir` is unobservable today; the field
 * stays named for its bash source anyway, so a future releases-layout fold
 * inherits correct wiring rather than a coincidence.
 *
 * ORDER IS THE CONTRACT. Steps 1-6 below run in bash's exact order and each
 * one aborts the whole function. Reordering them is not a refactor: the HEAD
 * postcondition sits BEFORE the journal's `checkout` write on purpose, so a
 * lying reset never records a phase the next tick would try to resume from.
 */
import type { ConfigureClaudeRequest, ConfigureClaudeResult, EnvValueResult } from "./bash-lib.js"
import {
  bunInstallArgv,
  gitFetchOriginArgs,
  gitHashObjectArgv,
  gitResetHardArgs,
  gitRevParseHeadArgs,
  incusRepinArgv,
  nodeModulesTestArgv,
} from "./commands.js"
import {
  claudeDegradedLine,
  headPostconditionLine,
  lockChangedLine,
  lockUnchangedLine,
  nodeModulesPostconditionLine,
} from "./flow-lines.js"
// The one shared helper rather than a fourth private copy: `$( )` strips ALL
// trailing newlines and nothing else, and session-guard.ts already owns that
// spelling for exactly the same reason (restart.ts imports it from there too).
import { stripTrailingNewlines } from "./session-guard.js"
import type { CommandResult } from "./target.js"

/** The env key the re-pin's degrade check reads back (scripts/luna-update-server:1248). */
const CLAUDE_PIN_KEY = "LUNA_CLAUDE_CODE_EXECUTABLE"

/** The sentinel the in-container re-pin payload exits with when it found no usable claude (:1237, :1239). */
const REPIN_NO_CLAUDE = 9

/**
 * `luna_lc` (scripts/lib/luna-deploy.sh:385-387) is `tr '[:upper:]'
 * '[:lower:]'`, which folds the twenty-six ASCII letters and NOTHING else.
 * `String.prototype.toLowerCase` is Unicode-aware and folds far more than
 * that, so it is a DIFFERENT function - a fact that cannot bite on a hex sha
 * but would bite the moment this helper were reused on an operator-supplied
 * string. Spelling the ASCII-only fold out costs one line and removes the
 * question.
 */
const lunaLowercase = (value: string): string => value.replace(/[A-Z]/g, (c) => c.toLowerCase())

/**
 * bash's `<cmd> || return 1`: anything but a clean zero fails.
 *
 * `status` is `null` when the child was killed by a signal (target.ts:96-104),
 * which bash would report as 128+signal - non-zero either way, so treating
 * null as failure is bash's behaviour, not a coercion.
 */
const failed = (result: CommandResult): boolean => result.status !== 0

// ---------------------------------------------------------------------------
// lockfile_hash (:538-544)
// ---------------------------------------------------------------------------

export interface LockfileHashOptions {
  /** `$HOST_REPO_DIR`: bun.lock lives on the host mount and git is host-side, so this is host-side in BOTH modes (:537). */
  readonly hostRepoDir: string
  /** `[[ -f "$HOST_REPO_DIR/bun.lock" ]]` (:539). */
  readonly fileExists: (path: string) => boolean
  /** Runs `gitHashObjectArgv` and reports status plus captured stdout; bound to UpdateIo's spawn seam by the composition root. */
  readonly spawn: (argv: ReadonlyArray<string>) => CommandResult
}

/**
 * `lockfile_hash` (scripts/luna-update-server:538-544), whose entire contract
 * is "a string, always".
 *
 * BOTH of bash's arms return the EMPTY STRING and neither can fail: a missing
 * `bun.lock` short-circuits before git is invoked at all (:539-543), and a
 * `git hash-object` that exits non-zero is swallowed by `|| printf ''`
 * (:540). This port must never throw and must never invent an error sentinel,
 * because the value feeds a plain string comparison in step 5 that decides
 * whether `bun install` runs - a thrown error would take down a deploy that
 * bash completes, and a sentinel like "error" would compare unequal to the
 * journal's persisted `prev_lock_hash` and reinstall dependencies on every
 * single run.
 *
 * The MISSING-FILE arm not invoking git is a behavioural fact the parity
 * suite asserts through the fixture's git log, not an implementation detail:
 * a port that always spawned git and relied on the failure arm would produce
 * the same string and a different, slower, log.
 *
 * `git hash-object` is BLOB-ID semantics. See commands.ts's own note on why a
 * generic sha256 or md5 of the file is not a substitute.
 */
export const lockfileHashSync = (opts: LockfileHashOptions): string => {
  if (!opts.fileExists(`${opts.hostRepoDir}/bun.lock`)) return ""
  const result = opts.spawn(gitHashObjectArgv(opts.hostRepoDir))
  if (failed(result)) return ""
  // `$( )` semantics: git prints the blob id plus a newline, and the caller
  // compares the value as a plain string against the journal's copy.
  return stripTrailingNewlines(result.stdout)
}

// ---------------------------------------------------------------------------
// apply_ref_inplace (:1170-1254)
// ---------------------------------------------------------------------------

export interface ApplyInplaceOptions {
  /** The target ref, 7-64 hex OR a resolved sha; passed to `git reset --hard` verbatim (:1177). */
  readonly target: string
  /** The lockfile hash to compare against. On the rollback call site this is computed FRESH at call time, not carried from before the forward attempt (:1821). */
  readonly prevLockHash: string
  /** `no_fetch="${3:-}"` (:1172). True means the third bash argument was `--no-fetch`; both real call sites pass it. */
  readonly noFetch: boolean
  /** `TRANSACTION_TRACK_APPLY` (:1195). Passed explicitly per call, NEVER a module global. */
  readonly trackApply: boolean

  /** `INCUS_CONTAINER` (:1221); "" is the bare-host arm. Selects the arm in steps 5 and 6, and nothing else. */
  readonly incusContainer: string
  /** `$BUN_BIN` (:1206). */
  readonly bunBin: string
  /** `$CONTAINER_REPO_DIR` (:1206, :1210-1211): the repo AS THE TARGET SEES IT. */
  readonly containerRepoDir: string
  /** `$ENV_FILE` - the HOST arm's .env ($LUNA_HOME/.env, :342). */
  readonly envFile: string
  /** `$REPO_DIR` VERBATIM (:1245), NOT hostRepoDir and NOT containerRepoDir. See this module's header. */
  readonly repoDir: string
  /**
   * Always false in practice - config.ts:271-277 delegates the whole run under
   * `--dry-run`, so this function is unreachable with it set. Carried anyway
   * because ConfigureClaudeRequest requires it (bash-lib.ts:271-278) and a
   * hardcoded `false` at the call site would be a second place to fix if
   * delegation ever narrowed.
   */
  readonly dryRun: boolean

  /** `git_target` (:1173, :1177): host-side, mutating, output flows to the operator. */
  readonly gitTarget: (args: ReadonlyArray<string>) => CommandResult
  /** `git_target_capture` (:1189): host-side, stdout captured. */
  readonly gitTargetCapture: (args: ReadonlyArray<string>) => CommandResult
  /** `run_target` (:1206, :1210, :1236): container-routed when a container is set. */
  readonly runTarget: (argv: ReadonlyArray<string>) => CommandResult
  /** `lockfile_hash` (:1200); bind to `lockfileHashSync` above. */
  readonly lockfileHash: () => string
  /**
   * `write_transaction "checkout" || return 1` (:1195-1196). Returns false on a
   * failed journal write, which fails the whole apply.
   *
   * WHERE THE FALSE COMES FROM: journal.ts:96-106's `writeTransactionSync`
   * returns void and THROWS on a failed atomic write, so the composition root
   * builds this seam as a try/catch that returns true on a normal return and
   * false on any throw. That is the whole derivation, and nothing else in this
   * flow may catch that throw - every other journal write bash performs here
   * is unguarded, and swallowing one would strand a host mid-transaction.
   */
  readonly onCheckout: () => boolean
  /** `[[ -d <path> ]]` on the HOST, used only on the bare-host arm of step 5 - see there for why that arm stats instead of spawning. */
  readonly dirExists: (path: string) => boolean
  /** bash-lib.ts's `configureClaudeExecutable`, host arm only (:1245). */
  readonly configureClaudeExecutable: (req: ConfigureClaudeRequest) => ConfigureClaudeResult
  /**
   * bash-lib.ts's `repinClaudeExecutable` (luna_repin_claude_executable :1262),
   * host arm only. Unconditionally re-detects and re-writes the pin so a
   * stale-but-executable wrong-version pin (e.g. 0.3.175 still linked at
   * /usr/local/bin/claude after a lockfile-bumping bun install) is replaced by
   * the freshly-installed binary. Mirrors the incus arm's luna_repin_claude_executable
   * call inside the container payload.
   */
  readonly repinClaudeExecutable: (req: ConfigureClaudeRequest) => ConfigureClaudeResult
  /** bash-lib.ts's `envValue`, host arm only (:1248). */
  readonly envValue: (envFile: string, key: string) => EnvValueResult
  /**
   * `command -v claude` on the HOST, host arm only (:1250).
   *
   * MUST NOT be `spawnSync("command", ["-v", name])`: `command` is a shell
   * BUILTIN and that spawn fails with ENOENT on every platform. The
   * composition root implements it as a walk of the injected PATH testing each
   * candidate for an executable regular file. The one behaviour that walk
   * cannot reproduce is bash's `command -v` also matching a shell function or
   * alias, neither of which can exist in the non-interactive engine context
   * this runs in.
   */
  readonly commandExists: (name: string) => boolean
  /** `[[ -x <path> ]]` (:1249). */
  readonly isExecutable: (path: string) => boolean

  /** `luna_info` - the PAYLOAD only; the `-> ` prefix is the writer's. */
  readonly info: (line: string) => void
  /** `luna_warn` - the PAYLOAD only; the `warning: ` prefix is the writer's. */
  readonly warn: (line: string) => void
  /** RAW passthrough for a sub-helper's own stdout bytes; see step 6. */
  readonly writeStdout: (text: string) => void
  /** RAW passthrough for a sub-helper's own stderr bytes; see step 6. */
  readonly writeStderr: (text: string) => void
}

/**
 * Which step refused, so a caller's log says WHY the apply failed rather than
 * only that it did. bash has one `return 1` per step and no such distinction;
 * the caller treats every `ok: false` identically (it rolls back), so this is
 * strictly additional information and cannot change control flow.
 */
export type ApplyInplaceOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly step:
        | "fetch"
        | "reset"
        | "head-postcondition"
        | "checkout-journal"
        | "bun-install"
        | "node-modules"
        | "claude-repin"
    }

export const applyInplaceSync = (opts: ApplyInplaceOptions): ApplyInplaceOutcome => {
  // --- step 1: fetch (:1172-1174) ------------------------------------------
  // UNREACHABLE from both real call sites (:1821 and :2020 both pass
  // `--no-fetch`, because the flow has already fetched once before resolving
  // the ref), so the dual-drive diff gives it no coverage and the parity suite
  // drives it directly instead.
  if (!opts.noFetch && failed(opts.gitTarget(gitFetchOriginArgs))) return { ok: false, step: "fetch" }

  // --- step 2: the reset (:1177) -------------------------------------------
  if (failed(opts.gitTarget(gitResetHardArgs(opts.target)))) return { ok: false, step: "reset" }

  // --- step 3: the HEAD postcondition (:1188-1194) --------------------------
  // A `git reset --hard` that reported success without MOVING HEAD used to
  // feed the old HEAD into NEW_HEAD and EXPECTED_BUILD_SHA, so the readiness
  // gate verified the OLD build and the run exited 0 - a self-referential
  // success. This is the check that makes that unrepresentable.
  //
  // bash reads it as `$(git_target_capture rev-parse HEAD 2>/dev/null || true)`,
  // so a FAILED read yields the empty string rather than propagating: the
  // status is deliberately not consulted here, only the captured stdout, and
  // the empty case is what prints `unreadable`. The seam's CommandResult
  // carries no stderr, which is that call site's `2>/dev/null` by construction.
  const head = stripTrailingNewlines(opts.gitTargetCapture(gitRevParseHeadArgs).stdout)
  // BIDIRECTIONAL prefix match, CASE-NORMALISED, and both halves are
  // load-bearing. `--ref` validation passes 7-64 hex through verbatim on the
  // inplace layout (:1991-1992) while `rev-parse HEAD` always answers full
  // lowercase 40, so a strict equality check would false-fail and roll back on
  // every abbreviated ref (head is longer) and on every UPPERCASE ref (git
  // accepts it and moves HEAD; rev-parse answers lowercase) even though the
  // reset did exactly what it was asked.
  //
  // ONE STATED FIDELITY LIMIT: bash writes the prefix test as `[[ "$a" != "$b"* ]]`,
  // which is PATTERN matching, so a `*`, `?` or `[` inside the target would be a
  // glob there and a literal in `startsWith` here. It cannot bite, because
  // `--ref` admits only 7-64 hex on this layout (:1991-1992) and the rollback
  // call site passes a resolved sha; stating it is cheaper than someone
  // re-deriving it from a surprising test.
  const headLc = lunaLowercase(head)
  const targetLc = lunaLowercase(opts.target)
  if (head === "" || (!headLc.startsWith(targetLc) && !targetLc.startsWith(headLc))) {
    opts.warn(headPostconditionLine(head, opts.target))
    return { ok: false, step: "head-postcondition" }
  }

  // --- step 4: the checkout journal write (:1195-1196) ----------------------
  // AFTER the postcondition, never before: recording `checkout` for a reset
  // that did not land would hand the next idle tick a phase to resume from
  // that describes a state the host is not in.
  if (opts.trackApply && !opts.onCheckout()) return { ok: false, step: "checkout-journal" }

  // --- step 5: the lockfile gate (:1199-1216) ------------------------------
  // Compared as plain strings, both sides produced by `git hash-object`. An
  // equal hash means the dependency tree the previous install produced is
  // still the declared one, so the install is SKIPPED and nothing runs at all.
  const newLockHash = opts.lockfileHash()
  if (newLockHash !== opts.prevLockHash) {
    opts.info(lockChangedLine)
    if (failed(opts.runTarget(bunInstallArgv(opts.bunBin, opts.containerRepoDir)))) {
      return { ok: false, step: "bun-install" }
    }
    // THE NODE_MODULES POSTCONDITION IS ARM-SPECIFIC, and the asymmetry is
    // bash's, not this port's. On the INCUS arm `run_target test -d ...`
    // really does exec an external `test(1)` inside the container through
    // `incus exec`, so the port issues the identical argv and the two engines
    // produce the same container-side log. On the BARE-HOST arm `run_target`
    // degenerates to running `test -d` in the engine's own shell, where `test`
    // is a BUILTIN and NO PROCESS IS CREATED - so the port stats instead.
    // Spawning `/usr/bin/test` there would be an unstated assumption about a
    // minimal host's PATH and would add a process bash never creates.
    const nodeModulesPresent =
      opts.incusContainer !== ""
        ? !failed(opts.runTarget(nodeModulesTestArgv(opts.containerRepoDir)))
        : opts.dirExists(`${opts.containerRepoDir}/node_modules`)
    if (!nodeModulesPresent) {
      opts.warn(nodeModulesPostconditionLine(opts.containerRepoDir))
      return { ok: false, step: "node-modules" }
    }
  } else {
    opts.info(lockUnchangedLine)
  }

  // --- step 6: the claude re-pin (:1221-1252) ------------------------------
  // ARM FOR ARM, NOT UNIFIED. A host-side re-pin on an incus target would
  // introspect HOST paths and write a host-perspective path into the
  // CONTAINER's .env, which is how the server ends up booting without being
  // able to spawn claude - a real incident, and the reason both arms exist.
  if (opts.incusContainer !== "") {
    // Three-way, and the middle arm is the whole point: the payload's `exit 9`
    // marks "no usable claude" distinctly from a transport or exec failure.
    // Warn-only, because a rollback cannot conjure an absent binary and
    // failing the deploy would deadlock updates on an orthogonal defect.
    const rc = opts.runTarget(incusRepinArgv).status
    if (rc === REPIN_NO_CLAUDE) opts.warn(claudeDegradedLine)
    else if (rc !== 0) return { ok: false, step: "claude-repin" }
  } else {
    const result = opts.repinClaudeExecutable({
      envFile: opts.envFile,
      // bash's `$REPO_DIR` (:1245). See this module's header for why this is
      // deliberately not `containerRepoDir` even though they are equal here.
      repoDir: opts.repoDir,
      dryRun: opts.dryRun,
    })
    // FORWARD THE HELPER'S OWN BYTES, BEFORE branching on its outcome. In bash
    // the helper is a function call, so its `warning: removing stale
    // LUNA_CLAUDE_CODE_EXECUTABLE (<path> is not executable)`
    // (scripts/lib/luna-deploy.sh:139) lands on the engine's own stderr with
    // no ceremony. The port delegates to a SUBPROCESS whose streams bash-lib.ts
    // captures precisely "so the caller can forward the bytes instead of
    // reconstructing them" (bash-lib.ts:257-262); without this the stale-pin
    // scenario shows that line on the bash drive and nothing here.
    opts.writeStdout(result.stdout)
    opts.writeStderr(result.stderr)
    if (!result.ok) return { ok: false, step: "claude-repin" }

    // luna_repin_claude_executable (:1262) handles its own degradation warning
    // internally — it emits "POSTCONDITION degraded: no usable claude executable
    // detected" when it finds nothing, so no secondary check is needed here.
    // The old luna_configure_claude_executable was silent on degrade; this is
    // the key behavioural difference between the two functions.
  }

  return { ok: true }
}
