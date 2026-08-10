# stack23 S22d PR2 - assemble `deploy-cli update` for the inplace layout

Build spec for the second PR of S22d, revision 3.
PR1 (merged) shipped sixteen primitive modules under `apps/deploy-cli/src/update/` with golden parity suites, and nothing outside that directory imports any of them.
This PR turns those primitives into a real `update` command that can perform a live inplace deploy on systemd, and proves it against the bash engine it replaces.

Read `docs/next/stack23-s22d-spec.md` first for the slice-level scope and abandon conditions.
This document is the implementation contract: exact files, exact signatures, exact ordering, exact strings, exact tests, exact gate.

Revision 2 resolved nineteen blockers and twenty-eight concerns raised by three independent adversarial audits, and REPLACED the acceptance gate wholesale.
The old gate (a `--dry-run` output diff) is deleted, not repaired; the section THE ACCEPTANCE GATE states why, so nobody proposes it again.

Revision 3 resolves the twenty-one blockers and twenty-three concerns a fourth audit raised against revision 2, all of them either in the acceptance gate or in operator-facing lines that were never ported.
Three of them were structural enough that the project owner decided them directly rather than leaving the choice open; those three decisions are recorded as REVISION 3: THE THREE DECIDED QUESTIONS, immediately below, and the rest of the document implements them.

## REVISION 3: the three decided questions

**DECISION 1, GATE 1 determinism.**
The measured non-determinism is real and was reproduced: the same bash engine against the same fixture produced `curl.log` with 6/7/7/7 lines and `systemctl.log` with 20/22/22/22 across four runs, because `readiness_ok` polls against a WALL-CLOCK deadline (`scripts/luna-update-server:1071` computes `deadline=$((SECONDS + READINESS_TIMEOUT))`, `:1074` is the `while (( SECONDS < deadline ))`, `:1122` is the per-iteration `sleep`).
Byte-diffing a retry loop is therefore invalid by construction, and revision 2's simultaneous demands of "byte-identical logs", "no fourth masking rule" and "scenarios that must fail readiness" were an unsatisfiable triple.
The resolution has two halves and both are implemented under GATE 1: READINESS DETERMINISM.
Half (a) pins the iteration count: every scenario states, per readiness call, how many poll iterations occur, and the fixture's `--readiness-timeout` / `--readiness-interval` pair is chosen so that the number is fixed by construction rather than by timing.
Half (b) covers the one scenario class whose iteration count genuinely cannot be pinned, by diffing a NORMALISED form of the three poll-fed logs and asserting the retry semantics in a dedicated test that does not rely on the byte diff.
Every artifact that is deterministic by construction stays a strict byte diff, and the section says which artifacts are which.

**DECISION 2, `$ENV_FILE` must become observable or lose its credit.**
Revision 2 credited artifact 8 with catching the wrong-repo-dir defect in the host claude re-pin.
That credit is DELETED, because no fixture can earn it and the underlying claim is false for a reason the audit found only half of.
The full evidence and what replaces the credit are under GATE 1: WHAT ARTIFACT 8 ACTUALLY OBSERVES.

**DECISION 3, the forced failure for the rollback half must actually fail.**
Revision 2's prescribed Half B failure ("the smallest edit that keeps the process alive and fails `/readyz`") is defeated by `readiness_ok` accepting a real HTTP 404 as a legacy pre-`/readyz` build (`scripts/luna-update-server:1090-1095`).
The replacement failure shape, the audit of which shapes `readiness_ok` accepts and rejects, and the restore procedure are under GATE 2, Half B.

## Revision log: what the audits changed

Every row was re-verified against the cited code before being adopted.
Three findings are rejected with counter-evidence, and the rejections are recorded here rather than silently dropped.

| Finding | Verdict | Where it landed |
| --- | --- | --- |
| B1, B7 argv is fed to two consumers with opposite requirements | ADOPTED | THE ARGV CONTRACT |
| B2, concern 13 corrupt-journal contract inverted | ADOPTED, with a different fix from either auditor | `wiring.ts`'s `loadTransaction` seam, typed `Transaction \| "corrupt"` |
| B3, B9 `fail_forward` not ported | ADOPTED | `update-flow.ts` calls `failForwardSync`; both strings added to the table |
| B4, B8 restart-only drops the readiness baseline | ADOPTED | `restart-only.ts`'s readiness seam gains `baseline` |
| B5 rollback readiness loses the give-up line | ADOPTED | `wiring.ts`'s `runReadiness` closure emits it |
| B6, B15 session-guard determinism | ADOPTED | an `ss` stub on the fixture PATH for BOTH drives; `LUNA_TEST_WS_COUNT` removed from both |
| B10 `UpdateFlowDeps` cannot build a `RollbackOptions` | ADOPTED | `rollback(args)` seam; `wiring.ts` owns the layout-vocabulary translation |
| B11 claude re-pin stderr not forwarded | ADOPTED | `apply-inplace.ts` forwards `result.stdout`/`result.stderr` verbatim |
| B12 preflight banner double-prefixing | ADOPTED | preflight's `print` is the RAW stdout writer |
| B13 standalone guard is host-scoped on incus | ADOPTED | `wiring.ts` fills `incusContainer` AND `readUnitState` on the standalone guard |
| B14 live gate unreachable through `luna-autodeploy --dry-run` | ADOPTED | old gate deleted; GATE 2 puts the binary in the engine position on the non-dry path |
| B16 in-process tests reach real spawns | ADOPTED | `RealSeams.io` is a REQUIRED `UpdateIo` record; `realUpdateIo` refuses a non-ambient env |
| B17 runtime resolution finds the fixture's `bun` stub | ADOPTED | resolve from the AMBIENT PATH, assert the candidate is outside the fixture root |
| B18 artifact set is blind to `$ENV_FILE` and to cross-stub ordering | ADOPTED | `$ENV_FILE` bytes + mode, and one shared `trace.log` |
| B19 the two drives do not run the same bash in the same env | ADOPTED in substance, one premise corrected | THE HARNESS CONTRACT |
| concern 1 `onCheckout` cannot fail | ADOPTED | seam returns `boolean` |
| concern 2 the restart-only ordering rationale is factually wrong | ADOPTED | rationale rewritten; git is host-side in BOTH modes |
| concern 3 CRITICAL is printed after the journal write | ADOPTED | `rollback.ts` gains a raw-stderr seam and emits before the write |
| concern 4 the `readinessTimeout` divergence is understated | ADOPTED, and measured | KNOWN DIVERGENCES |
| concern 5, 23 `readinessPort` refusal | ADOPTED, refusal DROPPED | operator-visible values keep their raw string spelling |
| concern 6 resume matrix misses two phases | ADOPTED | `rollback-failed` and `forward-failed` rows added |
| concern 7, 9 `lock-unacquirable` is dead | ADOPTED | `run-update.ts` constructs it |
| concern 8 citation drift | PARTLY ADOPTED | `bunRunArgv` and `dream_wake_install_script` corrected; the `lockfile_hash` correction is REJECTED, see below |
| concern 10 `DelegationFlag` narrowing | ADOPTED | `asDelegationFlag` |
| concern 11 `parseUpdateConfig` arity | ADOPTED | three parameters |
| concern 12 newline ownership | ADOPTED | `writeStdout`/`writeStderr` are RAW; line writers are adapters |
| concern 14 `sup_start` start-limit warn | ADOPTED | new builder plus a `startLimitLatched` outcome field |
| concern 15 `readinessTimeout` reprinting | ADOPTED | the give-up line takes the RAW string |
| concern 16, 24 `lockfileHash` missing-file arm | ADOPTED | empty string, never a throw |
| concern 17 `probes.ts` header contradiction | ADOPTED | header updated in the same commit |
| concern 18 env asymmetry | ADOPTED | one env map, both drives |
| concern 19 `updatedLine` is at :2074 | ADOPTED | table corrected |
| concern 20 live precondition cannot gate a PR | ADOPTED | moved into GATE 2 |
| concern 21 two help paths | ADOPTED | stated as unreachable-but-retained |
| concern 22 `installLockReleaseHooks` leaks listeners | ADOPTED | uninstaller called in the same `finally` |
| concern 25 `test -d` and `command -v` are builtins | ADOPTED | arm-specific, see `apply-inplace.ts` step 5 and step 6 |
| concern 26 Gate A filesystem inertness | REJECTED as moot | Gate A no longer exists |
| concern 27 `update --help` placement | ADOPTED | handled in `main.ts`'s raw-argv preamble |
| concern 28 generalise the `runEngine` env fix | ADOPTED | `UpdateIo` |

Rejected, with evidence.

Concern 8 claims `lockfile_hash` is `:537-545`.
It is `:538-544`: `scripts/luna-update-server:537` is the comment line `# host-side hash in BOTH modes (HOST_REPO_DIR is the bind-mount source on incus).` and `:545` is blank, while `:538` is `lockfile_hash() {` and `:544` is its closing brace.
The original spec's citation was correct and is kept.

Concern 26 asks the spec to record that a bash dry run mutates nothing.
That finding is true and was verified, but Gate A is deleted, so the statement has no consumer left in this document.

B19's premise that "Drive A's interpreter is resolved from the test runner's ambient PATH" is WRONG on Node.
Measured on this platform: `spawnSync("bash", ...)` with an explicit `options.env` resolves `bash` from the CHILD env's PATH, not the parent's, because libuv sets the child environment before `execvp`.
A probe that put a fake `bash` first on the child's PATH ran the fake.
B19's CONCLUSION is still adopted in full, because the environment maps genuinely differ (Drive A spreads `...process.env`, so `HOME` and everything else leak in), and because relying on that resolution rule is a portability landmine nobody should have to know about.
The fix below pins one interpreter explicitly for both drives instead of depending on it.

### Revision 3's twenty-one blockers

Every row was re-verified against the cited code before being adopted; four are rejected or corrected with counter-evidence.

| Finding | Verdict | Where it landed |
| --- | --- | --- |
| R1 `settle_after_stop`'s three lines are unported and GATE 1 pins the settle to 0 | ADOPTED | `restart.ts` gains `info`/`warn`; three builders; a settle scenario pair |
| R2 `restart_session_guard`'s five lines are unported | ADOPTED | `session-guard.ts`'s `guardVerdictLine`, emitted at all five guard sites |
| R3 restart-only never emits the MainPID or start-limit warns | ADOPTED, via R13's fix | they move into `restart.ts`, so all three call sites get them |
| R4 the byte diff is unsatisfiable on readiness-failing scenarios | ADOPTED | DECISION 1, GATE 1: READINESS DETERMINISM |
| R5 artifact 8 cannot observe the wrong-repo-dir defect | ADOPTED, and the audit's own fix REJECTED as also unable to observe it | DECISION 2, GATE 1: WHAT ARTIFACT 8 ACTUALLY OBSERVES |
| R6 Half B's flag renderer returns before it prints | ADOPTED | GATE 2 reads the registry directly, per argument |
| R7 nothing binds `$PIN/deploy-cli` to the tree under review | ADOPTED | GATE 2 preconditions 3 and 4 |
| R8 the `$ENV_FILE` disqualifier is never captured live | ADOPTED | GATE 2 Half A captures the container-side `.env` |
| R9 `--restart-only` is never exercised live | ADOPTED | GATE 2 Half C |
| R10 the forced failure is accepted as a legacy build | ADOPTED | DECISION 3, GATE 2 Half B |
| R11 `trace.log` requires editing a forbidden file | ADOPTED | `bash-fixtures.ts` re-implements `systemctl`/`curl`/`bun` in its own layer |
| R12 duplicate of R4 with the same fix | ADOPTED | folded into DECISION 1 |
| R13 the MainPID and start-limit warns have one printer and three call sites | ADOPTED | `restart.ts` prints them behind an injected `warn` |
| R14 the number-to-string widening list is incomplete | ADOPTED | exhaustive consumer list under EDITS TO EXISTING FILES |
| R15 `run-update.ts`'s own call sites take real-IO defaults | ADOPTED | `UpdateIo` gains `isReadableFile`; all three call sites spelled out |
| R16 `bunBin` has no provenance and no failure path | ADOPTED | `run-update.ts` step 7a, the `findBun` adapter |
| R17 a file under `src/update/` calls `process.exit` while the grep bans it | ADOPTED | `update-command.ts` moves to `src/update-command.ts` |
| R18 the ten steps never build `UpdateFlowDeps` | ADOPTED | steps 7a and 9a |
| R19 the `incusRepinArgv` source oracle is unimplementable as written | ADOPTED | an explicit extraction rule, plus the type/comment contradiction fixed |
| R20 `terminals.ts` imports a type it says it does not import | ADOPTED | the sentence is corrected |
| R21 removing `LUNA_TEST_WS_COUNT` from the shared default breaks three green suites | ADOPTED | the removal is scoped to `driveEnv` only |

### Revision 3's concerns, and the four findings I reject

Concerns 1 through 5, 7 through 21 and 23 are adopted and land where the text below says.
Four claims are rejected or corrected, with my own evidence rather than silent compliance.

Concern 22 says `probes.ts`'s `curlMaxTime` field is at `:197`, not `:196`.
It is at `:196`: `probes.ts:196` is `  readonly curlMaxTime: string` and `:197` is `  readonly runTargetCapture: RunTargetCapture`.
Revision 2's citation was right and is kept.

Concern 6 says `main.ts`'s raw-argv preamble begins at `:57`, quoting `const rawArgs = process.argv.slice(2)` as line 57.
That statement is on line 58, and concern 22 says `:58` for the same thing, so the two concerns contradict each other.
The correct span is `main.ts:58-67`, and every citation in this document is updated to it.

R5's proposed fix is rejected even though R5's problem statement is adopted.
The audit proposes planting an executable under `<work>/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude` so the `find` branch of `luna_find_claude_executable` answers with a `repo_dir`-rooted path.
That would still not distinguish `repoDir` from `hostRepoDir`, because `scripts/luna-update-server:318-320` sets `HOST_REPO_DIR="$REPO_DIR"` and `CONTAINER_REPO_DIR="$REPO_DIR"` on EVERY bare-host run, in production as well as in the fixture, and `:1221` routes an incus target to the container arm which never touches `repoDir` at all.
The three values are equal by construction on the only arm that reads `repoDir`, so no fixture and no host can make the defect observable.
See GATE 1: WHAT ARTIFACT 8 ACTUALLY OBSERVES for what replaces the credit.

R3's fix is rejected in favour of R13's.
R3 asks for a second copy of the MainPID and start-limit emission block inside `restart-only.ts`.
Bash emits those lines from INSIDE `restart_service` (`:1559`, `:1563`) and `sup_start` (`:1375`), which has three callers (`:1894` restart-only, `:2056` the forward restart, `:1824` the rollback restart), so a per-caller copy is three copies of one bash function's output and will drift.
One injected `warn` on `RestartServiceOptions` covers all three call sites and is the fix revision 2 already named as the fallback in UNCERTAINTY 1.

## Which design was picked, and why

The spine is the **thin orchestrator**: `update-flow.ts` is a single top-to-bottom synchronous function that reads as a line-for-line transcript of `scripts/luna-update-server:1871-2086`, with every subprocess, clock and writer injected, every decision delegated to a module that already owns it, and a bash line reference on every branch.
It wins because the bash tail is simultaneously the specification, the oracle and the thing an operator greps at 3am, so a port that preserves its shape is the only one whose correctness a reviewer can check by reading two files side by side.
The explicit-state-machine alternative names its own fatal risk honestly: modelling `--restart-only` as a sibling machine looks symmetric, reviews cleanly, passes every test anyone would naturally write, and silently deletes the `:1889-1913` fallthrough that lets a repair-rung invocation finish a pending transaction.

Three grafts from the other two designs are taken whole because each one closes a hole the spine leaves open.
From the explicit-machine design I take **`terminals.ts`**: a closed union of terminal outcomes with two total lookup tables over it (exit code, journal disposition), which turns "exit 3 is never conflated with exit 4" and "the journal is never cleared on a deferred or CRITICAL path" from a code review of eight scattered branches into two properties a pure test asserts in milliseconds.
From the one-argv-vocabulary design I take **`runUpdate(rawArgv, seams): number`** as the single in-process entry that never calls `process.exit`.
From the same design I take **`commands.ts`** as the one place every mutating argv is built, so the argv the live path issues and the argv a test asserts are the same bytes by construction rather than by transcription.

Three ideas are explicitly rejected and the rejections are load-bearing: the state-machine driver loop (it hides the restart-only fallthrough), `flow-lines.ts` being used as a proof oracle rather than as documentation (a human transcribing bash into a constants file and then asserting the constants against the transcription proves nothing), and `plan.ts` (a hand-ported native re-implementation of bash's dry-run prose block whose only consumer would be a test, discussed in full under THE ACCEPTANCE GATE).

## Files that must not be edited

`scripts/luna-update-server` is the live default engine AND the parity oracle, and a port cannot be proven against an oracle it mutated.
`test/helpers/update-server-fixtures.ts` is load-bearing for the 273-test hostenv suite.
Both must show zero lines changed in `git diff --stat` at review time.
Every new fixture behaviour goes into `apps/deploy-cli/test/update/bash-fixtures.ts`, which already layers replacement stubs into the bin dir `makeStubBin` returned.

## Scope: what the binary owns

`config.ts`'s `delegationFor` (verified at `apps/deploy-cli/src/update/config.ts:271-277`) returns non-null, and the whole run is handed to `$LUNA_DEPLOY_BASH_ENGINE`, for exactly four conditions checked in this fixed order: `layout !== "inplace"`, `supervisor !== "systemd"`, `systemdUser`, `dryRun`.
`--materialize` has no branch because validation already rejects it off the releases layout, so it can only reach `delegationFor` with `layout === "releases"`, which the first branch catches.
Everything else is owned by the binary, including `--incus`, `--restart-only`, `--no-rollback`, `--operator-override` and `--ref`.
So this PR implements the inplace-on-systemd transaction for both bare-host and incus targets, and implements nothing whatsoever from the releases layout.
`materialize_release`, `flip_current`, `prune_releases`, `do_rollback_releases`, `repin_claude_releases`, `deployed_sha` and `mirror_lock_blob` are out of scope and must not be ported, stubbed or referenced.
`status-file.ts`, `health-journal.ts` and `atomic-replace.ts` are also out of scope: the first two are guardian ports that stay bash-only until S24, and the third is the releases-layout symlink flip primitive.

## The exit code contract

Verified by direct reading of `scripts/luna-update-server:1871-2086`.
These five codes are a contract with `packages/server-registry/src/driver/luna-chat-server.ts`, `scripts/luna-autodeploy`'s rc `case` (`:539-560` for deploy, `:619-623` for repair), and an operator's shell.

| Code | Meaning | `exit` statements in bash |
| --- | --- | --- |
| 0 | Healthy update, or restart-only success, or a benign lock-contention defer in normal mode | :2083, :1908, :1880 |
| 1 | Rolled back successfully, or restart-only restart/readiness failure with no rollback attempted, or any `luna_die` preflight refusal, or `fail_forward` under `--no-rollback` | :1841, :1896, :1911, :1866 |
| 2 | Corrupt journal, or rollback itself failed | :1926, :1857 |
| 3 | Deferred by the session guard, at four distinct sites plus restart-only's own | :2000, :1950, :2059, :1831, :1895 |
| 4 | Lock contention, `--restart-only` only | :1879 |

Conflating 3 and 4 is the specific failure the bash comment at :1872-1878 exists to prevent: it makes a responder diagnose "live sessions" when the real cause is a concurrent update holding the profile lock.
The binary must branch `restartOnly` BEFORE deciding the lock-contention exit code, not use one constant.

## THE ARGV CONTRACT

This is the fix for B1 and B7, and it is the first thing an implementer must get right, because as previously specified every single invocation died with `error: unknown option: update` and exit 1 before anything ran.

Two argv shapes exist, they are different, and both are needed.

`rawArgv` is `process.argv.slice(2)`: the `update` subcommand token AND everything after it.
`scripts/luna-autodeploy:136` proves the token is always present on the live path, because `luna_select_engine` prints `<cli>` and `update` as a two-line argv prefix and `:538` execs that prefix followed by the flags.
`delegate.ts:244` types `rawArgs` as exactly this shape, and `delegate.ts:207-215` THROWS unless the first non-flag token is literally `update`.

`flagArgv` is the flags AFTER the token.
`config.ts:327-328` documents `parseUpdateConfig`'s first parameter as exactly this, and `config.ts:546-547` returns `unknown option: update` for any non-flag token in the default arm.

So `run-update.ts` computes both, from one source, using the function that already implements the scan:

```ts
export const runUpdate = (rawArgv: ReadonlyArray<string>, seams: RealSeams): number => {
  const flagArgv = forwardedFlags(rawArgv)   // delegate.ts:207 - throws if the token is absent
  ...
}
```

`forwardedFlags` is reused rather than reimplemented because `main.ts:56`'s preamble computes the same first-non-flag-token scan, and two copies of that scan are two things that can drift.
`parseUpdateConfig(flagArgv, env, seams)` takes THREE parameters (`config.ts:335-339`), not two.
`delegateToBashSync({ flag, rawArgs: rawArgv, ... })` takes the raw form.

`forwardedFlags` throwing is a programmer error, not an operator error, so `runUpdate` does NOT catch it: a caller that reached this binary without the token is a wiring bug in `luna_select_engine`, and it must be loud.
`exit-code-matrix.test.ts` asserts one row for `["update", "--profile", "x", ...]` proving the token is consumed rather than refused, and one row proving `runUpdate(["--profile", "x"])` throws with `forwardedFlags`'s message rather than returning an exit code.

## New source files

All paths are relative to the repository root.

### `apps/deploy-cli/src/update/terminals.ts` (new, ~130 lines, pure)

The exit-code and journal-disposition contract as data, so both are testable as properties rather than as a code review.
NO imports except the `AcquireFailureReason` TYPE from `lock.ts` (`lock.ts:301-309`), which the `lock-unacquirable` arm carries.
Revision 2 said "no imports except types from `journal.ts`", which is wrong twice over and is blocker R20: nothing in the declared surface needs a `journal.ts` type (`JournalDisposition` is declared here, and `TxPhase` never appears), while `AcquireFailureReason` is not declared here and must be imported.
Written literally, revision 2's `terminals.ts` did not compile.

```ts
export type Terminal =
  | { readonly kind: "lock-contention"; readonly restartOnly: boolean }
  | { readonly kind: "lock-unacquirable"; readonly restartOnly: boolean; readonly reason: AcquireFailureReason }
  | { readonly kind: "preflight-refused" }
  | { readonly kind: "config-refused" }
  | { readonly kind: "corrupt-journal" }
  | { readonly kind: "deferred"; readonly site: "fresh-run" | "recovery-resume" | "mid-transaction" | "rollback-restart" | "restart-only" }
  | { readonly kind: "restart-only-ok" }
  | { readonly kind: "restart-only-restart-failed" }
  | { readonly kind: "restart-only-readiness-failed" }
  | { readonly kind: "updated" }
  | { readonly kind: "rolled-back" }
  | { readonly kind: "rollback-failed" }
  | { readonly kind: "forward-failed-no-rollback" }

export type JournalDisposition = "cleared" | "retained" | "untouched"

export const exitCodeFor: (t: Terminal) => 0 | 1 | 2 | 3 | 4
export const journalDispositionFor: (t: Terminal) => JournalDisposition
```

`exitCodeFor` maps both `lock-contention` and `lock-unacquirable` to `restartOnly ? 4 : 0` by DELEGATING to `lock.ts:81-82`'s already-shipped `lockContentionExitCode(restartOnly)`, which is concern 18.
Revision 2 claimed `exitCodeFor` was "the ONLY place in the tree those two numbers are chosen" while `lock.ts:81-82` already chose them; the claim is now true because `terminals.ts` calls that helper instead of re-deciding, and `lock.ts`'s helper is NOT retired, because `lock.ts`'s own module doc cites it as the single copy of bash's `:1872-1881` mapping.
`lock-unacquirable` covers `acquireUpdateLockSync`'s three non-contended failure reasons (`stale-remkdir-failed`, `fingerprint-unavailable`, `ownership-unrecordable`, `lock.ts:301-309`), which bash also treats as `return 1` from `acquire_update_lock` (`:988`, `:992`, `:1000-1006`) and therefore takes the same exit path as contention.
It carries `reason` so an operator log and a test can distinguish "somebody else is deploying" from "this host cannot record its own ownership", which are completely different incidents.
It is CONSTRUCTED, not merely declared: `run-update.ts` step 7 branches on `outcome.reason === "contended"`, which is what closes concerns 7 and 9.

`journalDispositionFor` must return `"cleared"` for exactly `updated` and `rolled-back`, and must never return `"cleared"` for any terminal whose exit code is 2 or 3.
The disposition table is descriptive, not executive: `update-flow.ts` performs the actual clear at bash's own call sites (`:2076`, and `rollback.ts`'s own `clearTransaction` mirroring `:1840`), and the table is asserted against observed behaviour in the parity suite.
That distinction matters, because making the table executive would move the clear away from where bash does it and break recovery.

### `apps/deploy-cli/src/update/commands.ts` (new, ~90 lines, pure)

Every mutating argv the engine can issue, built in exactly one place.
Zero IO, zero branching on `dryRun`, zero knowledge of `TargetContext`.

```ts
/** `git_target fetch origin` (:1175, :1974). Args AFTER git's own -C/--git-dir prefix, which target.ts adds. */
export const gitFetchOriginArgs: ReadonlyArray<string>            // ["fetch", "origin"]
/** `git_target reset --hard "$target"` (:1177). */
export const gitResetHardArgs: (target: string) => ReadonlyArray<string>
/** `git_target_capture rev-parse HEAD` (:1189, :1964, :2040). */
export const gitRevParseHeadArgs: ReadonlyArray<string>
/** `git_target_capture rev-parse "${ref}^{commit}"` (:1992). */
export const gitRevParseCommitArgs: (ref: string) => ReadonlyArray<string>
/** `git -C <hostRepoDir> hash-object <hostRepoDir>/bun.lock` (:538-544). NOT routed through target.ts's layout-aware git arms: lockfile_hash is a plain host-side `git -C`. */
export const gitHashObjectArgv: (hostRepoDir: string) => ReadonlyArray<string>
/** `run_target "$BUN_BIN" install --cwd "$CONTAINER_REPO_DIR" --frozen-lockfile` (:1206). */
export const bunInstallArgv: (bunBin: string, containerRepoDir: string) => ReadonlyArray<string>
/** `run_target test -d "$CONTAINER_REPO_DIR/node_modules"` (:1210). INCUS ARM ONLY - see apply-inplace step 5. */
export const nodeModulesTestArgv: (containerRepoDir: string) => ReadonlyArray<string>
/** `run_target "$BUN_BIN" run "$script"` (:1719). */
export const bunRunArgv: (bunBin: string, script: string) => ReadonlyArray<string>
/** The `bash -lc` PAYLOAD of the incus claude re-pin, byte-exact (:1237). A single string. */
export const incusRepinPayload: string
/** The argv `runTarget` receives, i.e. exactly `["bash", "-lc", incusRepinPayload]` (:1236-1237). */
export const incusRepinArgv: ReadonlyArray<string>
```

Revision 2 declared one symbol typed `ReadonlyArray<string>` and then described it in its own doc comment as "one string", which is blocker R19's second half.
Two symbols, named for what they are, remove the contradiction: the payload is the string, the argv is the three-element array, and `apply-inplace.ts` step 6 passes the argv.

`incusRepinPayload` must reproduce the bash payload byte for byte, including its hardcoded `/root/luna` and `/root/.luna/.env` and its `exit 9` sentinel.
Do not templatise those paths: bash hardcodes them at `:1237` and no flag reaches them, so a parameterised version would diverge from the oracle on the incus drive.

THE SOURCE ORACLE, stated precisely, which is the first half of blocker R19.
Revision 2 asked `commands.test.ts` to compare the payload against "the bytes read out of `scripts/luna-update-server:1237`", which no correct implementation can pass: that line is a double-quoted bash literal, not the payload.
It carries six characters of leading indentation, an opening and closing `"`, a trailing ` ||`, and three `\$` escapes that bash strips before `bash -lc` ever sees the string.
So the test reads line 1237 and applies EXACTLY this extraction, in this order, with the rule written into the test as a comment:
strip leading whitespace; strip the trailing ` ||`; assert the remainder starts and ends with `"` and strip both; replace every `\$` with `$`.
No other unescaping is applied, and the test asserts that no other backslash remains, so a future edit to `:1237` that introduces `\"` or `\\` fails the test loudly instead of being silently mis-extracted.
The literal in `commands.ts` still carries a comment naming `:1236-1237`, so a reader never has to run the test to find the source.

### `apps/deploy-cli/src/update/flow-lines.ts` (new, ~90 lines, pure)

Every operator-facing string the orchestration tail emits, plus the six `restart.ts` now emits, as pure builders with a bash line reference on each.
`restart.ts` imports its six from here rather than declaring its own, so there is one file to diff against the bash when a string changes; a PR1 primitive importing a PR2 constants file is acceptable because the dependency is on data, is acyclic, and `flow-lines.ts` imports nothing.
The five session-guard lines are the exception: they live in `session-guard.ts` beside the already-shipped `operatorOverrideLogLine`, as the single `guardVerdictLine` function, because only that module can map the verdict union exhaustively.
This file exists to keep `update-flow.ts` literal-free and greppable, NOT to prove anything.
Its own unit tests are documentation; the proof is the stdout/stderr byte diff in the dual-drive suite.

Each builder returns the PAYLOAD only, without the `-> ` / `warning: ` / `error: ` prefix, matching how `rollback.ts`, `lock.ts` and `preflight.ts` already draw that line.
The one exception is `corruptJournalLine`, documented below, which is a raw `printf` in bash and carries no prefix at all.

### `apps/deploy-cli/src/update/numbers.ts` (new, ~80 lines, pure)

The `string` to `number` seam that `config.ts` deliberately refuses to own (see its header at `config.ts:52-58`).

THE RULE, decided here once and applied everywhere: a config value that reaches an OPERATOR-VISIBLE surface keeps its raw string spelling; only a value that needs ARITHMETIC is converted.
This is the resolution of concerns 5, 15 and 23, and it deletes the `readinessPort` refusal the previous revision proposed.
`probes.ts:196`'s `curlMaxTime` already follows this rule, with the reasoning written out in its own doc comment; the port simply stops making an exception of the other two.

```ts
export type NumbersOutcome =
  | { readonly ok: true; readonly value: ResolvedNumbers }
  | { readonly ok: false; readonly message: string }

export interface ResolvedNumbers {
  /** For `readiness_ok`'s deadline arithmetic (:1071). */
  readonly readinessTimeoutSecs: number
  /** The SAME value as written by the operator, for readinessGaveUpLine (:1124), which interpolates `${READINESS_TIMEOUT}` raw. */
  readonly readinessTimeoutRaw: string
  /** For the poll sleep (:1122). */
  readonly readinessIntervalSecs: number
}

export const resolveNumbers: (config: UpdateConfig) => NumbersOutcome
```

`readinessPort`, `readinessCurlMaxTime` and `restartSettleSecs` do NOT appear here at all: after the widening described under EDITS TO EXISTING FILES they travel as the strings `config.ts` already holds, straight from `UpdateConfig` into the argv builders.

Rules, each derived from how bash actually consumes the value:

`readinessTimeoutSecs` is INTEGER-ONLY.
Accept `^[0-9]+$`, convert with `Number`, and keep the original in `readinessTimeoutRaw`.
`007` is therefore accepted, converts to `7`, and still prints as `007` in the give-up line, which is what bash does.

`readinessIntervalSecs` accepts a FRACTIONAL value, because bash passes it straight to `sleep "$READINESS_INTERVAL"` (`:1122`) and the existing fixture already uses `--readiness-interval 0.3`.
Accept `^[0-9]+(\.[0-9]+)?$` and convert with `Number`.

Any rejection returns `ok: false` with a message; `run-update.ts` turns it into a `luna_die`-shaped stderr line and returns 1, and does so BEFORE the lock is acquired.
This is a real divergence from bash and it is documented in full under KNOWN DIVERGENCES, with the measured bash behaviour rather than a guess.

### `apps/deploy-cli/src/update/apply-inplace.ts` (new, ~220 lines)

The port of `apply_ref_inplace` (`scripts/luna-update-server:1169-1254`).
This is the one file in the repo that contains the string `reset --hard`, and it is the only module in this PR doing destructive work rather than orchestrating already-proven primitives.
The slice spec grants it an explicit abandon condition; see ABANDON CONDITIONS.

```ts
export interface ApplyInplaceOptions {
  /** The target ref, 7-64 hex OR a resolved sha; passed to `git reset --hard` verbatim. */
  readonly target: string
  /** The lockfile hash to compare against. On the rollback call site this is computed FRESH at call time, not carried from before the forward attempt (:1821). */
  readonly prevLockHash: string
  /** `no_fetch="${3:-}"`. True means the third bash argument was "--no-fetch". Both real call sites pass true. */
  readonly noFetch: boolean
  /** `TRANSACTION_TRACK_APPLY`. Passed explicitly per call, NEVER a module global. */
  readonly trackApply: boolean

  readonly incusContainer: string
  readonly bunBin: string
  readonly containerRepoDir: string
  /** $ENV_FILE - the HOST arm's .env ($LUNA_HOME/.env, :342). */
  readonly envFile: string
  /** $REPO_DIR VERBATIM (:1245), NOT hostRepoDir and NOT containerRepoDir. See THE REPO-DIR AXES below for what this can and cannot be proven against. */
  readonly repoDir: string
  /** Always false in practice - config.ts:271-277 delegates the whole run under --dry-run, so apply-inplace is unreachable with it set. Carried anyway because ConfigureClaudeRequest requires it (bash-lib.ts:271-278) and a hardcoded `false` at the call site would be a second place to fix if delegation ever narrows. This is concern 20. */
  readonly dryRun: boolean

  readonly gitTarget: (args: ReadonlyArray<string>) => CommandResult
  readonly gitTargetCapture: (args: ReadonlyArray<string>) => CommandResult
  readonly runTarget: (argv: ReadonlyArray<string>) => CommandResult
  readonly lockfileHash: () => string
  /**
   * `write_transaction "checkout" || return 1` (:1195-1196). Returns false on a failed journal write, which fails the whole apply.
   * WHERE THE FALSE COMES FROM, which is concern 17: `journal.ts:96-106`'s writeTransactionSync returns void and THROWS on a failed atomic write, so `wiring.ts` builds this seam as a try/catch that returns true on a normal return and false on any throw.
   * That is the whole derivation.
   * CORRECTED IN PHASE 2 (this sentence previously read "nothing else in the tree may catch that throw, because every other journal write in this flow is one bash performs unguarded", which is FALSE and produced a real defect).
   * bash guards three of them: `write_transaction "rolling-back" || true` (:1816), `write_transaction "rollback-failed" || true` (:1856) and `write_transaction "forward-failed" || true` (:1865), plus the releases-layout trio at :1749, :1756 and :1789 that this binary delegates.
   * Only :2002, :2043, :2045 and :2071 are bare, and only :1165/:1196 are `|| return 1`.
   * So `wiring.ts` binds `rollback.ts`'s one-parameter `writeTransaction` seam - the seam ALL THREE guarded writes reach - inside a try/catch that swallows and prints nothing, exactly as `|| true` does; leaving it bare loses exit 2 on the CRITICAL path, which is the whole exit-code contract, on a full or read-only state dir.
   * The two-parameter `writeTransaction` seam, which carries the four bare writes, still lets the throw escape: under `set -euo pipefail` an unguarded failure aborts the bash run.
   */
  readonly onCheckout: () => boolean
  /** `[[ -d <path> ]]` on the HOST, used only on the bare-host arm of step 5. */
  readonly dirExists: (path: string) => boolean
  /** bash-lib.ts's configureClaudeExecutable, host arm only. */
  readonly configureClaudeExecutable: (req: ConfigureClaudeRequest) => ConfigureClaudeResult
  /** bash-lib.ts's envValue, host arm only. */
  readonly envValue: (envFile: string, key: string) => EnvValueResult
  /** `command -v claude` on the HOST, host arm only. A PATH walk, NEVER a spawn - see below. */
  readonly commandExists: (name: string) => boolean
  /** `[[ -x <path> ]]`. */
  readonly isExecutable: (path: string) => boolean

  readonly info: (line: string) => void
  readonly warn: (line: string) => void
  /** RAW passthrough for a sub-helper's own bytes; see step 6. */
  readonly writeStdout: (text: string) => void
  readonly writeStderr: (text: string) => void
}

export type ApplyInplaceOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly step: "fetch" | "reset" | "head-postcondition" | "checkout-journal" | "bun-install" | "node-modules" | "claude-repin" }

export const applyInplaceSync: (opts: ApplyInplaceOptions) => ApplyInplaceOutcome
```

Steps, in bash's exact order, each failing the whole function:

1. If `!noFetch`, run `gitTarget(gitFetchOriginArgs)`; non-zero fails (`:1172-1174`).
   This branch is UNREACHABLE from both real call sites (`:1821` and `:2020` both pass `--no-fetch`) and therefore gets no coverage from the dual-drive diff; it needs its own unit test.
2. `gitTarget(gitResetHardArgs(target))`; non-zero fails (`:1177`).
3. HEAD postcondition (`:1188-1194`).
   Read `gitTargetCapture(gitRevParseHeadArgs)`, strip trailing newlines, lowercase both it and `target`, and fail unless the head is non-empty AND either string is a prefix of the other.
   A strict equality check here false-fails and triggers a rollback on every abbreviated or uppercase `--ref` even though the reset succeeded, because bash's `--ref` validation passes 7-64 hex through verbatim on the inplace layout (`:1991-1992`) while `rev-parse HEAD` always answers full lowercase 40.
   On failure emit the byte-exact POSTCONDITION warn (table below).
4. If `trackApply`, call `onCheckout()`; a `false` return fails with step `"checkout-journal"` (`:1195-1196`).
5. Lockfile gate (`:1199-1216`).
   `const newLockHash = lockfileHash()`.
   If it differs from `prevLockHash`, emit `bun.lock changed -> bun install --frozen-lockfile`, run `runTarget(bunInstallArgv(bunBin, containerRepoDir))` and fail on non-zero, then evaluate the node_modules postcondition and fail with the byte-exact warn if it does not hold.
   If it matches, emit `bun.lock unchanged -> skipping bun install` and run NOTHING.
   THE NODE_MODULES POSTCONDITION IS ARM-SPECIFIC, and this is the resolution of concern 25.
   On the INCUS arm (`incusContainer !== ""`) bash's `run_target test -d ...` really does spawn an external `test` binary inside the container through `incus exec`, so the port issues the identical argv through `runTarget(nodeModulesTestArgv(containerRepoDir))` and the two engines produce the same `incus.log` and `trace.log` lines.
   On the BARE-HOST arm bash's `run_target` degenerates to running `test -d` in the engine's own shell, where `test` is a BUILTIN and no process is created at all, so the port evaluates `dirExists(containerRepoDir + "/node_modules")` natively.
   Spawning `/usr/bin/test` there would be an unstated portability assumption about a minimal host, and it would add a process to `trace.log` that bash never creates.
6. Claude re-pin, ARM FOR ARM, NOT UNIFIED (`:1221-1252`).
   Incus arm (`incusContainer !== ""`): `runTarget(incusRepinArgv)`, three-way outcome - status 9 emits the degraded warn and CONTINUES (`:1239-1240`), any other non-zero fails (`:1241-1242`), 0 succeeds.
   Host arm (`:1245-1251`): call `configureClaudeExecutable({ envFile, repoDir, dryRun })`, write `result.stdout` to `writeStdout` and `result.stderr` to `writeStderr` VERBATIM before branching, then fail on `!result.ok`.
   The forwarding is not optional: `scripts/lib/luna-deploy.sh:139` emits `warning: removing stale LUNA_CLAUDE_CODE_EXECUTABLE (<path> is not executable)` from inside the helper, `bash-lib.ts:264-269` captures it, and `bash-lib.ts:257-262` says in so many words that it is carried "so the caller can forward the bytes instead of reconstructing them".
   Without the forwarding the stale-pin scenario shows that line on the bash drive and nothing on the binary drive.
   Then a SEPARATE warn-only degrade check (`:1247-1251`): read `envValue(envFile, "LUNA_CLAUDE_CODE_EXECUTABLE")`, and if the value is empty or not executable AND `commandExists("claude")` is false, emit the same degraded warn and continue.
   Note the host arm passes `repoDir` (bash's `$REPO_DIR`), not `hostRepoDir` and not `containerRepoDir`.
   Revision 2 called this "the single easiest thing to get wrong in the whole PR" and credited GATE 1's `$ENV_FILE` artifact with catching it; both statements are withdrawn, and the reason is THE REPO-DIR AXES, below.

THE REPO-DIR AXES, and which of them anything can observe.
There are two independent distinctions hiding under "the three-way repo-dir mapping", they have completely different observability, and revision 2 conflated them.

The FIRST axis is `hostRepoDir` versus `containerRepoDir`, and it is real, load-bearing and directly observable.
`scripts/luna-update-server:305-313` sets `HOST_REPO_DIR` to the host bind-mount source and `CONTAINER_REPO_DIR` to `/root/luna` whenever `INCUS_CONTAINER` is non-empty, so the two genuinely differ on every incus target, including the fixture's incus topology.
Every `git` call takes `hostRepoDir` (`git_target_capture` is a bare `git -C "$HOST_REPO_DIR"`, `:392-398`) and every `bun`, `systemctl` and node_modules call takes `containerRepoDir` (`:1206`, `:1210`).
GATE 1 observes this axis directly on the incus topology, because `git.log` records host paths and `bun.log` plus `incus.log` record container paths; swapping the two changes those bytes.
This is asserted as an explicit GATE 1 row, not left to chance.

The SECOND axis is `repoDir` versus `hostRepoDir`, and NOTHING can observe it, on any host or in any fixture.
`repoDir` has exactly one consumer, the host claude re-pin at `:1245`, which sits in the `else` of `if [[ -n "$INCUS_CONTAINER" ]]` at `:1221` and therefore runs ONLY on a bare-host target.
On a bare-host target `scripts/luna-update-server:318-320` sets `HOST_REPO_DIR="$REPO_DIR"` and `CONTAINER_REPO_DIR="$REPO_DIR"` unconditionally, in production exactly as in the fixture.
So on the only arm that reads `repoDir`, all three values are the same string by construction, and passing the wrong one is a distinction without a difference.
The releases layout is the only place they diverge (`:333` repoints `HOST_REPO_DIR` at `$CURRENT_LINK`), and the releases layout is delegated and out of scope for this PR.
The field therefore stays separate and named for its bash source, so that a future slice which does fold in the releases layout inherits the correct wiring rather than a coincidence, but it earns NO test credit and NO gate credit, and this document no longer claims otherwise.

`commandExists` MUST NOT be `spawnSync("command", ["-v", name])`: `command` is a shell builtin and that spawn fails with ENOENT on every platform.
It is implemented in `wiring.ts` as a walk of `seams.env.PATH` split on the platform path delimiter, testing each candidate with `accessSync(candidate, X_OK)` and a regular-file check.
The one behaviour this cannot reproduce is bash's `command -v` also matching a shell function or alias, which cannot exist in the non-interactive engine context this runs in; that is stated here rather than discovered later.

`lockfileHash` must reproduce BOTH of bash's arms (`:538-544`), which is concerns 16 and 24: when `$HOST_REPO_DIR/bun.lock` does not exist it returns the EMPTY STRING without ever invoking git, and when `git hash-object` fails it also returns the empty string (bash's `|| printf ''`).
It must never throw and must never return an error sentinel, because both arms feed a plain string comparison that decides whether `bun install` runs.
It must use `git hash-object` blob-id semantics through `commands.gitHashObjectArgv`, never a generic sha256 or md5 of the file, or the value will diverge from the journal's persisted `prev_lock_hash` on every run.

### `apps/deploy-cli/src/update/fresh-run.ts` (new, ~130 lines)

The no-journal prologue (`:1954-2003`), stopping deliberately BEFORE the session guard so the orchestrator shows the guard-then-first-journal-write ordering explicitly.

```ts
export interface FreshRunOptions {
  readonly hostRepoDir: string
  /** `--ref` as resolved by preflight; the REQUESTED_REF. */
  readonly requestedRef: string
  readonly gitTarget: (args: ReadonlyArray<string>) => CommandResult
  readonly gitTargetCapture: (args: ReadonlyArray<string>) => CommandResult
  readonly lockfileHash: () => string
  readonly info: (line: string) => void
}

export type FreshRunOutcome =
  | { readonly ok: true; readonly prev: string; readonly ref: string; readonly prevLockHash: string }
  | { readonly ok: false; readonly message: string }   // caller emits `error: <message>` and returns 1

export const freshRunSync: (opts: FreshRunOptions) => FreshRunOutcome
```

Order, which is load-bearing:

1. `prev = gitTargetCapture(gitRevParseHeadArgs)` with trailing newlines stripped; empty fails with `could not read current HEAD in ${hostRepoDir}` (`:1964-1965`).
2. `prevLockHash = lockfileHash()` (`:1966`).
3. Emit `Current HEAD: ${prev}` through `info` (`:1967`).
4. `gitTarget(gitFetchOriginArgs)`; non-zero fails with `fetch failed before update; checkout unchanged` (`:1974`).
5. Resolve `ref`: if `requestedRef` matches `^[0-9a-fA-F]{7,64}$`, use it VERBATIM with no normalisation (`:1989-1990`); otherwise `gitTargetCapture(gitRevParseCommitArgs(requestedRef))` with trailing newlines stripped (`:1992`).
6. Validate the result against `^[0-9a-fA-F]{7,64}$`; failure fails with `could not resolve target ref ${requestedRef}` (`:1994`).

Also export the two helpers the rollback path and the apply gate both need, so they have one implementation:

```ts
export const readHeadSync: (gitTargetCapture: (args: ReadonlyArray<string>) => CommandResult) => string
export const lockfileHashSync: (hostRepoDir: string, fileExists: (p: string) => boolean, spawn: SpawnTarget) => string
```

`lockfileHashSync` takes `fileExists` because of the missing-file arm above; it must not call `statSync` itself, so that the in-process no-ambient-IO test can reach it.

### `apps/deploy-cli/src/update/restart-only.ts` (new, ~80 lines)

Repair-ladder rung 1 (`:1883-1913`).
Its options type contains NO journal seam at all, so "rung 1 never writes a transaction" is unrepresentable rather than merely reviewed.

```ts
export interface RestartOnlyOptions {
  readonly serviceName: string
  readonly restart: () => RestartOutcome
  readonly readinessBaseline: () => number
  readonly readiness: (req: {
    readonly expectedBuildSha: string
    readonly allowMissingBuildSha: boolean
    readonly baseline: number
  }) => ReadinessResult
  readonly readHead: () => string
  readonly info: (line: string) => void
  readonly warn: (line: string) => void
}

export type RestartOnlyOutcome =
  | { readonly kind: "terminal"; readonly terminal: Terminal }
```

Steps:

1. `restart()` (`:1893-1894`).
   If code 3, terminal `deferred{site:"restart-only"}` (exit 3), with NO warn line FROM THIS MODULE, matching bash's bare `exit 3` at `:1895`.
   The guard's own deferral warn is not silent: it is emitted from inside `restart.ts`, exactly where bash emits it from inside `restart_session_guard`, which is the R2/R13 fix.
2. If code non-zero, emit the byte-exact restart-errored warn and return terminal `restart-only-restart-failed` (exit 1) (`:1896`).
   This module prints NEITHER the start-limit warn NOR either MainPID warn, and that is deliberate: bash emits all three from inside `restart_service`/`sup_start`, so `restart.ts` owns them for all three of its callers.
   Revision 2 put them in `update-flow.ts`, which restart-only never runs, so `--restart-only` against a unit whose stop silently failed printed the POSTCONDITION warn on bash and nothing on the binary.
   That was blocker R3, and it is fixed by R13's change rather than by a second copy here.
3. `baseline = readinessBaseline()` (`:1897`).
4. `expectedBuildSha = readHead()` (`:1904`, the inplace arm only; the releases `deployed_sha` arm at `:1899-1902` is out of scope).
   Revision 2 cited `:1903`, which is the `else` keyword; corrected per concern 22.
5. `readiness({ expectedBuildSha, allowMissingBuildSha: false, baseline })` (`:1906`).
   PASSING `baseline` IS MANDATORY, and its omission was blocker B4/B8: `readiness.ts:91` makes it a required field and `readiness.ts:154-155` is the crash-loop rung that compares against it, so a dropped baseline silently deletes the one signal that distinguishes a healthy unit from one crash-looping into a 200 served by the outgoing process.
   On success emit `restart-only: ${serviceName} healthy at ${expectedBuildSha.slice(0,12)}` and terminal `restart-only-ok` (exit 0) (`:1907-1908`).
   On failure emit `readinessGaveUpLine` then the byte-exact restart-only readiness warn, terminal `restart-only-readiness-failed` (exit 1) (`:1910-1911`).

The `ALLOW_MISSING_BUILD_SHA` stays false here on purpose: a build that cannot identify itself must fail rung 1 so the ladder escalates to rung 2.

Note the baseline is captured BEFORE the SHA is resolved, matching `:1897` and `:1904`.
The previous revision justified that ordering with a claim that the SHA read is "an extra subprocess on the incus drive"; THAT CLAIM IS FALSE and concern 2 was right to flag it.
`git` ALWAYS runs on the host in both topologies: `git_target_capture` is a bare `git -C "$HOST_REPO_DIR"` with no `run_target` and no `incus exec`, stated in the comment at `:373-383` and implemented at `:392-398`.
The real reason the ordering matters is simpler and still binding: `readiness_restart_baseline` reads `NRestarts` through `sup_restart_count`, which IS a systemctl call, so swapping the two lines changes the order of entries in `systemctl.log` and in the shared `trace.log`, and GATE 1 diffs both.

### `apps/deploy-cli/src/update/update-flow.ts` (new, ~300 lines)

The assembly.
Imports no `node:child_process`, no `node:fs`, contains no string literals other than journal phase names, calls no `process.exit`, and performs no arithmetic on config values.
Every branch carries its bash line number in a comment.

```ts
export interface UpdateFlowDeps {
  readonly restartOnly: boolean
  readonly serviceName: string
  readonly requestedRef: string

  readonly info: (line: string) => void
  readonly warn: (line: string) => void
  /** RAW stderr, no prefix. Used for exactly one line: the corrupt-journal printf at :1925. */
  readonly writeStderrRaw: (text: string) => void

  readonly journalExists: () => boolean
  /** Called ONLY when journalExists() is true. "corrupt" covers both an unreadable journal and an unparsable one - see below. */
  readonly loadTransaction: () => Transaction | "corrupt"
  readonly writeTransaction: (phase: TxPhase, fields: { prev: string; target: string; prevLockHash: string }) => void
  readonly clearTransaction: () => void
  readonly journalPath: string

  readonly guard: () => GuardVerdict
  readonly restart: (guardSessions: boolean) => RestartOutcome
  readonly readinessBaseline: () => number
  readonly readiness: (req: { expectedBuildSha: string; allowMissingBuildSha: boolean; baseline: number }) => ReadinessResult

  readonly applyRef: (target: string, prevLockHash: string, trackApply: boolean) => boolean
  readonly readHead: () => string
  readonly freshRun: () => FreshRunOutcome
  readonly seedDreamWakeJobs: () => void

  /** `fail_forward` (:1861-1869). wiring.ts binds every RollbackOptions field this flow cannot see. */
  readonly failForward: (args: {
    reason: string
    ref: string
    prev: string
    newHead: string | null
    forwardRestartRan: boolean
  }) => FailForwardOutcome
  /** `do_rollback` reached directly from journal recovery (:1934-1938), never through fail_forward. */
  readonly rollback: (args: { ref: string; prev: string; forwardRestartRan: boolean }) => RollbackOutcome
}

export const runUpdateFlowSync: (deps: UpdateFlowDeps) => Terminal
```

It returns a `Terminal`, never an exit code, so `run-update.ts` is the only thing that consults `exitCodeFor`.

THE `loadTransaction` SEAM IS `Transaction | "corrupt"`, WITH NO `undefined` ARM, and this is the fix for blocker B2 and concern 13.
`journal.ts:150-186` returns `undefined` ONLY on ENOENT and THROWS `CorruptJournalError` for every other failure, which is the opposite of what the previous revision told the implementer; left uncorrected, the throw escapes `run-update.ts`'s `try/finally`, exits 1 with a stack trace, and loses both exit code 2 and the byte-exact CRITICAL line.
Neither auditor's suggested fix is quite right either.
B2 proposed collapsing everything to `undefined`; concern 13 objected that this erases journal.ts's deliberate three-state contract and worried that a journal vanishing between `journalExists()` and `loadTransaction()` would make the binary exit 2 where bash takes the fresh path.
The worry is unfounded: bash's `load_transaction` begins with `[[ -r "$UPDATE_JOURNAL" ]] || return 1` at `:1029`, so a journal that vanishes after the `[[ -f ]]` test at `:1923` makes BASH print CRITICAL and exit 2 as well.
The two-state seam encodes exactly that: `wiring.ts` calls `loadTransactionSync`, maps a caught `CorruptJournalError` to `"corrupt"`, maps a returned `undefined` to `"corrupt"` as well (with a comment naming `:1029` as the reason), and never surfaces a third state to the flow, which is only ever reached behind `journalExists()`.
`journal.ts` itself is NOT weakened; its three-state contract stays intact for every other caller.

### `apps/deploy-cli/src/update/wiring.ts` (new, ~280 lines)

The composition root, and the ONLY new file permitted to touch real IO.
Builds `UpdateFlowDeps` from `UpdateConfig` + resolved `BashLib` + `ResolvedNumbers` + `UpdateIo`.

```ts
export interface RealSeams {
  readonly env: Readonly<Record<string, string | undefined>>
  /** RAW writers. They receive text VERBATIM, including any newline; nothing here appends one. */
  readonly writeStdout: (text: string) => void
  readonly writeStderr: (text: string) => void
  /** REQUIRED. Every real-IO boundary the run can reach, in one record. See INJECTED VERSUS REAL. */
  readonly io: UpdateIo
}

export const buildTargetContext: (config: UpdateConfig, seams: RealSeams) => TargetContext
export const buildFlowDeps: (args: {
  config: UpdateConfig
  numbers: ResolvedNumbers
  bashLib: BashLib
  bunBin: string
  /** Preflight's RESOLVED --ref, never the transaction target; see run-update.ts step 9a. */
  requestedRef: string
  seams: RealSeams
}) => UpdateFlowDeps
```

What `wiring.ts` owns, and the trap each one closes.

NEWLINE OWNERSHIP, decided once here, which is concern 12.
`RealSeams.writeStdout` and `RealSeams.writeStderr` are RAW: they write their argument verbatim and append nothing.
`info` is `(line) => writeStdout("-> " + line + "\n")` and `warn` is `(line) => writeStderr("warning: " + line + "\n")`, matching `scripts/lib/luna-deploy.sh:4-5`.
`delegate.ts:245-246` types its own `writeStderr` as "A line, WITHOUT its newline", so `wiring.ts` hands delegation the ADAPTER `(line) => writeStderr(line + "\n")`, never the raw writer; handing it the raw writer leaves the `DELEGATED to bash engine: <flag>` marker unterminated.
`preflight.ts:172-173` types its `print` as "One fully-formed stdout line, newline excluded", and `preflight.ts:119-147` already applies `-> ` to the FIRST banner line only (`infoLine`, `preflight.ts:68`) while leaving the rest bare, mirroring bash where `:422` is `luna_info` and `:424-440` plus `Target ref:` at `:521` are bare `printf`.
So preflight's `print` is `(line) => writeStdout(line + "\n")`, the RAW writer plus a newline, NEVER `info`.
Passing `info` there double-prefixes four stdout lines and fails the very first bytes of the GATE 1 diff, which was blocker B12.

THE THREE-WAY REPO-DIR MAPPING: `hostRepoDir` for every git call, `containerRepoDir` for bun and systemctl and the node_modules test, and `repoDir` VERBATIM for the host claude re-pin (`:1245`).
Getting the first two the wrong way round IS observable and GATE 1 asserts it on the incus topology, from `git.log` against `bun.log` and `incus.log`.
Getting the third wrong is NOT observable anywhere; revision 2 claimed `$ENV_FILE` caught it and that claim is withdrawn under DECISION 2, with the evidence under THE REPO-DIR AXES in `apply-inplace.ts`.
`wiring.test.ts` asserts the third against a synthetic config, as documentation of intent for a future releases-layout fold, and the assertion's comment says exactly that.

THE STANDALONE SESSION GUARD, which is blocker B13.
`session-guard.ts:117-127` documents that its is-active FALLBACK is host-scoped even for a container target, because bash's own fallback routes through `run_target_capture` (`:365-371`), which execs inside the container.
`restartServiceSync` closes that gap for itself by injecting a `runSystemctl`-routed `readUnitState` (`restart.ts:175`; revision 2 cited `:180-186`, corrected per concern 22), but `UpdateFlowDeps.guard` is exactly the standalone use the doc warns about, and it is called at the fresh-run and recovery-resume sites in both topologies.
So `wiring.ts` builds the standalone guard's `SessionGuardOptions` with BOTH `incusContainer` (from config) AND `readUnitState`, pointing `readUnitState` at the same target-routed runner `makeRunSystemctl` builds (`probes.ts:297-303`), using `stripTrailingNewlines` and never `.trim()`.
The guard then reads the same systemd the restart acts on in both topologies.

THE GUARD'S OWN FIVE OPERATOR LINES, which is blocker R2.
`restart_session_guard` (`:1461-1500`) emits five `luna_warn` lines from inside itself, and `restartSessionGuardSync` (`session-guard.ts:232-275`) returns a typed verdict and writes nothing, so revision 2's binary was silent wherever bash spoke.
The GATE 1 row "fresh-run guard defer with the `ss` stub reporting one established connection" makes that a guaranteed stderr diff failure, not a theoretical one: bash prints the `:1477` line and then the caller's DEFERRED line, and revision 2's binary printed only the second.

`session-guard.ts` gains ONE pure builder, which is the only new export:

```ts
/** The luna_warn payload restart_session_guard emits for this verdict, or null for its four silent arms. */
export const guardVerdictLine: (verdict: GuardVerdict, readinessPort: string) => string | null
```

It maps, exhaustively, over the verdict union already declared at `session-guard.ts:58-99`:
`operator-override` returns `verdict.auditLine` (`:1468`, already built by `operatorOverrideLogLine`);
`live-sessions` returns `session guard: ${verdict.sessionCount} active session(s) on :${readinessPort} — deferring restart` (`:1477`);
`dead-server-exception` returns `session guard: ws count unknown but unit answered '${verdict.unitState}' — no server process; restart permitted` (`:1491`);
`transport-unreachable` returns `session guard: transport never reached systemd — deferring (fail closed); a restart through the same transport could not succeed anyway` (`:1494`);
`unit-state-uncertain` returns `session guard: ws count unknown while unit answers '${verdict.unitState}' — may be serving; deferring (fail closed)` (`:1497`);
and `dry-run`, `guard-disabled`, `non-systemd-supervisor` and `zero-sessions` return `null`, matching bash's four silent early returns at `:1462`, `:1463`, `:1466` and `:1480`.
It takes `readinessPort` as its second parameter because `:1477` interpolates `$READINESS_PORT`, which the verdict does not carry.

It is emitted through `warn` at ALL THREE places a guard verdict is produced, which between them cover bash's five call paths:
`restart.ts`, immediately after `restartSessionGuardSync` returns and BEFORE the `permitted` branch, covering the forward restart (`:2056`), the rollback restart (`:1824`) and restart-only's restart (`:1894`);
and `wiring.ts`'s `UpdateFlowDeps.guard` closure, covering the two standalone calls at `:1948` and `:1998`.
A verdict whose line is `null` emits nothing at all, so the four silent arms stay silent.

THE READINESS CLOCK IS OVERRIDDEN, NOT INHERITED, which is concern 16.
`probes.ts:269-281`'s `makeReadinessProbes` hardcodes `now: makeMonotonicSeconds()` and `sleep: sleepSecondsSync`, and the latter spawns a real `sleep` (`probes.ts:257-259`); neither is a seam.
Revision 2's claim that "`readiness.ts`'s `now`/`sleep` and `restart.ts`'s `sleepSync` come from `probes.ts` factories" is therefore only half true, and an in-process test that trusted it would spawn.
`wiring.ts` spreads the factory's result and OVERRIDES both from `UpdateIo`: `{ ...makeReadinessProbes(...), now: io.now, sleep: io.sleepSecs }`, and does the same for `restart.ts`'s `sleepSync` from `io.settleSleep`.
`no-ambient-io.test.ts` is what proves the override took, because a missed override reaches a tagged-throwing `UpdateIo` function in neither case and instead reaches a real spawn, which the test reports as an untagged error.

`dreamWakeInstallScript()`: bash's `dream_wake_install_script` (`:413-419`) probes `$HOST_REPO_DIR/apps/server/scripts/dream-wake-install.ts` on the HOST filesystem (no `run_target`, because the host mount is always reachable) but PRINTS a `$CONTAINER_REPO_DIR`-relative path.
Port both halves; getting the probe side container-relative breaks every incus deploy.

`seedDreamWakeJobs()`: emits `post-deploy: seeding V2 dream/wake job rows (idempotent)` (`:1718`), runs `runTarget(bunRunArgv(bunBin, script))` (`:1719`), then emits either the ensured line (`:1720`) or the FAILED warn (`:1722`), and ALWAYS returns void without throwing.
Bash's `|| true` at `:2075` is load-bearing: a seed failure must never fail a healthy deploy.

`applyRef`: a closure over `applyInplaceSync`.
When invoked from the rollback path it computes the lockfile hash FRESH at call time, because bash passes `$(lockfile_hash)` at `:1821`, not the `PREV_LOCK_HASH` captured before the forward attempt; reusing the stale hash makes rollback skip a `bun install` it needed.

`failForward` and `rollback`, which is blocker B10 and blocker B3/B9.
`update-flow.ts` cannot construct a `RollbackOptions` and must not try: `rollback.ts:110-129` requires `layout: "bare" | "releases"` (NOT `"inplace"`, and `target.ts:76-81` exists specifically to warn that these are two different vocabularies for two different questions), plus `uid` and `launchdLabel` through `RemediationContext` (`rollback.ts:75-81`), plus a ONE-parameter `writeTransaction: (phase: string) => void` that the flow's two-parameter journal seam is not assignable to.
So `wiring.ts` owns the whole record and exposes the two narrow seams above.
`wiring.ts` performs the layout translation explicitly and in one line, with a comment naming `target.ts:76-81`: the binary only ever reaches this code on `layout === "inplace"`, which is a BARE-host rollback in `rollback.ts`'s vocabulary, so it passes `"bare"`.
`update-flow.ts` therefore does NOT need `remediationHint` at all; the previous revision declared it as `() => string` while `rollback.ts:89` is `remediationHint(ctx: RemediationContext)`, and then called it with arguments.

THE ROLLBACK READINESS CLOSURE, which is blocker B5.
`rollback.ts:125` types `runReadiness` as returning a bare boolean and `rollback.ts:179-186` prints nothing on the false branch, but in bash the give-up warn lives INSIDE `readiness_ok` at `:1124`, so it fires at all three call sites including the rollback probe reached from `:1838`.
`wiring.ts`'s `runReadiness` closure therefore does three things in order: call `readinessBaseline()` at invocation time (bash captures `rollback_baseline` at `:1837`, AFTER the rollback restart, so a baked-in baseline is the wrong number), call `readinessOkSync` with that baseline and the request's two pinned fields, and on `ready === false` emit `readiness.readinessGaveUpLine(numbers.readinessTimeoutRaw, result.detail)` through `warn` before returning false.
Without this the exit-2 CRITICAL scenario is a guaranteed stderr diff failure, not a theoretical one.

### `apps/deploy-cli/src/update/run-update.ts` (new, ~190 lines)

The single testable entry.
Never calls `process.exit`.

```ts
export const runUpdate: (rawArgv: ReadonlyArray<string>, seams: RealSeams) => number
```

Order, and every step of it is asserted by `exit-code-matrix.test.ts`:

1. `flagArgv = forwardedFlags(rawArgv)` (see THE ARGV CONTRACT).
2. `resolveBashLib({ env: (n) => seams.env[n], isReadableFile: seams.io.isReadableFile, runBash: seams.io.runBash })`.
   On failure write the byte-exact error line and return 1.
   This must happen FIRST because `config.ts`'s `ConfigSeams.validateProfile` is an input to `parseUpdateConfig`, not something it can lazily resolve, so the binary can never report a config error faster than it can prove the bash escape hatch exists.
   `isReadableFile` is a REQUIRED field of `ResolveBashLibOptions` (`bash-lib.ts:169-175`) whose production implementation is a real `statSync` plus `accessSync` (`bash-lib.ts:183-191`), and revision 2 wrote it as a bare identifier with no source, which is blocker R15 and concern 2.
   It is now a member of `UpdateIo`, so `no-ambient-io.test.ts` tags it like every other boundary.
3. Wrap `bashLib.validateProfile` (which returns a `ValidateProfileResult`) into `config.ts`'s bare `(profile) => boolean` seam, forwarding the result's stderr bytes verbatim first.
   Provide `hasLaunchctl` as `seams.io.commandExists("launchctl")`, the PATH walk, never a `command -v` spawn.
4. `parseUpdateConfig(flagArgv, seams.env, configSeams)`.
   On `kind: "help"` print the usage text and return 0; on `kind: "missing-value"` or `kind: "error"` write the line the outcome carries and return `exitCodeFor({ kind: "config-refused" })`.
   CORRECTED IN PHASE 2: returning `parsed.exitCode` directly is the same number (`ParseOutcome` types it as the literal 1 for both variants) but leaves `terminals.ts`'s `config-refused` arm constructed nowhere, so the one table that holds the whole exit-code contract has an arm no run can reach and no test can observe.
   The help branch is UNREACHABLE in production because `main.ts`'s raw-argv preamble handles `update --help` before citty ever dispatches (concern 21); it is retained as a defensive return rather than deleted, and a comment says so.
5. `delegationFor(config)`.
   Non-null means `delegateToBashSync({ flag: asDelegationFlag(d.flag), rawArgs: rawArgv, env: seams.env, writeStderr: lineWriter, runEngine: seams.io.runEngine, isExecutableFile: seams.io.isExecutable })` and return its exit code VERBATIM.
   `isExecutableFile` is optional on `DelegateOptions` (`delegate.ts:249-250`) and defaults to a real stat plus X_OK probe, so omitting it, as revision 2 did, leaves a real filesystem boundary in the one file every in-process test drives; that is the second half of blocker R15.
   `asDelegationFlag` narrows `config.ts:234-236`'s bare `string` to `delegate.ts:102-108`'s CLOSED `DelegationFlag` union by membership in `DELEGATION_FLAGS`, throwing on anything else (concern 10).
   Concern 5 is right that the throw is unreachable on every valid input today, because `delegationFor` can only ever yield `--dry-run`, `--user`, `--layout releases` and `--supervisor launchd`, and `Layout` is a two-member union (`config.ts:71`); revision 2's claim that it "catches a sixth spelling" overstates it.
   The narrowing is kept anyway because it is a type-level requirement, not a runtime hope: without it, `config.ts`'s `string` is not assignable to `delegate.ts`'s union and the call does not compile.
   Delegation happens BEFORE the lock, always.
6. `resolveNumbers(config)`.
   On failure write `error: <message>` and return 1.
7. `runPreflightSync(...)`, with EVERY seam bound explicitly from `seams.io` and none left to a module default, because `PreflightSeams`' `dirExists`, `fileExists`, `containerFileExists` and `gitCurrentBranch` all default to real `statSync` / real `incus exec` / real `git` (`preflight.ts:174-192`, `:235-249`).
   The full binding is `{ print, dirExists: io.dirExists, fileExists: io.fileExists, containerFileExists: io.containerFileExists, gitCurrentBranch: io.gitCurrentBranch, findBun }`, plus the banner-context and option fields `parseUpdateConfig` already produced.
   `print` is bound to the RAW stdout writer plus a newline, never to `info`.
   On refusal write the error line and return 1.
   No lock has been taken at any point above, and a test asserts the lock dir does not exist on every one of these paths.
   Preflight's resolved `ref` (`preflight.ts:364-368`, bash `:510-521`) is what `freshRun` later receives as `requestedRef`, matching bash where `REQUESTED_REF="$REF"` at `:1973` reads the already-defaulted global.

   THE `findBun` ADAPTER, which is blocker R16 and concern 3.
   `PreflightSeams.findBun` is a REQUIRED `() => string` with NO DEFAULT on purpose (`preflight.ts:193-199`), and the only production source is `bashLib.findBun`, typed `() => FindBunResult` (`bash-lib.ts:289`) whose failure arm is `{ ok: false, exitCode, stderr }` (`bash-lib.ts:235-237`) because bash's `luna_find_bun` dies.
   The two do not compose, and revision 2 never said how they were bridged or what the binary prints when bun cannot be found.
   `run-update.ts` builds the adapter itself:
   `const findBun = () => { const r = bashLib.findBun(); if (!r.ok) throw new BunUnresolvedError(r.stderr, r.exitCode); return r.path }`.
   `BunUnresolvedError` is a module-private tagged error that `run-update.ts` catches around the `runPreflightSync` call ONLY, writes `r.stderr` VERBATIM through `seams.writeStderr` (the bytes are `luna_find_bun`'s own `luna_die` line, already carrying its `error: ` prefix and its newline, so nothing is added), and returns the carried exit code, which `luna_die` makes 1.
   It is a thrown error rather than a returned outcome because `PreflightSeams.findBun`'s signature is fixed by PR1 and widening it would change a shipped module for one caller.
   `config.ts:291-292`'s `resolveBunBin(config, findBun)` is NOT used and must not be called: `runPreflightSync` already implements the same `incusContainer !== "" ? bunBinIncus : findBun()` arm at `preflight.ts:367`, and two resolvers for one value is exactly the drift this PR exists to remove.

7a. `bunBin` is `PreflightSuccess.bunBin` (`preflight.ts:214-219`, `:367-368`), carried forward from step 7's success outcome.
   It is not recomputed anywhere, and `buildFlowDeps` receives this value.
8. `acquireUpdateLockSync(...)`.
   On `acquired: false`, return `exitCodeFor(outcome.reason === "contended" ? { kind: "lock-contention", restartOnly: config.restartOnly } : { kind: "lock-unacquirable", restartOnly: config.restartOnly, reason: outcome.reason })`, which is 4 under `--restart-only` and 0 otherwise for both.
9. `const uninstallHooks = installLockReleaseHooks(lock)`, then everything from here down runs inside `try { ... } finally { uninstallHooks(); lock.release() }`.
   CALLING THE UNINSTALLER IS MANDATORY (concern 22): `lock.ts:437-454` adds two listeners per call and is NOT idempotent, and `exit-code-matrix.test.ts` drives many `runUpdate` calls in one process, so without it Node emits `MaxListenersExceededWarning` onto the very stderr a parity suite diffs.
9a. Build the flow's dependencies, INSIDE the `try`, which revision 2 omitted entirely and which is blocker R18.
   `const target = buildTargetContext(config, seams)`, then `const deps = buildFlowDeps({ config, numbers, bashLib, bunBin, requestedRef, seams })`.
   `buildFlowDeps`'s ref parameter is RENAMED from `ref` to `requestedRef` and carries preflight's resolved value, the same string `UpdateFlowDeps.requestedRef` exposes.
   It is emphatically NOT the transaction target: the fresh-run target is resolved inside `freshRun` (`:1989-1994`) and the recovery target is read out of the journal (`:1929`), both of them after this record is built, and both of them supplied per call through the `applyRef` and `rollback` seams rather than baked in.
   Building the record here rather than before the lock is deliberate: it constructs nothing observable, but keeping every construction inside the `finally`'s scope means a throw during wiring still releases the lock.

10. `runUpdateFlowSync(deps)`, then `exitCodeFor(terminal)`.

SIGNAL DIVERGENCE, stated rather than papered over: bash's `trap release_update_lock EXIT INT TERM` (`:1007`) fires between commands, but Node dispatches SIGINT/SIGTERM on the event loop, which a synchronous body spanning a settle sleep and a readiness poll never yields to.
`process.on("exit")` and `uncaughtException` DO fire synchronously and are wired.
INT/TERM are not, and the recovery is the next run's stale-lock takeover, which emits an extra `removing stale update lock for profile '<p>'` stderr line bash never emits.
`interop-parity.test.ts` asserts that line as a KNOWN divergence rather than hiding it.

### `apps/deploy-cli/src/update-command.ts` (new, ~80 lines)

NOTE THE PATH: this file lives beside `main.ts`, OUTSIDE `src/update/`, and that placement is blocker R17.
Revision 2 put it under `src/update/` and gave it a `run` that calls `process.exit`, in the same document that bans `process.exit` anywhere under `src/update/` by CI grep; following revision 2 produced a red gate on the first commit.
`src/update/` is the pure-and-injected directory and `src/` is the process boundary, so the command definition, `realSeams()` and the one `process.exit` all belong on the `src/` side of that line.
Nothing under `src/update/` imports this file.

The citty command definition for `update`.
Reproduces the `Exit codes:` block from `scripts/luna-update-server`'s usage verbatim, because operators read it literally during an incident.
Its `run` is `process.exit(runUpdate(process.argv.slice(2), realSeams()))`.
It also exports `realSeams()`, defined in full under INJECTED VERSUS REAL.

`update --help` is NOT handled here, which is concern 27.
`main.ts:58-67`'s raw-argv preamble runs BEFORE `runMain`, and putting the handling inside the command's `run` is too late if citty intercepts first; citty's own per-subcommand help goes silent under `NODE_ENV=test`, which is exactly the exit-0-no-output shape guardian's publish postcondition exists to catch.
So the preamble gains one branch, and a comment records that its first-non-flag-token scan is the same computation `forwardedFlags` does (`delegate.ts:208`) and that the two must not drift.
THAT BRANCH IS POSITIONAL, which is a phase-2 correction: it asks `updateArgvWantsHelp(rawArgs.slice(firstTokenIndex + 1))`, a walk exported from `config.ts` beside the parse loop it mirrors, NOT `rawArgs.includes("-h")`.
A membership test answers "help" for `update --ref -h`, where bash's `case` loop assigns `-h` as the ref value (`:219`) and never reaches the usage arm, and for `update --bogus -h`, where bash dies at `--bogus` with exit 1.
The walk consumes a value after each of the 18 value-taking flags, stops at anything outside the 23-flag vocabulary, and treats a missing or empty value as the refusal `${2:?...}` makes it; `assembly-fidelity.test.ts` asserts it agrees with `parseUpdateConfig` on every argv and derives value-taking-ness from that parser, so a 24th flag cannot drift out of the preamble.

## Edits to existing files

### `apps/deploy-cli/src/update/restart.ts` (edit, ~150 lines)

THIS MODULE NOW PRINTS, AND THAT IS A DELIBERATE REVERSAL OF ITS OWN HEADER.
`restart.ts:6-10` says the `luna_info`/`luna_warn` lines inside `restart_service` and `settle_after_stop` "are not reproduced here by design (this module returns typed outcomes instead)".
That design is wrong for this PR and it produced three separate blockers, R1, R3 and R13, because bash emits SIX operator-facing lines from inside the very functions this module ports, and `restart_service` has three in-scope callers.

The six lines and where bash emits them:
`settle_after_stop`'s invalid-value warn (`:1276`), its settling info line (`:1279`) and its sleep-failed warn (`:1283`), all of which sit BETWEEN `sup_stop` and `sup_start` at `:1528`;
`sup_start`'s start-limit warn (`:1375`), which sits between the `is-failed` probe at `:1374` and the `reset-failed` at `:1376`;
and `restart_service`'s two MainPID warns, INCONCLUSIVE at `:1559` and POSTCONDITION-unchanged at `:1563`, which sit between `sup_start` at `:1549` and the function's return at `:1569`.
The five `restart_session_guard` lines (`:1468`, `:1477`, `:1491`, `:1494`, `:1497`) also fire from inside `restart_service`, at its very first line `:1509`.

The three in-scope callers of `restart_service` are `:1894` (restart-only), `:2056` (the forward restart) and `:1824` (the rollback restart).
Revision 2 gave those lines exactly ONE printer, `update-flow.ts`, which runs on none of restart-only's path and cannot see inside `rollback.ts`'s `restartService: (guardSessions: boolean) => number` seam (`rollback.ts:123`), so two of the three callers printed nothing.
Printing from the caller is also the wrong ORDER even where it works: revision 2's `update-flow.ts` printed the MainPID warns after `restartServiceSync` returned, which puts them after the settle line rather than interleaved where bash puts them.

So `RestartServiceOptions` gains two seams, and `restart.ts` prints all eleven lines at exactly the positions bash does:

```ts
  /** `luna_info` PAYLOAD, no prefix; wiring supplies the `-> ` writer. */
  readonly info: (line: string) => void
  /** `luna_warn` PAYLOAD, no prefix; wiring supplies the `warning: ` writer. */
  readonly warn: (line: string) => void
```

The emission points, in `restartServiceSync`'s own order:

1. After `restartSessionGuardSync` returns and BEFORE the `permitted` branch: `const l = guardVerdictLine(verdict, opts.guard.readinessPort); if (l !== null) opts.warn(l)`.
2. Around `settleAfterStopSync`, and CORRECTED IN PHASE 2 as to where within that window each of the three lands.
   The `:1279` settling info goes out through an optional `onSettling` callback on `SettleAfterStopOptions`, fired after the format check and BEFORE the sleep starts, because that is where bash prints it (`:1279`, then the sleep at `:1282`).
   Revision 3 specified mapping all three from the returned `SettleOutcome`, which cannot be observed until the sleep is over, so the line announcing a six-second pause arrived six seconds after the pause began: invisible to a byte diff, visible to an operator tailing a live deploy and to anyone reading the tail of a run killed DURING the settle, where bash's last line is the settling line and the outcome-mapped port's is the stop.
   The other two still branch on the outcome, which is when bash learns them too: `skipped-invalid` emits the `:1276` warn, `settled-sleep-failed` emits the `:1283` warn (its `:1279` line having already gone out through `onSettling`), and `settled`, `skipped-dry-run` and `skipped-zero` emit nothing further.
   `restartServiceSync` always supplies `onSettling`, so the compile-time guarantee that a real wiring cannot forget the line is unchanged, and `settleAfterStopSync` stays callable without a writer.
   Note the ordering inside `settled-sleep-failed`: bash prints the settling line at `:1279` BEFORE attempting the sleep at `:1282`, so a failed sleep produces two lines, not one.
3. Inside the start retry block, between `runStep(["is-failed", ...])` returning 0 and `runStep(["reset-failed", ...])`: the `:1375` start-limit warn.
   This is the exact position `sup_start` prints it, and it removes the need for the `startLimitLatched` outcome field to carry a printing obligation.
4. In the MainPID postcondition block: the INCONCLUSIVE warn on an unreadable `post_pid`, and the unchanged warn immediately before returning `{ code: 1, step: "mainpid" }`.

`startLimitLatched` REMAINS on the outcome, but its meaning narrows from "the caller must print" to "the latch fired", so that `restart-mainpid-parity.test.ts` can assert the latch without string-matching stderr.
No caller prints it any more, and `update-flow.ts` prints none of these eleven lines.

`rollback.ts:123`'s `restartService: (guardSessions: boolean) => number` seam is therefore NOT widened, which is the second half of R13 declined on purpose: with `restart.ts` printing, the bare `number` already carries everything `doRollbackSync` needs, and widening a shipped signature for a need that no longer exists is churn.

This is also PR1 work the spec assigned to PR1 and PR1 did not ship: `restart.ts:15-19` still says the MainPID postcondition is DELIBERATELY EXCLUDED, and `grep` confirms zero MainPID references in the file.
The fixture support already exists and is unconsumed (`bash-fixtures.ts`'s settable `mainPid` queue at `:203-236`).
Without it the binary is strictly weaker than the bash it replaces at detecting a failed stop, and three acceptance rows are unwritable.
It lands as the FIRST commit of this PR and must be independently revertible.

Add `mainPid?: () => string` to `RestartServiceOptions`, and widen the failure variant:

```ts
export type RestartOutcome =
  | { readonly code: 3; readonly verdict: Extract<GuardVerdict, { readonly permitted: false }> }
  | { readonly code: 1; readonly step: "reload" | "stop" | "start"; readonly startLimitLatched?: boolean }
  | { readonly code: 1; readonly step: "mainpid"; readonly prePid: string; readonly postPid: string }
  | { readonly code: 0; readonly settle: SettleOutcome; readonly mainPidInconclusive?: boolean; readonly startLimitLatched?: boolean }
```

THE RULE IS FAIL ONLY ON POSITIVE PROOF, ported from `:1510-1568`:

- Read `pre_pid` only when `!dryRun && supervisor === "systemd"`, immediately after the guard permits and before `sup_reload` (`:1519-1522`).
- After `sup_start` succeeds, evaluate the check only when `pre_pid` matches `^[0-9]+$` and is not `0`; anything else SKIPS entirely (`:1550-1551`).
- An unreadable `post_pid` (not `^[0-9]+$`) emits the INCONCLUSIVE warn and PASSES (`:1553-1559`).
- `post_pid === "0"` PASSES: systemd answered "no main process", which disproves "the old process is still serving" (`:1566-1567`).
- Only a numeric `post_pid` equal to a numeric non-zero `pre_pid` returns code 1 with `step: "mainpid"` (`:1560-1564`).

`startLimitLatched` is concern 14, and it stays on the outcome as a machine-readable signal even though the warn is now printed in place.
`sup_start` (`:1371-1381`) warns `sup_start: $SERVICE_NAME is start-limit latched failed; clearing with reset-failed and retrying once` at `:1375` between the `is-failed` probe and `reset-failed`.
No pre-existing scenario triggers it, which is exactly why it would be missed, so GATE 1 adds a row for it on both the forward and the restart-only paths.

`RESTART_PRESTART_HOOK` stays excluded: it is releases-only and delegated.

`settleSecs` reaches this module as the RAW STRING `config.ts:362` holds (`restartSettleSecs = envOr(env, "LUNA_RESTART_SETTLE_SECS", "6")`), and the `:1276`, `:1279` and `:1283` builders interpolate that same raw string, exactly as bash interpolates `$RESTART_SETTLE_SECS`.
The production default is `"6"`, not `"0"`, so the `:1279` info line fires on EVERY real deploy; a GATE 1 that only ever ran with the settle pinned to `0` could never have seen it, which is the second half of blocker R1 and is fixed under GATE 1's scenario list.

The ordering of every one of these lines is provably identical to bash, because each is emitted from the same position inside the same ported function, and `restart.ts` is the only writer between the guard and the function's return.
That is a stronger argument than revision 2's, which rested on nothing else writing to stderr between `sup_start` and the caller's next line and which UNCERTAINTY 1 flagged as unproven for the incus `run_target_capture` case; moving the print inside removes the premise entirely.

### `apps/deploy-cli/src/update/probes.ts` (edit, ~40 lines)

Add `supMainPidSync` through the same `RunTargetCapture` waist the other probes use, porting `sup_main_pid` (`:1423-1430`): run `systemctl [--user] show <unit> --property=MainPID --value`, and return `""` unless the captured value matches `^[0-9]+$`.
Keep `restartOutcomeRc` total over the widened `RestartOutcome` union (it reads `.code`, so it stays a one-liner, but the type must still compile).

Update the module header in the SAME commit, which is concern 17: `probes.ts:84-85` currently states that `sup_main_pid` is out of scope because "restart.ts reads MainPID through the same injected runSystemctl this module builds, so it needs no second probe", and leaving that in place makes the file contradict itself.

Widen the three `probes.ts` rows of THE COMPLETE `readinessPort` WIDENING LIST.
Nothing does arithmetic on the value; it is interpolated into `http://127.0.0.1:${readinessPort}/healthz` and nothing else.
This is concern 23, and it is what lets an operator's `--readiness-port 04753` produce byte-identical curl argv on both engines instead of an exit-1 refusal bash does not have.
`probes.ts:196`'s `curlMaxTime` already carries the same rule with the reasoning written out, and revision 2's citation of `:196` for it is correct; concern 22's proposed correction to `:197` is rejected, because `:196` is the field and `:197` is `runTargetCapture`.

### `apps/deploy-cli/src/update/readiness.ts` (edit, ~10 lines)

Widen the two `readiness.ts` rows of THE COMPLETE `readinessPort` WIDENING LIST.
`ReadinessProbeOptions.readinessPort`'s only uses are the argv builders and the `/healthz did not return 200 on :${readinessPort}` detail at `readiness.ts:156`, both of which want the raw spelling.
`readinessGaveUpLine`'s first parameter is concern 15: bash interpolates `${READINESS_TIMEOUT}` raw at `:1124`, so `--readiness-timeout 007` must print `007`.

WHERE THAT RAW STRING COMES FROM, at each of the three call sites, because revision 3 named the emitters without giving two of them a source and neither compiled.
`readinessTimeoutRaw: string` is carried as an explicit field on the deps record of every module that emits the line:

| Emitter | Field added | Source |
| --- | --- | --- |
| `wiring.ts`'s `runReadiness` closure (rollback path) | closes over it | `config.readinessTimeoutRaw`, available because `wiring.ts` holds the parsed config |
| `update-flow.ts` (forward Verify path) | `UpdateFlowDeps.readinessTimeoutRaw: string` | set by `buildFlowDeps` from the same config field |
| `restart-only.ts` (rung 1 readiness failure) | `RestartOnlyDeps.readinessTimeoutRaw: string` | set by its caller in `run-update.ts` from the same config field |

It is threaded as a STRING and never re-derived from the parsed number, because the whole point is that `007` and `7` must print differently while behaving identically.
`numbers.ts` therefore exposes BOTH: `readinessTimeoutSecs: number` for the arithmetic and `readinessTimeoutRaw: string` for the operator line, and a unit test asserts a `007` input yields `7` and `"007"` respectively.
Correct that function's doc citation from `:1129` to `:1124`; `:1129` is a comment line in the following section, verified by reading both.
Nothing else in `readiness.ts` changes: `readinessOkSync`'s loop is already a faithful port of `:1071-1125`, including the zero-budget behaviour its own header documents, which GATE 1's determinism argument depends on.

### THE COMPLETE `readinessPort` WIDENING LIST

Blocker R14 is that revision 2 gave examples where it needed an exhaustive list, and the omissions do not compile.
`readinessPort` is a `string` throughout `config.ts` already (`config.ts:358` is `envOr(env, "LUNA_READINESS_PORT", "4753")`), so this is unwrapping a conversion that never needed to happen.
Every consumer, found by grepping `readinessPort` and `port` across `src/update/` and `test/update/`:

| Site | Change |
| --- | --- |
| `probes.ts:188` `CurlProbeOptions.readinessPort` | `number` to `string` |
| `probes.ts:201` `healthzArgv`'s first parameter | `number` to `string` |
| `probes.ts:208` `readyzArgv`'s first parameter | `number` to `string` |
| `readiness.ts:83` `ReadinessProbeOptions.readinessPort` | `number` to `string` |
| `readiness.ts:204` `readinessGaveUpLine`'s first parameter | `number` to `string` |
| `session-guard.ts:108` `SessionGuardOptions.readinessPort` | `number` to `string` |
| `session-guard.ts:136` `SessionGuardOptions.queryActiveWsCount`'s `port` parameter | `number` to `string`, MISSING from revision 2 |
| `session-guard.ts:186` `queryActiveWsCountSync`'s `port` parameter | `number` to `string` (revision 2 cited `:182`, which is a doc line) |
| `restart.ts:121` `RestartServiceOptions.guard` | NO edit; it is `Omit<SessionGuardOptions, ...>` and picks the change up transitively |
| `bash-fixtures.ts:85` `export const READINESS_PORT = 4753` | to `"4753"`, so the fixture's `--readiness-port` argv and its `readinessPort` field still cannot drift |
| `restart-guard-parity.test.ts:788` `queryActiveWsCountSync(READINESS_PORT, ...)` | no source edit needed once the constant is a string, but the file is listed because concern 1 is right that vitest does not typecheck and this only surfaces under `tsc` |

`session-guard.ts:136` is the one that makes revision 2 fail to compile outright: `session-guard.ts:246` calls `(opts.queryActiveWsCount ?? queryActiveWsCountSync)(opts.readinessPort, opts.incusContainer)`, so a widened `readinessPort` with an unwidened field is a direct type error, and `UpdateIo.queryActiveWsCount`, declared `(port: string, ...)`, is not assignable to it either.

`tsc` over `apps/deploy-cli` is a REQUIRED check for this PR precisely because of concern 1, and the PR body records that it was run.

### `apps/deploy-cli/src/update/session-guard.ts` (edit, ~40 lines)

Widen the two sites in the table above, and add `guardVerdictLine`, the one new export, specified in full under `wiring.ts`.
The widening reason is the same everywhere: the value is interpolated into the ss filter `( sport = :${port} )` and nothing else.

Do NOT add an ambient env seam.
`session-guard.ts:35-39` states that this module takes dependency injection only, "never an ambient LUNA_TEST_* env read from shipped code", and that rule is what stops a stray inherited variable from spoofing a fail-closed decision.
GATE 1's determinism comes from an `ss` stub on the fixture PATH instead, which is described under THE HARNESS CONTRACT and which has the additional virtue of making the guard genuinely dual-driven rather than short-circuited on the bash side.

### `apps/deploy-cli/src/update/rollback.ts` (edit, ~20 lines)

Add one seam and move one line, which is concern 3.

```ts
export interface RollbackOptions extends RemediationContext {
  ...
  /** RAW stderr, no prefix: the CRITICAL line is a bare printf in bash (:1854-1855), not a luna_warn. */
  readonly writeStderrRaw: (text: string) => void
}
```

`doRollbackSync`'s exit-2 tail currently calls `writeTransaction("rollback-failed")` and returns, leaving the caller to print (`rollback.ts:185-186`).
Bash prints CRITICAL FIRST (`:1854-1855`) and writes the phase SECOND (`:1856`).
A crash between the two steps therefore leaves a different on-disk state than bash, which is invisible to a stderr-only diff and is exactly the class of bug this port exists to avoid.
So `doRollbackSync` builds `criticalLine(ref, prev, remediationHint(options))` itself, which it can already do because `RollbackOptions extends RemediationContext`, emits it through `writeStderrRaw` with its own trailing newline, and only then writes the phase.
`update-flow.ts` prints nothing on that path.

### `apps/deploy-cli/src/main.ts` (edit, ~10 lines)

Replace `update: stubSurface(...)` with an import of `./update-command.js`, the sibling file, NOT anything under `./update/`.
Extend the raw-argv preamble at `:58-67` with the `update --help` branch described under `update-command.ts`.
`autodeploy`, `guardian`, `stubSurface`, `exit-codes.ts` and `version.ts` are untouched.

### `apps/deploy-cli/test/update/bash-fixtures.ts` (edit, ~420 lines)

See THE HARNESS CONTRACT for the full list; this is the summary of the surface.
`makeFixturePair` already exists, already pins commit dates and already asserts the two repos hashed identically.
Added: `resolveHostTool`; `driveEnv`, which also mkdirs the fixture `HOME`; the `ss`, `git` and `bash` layered entries, with `ss` written UNCONDITIONALLY; trace-emitting REPLACEMENTS for `systemctl`, `curl` and `bun`, written unconditionally over `makeStubBin`'s originals because those three live in the forbidden file; a `readyAfterCalls` option on the replacement `curl`; an optional failing `sleep` stub for the settle row; `runBinaryUpdate`; `captureArtifacts`; `maskArtifacts`; and `normalisePollBlocks`.
`bash-fixtures.ts:94-97`'s legacy `runUpdate` is NOT touched, per blocker R21, and gains only a `runBashUpdate` alias re-export.
The three replacement stubs are the mechanical risk in this file and `stub-fidelity.test.ts` exists for them.

## Exact ordered flow, with every exit code

This mirrors `scripts/luna-update-server:1871-2086` and is the reading order `update-flow.ts` must preserve.

**Lock (:1871-1881).** Acquired in `run-update.ts`, before ANY other check including restart-only.
Contention returns 4 under `--restart-only`, 0 otherwise; the three non-contended acquire failures take the same codes through `lock-unacquirable`.
Released in a `finally` that covers the entire remaining body and also uninstalls the exit hooks.

**Restart-only (:1883-1913).** Only when `restartOnly` is true.
If the journal EXISTS, emit `restart-only requested but an update transaction is pending; running normal recovery instead` (`:1891`) and FALL THROUGH into the normal flow below.
This fallthrough is the single most important structural fact in this PR.
`RESTART_ONLY` is never re-read after `:1889`, so a restart-only invocation with a pending journal can reach `do_rollback`, can emit `ROLLED BACK to`, and can exit 2.
Its exit set is `{0,1,2,3,4}`, NOT `{0,1,3,4}`.
If the journal does not exist, run `restart-only.ts` and return its terminal.

**Journal fork (:1915-1953).**
If the journal exists: `loadTransaction()`.
`"corrupt"` means write the corrupt-journal line to stderr as a RAW printf with no `warning: ` prefix through `writeStderrRaw`, and return terminal `corrupt-journal` (exit 2) (`:1924-1926`).
Otherwise restore `prev`, `ref`, `prevLockHash` and `recoveryPhase` from the journal, and emit the RECOVERING warn (`:1928-1932`).
If the phase is `rolling-back` or `rollback-failed`, set `forwardRestartRan = true` (guard-EXEMPT, unconditionally, because a prior run already began interrupting service) and call `rollback()` directly, which never returns to the forward flow (`:1933-1938`).
For any other non-empty phase, call `guard()`; a deferred verdict emits the recovery-resume DEFERRED warn and returns terminal `deferred{site:"recovery-resume"}` (exit 3) with the journal RETAINED (`:1947-1951`).
A permitted verdict falls through into the same forward-apply code a fresh run reaches, with `newHead` still `null`.

If the journal does not exist: run `freshRun()`.
On failure write `error: <message>` and return terminal `preflight-refused` (exit 1).
On success, call `guard()`; a deferred verdict emits `DEFERRED by session guard; nothing mutated (retry next tick)` and returns terminal `deferred{site:"fresh-run"}` (exit 3) with NOTHING written (`:1997-2001`).
The guard check sits after ref resolution (read-only) and before the first journal write, and no state may be written before it passes.
Then `writeTransaction("prepared", ...)`, which is the FIRST journal write (`:2002`).

**Forward apply (:2019-2033).**
`applyRef(ref, prevLockHash, /* trackApply */ true)`.
`trackApply` true is passed ONLY here.
On failure, call `failForward({ reason: "apply to " + ref + " errored", ref, prev, newHead: null, forwardRestartRan })` (`:2031`).
`newHead` is `null` here, and `failForwardSync` resolves `${NEW_HEAD:-$REF}` to `ref` (`rollback.ts:209`), matching bash's `NEW_HEAD=""` initialisation at `:1915`.
CORRECTED IN PHASE 2: that resolution is `headOrRef`, which maps BOTH `null` and the EMPTY STRING to `ref`, and not `newHead ?? ref`.
Bash's `:-` substitutes for an unset variable or an empty one, and an empty `NEW_HEAD` is reachable at `:2040` in the same narrow "git exits 0 and prints nothing" window KNOWN DIVERGENCES carves out for `:1964` and `:1992`.
With `??` the two engines print `HEAD=<ref>` and `HEAD=` for the same run, on the one path whose job is telling a human what the host is running.
The releases-layout PRE-flip carve-outs at `:2022-2030` are out of scope and must not be ported; on the inplace layout an apply failure ALWAYS routes to `fail_forward`.

**Post-apply (:2034-2045).**
`newHead = readHead()`, emit `Checked out: ${newHead}` (`:2041`), `writeTransaction("applied")` (`:2043`), then immediately `writeTransaction("restarting")` (`:2045`).
Two sequential phase writes with no mutation between them is what bash does on inplace, and the order is what recovery's phase branching depends on.
The journal's `target` field stays REF throughout; `EXPECTED_BUILD_SHA` is `newHead`, and with an abbreviated or uppercase `--ref` the two differ, which changes both the success line and `READINESS_DETAIL`.

**Restart (:2052-2066).**
`restart(/* guardSessions */ true)`.
Code 3 emits `DEFERRED by session guard mid-transaction; journal retained (phase=restarting) — resumes next tick` and returns terminal `deferred{site:"mid-transaction"}` (exit 3), NEVER routed through `fail_forward`, because `fail_forward`'s rollback would perform the very restart the guard just refused (`:2056-2059`).
Immediately after the guard clears, set `forwardRestartRan = true` (`:2062`).
That flag is the single thing that decides whether the eventual rollback exempts or keeps the session guard, and it must be set here, after the code-3 check and before the code-non-zero check.
`update-flow.ts` prints NOTHING about the restart itself: the guard line, the settle lines, the start-limit warn and both MainPID warns are all emitted from inside `restart.ts`, at bash's own positions, per the `restart.ts` edit above.
Any other non-zero code, including `step: "mainpid"`, calls `failForward({ reason: "service restart errored", ..., newHead })` (`:2065`).

**Verify (:2067-2086).**
`baseline = readinessBaseline()` captured right AFTER issuing the restart, so a climbing NRestarts count during the probe window reads as crash-looping (`:2069`; revision 2 cited `:2068`, which is the comment).
`writeTransaction("verifying")`, the fourth and last forward phase write (`:2071`; revision 2 cited `:2070`, which is the `EXPECTED_BUILD_SHA` assignment).
`readiness({ expectedBuildSha: newHead, allowMissingBuildSha: false, baseline })` (`:2073`).
On success: emit `updated ${prev} -> ${newHead} (${serviceName} healthy)` (`:2074`), call `seedDreamWakeJobs()` swallowing every error (`:2075`), `clearTransaction()` (`:2076`), return terminal `updated` (exit 0) (`:2083`).
`prune_releases` never fires on the inplace layout, so the success tail ends there.
On failure: emit `readinessGaveUpLine(readinessTimeoutRaw, result.detail)` then `failForward({ reason: "failed readiness", ..., newHead })` (`:2086`).

**fail_forward (:1861-1869), via `rollback.failForwardSync`.**
It is NOT re-implemented inline; that was blocker B3 and B9, and it dropped four operator-facing lines from every forward-failure path.
`failForwardSync` emits `update to ${ref} failed: ${reason} (HEAD=${head})` on EVERY call (`:1863`, `rollback.ts:210`), then under `--no-rollback` writes phase `forward-failed` and returns a `died` outcome carrying `${reason} and --no-rollback set; server left at ${head} (may be unhealthy)` (`:1866`, `rollback.ts:217`), which `update-flow.ts` prints as an `error: ` line before returning terminal `forward-failed-no-rollback` (exit 1).
Otherwise it returns a `rolled-back` outcome wrapping `doRollbackSync`'s `RollbackOutcome`.
The three `reason` values are literals and there are exactly three: `apply to ${ref} errored` (`:2031`), `service restart errored` (`:2065`), `failed readiness` (`:2086`).

**Rollback (:1793-1857), inside `rollback.doRollbackSync`.**
`forwardRestartRan` is passed through explicitly; `doRollbackSync` derives `guardSessions = !forwardRestartRan` and emits its own two policy warns (`:1811`, `:1813`), the `ROLLING BACK to ${prev}` line (`:1815`), and the `rolling-back` phase write (`:1816`).
Its `applyRef` seam computes the lockfile hash FRESH at call time (`:1821`) and passes `trackApply: false` (`:1820`), so the rollback's git reset never overwrites the journal phase away from `rolling-back`.
Its outcome maps to terminals `deferred{site:"rollback-restart"}` (3, `:1831`), `rolled-back` (1, `:1841`) or `rollback-failed` (2, `:1857`).
Exit 1 is reachable ONLY through the readiness-OK branch of rollback; every other rollback failure converges on the single exit-2 terminal, whose CRITICAL line `doRollbackSync` now emits itself.

## Byte-exact operator strings

Every line below is a verbatim port from `scripts/luna-update-server` and MUST match byte for byte, including the em dash character (U+2014) where the bash has one.
The em dash appears here only because these are verbatim ports; house style forbids it in new prose.
The `-> ` / `warning: ` / `error: ` prefixes come from `scripts/lib/luna-deploy.sh:4-6` and are applied by `wiring.ts`'s `info`/`warn`, so the builders below return payloads only.
All line references were re-verified against the file for this revision; corrections from revision 1 are marked.

| Builder | Stream | Payload | Bash |
| --- | --- | --- | --- |
| `recoveringLine` | warn | `RECOVERING interrupted update phase=${phase} prev=${prev.slice(0,9)} target=${ref.slice(0,9)}` | :1932 |
| `corruptJournalLine` | RAW stderr, NO prefix | `CRITICAL: corrupt update transaction journal ${path} — refusing to mutate the checkout; inspect or remove it manually.` | :1925 |
| `deferredRecoveryResumeLine` | warn | `DEFERRED by session guard; transaction journal retained (phase=${phase}) — resumes when sessions end` | :1949 |
| `deferredFreshRunLine` | warn | `DEFERRED by session guard; nothing mutated (retry next tick)` | :1999 |
| `deferredMidTransactionLine` | warn | `DEFERRED by session guard mid-transaction; journal retained (phase=restarting) — resumes next tick` | :2058 |
| `currentHeadLine` | info | `Current HEAD: ${prev}` | :1967 |
| `checkedOutLine` | info | `Checked out: ${newHead}` | :2041 |
| `updatedLine` | info | `updated ${prev} -> ${newHead} (${serviceName} healthy)` | :2074 (was :2072) |
| `restartOnlyJournalPendingLine` | warn | `restart-only requested but an update transaction is pending; running normal recovery instead` | :1891 |
| `restartOnlyRestartErroredLine` | warn | `restart-only: restart errored (checkout untouched; no rollback)` | :1896 |
| `restartOnlyHealthyLine` | info | `restart-only: ${serviceName} healthy at ${sha.slice(0,12)}` | :1907 |
| `restartOnlyReadinessFailedLine` | warn | `restart-only: readiness failed after plain restart (checkout untouched; no rollback)` | :1910 |
| `headPostconditionLine` | warn | `POSTCONDITION: git reset reported success but HEAD is '${head \|\| "unreadable"}', expected ${target} — refusing to continue` | :1192 |
| `lockChangedLine` | info | `bun.lock changed -> bun install --frozen-lockfile` | :1202 |
| `lockUnchangedLine` | info | `bun.lock unchanged -> skipping bun install` | :1215 |
| `nodeModulesPostconditionLine` | warn | `POSTCONDITION: bun install exited 0 but ${containerRepoDir}/node_modules is missing` | :1211 |
| `claudeDegradedLine` | warn | `POSTCONDITION degraded: no usable claude executable after re-pin — server will boot but cannot spawn claude` | :1240 (incus arm), :1250 (host arm) |
| `startLimitLatchedLine` | warn | `sup_start: ${serviceName} is start-limit latched failed; clearing with reset-failed and retrying once` | :1375 (NEW in rev 2, concern 14; printed by `restart.ts` since rev 3) |
| `mainPidInconclusiveLine` | warn | `restart postcondition INCONCLUSIVE: post-restart MainPID unreadable (transport failure?); skipping the PID-change check — readiness still gates` | :1559 (printed by `restart.ts`) |
| `mainPidUnchangedLine` | warn | `POSTCONDITION: restart did not replace the server process (MainPID before=${pre} after=${post}) — the stop silently failed` | :1563 (printed by `restart.ts`) |
| `settleInvalidLine` | warn | `RESTART_SETTLE_SECS='${settleSecs}' is not a non-negative number of seconds; SKIPPING the post-stop settle — the DuckDB/SQLite WAL/SHM race may recur. Set --restart-settle / LUNA_RESTART_SETTLE_SECS to a valid value (e.g. 6).` | :1276 (NEW, R1; printed by `restart.ts`) |
| `settlingLine` | info | `settling ${settleSecs}s after stop so DuckDB/SQLite release WAL/SHM before start` | :1279 (NEW, R1; printed by `restart.ts`) |
| `settleSleepFailedLine` | warn | `post-stop settle sleep failed (RESTART_SETTLE_SECS='${settleSecs}'); proceeding to start WITHOUT a settle — the WAL/SHM race may recur.` | :1283 (NEW, R1; printed by `restart.ts`) |
| `seedStartLine` | info | `post-deploy: seeding V2 dream/wake job rows (idempotent)` | :1718 |
| `seedOkLine` | info | `post-deploy: dream/wake job rows ensured` | :1720 |
| `seedFailedLine` | warn | `post-deploy: dream/wake seed FAILED (non-fatal); if wake/dream go dark, run manually: ${bunBin} run ${script}` | :1722 |
| `readHeadFailedMessage` | `luna_die` | `could not read current HEAD in ${hostRepoDir}` | :1965 (near-unreachable in bash; see KNOWN DIVERGENCES) |
| `fetchFailedMessage` | `luna_die` | `fetch failed before update; checkout unchanged` | :1974 |
| `refUnresolvedMessage` | `luna_die` | `could not resolve target ref ${requestedRef}` | :1994 |

The session guard's five lines, all `warn`, all returned by `session-guard.ts`'s new `guardVerdictLine` and emitted at the three sites named under `wiring.ts`.
Revision 2 omitted four of them entirely and named the fifth without a caller, which is blocker R2.

| Verdict `reason` | Payload | Bash |
| --- | --- | --- |
| `operator-override` | `SESSION GUARD OVERRIDDEN by operator: ${reason}` (already `operatorOverrideLogLine`, `session-guard.ts:148`) | :1468 |
| `live-sessions` | `session guard: ${sessionCount} active session(s) on :${readinessPort} — deferring restart` | :1477 |
| `dead-server-exception` | `session guard: ws count unknown but unit answered '${unitState}' — no server process; restart permitted` | :1491 |
| `transport-unreachable` | `session guard: transport never reached systemd — deferring (fail closed); a restart through the same transport could not succeed anyway` | :1494 |
| `unit-state-uncertain` | `session guard: ws count unknown while unit answers '${unitState}' — may be serving; deferring (fail closed)` | :1497 |
| `dry-run`, `guard-disabled`, `non-systemd-supervisor`, `zero-sessions` | nothing at all | :1462, :1463, :1466, :1480 |

Already shipped byte-exact in PR1 and reused unchanged.
Two of these were missing from revision 1's list, which was blocker B9, and both are emitted on every forward-failure path:

| Owner | Payload | Bash |
| --- | --- | --- |
| `rollback.failForwardSync` (`rollback.ts:210`) | `update to ${ref} failed: ${reason} (HEAD=${head})` | :1863 |
| `rollback.failForwardSync` (`rollback.ts:217`) | `${reason} and --no-rollback set; server left at ${head} (may be unhealthy)` | :1866 |
| `rollback.rolledBackMarker` | `update to ${ref} failed — ROLLED BACK to ${prev} (${serviceName} healthy)` | :1839 |
| `rollback.criticalLine` | `CRITICAL: update to ${ref} failed AND rollback to ${prev} also failed — server may be DOWN. Manual intervention required (check: ${hint}).` | :1854-1855 |
| `rollback.remediationHint` | supervisor-conditional | :1845-1853 |
| `rollback`'s two guard-policy warns | as written | :1811, :1813 |
| `readiness.readinessGaveUpLine` | `readiness gave up after ${timeoutRaw}s: ${detail}` | :1124 |
| `lock.lockContendedLine`, `lock.removingStaleLockLine` | as written | :982-988 |
| `session-guard.operatorOverrideLogLine` | as written | :1467-1469 |
| `preflight` banner and refusal lines | as written | :422-440, :468, :480-495, :521 |
| `bash-lib.lunaDieLine`, `delegate.delegatedMarker` | as written | luna-deploy.sh:6, config.ts:243 |

The three `reason` literals interpolated into the two `failForwardSync` strings are `apply to ${ref} errored` (`:2031`), `service restart errored` (`:2065`) and `failed readiness` (`:2086`).

`packages/server-registry/src/driver/luna-chat-server.ts:164` tests `stderr.includes("ROLLED BACK to")`, so that substring is a hard external contract.
Note the releases variant at `:1776` has an extra `(flipped)` that the inplace one lacks, which is why a shared message helper across layouts would break one of the two.
This PR ships only the inplace spelling.

## Injected versus real

INJECTED into `update-flow.ts` (all of it, as one `UpdateFlowDeps` record): `info`/`warn`/`writeStderrRaw`; the four journal operations already bound to a path; `guard()`; `restart(guardSessions)`; `readinessBaseline()`/`readiness()`; `applyRef(target, prevLockHash, trackApply)`; `readHead()`; `freshRun()`; `seedDreamWakeJobs()`; `failForward()`; `rollback()`.

INJECTED into `apply-inplace.ts`: `gitTarget`/`gitTargetCapture`/`runTarget` (already `target.ts`'s waist), `lockfileHash`, `onCheckout`, `dirExists`, `configureClaudeExecutable`, `envValue`, `commandExists`, `isExecutable`, `info`/`warn`/`writeStdout`/`writeStderr`.
It computes decisions and spawns nothing itself.

INJECTED into `restart-only.ts`: `restart`, `readinessBaseline`, `readiness`, `readHead`, `info`/`warn`.
No journal seam exists on its options type, by design.

INJECTED everywhere: the clock.
`readiness.ts`'s `now`/`sleep` and `restart.ts`'s `sleepSync` come from `probes.ts` factories, so a 60s readiness poll and a 6s settle cost nothing in tests and cannot make the byte diff wall-clock dependent.

REAL, and only through `UpdateIo`.
This is the resolution of blocker B16 and concern 28, and it replaces revision 1's single spot-fix for `delegate.ts`'s `defaultRunEngine`.
The problem the audit found is real and general: not one PR1 spawn site honours an injected `env`, because every one of them resolves argv[0] and PATH from the process's own `process.env`.
`target.ts:271-282` calls `spawnSync(cmd, argv.slice(1), { encoding, stdio })` with no `env`; `probes.ts:258` spawns `sleep`; `session-guard.ts:189/195/220` spawn `incus`, `ss` and `systemctl`; `lock.ts:217` spawns `ps`; `bash-lib.ts:151` reads `process.env` at call time.
An in-process `runUpdate` test that reached any of those would run REAL host binaries, and on the self-hosted CI runner, which `.github/workflows/ci.yml` documents as itself a live deployment host, one of them is `systemctl stop <unit>`.

So `RealSeams.io` is a REQUIRED field of type `UpdateIo`:

```ts
export interface UpdateIo {
  readonly spawnTarget: SpawnTarget                                        // target.ts's waist
  readonly runBash: BashRunner                                             // bash-lib.ts
  readonly runEngine: (path: string, args: ReadonlyArray<string>) => EngineRunResult   // delegate.ts
  readonly queryActiveWsCount: (port: string, incusContainer?: string) => number       // session-guard.ts
  readonly sleepSecs: (secs: number) => void                               // readiness poll
  readonly settleSleep: (secs: string) => { readonly ok: boolean }         // restart.ts's settle
  readonly processAlive: (pid: number) => boolean                          // lock.ts
  readonly processFingerprint: (pid: number) => string                     // lock.ts
  readonly pid: () => number                                               // lock.ts's `$$`
  readonly now: () => number                                               // readiness deadline
  readonly dirExists: (path: string) => boolean
  readonly fileExists: (path: string) => boolean
  readonly isExecutable: (path: string) => boolean
  /** `[[ -r "$f" && -f "$f" ]]`, resolveBashLib's REQUIRED seam (bash-lib.ts:169-175). Added in revision 3; see run-update.ts step 2. */
  readonly isReadableFile: (path: string) => boolean
  readonly containerFileExists: (container: string, path: string) => boolean
  readonly gitCurrentBranch: (hostRepoDir: string) => string
  readonly commandExists: (name: string) => boolean
}

/** THROWS unless `env === process.env`. Lives in src/update-command.ts, NOT under src/update/. */
export const realUpdateIo: (env: Readonly<Record<string, string | undefined>>) => UpdateIo
```

`realUpdateIo` LIVES IN `apps/deploy-cli/src/update-command.ts`, beside `realSeams()`, and NOT under `src/update/`.
This is blocker R21 and it is the same self-inflicted shape R17 fixed for `process.exit`: the function's whole contract is the identity comparison `env === process.env`, which is a `process.env` read, and this spec's own CI grep bans `process.env` anywhere under `src/update/`.
Declared under `src/update/` it would fail the gate it is specified alongside.
Placing it in `update-command.ts` keeps the property the grep exists to protect - that `src/update/` contains no ambient-environment read at all, so every module there is drivable from an injected env - while giving the one function that must touch the real environment a home in the composition root, which is exactly where `realSeams()` already lives for the same reason.
The `UpdateIo` TYPE stays under `src/update/` (types read nothing); only the real implementation moves.

Two rules make the class of bug unrepresentable rather than merely tested.
First, `wiring.ts` constructs EVERY PR1 options record with EXPLICIT seam fields drawn from `UpdateIo`, never relying on a module default; `readUnitState` is not a field of `UpdateIo` because it is derived from `spawnTarget` through `makeRunSystemctl`, which is what keeps the guard and the restart pointed at one transport.
Second, `realUpdateIo(env)` throws unless `env` is the very `process.env` object, because a real IO layer built against a different env map is precisely the silent-leak shape the audit found; production's `realSeams()` passes `process.env`, and any test that wants a different env must supply its own `io`.

Third, the rule is restated so it covers `run-update.ts` and not only `wiring.ts`: NO options record for a PR1 module, constructed anywhere under `src/`, may rely on a module default for a seam that performs IO.
Revision 2 scoped the rule to `wiring.ts`, and all three of `run-update.ts`'s own PR1 call sites sat outside it, which is blocker R15.
The CI grep that enforces this is named under ENFORCED BY GREP.

`realSeams()` is defined ONCE, in `apps/deploy-cli/src/update-command.ts`, and is the only function in the tree that reads `process.env` or writes to `process.stdout` directly:

```ts
export const realSeams = (): RealSeams => ({
  env: process.env,
  writeStdout: (text) => { process.stdout.write(text) },
  writeStderr: (text) => { process.stderr.write(text) },
  io: realUpdateIo(process.env),
})
```

Revision 2 referenced `realSeams()` twice and never gave it a home or a signature.

`no-ambient-io.test.ts` enforces the first rule directly: it drives every scenario in the exit-code matrix with an `UpdateIo` whose every function throws a tagged error, and asserts that every escaping error carries the tag.
An untagged `ENOENT`, `EPERM` or `spawnSync` error means a real boundary was reached and the test fails.

REAL and deliberately not injected: the filesystem under `updateStateDir`, through `atomic-file.ts`, `journal.ts` and `lock.ts`.
Every path they touch is fixture-rooted in tests and profile-rooted in production, so a real write there is the behaviour under test rather than an escape.

REAL in the tests, not stubbed: `git` (a real local repo with a local origin remote, no network, reached through a logging shim that execs the real binary by absolute path), the real `scripts/luna-update-server` as the oracle, the real filesystem for journal/lock/atomic-file, and the CLI as a separate OS process.
Stubbed only at the PATH boundary the fixture owns: `systemctl` (with the settable MainPID queue), `curl`, `bun`, `incus` (passthrough with container-path rewriting), `claude` and `ss`.

ENFORCED BY GREP in CI, as a cheap structural check.
No `child_process` import in `update-flow.ts`, `terminals.ts`, `flow-lines.ts`, `commands.ts`, `numbers.ts`, `apply-inplace.ts`, `fresh-run.ts` or `restart-only.ts`.
No `process\.exit(` anywhere under `src/update/`, which now holds because `update-command.ts` moved out of that directory.
The pattern must be anchored on the open parenthesis: `lock.ts:208` and `restart.ts:38` both contain the English words "process exits" and "process exit" in comments, and a loose grep would report them.
No NEW `process.env` read under `src/update/`: the only permitted occurrence outside a comment is the pre-existing `bash-lib.ts:151` (`spawnBashSync`), and a second grep asserts that `spawnBashSync` has ZERO callers under `src/`, because this PR reaches bash through `seams.io.runBash` instead.
Together those keep `realSeams()` the single ambient-environment boundary.
No PR1 options record constructed under `src/` omits a seam that has an IO-performing default, checked by grepping each construction site against the seam list in INJECTED VERSUS REAL rather than by a regex; the reviewable form is that `wiring.ts` and `run-update.ts` are the only files that build such records, and both are short.
`reset --hard` in exactly one file.
`ROLLED BACK to` present in `rollback.ts`.
`git diff --stat` clean for `scripts/luna-update-server` and `test/helpers/update-server-fixtures.ts`.

## Test plan, per file

All of these live under `apps/deploy-cli/test/update/` and run in the DEFAULT `bun run test` gate (`vitest.config.ts` includes `apps/**/*.test.ts`), which means they execute on both the Linux runner and developer macOS.

HARD RULE, and the direct lesson of PR1: no test may assume macOS or this developer machine.
Anything touching spawn, exec, stat, symlinks, file modes or path resolution is either portable or explicitly platform-branched with a stated reason.
No test may spawn a helper with "whatever launched the tests"; every runtime is resolved explicitly by `resolveHostTool` (below).
No test may use an undeclared dependency.
No test may create a symlink as part of its own scaffolding, because a checkout or CI cache that does not preserve symlinks would then fail for a reason unrelated to the port; the `bash` and `git` entries in the fixture bin dir are two-line `#!/bin/sh` shims that `exec` an absolute path, not symlinks.

PER-TEST TIMEOUTS ARE MANDATORY AND EXPLICIT, which is concern 9.
The pre-existing readiness-failure parity tests already need them (`journal-parity.test.ts:118`, `:160`, `:167` each carry `{ timeout: 30_000 }`), and `update-flow-parity.test.ts` runs roughly thirty scenarios across two drives, several of them paying a three-second settle or readiness sleep per drive plus a full `makeFixturePair` build, in the DEFAULT `bun run test` gate.
Every dual-drive test carries `{ timeout: 60_000 }`, the retry-to-success rows carry `{ timeout: 120_000 }` because their thirty-second window is a real budget, and `compiled-artifact.test.ts` carries `{ timeout: 300_000 }` because it runs `bun build --compile` first.
A test that needs more than that is a test whose fixture is wrong.

THE `runUpdate` NAME COLLIDES, which is concern 19.
`bash-fixtures.ts:94` already exports `runUpdate` as the bash-drive runner and `run-update.ts` exports `runUpdate` as the in-process entry, so any file importing both needs an alias.
The rule is that test files import the bash one as `runBashUpdate` and the binary entry as `runUpdate`, and `bash-fixtures.ts` gains a re-export under the new name while KEEPING the old one, since renaming it would touch three green PR1 suites for cosmetic reasons.

**`terminals.test.ts`** (new, ~190 lines, pure, no fixtures, runs anywhere).
The tables under test as properties: every `Terminal` maps to a code in `{0,1,2,3,4}`; `lock-contention` and `lock-unacquirable` are both 4 when `restartOnly` and 0 otherwise; NO terminal whose code is 2 or 3 has disposition `"cleared"`; exactly `updated` and `rolled-back` have `"cleared"`; the union is exhaustive (a `never` check on the switch).

**`numbers.test.ts`** (new, ~90 lines, pure).
`readinessTimeout` rejects `0.3` and `""` and `abc` and accepts `60`; `007` is accepted, yields `7` for arithmetic and `007` for `readinessTimeoutRaw`; `readinessInterval` accepts `0.3` and `2`.
No `readinessPort` case exists, because the refusal is gone.
One test pins the KNOWN DIVERGENCE below by asserting the exact message the binary emits, with a comment naming this spec.

**`flow-lines.test.ts`** (new, ~140 lines, pure).
Every builder against a literal, as DOCUMENTATION only; the header says in so many words that this file proves nothing and that GATE 1's byte diff is the proof.

**`commands.test.ts`** (new, ~90 lines, pure).
Every argv against a literal, with the `incusRepinArgv` payload compared against the bytes read out of `scripts/luna-update-server:1237` at test time rather than against a transcription.

**`wiring.test.ts`** (new, ~180 lines).
The three-way repo-dir mapping asserted against config-derived fixtures: git calls carry `hostRepoDir`, bun and systemctl and the incus node_modules test carry `containerRepoDir`, and the host claude re-pin request carries `repoDir` verbatim.
This file is the ONLY place the third of those is checked, and the assertion is a unit-level one against a synthetic config in which the three values are deliberately made distinct.
Its comment must say why: no runtime path can make `repoDir` differ from `hostRepoDir` on the inplace layout (`:318-320`), so this assertion protects a future releases-layout fold rather than anything GATE 1 or GATE 2 could observe today.
The first two ARE observable and are additionally asserted end-to-end by GATE 1's incus topology, from `git.log` against `bun.log` and `incus.log`.
The four banner lines plus `Target ref:` asserted byte-exactly through the raw writer, which is the regression test for blocker B12.
The delegation adapter terminates its line, which is the regression test for concern 12.
The standalone guard's options carry both `incusContainer` and a target-routed `readUnitState`, which is the regression test for blocker B13.
`dreamWakeInstallScript()` probes the HOST path and returns a CONTAINER-relative path, in both the `apps/server` and `apps/ui-web` cases.
`seedDreamWakeJobs()` returns normally when the bun run fails and emits the FAILED warn.
The rollback closure emits `readinessGaveUpLine` on a false probe and takes its baseline at call time, which is the regression test for blocker B5.
This file exists because every parity suite injects AROUND `wiring.ts`, making it the one module the byte diff cannot isolate.

**`apply-inplace-parity.test.ts`** (new, ~360 lines).
The module with the abandon condition gets its own oracle suite, driven by `makeFixturePair` at the function level.
HEAD postcondition across a full 40-hex ref, a 7-char abbreviation, an UPPERCASE 40-hex ref, and a genuinely lying reset (a stub git that reports success without moving HEAD).
Lockfile gate both ways, asserting both stdout lines and that `bun.log` contains exactly one install line on the delta case and zero on the unchanged case.
The missing-`bun.lock` arm returns the empty string without invoking git at all, asserted through `git.log`.
The node_modules postcondition on an install that exits 0 and produces nothing, in BOTH arms, asserting that the bare-host arm creates no process and the incus arm creates exactly the `incus exec ... test -d` one.
The claude re-pin three-way on the incus arm (0, rc 9 degrade, other non-zero) and two-way plus degrade on the host arm, including the `claude.envPin: "stale"` case, which asserts the forwarded stale-pin stderr line byte for byte.
The `onCheckout` false path fails the apply with step `checkout-journal`.
The `noFetch: false` arm, which no real call site exercises and which therefore has zero coverage from the dual-drive diff.

**`restart-mainpid-parity.test.ts`** (new, ~230 lines).
MainPID crossed with `{changed -> pass, unchanged -> code 1 with the byte-exact POSTCONDITION warn, post-unreadable -> INCONCLUSIVE warn and pass, post-zero -> pass, pre-zero -> skip, pre-unreadable -> skip}`, driven by the fixture's already-built settable MainPID queue.
A rolling-back run restarts twice, so the queue must supply two pre/post pairs and the test must assert the second pair was consumed.
Plus the start-limit path: a systemctl stub whose first `start` fails and whose `is-failed` succeeds must produce `startLimitLatched` and the byte-exact `:1375` warn on both drives, in the same position in stderr, emitted BETWEEN the `is-failed` and the `reset-failed` entries in `systemctl.log`.
Plus the settle triple, at the function level rather than through the flow: `settled` emits only the `:1279` info, `skipped-invalid` emits only the `:1276` warn, `settled-sleep-failed` emits `:1279` then `:1283` in that order, and `skipped-zero` and `skipped-dry-run` emit nothing.
Plus one row per `GuardVerdict` arm through `restartServiceSync`, asserting that the guard line lands BEFORE anything the restart itself prints, matching bash's `:1509` being `restart_service`'s first statement.

**`update-flow-parity.test.ts`** (new, ~800 lines). THE GATE 1 SUITE.
Dual-drive, REAL (non-dry), mutating runs of both engines over `makeFixturePair`, diffing every artifact listed under GATE 1.
Scenarios, each run in bare-host and (for the first four) incus topologies:
happy path with the lock unchanged;
happy path with the lock changed, asserting `trace.log` shows install THEN restart THEN readiness THEN seed, in that order;
readiness-fail with rollback OK (exit 1, byte-exact `ROLLED BACK to`, and the give-up line present EXACTLY ONCE, for the forward probe only);
revision 2 said TWICE here and that is a fourth error this document corrects on its own evidence rather than an auditor's: `readiness_ok` emits the give-up warn at `:1124` only after the loop ends without returning, and on this scenario the rollback probe RETURNS 0 at `:1105` because the fixture's `readyAtPrev` is true, so it never reaches `:1124`;
the give-up line appears twice only on the rollback-also-fails row, where both probes exhaust;
apply-phase failure with the guard still ACTIVE (exit 3, checkout at PREV);
fresh-run guard defer with the `ss` stub reporting one established connection (exit 3, journal absent);
rollback also fails (exit 2, supervisor-conditional CRITICAL hint, and the CRITICAL line emitted BEFORE the phase write, asserted by crashing between them);
`--no-rollback` (exit 1, journal at phase=forward-failed, both `fail_forward` lines present);
corrupt journal (exit 2, checkout untouched), in three shapes: unparsable `phase=bogus`, a directory at the journal path, and a journal removed between the exists test and the load;
mid-transaction guard defer (exit 3, journal retained at phase=restarting);
resume from each of `prepared`, `checkout`, `applied`, `restarting`, `verifying`, `rolling-back`, `rollback-failed` and `forward-failed`, which is all eight phases the regex at `:1041` admits and closes concern 6;
`--ref <7-char abbrev>` and `--ref <UPPERCASE 40-hex>`, the two spellings where REF and NEW_HEAD separate;
a resume performs ZERO `git fetch`, asserted from `git.log`;
seed fires exactly once on the happy path and zero times on readiness-fail-rollback;
`--restart-only` crossed with `{ok, restart-fail -> 1, guard-defer -> 3, lock contention -> 4, climbing NRestarts -> 1}`, the last of which is the regression test for blockers B4 and B8;
the two NON-NEGOTIABLE journal-precedence rows that prove the `:1889-1913` fallthrough is intact: a pending phase=verifying journal completing normally (exit 0, journal cleared) and the same failing readiness (exit 1, `ROLLED BACK to`);
and the eight rows revision 3 adds, each of which exists because revision 2's gate was structurally blind to it.

| New row | Why it exists |
| --- | --- |
| happy path with `LUNA_RESTART_SETTLE_SECS=1` | the `:1279` settling info line, which fires on every production deploy and which a settle pinned to `0` can never show (R1) |
| happy path with `LUNA_RESTART_SETTLE_SECS=abc` | the `:1276` invalid-value warn and the proof that the restart still succeeds (R1) |
| happy path with a settle value whose sleep fails | the `:1283` sleep-failed warn, driven by a `sleep` stub that logs and exits 1, installed for this row ONLY; the row is a HAPPY path whose readiness succeeds on its first poll, so the settle is the only caller of `sleep` and a failing stub cannot spin the readiness loop; it also asserts the `:1279` line precedes the `:1283` one (R1) |
| fresh-run guard defer, `ss` stub `sessions: 2` | the `:1477` line AND the `:1999` caller line, in that order (R2) |
| guard `ss` stub `rc: 1` with the unit answering `inactive` | the `:1491` dead-server-exception line, on the permitted arm, which is the only guard line that appears on a SUCCESSFUL run (R2) |
| guard `ss` stub `rc: 1` with the unit answering `activating` | the `:1497` fail-closed line and exit 3 (R2) |
| `--restart-only` with MainPID unchanged | the `:1563` POSTCONDITION warn followed by `:1896`'s restart-errored warn, exit 1, proving `restart.ts` prints for restart-only too (R3) |
| `--restart-only` with a start-limit latch that then starts | the `:1375` warn on an otherwise SUCCESSFUL rung-1 restart, exit 0 (R3, concern 14) |

Plus the two readiness rows specified under READINESS DETERMINISM, retry-to-success and retry-to-exhaustion.

If the two journal-precedence rows cannot be made to pass, the restart-only factoring is what to change, not the scenarios.

**`compiled-artifact.test.ts`** (new, ~80 lines).
Runs `bun build --compile --outfile=<tmp>/deploy-cli apps/deploy-cli/src/main.ts` once, then re-runs ONE happy-path scenario with the compiled binary in the Drive B position and diffs it against the same bash drive.
This exists because the compiled single-file binary is what `scripts/luna-guardian:1216-1219` actually publishes, and every other scenario runs `bun main.ts` for speed.
If `bun` cannot be resolved the test THROWS with the resolution message; it does not skip.

**`interop-parity.test.ts`** (new, ~250 lines).
Bash crashes at each phase via `LUNA_TEST_CRASH_AFTER_PHASE` (`:1017-1020`) and the binary completes the transaction.
In reverse, the binary writes a journal and bash's `load_transaction` (`:1028-1044`) parses and completes it; the binary ships NO self-SIGKILL seam, so the reverse direction is driven by writing a journal and then invoking bash.
A bash lock holder defers the binary and vice versa, with the owner file read by the other engine's `lock_owner_alive`.
The binary-killed-mid-deploy case takes stale takeover, and its extra `removing stale update lock for profile '<p>'` stderr line is asserted as a KNOWN divergence, not masked.
Per platform, assert WHICH lock-fingerprint branch ran (`/proc` on Linux, `ps` fallback on macOS) so neither silently stops being covered.

**`exit-code-matrix.test.ts`** (new, ~260 lines).
The contract table as one readable suite, driven through `runUpdate` in-process with a fully injected `UpdateIo`, with each of the four session-guard defer sites kept distinct from the two lock sites.
Two rows exist purely for THE ARGV CONTRACT: `["update", ...flags]` parses, and `[...flags]` without the token throws `forwardedFlags`'s message rather than returning an exit code.
Two rows exist purely for the lock: `contended` and each of the three non-contended reasons produce 0 without `--restart-only` and 4 with it.
Plus the ordering invariants that have no test today because there was no caller: delegation happens strictly BEFORE lock acquisition; every preflight refusal and every config refusal exits 1 with the lock dir absent; the lock dir is absent after EVERY terminal path including exit 2 and exit 3; the exit hooks are uninstalled, asserted by running the whole matrix in one process and checking `process.listenerCount("exit")` returns to its starting value.

**`readiness-retry.test.ts`** (new, ~120 lines).
The retry assertions the poll-collapse normalisation depends on, described in full under GATE 1: READINESS DETERMINISM.
Per drive, never cross-drive: each engine is driven with `readyAfterCalls: 3` and must exit 0 with exactly three `/healthz` entries in its own `curl.log`.
Its file header states that deleting this suite invalidates the normalisation rule and therefore the gate.

**`stub-fidelity.test.ts`** (new, ~110 lines).
The guard on blocker R11's mechanical risk.
It builds `makeStubBin`'s ORIGINAL `curl` and `bun` from `test/helpers/update-server-fixtures.ts` and `bash-fixtures.ts`'s trace-emitting REPLACEMENTS over the same option matrix, invokes both with the same argv at the same repo HEAD, and asserts byte-identical stdout and identical exit status.
The trace line is excluded from the comparison, being the one intended difference.
Without this, the re-implementation can drift from its source and every scenario keeps passing because both drives use the drifted copy.

**`guard-lines.test.ts`** (new, ~90 lines, pure).
`guardVerdictLine` over every member of the `GuardVerdict` union, asserting the five payloads byte-exactly and `null` for the four silent arms, plus an exhaustiveness check that a new `reason` is a compile error rather than a silent `null`.

**`no-ambient-io.test.ts`** (new, ~120 lines).
Described under INJECTED VERSUS REAL.
It is the structural guarantee that no in-process test can reach a real `systemctl`, `ss`, `ps`, `sleep`, `incus` or `bash`.

**`delegation-boundary.test.ts`** (new, ~140 lines).
`--dry-run`, `--layout releases`, `--supervisor launchd` and `--user` each reach `delegateToBashSync` with `rawArgs === rawArgv`, the correct narrowed `DelegationFlag`, an injected `runEngine` that records its argv and env, and an exit code returned VERBATIM.
The marker line is terminated exactly once.
The lock dir does not exist afterwards.
This suite is NOT a parity oracle and the file header says so: `--dry-run` proves only that the binary hands the whole run to bash and passes the code through.

## THE ACCEPTANCE GATE

### Why the old gate is dead, and must not be proposed again

The previous revision's gate was "the binary performs a REAL `--dry-run` against a real profile, and its output is diffed against the bash engine doing the same thing on the same inputs".
That gate is deleted in full.
It cannot prove anything, for three independent reasons, and each one is fatal on its own.

FIRST, the diff is bash against itself.
`config.ts:271-277` (the `dryRun` arm of `delegationFor`) delegates `--dry-run` back to the bash engine UNCONDITIONALLY, including on the inplace-on-systemd topology the binary owns, and `delegate.ts`'s spawn inherits stdio.
So `deploy-cli update --dry-run` IS `luna-update-server --dry-run` running one process deeper, plus one stderr marker line.
Diffing the two is diffing bash against itself, and that diff passes by construction while `apply-inplace.ts` and `update-flow.ts` are still empty files.

SECOND, the live half never reaches the binary at all.
`scripts/luna-autodeploy:511-514` returns at the DRY-RUN echo, which sits ABOVE `luna_pin_engine` at `:518` and ABOVE `luna_select_engine` at `:524`.
`LUNA_DEPLOY_ENGINE=binary` is therefore never consulted on a dry run, and the binary is never invoked.
The repair ladder has the identical short-circuit at `:603-607`, and an already-up-to-date host returns even earlier at `:480-485`.
What the old gate actually diffed was a single `[autodeploy:<profile>] DRY-RUN: ...` echo line against `luna-update-server`'s multi-line plan block, which can only be made green by hand-tuning.
`luna-autodeploy <profile> --dry-run` is a FLAG RENDERER, not an engine invocation, and this document uses it for exactly that and nothing else.

THIRD, implementing a native dry-run is not the fix either.
Bash's inplace dry-run block (`:1639-1698`) is a hand-authored print sequence that never calls `apply_ref_inplace`: it prints the `bun install` line UNCONDITIONALLY, never computes or compares the lockfile hash, never runs the HEAD postcondition, skips the unit-existence preflight (`:478`), and short-circuits `restart_session_guard` to 0 (`:1461-1465`).
There is no dry-run path THROUGH the ported logic to diff.
Porting it would mean transcribing a fake into TypeScript and then testing the transcription against itself, while the live transaction changes underneath both.

The replacement has two parts.
GATE 1 is hermetic, automated and runs in CI on every push.
GATE 2 is live, run by hand exactly once, with its evidence pasted into the PR.
Both must pass.
GATE 1 alone does not ship this PR, because the fixture rewrites container paths in order to run at all and is therefore structurally weakest at exactly the plumbing GATE 2 exercises.

### THE HARNESS CONTRACT

Everything in this subsection is shared by GATE 1 and by the per-module parity suites, and it is stated once here because it is what makes any diff meaningful.

**One interpreter, resolved once.**
`resolveHostTool(name)` scans the AMBIENT `process.env.PATH` (the test runner's own, never a fixture env), returns the first executable regular file named `name`, and THROWS a message naming the fix when there is none.
It then asserts the resolved absolute path is not inside any fixture root, and throws if it is.
This is the fix for blocker B17: under `bun run test` the vitest process is Node, not Bun (measured: `vitest run` reports `process.versions.bun === undefined`), so the old "use `process.execPath` when `process.versions.bun` is set, else look up `bun` on PATH" rule always took the PATH branch, and the PATH it would have searched is the fixture's, whose first entry contains a `bun` that logs its argv and exits 0.
The natural implementation of the old rule therefore "ran the binary" by running a stub.

`resolveHostTool("bash")` and `resolveHostTool("git")` are computed once per suite.
The resolved `bash` is used in three places, so that both drives run the SAME interpreter: it is `spawnSync`'s argv[0] for Drive A, it is written into the fixture bin dir as a `#!/bin/sh` shim named `bash` that `exec`s the absolute path, and every `#!/usr/bin/env bash` shebang in the engine and in the stubs therefore resolves to it on both drives.
A shim rather than a symlink, because no test may depend on symlink support.
This is the fix for blocker B19: the interpreter is pinned explicitly instead of depending on Node's argv[0] resolution rule, and the fixture's stubs, the engine and Drive A can no longer disagree about which bash is running.
That matters concretely because bash 3.2 and bash 5.x differ in `[[ ]]` regex handling, in `${var,,}` support (a bash-4 feature whose absence makes bash 3.2 print "bad substitution" and then EXIT 0), and in arithmetic-error handling, all of which this engine and its stubs exercise.
Revision 2 justified the pin with `printf %q`, which concern 8 correctly points out is wrong for this gate: `luna_run` only renders with `%q` under `DRY_RUN` (`scripts/lib/luna-deploy.sh:9-17`), and GATE 1 is entirely non-dry, so no `%q` output exists on the diffed path.
The pin is still right; only its stated reason changes.

**One environment map, both drives.**
`driveEnv(fixture)` returns the SAME keys and values for both drives, and it does NOT spread `process.env`.
That spread was the source of the asymmetry the audit found (concern 18, blocker B19): `bash-fixtures.ts:97` currently spreads the whole ambient environment into Drive A while `runBinaryUpdate` was specified as an explicit override, and `scripts/luna-update-server:43` exports `HOME="${HOME:-/root}"`, which `luna_find_bun`'s `$HOME/.bun/bin/bun` fallback (`scripts/lib/luna-deploy.sh:450-454`) then reads.

The map is exactly:

```
PATH=<fixture bin>:/usr/bin:/bin
HOME=<fixture root>/home
LANG=C
LC_ALL=C
TZ=UTC
LUNA_RESTART_SETTLE_SECS=<per-scenario, default "0">
LUNA_TEST_BUN_PATH=<fixture bin>/bun
LUNA_UPDATE_STATE_DIR=<fixture root>/update-state
LUNA_DEPLOY_BASH_ENGINE=<repoRoot>/scripts/luna-update-server
```

`driveEnv` MKDIRS `<fixture root>/home` before returning, which is concern 21: `luna_find_bun`'s `$HOME/.bun/bin/bun` fallback (`scripts/lib/luna-deploy.sh:450-454`) and git's config lookup both read it, and a directory that exists on one drive and not the other is exactly the asymmetry this map exists to remove.

`LUNA_RESTART_SETTLE_SECS` defaults to `"0"` for speed, but it is a PER-SCENARIO value, not a constant, which is the first half of blocker R1.
Production defaults it to `"6"` (`config.ts:362`), so the `:1279` settling info line fires on every real deploy, and a gate that always pinned it to `0` could never see it; the scenario list below adds three rows that set it to `"1"`, to `"abc"` and to a value whose sleep fails.

`LUNA_DEPLOY_BASH_ENGINE` is set on BOTH drives even though bash ignores it, so that the two maps are literally identical and no future reader has to reason about which keys are drive-specific.

`LUNA_TEST_WS_COUNT` is ABSENT from `driveEnv` and from `driveEnv` ONLY, which is blocker R21 and concern 4.
Revision 2 said the variable is "removed from `bash-fixtures.ts:97`'s defaults for every suite in this PR", and `bash-fixtures.ts:94-97` is the SHARED legacy `runUpdate` helper that `config-parity.test.ts`, `journal-parity.test.ts` and `restart-guard-parity.test.ts` already drive, 23 call sites between them.
Removing it there would drop those green suites into `luna_active_ws_count`'s real probe (`scripts/lib/luna-deploy.sh:281-284`), which on a developer macOS has no `ss` at all and returns UNKNOWN, so every one of those runs would fail closed into an exit-3 defer.
`bash-fixtures.ts:94-97` is therefore left BYTE-UNCHANGED, `driveEnv` is a separate new function that simply never sets the variable, and the PR body states that the legacy helper and the new dual-drive helper deliberately have different test-seam surfaces.

**Session-guard determinism comes from an `ss` stub, on both drives.**
This is the fix for blockers B6 and B15, and it is a decision made here rather than at test time.
`session-guard.ts:35-39` and `:182-184` state that this port has no `LUNA_TEST_WS_COUNT` seam and never will, because an ambient test variable that can spoof a fail-closed decision is exactly what that module refuses to have.
So the bash drive can no longer be pinned by `LUNA_TEST_WS_COUNT` either, or the two engines take structurally different probe paths: bash short-circuits at `scripts/lib/luna-deploy.sh:268-273` while the port runs `spawnSync("ss", ...)` at `session-guard.ts:195`, which on macOS does not exist and on the self-hosted Linux runner counts the REAL host's established sockets on the readiness port.

`bash-fixtures.ts` therefore adds an `ss` stub to the layered bin dir, with a knob:

```
#!/usr/bin/env bash
printf 'ss %s\n' "$*" >> "<trace.log>"
printf 'ss %s\n' "$*" >> "<ss.log>"
# One line per simulated established connection; zero lines = zero sessions.
n=<sessions>
i=0; while [[ $i -lt $n ]]; do printf 'ESTAB 0 0 127.0.0.1:<port> 127.0.0.1:12345\n'; i=$((i+1)); done
exit <rc>
```

`sessions: 0` with `rc: 0` is the default and means zero sessions; `sessions: 2` drives the live-sessions defer; `rc: 1` drives the UNKNOWN arm that both engines must fail closed on.
Both `luna_active_ws_count`'s bare-host arm (`scripts/lib/luna-deploy.sh:283-287`) and `queryActiveWsCountSync`'s bare-host arm (`session-guard.ts:195-199`) pass the filter as ONE quoted argv word and count lines, so one stub serves both.
The incus arm needs nothing extra: both engines exec `sh -c "command -v ss ...; ss ..."` through the fixture's `incus` passthrough, the payload inherits the fixture PATH, and `command -v ss` finds this same stub.

The `ss` stub is written UNCONDITIONALLY by `makeFixture` and `makeLightFixture`, with `sessions: 0` and `rc: 0` as the default, not gated behind an option.
That is what lets `driveEnv` omit `LUNA_TEST_WS_COUNT` safely: the bash drive's `luna_active_ws_count` finds a real `ss` on the fixture PATH and counts zero lines, instead of failing closed.
It also means the legacy `runUpdate` helper gains an `ss` stub it did not have, which is harmless there because `LUNA_TEST_WS_COUNT=0` short-circuits before the probe (`scripts/lib/luna-deploy.sh:268-273`).
The three pre-existing suites must be re-run green after this change and the PR body records that they were, since the stub is not opt-in.

The PR body must state that the two engines now have different test-seam surfaces on purpose, so that a future hostenv suite does not rediscover this.

**The readiness flags are per-scenario, not fixture constants.**
`bash-fixtures.ts:404-421` currently hardcodes `--readiness-timeout 2 --readiness-interval 0.3` into every fixture's `args`.
`makeFixture` and `makeFixturePair` gain a `readiness?: { timeout: string; interval: string }` option that overrides those two argv entries and nothing else.
Its DEFAULT stays `{ timeout: "2", interval: "0.3" }`, byte-identical to today, so the three existing PR1 suites see no change at all; the same reasoning as blocker R21, which is that a green suite is not this PR's to perturb.
`update-flow-parity.test.ts` passes `{ timeout: "2", interval: "3" }` on every scenario, which is the exactly-one-iteration pair proven under GATE 1: READINESS DETERMINISM, and the two rows under that section's half (b) pass their own values.
The values travel as STRINGS, matching the raw-spelling rule and matching how they reach both engines' argv.

**One shared ordered trace.**
This is the fix for the second half of blocker B18.
`test/helpers/update-server-fixtures.ts:113-116` gives `systemctl`, `curl` and `bun` three independent append targets with no shared sequence, so cross-stub ORDER is unobservable: a binary that ran `bun install` after the restart, or probed readiness before it, or seeded dream/wake before clearing the journal, diffs clean on every per-stub log.
Every stub in `bash-fixtures.ts`'s layered bin dir therefore appends `<name> <argv>` to a single `trace.log` in the fixture root IN ADDITION to its own log, as its first line, before doing anything else.
The stubs are `systemctl`, `curl`, `bun`, `incus`, `claude`, `ss` and `git`.

WHERE THOSE STUBS LIVE, which is blocker R11 and which revision 2's one-line edit summary hid.
Three of the seven, `systemctl`, `curl` and `bun`, are today defined ONLY inside `test/helpers/update-server-fixtures.ts:126-189`, which this document forbids editing, and `bash-fixtures.ts` currently replaces `systemctl` only when the opt-in `mainPid` option is passed (`bash-fixtures.ts:347-348`) and never touches `curl` or `bun` at all.
So `makeFixture` and `makeLightFixture` in `bash-fixtures.ts` now ALWAYS overwrite all three in the layered bin dir, after `makeStubBin` has written its own, with trace-emitting replacements.
The `curl` and `bun` replacements are byte-faithful re-implementations of `update-server-fixtures.ts:142-187`, carrying a comment that pins them to those exact lines and requires a reviewer to diff the two.
`curl` in particular interpolates six options (`readyAtTarget`, `readyAtPrev`, `setupAtTarget`, `omitBuildShaAtTarget`, `omitBuildShaAtPrev`, `mismatchBuildShaAtPrev`) whose semantics every scenario depends on, so the re-implementation is the single riskiest mechanical step in the harness and gets its own assertion: a `stub-fidelity.test.ts` drives the ORIGINAL `makeStubBin` curl and the replacement over the same option matrix and the same HEAD values and asserts byte-identical stdout, which is what stops the re-implementation drifting from its source.
The replacement `curl` gains ONE option the original does not have, `readyAfterCalls`, used only by the retry scenario under READINESS DETERMINISM; it counts its own invocations in a file beside the log and answers not-ready until the count is reached.
Duplicating a stub is worse than editing one, and it is chosen anyway because editing `update-server-fixtures.ts` would put a 273-test hostenv suite inside this PR's blast radius while the whole point of the parity gate is that the oracle side is untouched.
`git` is a new entry and it is a SHIM, not a stub: it appends to `trace.log` and `git.log`, then `exec`s `resolveHostTool("git")` by absolute path with the original arguments, so git stays real while its call sequence becomes observable.
Without the git shim, "a resume performs ZERO `git fetch`" has no artifact to assert against.

THE REPLACEMENT `curl` MUST CALL GIT BY ABSOLUTE PATH, BYPASSING THE SHIM, and this is load-bearing for the whole gate rather than a detail.
`update-server-fixtures.ts:143` has the curl stub run `git -C <repo> rev-parse HEAD` as its first action after its own log line, and the fixture bin dir is first on `PATH` with nothing anywhere in `scripts/luna-update-server` or `scripts/lib/luna-deploy.sh` re-ordering it, so a bare `git` inside the stub resolves to the shim.
Each readiness poll would then append one or two `git` entries to `trace.log` and `git.log`.
That breaks the gate in two separate ways at once: `git.log` becomes exactly as poll-count-dependent as the logs the determinism section admits it cannot pin, so the STRICT diff flakes red on a CORRECT implementation; and the poll-block definition below stops matching anything real, so the collapse never fires and the one scenario that needs it is compared strictly against a varying log.
The replacement therefore invokes `resolveHostTool("git")` by absolute path.
The consequence is the property the gate needs: `git.log` records ONLY the flow's own git calls, which are deterministic, so it stays STRICT on every scenario including retry-to-exhaustion, and no readiness poll contributes a `git` entry to any artifact.
`stub-fidelity.test.ts` asserts this directly: it drives the replacement `curl` once and asserts `git.log` is unchanged by that invocation, which fails loudly if the absolute-path resolution is ever reverted to a bare `git`.

**Drive definitions.**

Drive A, the oracle:

```ts
spawnSync(BASH, [join(repoRoot, "scripts/luna-update-server"), ...fixture.args], {
  cwd: repoRoot, env: driveEnv(fixture), encoding: "utf8",
})
```

Drive B, the binary as its own OS process, never `runUpdate` in-process and never `delegateToBashSync`, because that is the only way `wiring.ts`, `run-update.ts` and `update-command.ts` end up on the diffed path:

```ts
spawnSync(BUN, [join(repoRoot, "apps/deploy-cli/src/main.ts"), "update", ...fixture.args], {
  cwd: repoRoot, env: driveEnv(fixture), encoding: "utf8",
})
```

`BUN` is `resolveHostTool("bun")`, resolved from the AMBIENT PATH with the not-inside-the-fixture assertion.
The spawned artifact is `bun main.ts` for every scenario except `compiled-artifact.test.ts`, which spawns the `bun build --compile` output because that is what guardian publishes; both are stated rather than left to the implementer.

### GATE 1: hermetic full-flow parity, automated, in CI

Both engines drive the ENTIRE state machine over identical fixture inputs, non-dry and mutating, on two INDEPENDENT fixture roots built by `makeFixturePair`, which already pins commit dates and asserts both repos hashed identically.
Every scenario listed under `update-flow-parity.test.ts` runs on both drives, and every observable artifact is compared after masking, byte for byte except for the one narrowly scoped normalisation described immediately below.

### GATE 1: READINESS DETERMINISM

This subsection implements DECISION 1 and it is a precondition for everything else in the gate, so it comes first.

**The problem, restated with the measurement.**
`readiness_ok` polls against a wall clock: `:1071` sets `deadline=$((SECONDS + READINESS_TIMEOUT))`, `:1074` loops `while (( SECONDS < deadline ))`, and `:1122` sleeps `READINESS_INTERVAL` at the bottom of each iteration.
Each iteration spawns `systemctl is-active`, possibly `systemctl show --property=NRestarts`, and one or two `curl`s, so the number of lines in `trace.log`, `systemctl.log`, `curl.log` and, on the incus topology, `incus.log`, is a function of subprocess latency.
Measured, bash against bash, same fixture options, four runs: `curl.log` 6/7/7/7 lines and `systemctl.log` 20/22/22/22.
The fixture's historic `--readiness-timeout 2 --readiness-interval 0.3` (`bash-fixtures.ts:415-416`) is what produces that spread.
Revision 2 simultaneously required byte-identical logs, forbade a fourth masking rule, and enumerated at least six scenarios that must fail readiness; that triple has no solution and no amount of care would have made one.

**Half (a): pin the iteration count.**
Every GATE 1 scenario runs with `--readiness-timeout 2 --readiness-interval 3`, and with those two values EVERY readiness call performs EXACTLY ONE poll iteration on BOTH drives.
The proof does not depend on machine speed, which is why this pair and not another.

For bash: let `e` be the real seconds elapsed since shell start when `:1071` executes, so `SECONDS` reads `S = floor(e)` and `deadline = S + 2`.
The first evaluation of `:1074` happens two assignments later, so the elapsed time is still under `S + 1`, hence strictly under `deadline`, with a margin of at least one whole second; the first iteration therefore ALWAYS runs, whatever the machine.
`sleep 3` at `:1122` guarantees at least three further real seconds, so the second evaluation sees `SECONDS >= S + 3 > deadline` and the loop ALWAYS ends; the second iteration therefore NEVER runs, whatever the machine.
The margin on each side is at least one second and neither bound involves per-iteration cost, so there is no flakiness window to argue about.

For the port: `readiness.ts:145` computes `deadline = now() + timeoutSecs` where `now()` is truncated to whole seconds (`probes.ts:244-246`), so with `now()` reading `N` at entry the deadline is `N + 2`; the first `now() < deadline` check is `N < N + 2`, always true, and after `sleep(3)` the clock reads at least `N + 3`, always false.
Exactly one iteration, by the same argument, and with no dependence on when `makeMonotonicSeconds` was anchored.

A poll that SUCCEEDS returns from inside the iteration, before the sleep (`readiness.ts:164`, `:170`, `:177`, `:183`; bash `:1095`, `:1100`, `:1105`, `:1111`), so a passing readiness call costs one iteration and NO sleep, and a failing one costs one iteration plus one three-second sleep.
The per-scenario cost is therefore three seconds per failing readiness call, and the scenarios that fail readiness twice, the rollback-also-fails and the forward-plus-rollback-probe rows, cost six.

Stated per scenario, since DECISION 1 requires the number rather than the rule:
every happy-path, resume, guard-defer, corrupt-journal, lock and delegation scenario performs ZERO or ONE readiness call, each of one iteration;
readiness-fail-with-rollback-OK performs two calls, the forward one of one iteration ending in give-up and the rollback one of one iteration ending in success;
rollback-also-fails and `--no-rollback` and the restart-only climbing-NRestarts row each perform their calls at one iteration apiece, ending in give-up;
and the two rows named under half (b) are the only ones that do anything else.

**Half (b): the two scenarios that cannot be pinned, and what happens to them.**
Pinning everything to one iteration would leave the retry loop itself completely uncovered: a port that ran the body once and returned would pass every scenario above.
So two scenarios, one bare-host and one incus, are added specifically to exercise multiple polls, and they are the ONLY place any normalisation is applied.

The RETRY-TO-SUCCESS scenario uses `--readiness-timeout 30 --readiness-interval 0.3` and the replacement `curl` stub's `readyAfterCalls: 3`.
It terminates on SUCCESS at the third poll, not on the deadline, so the iteration count is three on both drives BY BEHAVIOUR, and it stays a STRICT byte diff.
Its one assumption is that three iterations complete inside a window of at least 29 seconds, i.e. that a poll costs under about 9 seconds; if a runner ever violates that the scenario does not go quietly green, it changes its EXIT CODE from 0 to 1 and fails loudly.

The RETRY-TO-EXHAUSTION scenario keeps the fixture's historic `--readiness-timeout 2 --readiness-interval 0.3`, which is the production-shaped case (`config.ts:359-360` defaults are 60 and 2) and is the measured 6/7/7/7 one.
Its iteration count CANNOT be pinned, and this document says so plainly rather than pretending otherwise: the count is `ceil(window / (interval + per-iteration cost))`, the window varies over a one-second range because `SECONDS` is integral, and the per-iteration cost is the machine's.
For this scenario only, `trace.log`, `systemctl.log`, `curl.log` and, on the incus topology, `incus.log` are compared in NORMALISED form.

**The normalisation rule, and why it is not masking.**
NORMALISATION RULE (the fourth rule, and the only one added since revision 2): in `trace.log`, `systemctl.log`, `curl.log` and `incus.log`, and only for the retry-to-exhaustion scenario, a maximal run of two or more consecutive repetitions of an identical readiness-poll block is replaced by ONE copy of the block followed by the fixed token `<POLL-REPEATED>`.
A readiness-poll block is defined OVER THE ENTRIES THE STUBS ACTUALLY WRITE, in both topologies, because revision 3's definition described a sequence the harness never produces and so never collapsed anything.

Two things make the real sequence differ from the naive one, and the definition accounts for both.
The first is now gone by construction: the replacement `curl` calls git by absolute path (see THE REPLACEMENT `curl` above), so no poll contributes a `git` entry and no block is interrupted by one.
The second is the incus topology, which this scenario includes.
`scripts/luna-update-server:1387-1389` routes `sup_is_active` through `run_target_capture`, and `run_target_capture` (`:361-369`) wraps every probe as `incus exec <container> -- <argv>`, while the incus stub (`bash-fixtures.ts:124-176`) logs and then re-execs the payload.
So on that topology each probe yields an `incus exec ... -- <cmd>` entry IMMEDIATELY followed by the `<cmd>` entry itself.

A poll block is therefore the contiguous run of entries matching, in order, the four probe commands `systemctl [--user] is-active <unit>`, `systemctl [--user] show <unit> --property=NRestarts --value`, `curl ... /healthz`, `curl ... /readyz`, where any suffix of the last three may be absent, and where on the incus topology each of those entries may be immediately preceded by its own `incus exec <container> -- <that same argv>` wrapper.
Matching is on the payload argv, so one definition serves both topologies rather than two definitions drifting apart.
Nothing else is collapsible: a run containing any command outside that set is left alone entirely.
`normalisePollBlocks` is unit-tested against captured fixtures from BOTH topologies, asserting that a two-iteration log and a three-iteration log normalise to the same bytes and that a log differing in any non-poll entry does NOT.
That second assertion is what keeps the collapse from quietly swallowing a real difference.
The repeat COUNT is deliberately not compared, because the count is precisely the non-deterministic dimension.

The difference between this and masking, stated once so nobody has to relitigate it: normalisation collapses a dimension whose behaviour is asserted somewhere else, whereas masking hides a difference that nothing else checks.
The retry behaviour this rule collapses is asserted in three places, none of which relies on the byte diff.
FIRST, `readiness-retry.test.ts` (new, ~120 lines) drives EACH engine independently, not against the other, with `readyAfterCalls: 3`, and asserts on each drive separately that `curl.log` contains exactly three `/healthz` entries and that the run exits 0; that is the positive proof that the loop retries and that a late-ready server is accepted.
SECOND, the retry-to-exhaustion scenario itself asserts, per drive and outside the diff, that the pre-collapse block count is at least two, so a port that stopped retrying would fail even though its collapsed logs would match.
THIRD, `readiness.ts`'s own PR1 unit suite already pins the loop against an injected clock, where the iteration count is exact by construction.
If any of those three assertions is deleted, this normalisation rule becomes masking and must be deleted with it.

Any FIFTH rule, and any application of the fourth rule to a scenario other than retry-to-exhaustion, is a DISQUALIFYING weakening of the gate and must be argued in the PR body rather than added quietly to make a scenario pass.

**Which artifacts are which.**
STRICT byte diff, on every scenario without exception, because none of them is written per poll: exit code, full stdout, full stderr, the final journal bytes or its absence, the lock-dir presence, the final `git rev-parse HEAD`, `$ENV_FILE` bytes and mode, `bun.log`, `claude.log`, `ss.log`, `git.log`, and the sorted path-plus-mode listing.
`readiness_ok` prints nothing inside its loop, in either engine, so stdout and stderr are poll-count-independent even on the exhaustion path; the give-up line is emitted exactly once, after the loop.
STRICT byte diff on every scenario EXCEPT retry-to-exhaustion, where the normalised form is compared instead: `trace.log`, `systemctl.log`, `curl.log`, and `incus.log` on the incus topology.

### The artifacts

The artifacts, all of them:

1. Exit code.
2. Full stdout.
   This is where the engine's entire narrative lives, since `luna_info` writes to stdout.
   Pin at minimum the preflight banner, `Target ref:`, `Current HEAD:`, whichever of the two bun.lock decision lines the scenario takes, `Checked out:`, the TWO seed lines, the settling line when the scenario sets a non-zero settle, and `updated ${prev} -> ${newHead} (${serviceName} healthy)`.
   TWO seed lines, not three, which is concern 7: `seed_dream_wake_jobs` (`:1716-1725`) emits the start line at `:1718` and then EXACTLY ONE of `:1720` or `:1722`, never both.
   Measured on the fixture happy path: `-> post-deploy: seeding V2 dream/wake job rows (idempotent)` followed by `-> post-deploy: dream/wake job rows ensured`.
3. Full stderr.
4. `trace.log`, the single shared ordered trace.
   It is the ONLY artifact that can prove sequencing across collaborating subprocesses, and a scenario that passes every other artifact while failing this one is a real ordering defect, not a harness artifact.
   Compared strictly on every scenario except retry-to-exhaustion, where the poll-collapsed form is compared; see WHICH ARTIFACTS ARE WHICH above.
5. The per-stub logs: `systemctl.log`, `curl.log`, `bun.log`, `incus.log`, `claude.log`, `ss.log`, `git.log`.
   `systemctl.log`, `curl.log` and, on the incus topology, `incus.log` carry the same one-scenario normalisation as `trace.log`; the other four are strict everywhere.
   `git.log` is what makes "a resume performs ZERO `git fetch`" assertable, and it is strict on every scenario because no poll touches git - which is TRUE ONLY BECAUSE the replacement `curl` resolves git by absolute path and bypasses the shim.
   That is not an incidental detail of the stub: revert it to a bare `git` and this line becomes false, `git.log` inherits the poll count, and the strict diff starts flaking red on a correct implementation.
   `stub-fidelity.test.ts` pins it, and this sentence is the reason that assertion exists.
6. The final journal bytes, or the fact of its absence.
7. The presence or absence of the lock dir, which must be ABSENT after every terminal on both drives.
8. `$ENV_FILE` bytes AND its mode, as `mode & 0o777` rendered octal.
   See WHAT ARTIFACT 8 ACTUALLY OBSERVES, below, for the corrected and much narrower claim.
   `$ENV_FILE` is `$LUNA_HOME/.env` (`:342`), written mode 600 by `scripts/lib/luna-deploy.sh:48/63/85`.
9. Final `git rev-parse HEAD` on the deploy checkout, which proves the reset postcondition against real git rather than a mock.
10. A sorted listing of every path under the fixture root with its mode, relative to the root.

### WHAT ARTIFACT 8 ACTUALLY OBSERVES

This implements DECISION 2, and it deletes a credit revision 2 claimed three times (in `apply-inplace.ts` step 6, in `wiring.ts`'s repo-dir paragraph, and in artifact 8 itself).

The withdrawn claim is that artifact 8 catches the host claude re-pin being handed `hostRepoDir` instead of `repoDir`.
It does not and cannot, for the reason given in full under THE REPO-DIR AXES: `:318-320` makes `REPO_DIR`, `HOST_REPO_DIR` and `CONTAINER_REPO_DIR` the same string on every bare-host run, and `:1221` sends every incus run to the container arm which never reads `repoDir`.
The audit's own proposed rescue, planting an executable under `<work>/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude` so `luna_find_claude_executable`'s `find` branch answers with a `repo_dir`-rooted path (`scripts/lib/luna-deploy.sh:112-121`), does not rescue it either, because that path would be rooted at a directory all three variables name.
Adding a fixture topology in which the two repo dirs differ is worth doing on its own merits and IS specified, but it moves the container-versus-host axis, not the `repoDir` axis: `makeFixturePair`'s incus topology already sets `CONTAINER_REPO_DIR=/root/luna` against a host `HOST_REPO_DIR`, and GATE 1 now asserts that split directly from `git.log` (host paths) against `bun.log` and `incus.log` (container paths).

What artifact 8 DOES observe, which is worth keeping and is why it stays on the list:
that the two engines agree on whether the file exists at all;
that they write identical bytes when it is written, which covers the pin value, the key spelling and the trailing newline;
that they agree on mode 600, which is a secrets-file posture regression the rest of the gate would miss entirely;
and, on the `claude.envPin: "stale"` scenario, that the stale-pin removal happened identically, which is the observable half of the `bash-lib.ts:257-262` stderr-forwarding requirement.

For any of that to be non-trivial the file has to be WRITTEN, and it is not written by default: with no `claude` option the fixture plants no `claude` on PATH, `luna_find_claude_executable` finds nothing, and `$ENV_FILE` is absent on both drives, which is an artifact comparison of "absent equals absent".
So every GATE 1 scenario runs with `claude: { stub: "present" }` unless the scenario is specifically about the degrade path, and two dedicated rows carry `claude: { stub: "present", envPin: "stale" }` and `claude: { stub: "absent" }`.
With the stub present the written bytes are `LUNA_CLAUDE_CODE_EXECUTABLE=<fixture bin>/claude\n` at mode 600, which was measured, and which both drives must produce identically.

The defect class artifact 8 was wrongly credited with, "a host-perspective path written into a container's `.env`", is caught ONLY by GATE 2, and GATE 2 Half A now captures exactly that: the container-side `/root/.luna/.env`, read through the same `run_target` seam the engine uses, before and after the run, with its `LUNA_CLAUDE_CODE_EXECUTABLE` value and its `stat` mode. See GATE 2 Half A's capture list.

### Masking, and what disqualifies

MASKING is a closed list of exactly THREE rules, unchanged from revision 2:
the drive's own fixture root path is replaced with a fixed token wherever it appears;
the journal's `updated_at=<digits>` value is replaced with a fixed token;
and the numeric pid inside a lock owner record is replaced with a fixed token, which only matters if a future scenario captures a live lock dir, since every current scenario asserts its absence.
Any FOURTH masking rule is a DISQUALIFYING weakening of the gate and must be argued in the PR body, not added quietly to make a scenario pass.

The poll-collapse rule under READINESS DETERMINISM is a NORMALISATION rule, is counted separately, applies to one named scenario and four named logs, and is legitimate only for as long as the three retry assertions named there exist.
The two lists are kept apart on purpose so that "we added a rule" is always a question with a yes-or-no answer.

DISQUALIFYING differences: a different exit code; a missing or reworded operator line; a different number or order of entries in `trace.log` on any scenario other than retry-to-exhaustion, or in its collapsed form on that one; a journal present on one drive and absent on the other; a different final HEAD; different `$ENV_FILE` bytes or mode; any file present on one drive and absent on the other.
The ONE pre-declared known divergence is `interop-parity.test.ts`'s stale-lock takeover line, which is asserted explicitly and is scoped to that one suite.

WHAT GATE 1 PROVES: the ordering, the conditionality, the journal, the session guard and its five operator lines, the settle and its three, the restart postconditions, the rollback, the exit-code contract, the argv of every subprocess and the sequence in which they were created, on both bare-host and incus fixture topologies.
WHAT GATE 1 DOES NOT PROVE, and the PR body must say so in these words: that the container-path plumbing is right against REAL container paths, because the fixture's `incus` stub rewrites the hardcoded `/root/luna` and `/root/.luna/.env` prefixes onto host directories in order to run at all.
That is the one class of defect the fixture is structurally least able to catch, and it is what GATE 2 exists for.

### GATE 2: a real update on the dev channel, run by hand, once

The binary performs an ACTUAL update of the `dev` profile: real git checkout, real restart, real readiness probe.
Not a dry run.
Then a SECOND run deliberately fails and must roll back, because rollback is the behaviour we most need to see work and a successful path never exercises it.

The whole procedure is described using the PROFILE NAME only.
No host name, container name, address or personal infrastructure detail appears anywhere in this document, and none may appear in the evidence pasted into the PR; redact any that a command prints.

**How the binary is put in the engine position.**

`luna_select_engine` is reached only on the non-dry path (`scripts/luna-autodeploy:524`), and it resolves the binary as `<dirname of the running luna-autodeploy>/deploy-cli` (`:130`), which is the guardian pin directory that published it (`scripts/luna-guardian:1216-1219`).
`LUNA_DEPLOY_ENGINE` is read at `:122` and is an ENVIRONMENT VARIABLE ONLY: nothing on disk is modified to select the engine, which is what makes the abort procedure below a single unset.

Half A, the successful update, goes through autodeploy exactly as the timer would:

```zsh
PIN="$(readlink -f /usr/local/lib/luna-guardian/current-dev)"
LUNA_DEPLOY_ENGINE=binary "$PIN/luna-autodeploy" dev
```

Half B, the deliberate failure, cannot go through autodeploy, because autodeploy pins `--ref origin/<branch>` from the registry and half B needs a specific bad sha.
It reproduces `:538`'s invocation directly.

HOW THE FLAGS ARE OBTAINED, which is blocker R6.
Revision 2 told the operator to run `"$PIN/luna-autodeploy" dev --dry-run` and read the flags off its DRY-RUN line.
That line is at `scripts/luna-autodeploy:512`, and by the time Half B runs it is unreachable: Half A has just brought the channel up to date, so `:480-485` prints `up to date ... no-op` and returns 0 THIRTY LINES EARLIER, and `--dry-run` does not set `FORCE` (`:885` sets only `DRY_RUN`, `:880` is what sets `FORCE`).
A second early return sits between them at `:491-500`, where an unknown or non-zero active-session count prints DEFERRED and returns 0, which on a live channel with one connected client is the normal state.
This is precisely the class of mistake this document spends its acceptance-gate preamble diagnosing in revision 1, repeated one revision later.

The flags are read from the REGISTRY instead, per argument, never from a space-joined line:

```zsh
# Prints one registry-supplied flag per line. Nothing is deployed and nothing is mutated.
( set -e
  . "$PIN/lib/luna-deploy.sh"
  . "$PIN/lib/luna-registry.sh"   # provides luna_load_server (scripts/luna-autodeploy:75-77)
  luna_load_server dev
  printf '%s\n' "${P_UPDATE_ARGS[@]}" )
```

`luna_load_server` lives in `lib/luna-registry.sh`, not in `lib/luna-deploy.sh`; both are sourced because the registry reader assumes the deploy lib's helpers are already present, which is the order `luna-autodeploy` itself uses.
If the pin does not carry `lib/luna-registry.sh`, source the repo's copy instead and say so in the evidence, because the flags are then read from a different tree than the one that would run.

The operator then re-quotes each line as its own argument, drops the `--ref` flag and the value that follows it (the same strip `do_repair` performs at `:596-602`), and appends `--ref <bad sha>`.
Reading `${P_UPDATE_ARGS[*]}` off any DRY-RUN echo is FORBIDDEN in this procedure, because that rendering is space-joined and quoting-lossy and would silently split any registry value that ever contains a space.
If the registry function cannot be sourced in isolation on the pinned copy, the fallback is `"$PIN/luna-autodeploy" dev --repair --dry-run`, which is reached unconditionally after the repo checks (`:590-607`) and already performs the `--ref` strip; its output is still space-joined, so it is a diagnostic of last resort and the per-argument form above is what the evidence must show.

```zsh
LUNA_DEPLOY_BASH_ENGINE="$PIN/luna-update-server" \
  "$PIN/deploy-cli" update <those flags, one argument each> --ref <bad sha>
```

Setting `LUNA_DEPLOY_BASH_ENGINE` explicitly is not optional: `run-update.ts` step 2 resolves it before anything else, and it is what autodeploy itself passes at `:538`.
Concern 14 notes the deviation honestly: the live path passes `luna_pin_engine`'s output (`:518`, `:538`), which is a separately pinned engine directory, while this command passes the guardian pin's own sibling engine.
Both directories carry a sibling `lib/`, which is the only property `resolveBashLib` needs, so the substitution is safe; it is recorded here so that the PR body does not claim a byte-identical reproduction of `:538` that it does not have.

**Preconditions, checked in this order, before anything is started.**

1. The working tree that produced the binary is the tree under review, and `git diff --stat` is clean for `scripts/luna-update-server` and `test/helpers/update-server-fixtures.ts`.
2. GATE 1 is green on this exact commit.
3. THE PIN CARRIES THIS COMMIT, which is blocker R7 and which revision 2 asserted as something the operator was supposed to already know.
   `$PIN` is `readlink -f` of the profile's current pin and its basename is `engine@<sha>` (`scripts/luna-guardian:1339`), and the `deploy-cli` inside it was compiled at publish time from THAT checkout (`scripts/luna-guardian:1156-1219`).
   `--version` cannot distinguish two builds, because it prints a static constant (`apps/deploy-cli/src/version.ts`, printed by `main.ts:64-66`), so `test -x` plus `--version` proves nothing about which revision is in there.
   So: record `readlink -f` of the pin, extract the sha from its basename, and assert that sha equals the PR head.
   The publishing sequence that makes it true, and which must be performed BEFORE the timers are stopped: push the PR branch to the profile's deploy branch, let one ordinary bash-engine tick deploy and publish it with `LUNA_DEPLOY_ENGINE` UNSET, then re-read the pin and confirm the sha moved to the PR head.
   Add the identity probe as a cheap cross-check that does not deploy anything: `"$PIN/deploy-cli" update --help` must print usage and exit 0, where the S22 stub prints `deploy-cli update: not implemented` and exits 2 (`main.ts:26-27`).
   Re-running GATE 2 after a fix requires repeating this whole step; a re-run against a pin that was never republished silently re-proves the previous revision's binary and produces green evidence for code that is not in the PR.
4. The engine gate actually selects the binary, proven WITHOUT deploying anything.
   `luna_select_engine` is a pure function of its two arguments and the environment (`scripts/luna-autodeploy:119-143`): it prints an argv prefix and mutates nothing.
   So call it directly, in a subshell, exactly as `:524` does:
   ```zsh
   ( set -e
     # luna-autodeploy defines the function; sourcing it would also run its main body,
     # so extract the function alone rather than sourcing the whole script.
     eval "$(sed -n '/^luna_select_engine() {/,/^}/p' "$PIN/luna-autodeploy")"
     LUNA_DEPLOY_ENGINE=binary luna_select_engine "$PIN/luna-update-server" "$PIN" )
   ```
   It must print two lines, `$PIN/deploy-cli` and `update`.
   With `LUNA_DEPLOY_ENGINE=bogus` it must instead print the refusal from `:139-140` and return 1, and with the variable unset it must print the single bash-engine path from `:126`.
   If the `sed` extraction proves fragile, the fallback is to read the three outcomes off a real non-dry run's first line of output; see UNCERTAINTY 6, which flags this step as the one I did not execute.
   The point of this step is that revision 1's precondition used `--dry-run`, which returns at `:511-514` before the selector is ever reached and therefore could never have observed the refusal it claimed to test.
5. There is no pending transaction journal for the profile, and no update lock dir.
6. The profile's autodeploy and guardian timers are stopped for the duration, so no tick races the hand run:
   `systemctl stop luna-guardian-dev.timer luna-autodeploy-dev.timer`.
   Stopping a timer does NOT stop an already-running service instance, which is concern 11, so then WAIT FOR IDLE: poll `systemctl is-active luna-guardian-dev.service` and `systemctl is-active luna-autodeploy-dev.service` until both answer `inactive`, and only then continue.
   Both timers are re-enabled in the teardown, and forgetting to is itself a reportable defect.
   With the timers stopped there is nothing left to self-heal the channel, which is concern 12 and which the abort procedure below now opens with rather than implies.
7. The channel is HEALTHY before starting, proven and recorded: the service unit is `active`, `/readyz` returns 200 with `"status":"ok"` and a `buildSha` equal to the checkout's current `HEAD`, and `NRestarts` is stable across two reads thirty seconds apart.
   If `buildSha` and `HEAD` disagree BEFORE the run, stop: the channel is already in a state this gate cannot interpret.
8. The current sha is recorded as `SHA_BEFORE`, and the readiness JSON is saved.

**Half A: the successful update.**

Advance the dev branch by one real commit first, so there is something to deploy; a documentation-only commit is fine and is the least disruptive choice.
Then run the Half A command above with output captured, and capture:

- the full stdout and stderr of the run, and its exit code, which must be 0;
- the operator lines, which must include the preflight banner, `Target ref:`, `Current HEAD: <SHA_BEFORE>`, one of the two bun.lock decision lines, `Checked out: <SHA_AFTER>`, the `settling 6s after stop ...` line (the production default is 6, `config.ts:362`, so its ABSENCE is a defect, not a nicety), the TWO seed lines, and `updated <SHA_BEFORE> -> <SHA_AFTER> (<unit> healthy)`;
- the container-side `.env`, which is blocker R8 and is the ONLY place the container-path plumbing is ever inspected.
  Capture it BEFORE and AFTER the run, read through the same `run_target` seam the engine uses so the read cannot accidentally answer about the host filesystem: the `LUNA_CLAUDE_CODE_EXECUTABLE` line out of `/root/.luna/.env` inside the container, and `stat -c %a` on that file.
  Assert that the pinned path resolves INSIDE the container, that it is executable there, and that the mode is 600.
  This is the artifact whose absence made revision 2 list a disqualifier (`$ENV_FILE` containing a host-perspective path, or losing mode 600) that neither half ever observed, while `:1221-1252` runs that re-pin on every single apply;
- `journalctl -u <the profile's service unit> --since "<start time>"` for the whole window, which must show the stop, the start, and a clean boot;
- the readiness outcome: `/readyz` returning 200 with `buildSha` equal to `SHA_AFTER`;
- `git rev-parse HEAD` before and after, which must be `SHA_BEFORE` and `SHA_AFTER`;
- the absence of the transaction journal and of the lock dir afterwards;
- confirmation that the marker `DELEGATED to bash engine:` does NOT appear anywhere in stderr, which is what proves the binary ran the transaction rather than handing it back.

**Half B: the deliberate failure and the rollback.**

This implements DECISION 3, and it replaces revision 2's prescription, which does not fail.

WHY REVISION 2'S FAILURE SHAPE IS DEFEATED.
Revision 2 said "the smallest edit that keeps the process alive and fails `/readyz`".
The smallest such edit is removing or renaming the `/readyz` route, and `readiness_ok` ACCEPTS that: `:1090-1095` reads the response code and returns 0 immediately on a literal `404`, with a comment naming exactly this back-compat path for legacy pre-`/readyz` builds.
A gate run against that commit reports a healthy deploy, never rolls back, and produces green evidence for the one behaviour GATE 2 exists to see.

WHICH SHAPES `readiness_ok` ACTUALLY REJECTS, audited against `:1069-1126` rung by rung.
The unit never reaching `active` rejects (`:1077`), but it usually also makes `systemctl start` fail, which routes to `service restart errored` at `:2065` rather than to `failed readiness`, and risks systemd's start-limit latch.
`NRestarts` climbing above the baseline rejects (`:1081`), but it needs a crash loop, which is the same problem.
`/healthz` answering anything but 200 rejects (`:1086`), and keeps the process alive, but it disables the liveness endpoint other things watch.
`/readyz` answering 200 with a mode other than `normal` rejects (`:1097-1098`), because the check is a `grep -q '"mode":"normal"'` and a setup-mode body carries `"mode":"setup"`.
`/readyz` answering 200 with a `buildSha` that does not prefix-match either way rejects (`:1104-1116`).
A `/readyz` transport failure answering `000` rejects, by the same `:1094` comment that accepts 404.
Note what is NOT checked: the top-level `status` field. A body with `"status":"degraded"` and `"mode":"normal"` and a matching `buildSha` PASSES, so `LUNA_SCHEDULER_STRICT_READY` is not a usable failure lever either.

THE PRESCRIBED SHAPE IS SETUP-MODE.
Create a throwaway branch off the dev branch with ONE commit that makes the server's boot-time model-credential gate fail, so `chat-server.ts` takes its setup branch (the path that prints `setup-mode: model credential not usable — serving setup UI`) and `packages/ui-ws/src/server.ts:904` therefore computes `const mode = setupPty != null ? "setup" : "normal"` as `"setup"`.
`/healthz` keeps answering 200 (`packages/ui-ws/src/server.ts:891-894`), `/readyz` answers 200 with `{"status":"ok","mode":"setup",...}` (`:921-933`), the process stays alive, `systemctl start` succeeds, and `readiness_ok` polls to its deadline and gives up with `/readyz did not report "mode":"normal" (still booting or in setup-mode; http=200)`.

WHY IT IS REALISTIC RATHER THAN CONTRIVED.
Setup-mode is not a test hook: it is the server's own designed response to an unusable model credential, and a change that breaks credential resolution shipping to a channel is the exact incident class where the process is alive, `/healthz` is green, monitoring is quiet and chat is dead.
`packages/ui-ws/src/server.ts:897-903` says in its own comment that distinguishing this from a normal server is what the `/readyz` endpoint exists for and that `luna-update-server`'s gate is the consumer.
It is also the shape GATE 1 already drives through the fixture's `setupAtTarget` option, so the live half and the hermetic half exercise the same rung, which is what makes a disagreement between them meaningful.

BEFORE DEPLOYING THE BAD COMMIT, prove its shape locally rather than discovering it from the gate: build the branch, run the server, and confirm `curl /readyz` returns HTTP 200 with `"mode":"setup"`.
If it returns 404, the edit removed the route and the run would have passed; if it returns 000 or the process is dead, the edit crashed the boot and the run will fail at the restart step instead.

FORBIDDEN ways to force the failure, each of which tests the harness rather than the engine: removing or renaming the `/readyz` route (it returns 404 and is ACCEPTED); shortening `--readiness-timeout`; stopping the unit by hand mid-run; pointing readiness at a closed port.
A commit that crashes the process on boot is not forbidden but is not the prescribed shape, because it exercises `service restart errored` rather than `failed readiness`; if it is used anyway, say so and adjust the expected stderr sequence below accordingly.

Expected behaviour, all of which must be evidenced:

- exit code 1;
- stderr contains, in this order: `readiness gave up after <N>s: /readyz did not report "mode":"normal" (still booting or in setup-mode; http=200)`, which is the line that proves the prescribed failure shape actually fired rather than some other rung;
  then `update to <bad sha> failed: failed readiness (HEAD=<bad sha>)`;
  then `rollback restart proceeds without the session guard: ...`;
  then `ROLLING BACK to <SHA_AFTER>`;
  then a second `readiness gave up ...` only if the rollback probe also failed;
  then `update to <bad sha> failed — ROLLED BACK to <SHA_AFTER> (<unit> healthy)`;
- if the give-up detail is anything other than the setup-mode one, the run is INVALID rather than failed: the commit did not produce the shape the procedure prescribes, and it must be corrected and re-run;
- the journal is written and then CLEARED, evidenced by capturing it mid-run if possible and by its absence afterwards;
- `journalctl` shows two stop/start cycles, the failing one and the rollback one;
- `git rev-parse HEAD` afterwards equals `SHA_AFTER`, the pre-failure sha, not the bad sha;
- `/readyz` returns 200 with `"mode":"normal"` and `buildSha` equal to `SHA_AFTER`;
- the container-side `.env` still names an executable inside the container at mode 600, captured the same way Half A captures it, because the rollback performs its own re-pin through `apply_ref`;
- the lock dir is absent.

**Restoring the channel after Half B.**

The rollback is supposed to restore the channel by itself, and the first step is to VERIFY that rather than assume it.

1. Confirm the three restore postconditions: `git rev-parse HEAD` equals `SHA_AFTER`, `/readyz` returns 200 with `"mode":"normal"` and `buildSha` equal to `SHA_AFTER`, and the service unit is `active`.
   Record all three; they are part of the evidence, not just a check.
2. If any of the three fails, the channel is NOT restored and the rollback itself is a disqualifying defect; put it back with the BASH engine explicitly, which is the escape hatch this whole design exists to preserve:
   `LUNA_DEPLOY_BASH_ENGINE="$PIN/luna-update-server" "$PIN/luna-update-server" <the same flags> --ref <SHA_AFTER>`.
3. Delete the throwaway branch from origin, which is concern 13: this repository is PUBLIC, the branch carries a deliberately broken commit, and it must be gone before the evidence is pasted.
   The bad sha must never be the commit the dev branch itself points at, so that a stray tick can never deploy it.
4. Confirm there is no pending transaction journal and no lock dir for the profile.
5. Re-run one ordinary bash-engine tick with `LUNA_DEPLOY_ENGINE` UNSET, and confirm it reports up-to-date, which proves the channel is back in the state the timers expect.
6. Restart both timers and confirm they are `active`.

**Half C: `--restart-only` live, one command.**

This is blocker R9, and it is the cheapest live proof in the whole gate.
`--restart-only` is repair rung 1, the rung unattended automation drives most often, it is owned by the binary (it is not one of `delegationFor`'s four delegated conditions), and it is the ONLY consumer anywhere that distinguishes exit 3 from exit 4 (`scripts/luna-autodeploy:619-623`, whose two messages are the false diagnosis the `:1872-1878` comment exists to prevent).
Revision 2 gave it a module, two NON-NEGOTIABLE parity rows and a whole exit-code argument, and then never ran it against a real unit.

With the timers still stopped, the channel healthy and the checkout at `SHA_AFTER`:

```zsh
LUNA_DEPLOY_ENGINE=binary "$PIN/luna-autodeploy" dev --repair
```

It goes through the same `luna_select_engine` gate the deploy path uses (`scripts/luna-autodeploy:616`), it mutates no checkout, and it must produce:

- exit code 0 and `[repair:dev] REPAIRED by unit restart`, which is rung 1 returning 0 (`:620`) and therefore rung 2 never running;
- the operator line `restart-only: <unit> healthy at <first 12 of SHA_AFTER>`;
- the settling line, since the settle runs on this rung too;
- `journalctl` showing exactly ONE stop/start pair;
- `/readyz` still reporting 200, `"mode":"normal"` and `buildSha` equal to `SHA_AFTER`;
- `git rev-parse HEAD` unchanged at `SHA_AFTER`, since rung 1 touches no checkout;
- no transaction journal at any point, which is the type-level guarantee `restart-only.ts` claims and this is its only live check;
- the lock dir absent afterwards.

If a live session happens to be connected, the expected result is exit 3 and `[repair:dev] DEFERRED by session guard`, which is a PASS for this half and should be recorded as such, along with the `session guard: <n> active session(s) on :<port> — deferring restart` line that must accompany it.
Disconnect and re-run to get the exit-0 evidence as well.

**Abort and manual recovery.**

READ THIS BEFORE STARTING, which is concern 12.
The timers are stopped for the duration of this gate, so NOTHING will heal the channel automatically.
A hang, or a Ctrl-C landing between the stop and the start, leaves the channel DOWN until a human acts, and this document's own KNOWN DIVERGENCES record that SIGINT and SIGTERM are deliberately not wired in the binary, so an interrupt does not even release the lock in an orderly way.
If a run hangs, do not interrupt it first: capture the tree of what it is waiting on, then interrupt, then go straight to step 1 below and bring the channel up with the bash engine before doing anything else, including before writing anything down.

At any point, the engine selection is undone by simply not setting `LUNA_DEPLOY_ENGINE`; nothing on disk was changed to select the binary, and the next timer tick runs bash.
If a run is interrupted or leaves the channel unhealthy:

1. Put the bash engine back explicitly for the recovery run: `"$PIN/luna-autodeploy" dev` with `LUNA_DEPLOY_ENGINE` UNSET, or, if the channel needs a targeted repair, `LUNA_DEPLOY_BASH_ENGINE="$PIN/luna-update-server" "$PIN/luna-update-server" <flags> --ref <SHA_AFTER>`.
2. If a transaction journal is pending, do NOT delete it; run the bash engine again with the same flags and let it resume, which is the path the journal exists for.
   Only if bash itself reports the journal CORRUPT (exit 2) is manual removal correct, and the file should be copied into the PR before removal.
3. If the lock dir is stale, leave it: the next run's stale takeover removes it and says so.
4. Re-enable the timers: `systemctl start luna-guardian-dev.timer luna-autodeploy-dev.timer`.
5. Delete the throwaway branch from origin.

**What DISQUALIFIES the slice, as opposed to merely needing a fix.**

Disqualifying, meaning the fold stops and `update` ships as a pure delegator:

- the binary reports success while `HEAD` did not reach the target, or while `/readyz`'s `buildSha` disagrees with `HEAD`; that is the self-referential success the HEAD postcondition exists to prevent;
- rollback leaves the checkout at the bad sha, or leaves the unit down, or exits 0;
- the session guard permits a restart with live sessions on any binary path;
- the journal or the lock proves non-interoperable in either direction, since the escape hatch is then fiction;
- the container-side `.env` ends up containing a host-perspective path, or loses mode 600, as observed by Half A's and Half B's capture of it; this disqualifier is only meaningful because those captures now exist, and it was unobservable in revision 2;
- Half C's `--restart-only` writes a transaction journal, or returns 4 where no concurrent update holds the lock, or returns 3 where no sessions were evaluated.

Merely needing a fix, meaning iterate and re-run GATE 2:

- a wrong or missing operator line, a line in the wrong order, or a wrong exit code on a path that still left the channel healthy;
- a readiness timeout that was too short for this host, provided the rollback then worked;
- a stale-lock takeover line appearing where it was not expected, since that divergence is already declared.

## Known divergences

These are the complete list, and the PR body must reproduce it.

**Signals.** `process.on("exit")` and `uncaughtException` are wired; SIGINT and SIGTERM are not, because Node dispatches them on the event loop and this body is synchronous.
The recovery is the next run's stale-lock takeover, which emits one stderr line bash never emits.

**A non-integer `--readiness-timeout` refuses before the lock instead of mutating and rolling back.**
Revision 1 claimed "bash is ALSO non-successful, so the divergence is bounded to the exit code".
That claim was wrong, concern 4 caught it, and the real behaviour was MEASURED rather than reasoned about.
`readiness_ok` is always invoked as `if readiness_ok ...` (`:1838`, `:1906`, `:2073`), which suspends errexit, and `local deadline=$((SECONDS + READINESS_TIMEOUT))` at `:1071` is an arithmetic SYNTAX error for a fractional value.
Measured on bash 3.2 and bash 5.x: the arithmetic error aborts the enclosing `if` COMMAND entirely without taking either branch, and execution resumes at the next statement, with the shell still exiting 0 overall.
For `--readiness-timeout 0.3` that means bash performs the whole transaction (`reset --hard`, `bun install`, stop, start), falls straight past the `if` at `:2073-2083` into `fail_forward "failed readiness"` at `:2086`, and then hits the SAME abort inside `do_rollback`'s `if readiness_ok` at `:1838`, falling into the CRITICAL printf and exiting 2.
So bash mutates the host and exits 2 on an input the binary refuses at exit 1 with nothing mutated.
The binary's behaviour is strictly safer and the input is operator error, so the refusal stays; what changes is that this document now states the divergence correctly.
A non-numeric value such as `abc` behaves differently again in bash, because bash arithmetic treats a bare identifier as 0, so the deadline is `SECONDS` and the loop never runs: bash mutates, fails readiness immediately, and rolls back.

**No `readinessPort` divergence any more.** Revision 1 proposed refusing a non-canonical spelling like `04753`.
That refusal is DELETED in favour of widening `probes.ts`, `readiness.ts` and `session-guard.ts` from `number` to `string`, so the raw spelling reaches curl and ss byte-identically on both engines.
Refusing an input bash accepts converts a working deploy into an exit-1 refusal on a real host, which is the same outage-by-strictness the delegation design exists to avoid.

**Test-seam asymmetry.** Bash has `LUNA_TEST_WS_COUNT`; the port deliberately has none and never will.
GATE 1's `driveEnv` omits the variable from both drives and uses an `ss` stub instead, while the legacy `runUpdate` helper at `bash-fixtures.ts:94-97` keeps it, so the two helpers have different seam surfaces on purpose.
A future hostenv suite that wants a deterministic session count must use the stub.

**Two `luna_die` messages the port emits that bash almost never reaches**, which is concern 15 and which revision 2 listed as ordinary ported strings.
`scripts/luna-update-server:37` is `set -euo pipefail` and `git_target_capture` (`:392-398`) carries no `|| true`, so `PREV="$(git_target_capture rev-parse HEAD)"` at `:1964` and `REF="$(git_target_capture rev-parse "${REQUESTED_REF}^{commit}")"` at `:1992` ABORT the whole script with git's own status, typically 128, and git's own stderr.
The guards at `:1965` and `:1994` are therefore reachable only in the narrow case where git exits 0 and prints nothing.
The port has no errexit, so it reaches the guard on every failure and prints `error: could not read current HEAD in <dir>` or `error: could not resolve target ref <ref>` and returns 1, where bash prints git's message and exits 128.
The binary's behaviour is the more useful one and it stays, but no GATE 1 scenario covers it, so nothing will fail the build if an implementer gets it wrong; it is listed here so a reviewer knows to read those two arms by eye.

**`command -v` semantics.** The port's `commandExists` is a PATH walk and cannot see a shell function or alias, which bash's `command -v` would.
No such function or alias can exist in the non-interactive engine context.

**`run_target test -d` on the bare-host arm.** Bash uses the shell builtin and creates no process; the port evaluates it natively for the same reason.
On the incus arm both engines spawn the same external `test` through `incus exec`.

## Things I am still unsure about

These are stated as uncertainties rather than written over with confident prose.
Each one should be resolved by the implementer against the code, not assumed from this document.

1. **CLOSED in revision 3: where the MainPID and start-limit warns are printed.**
   Revision 2 kept them in `update-flow.ts` and flagged the ordering argument as unproven for the incus `run_target_capture` case.
   Revision 3 takes the fix that uncertainty itself named: the prints move into `restart.ts` behind an injected `warn`, joining the settle triple and the guard line, so ordering is positional rather than argued and the two other callers of `restart_service` stop being silent.
   The residual uncertainty is smaller and different: `restart.ts` now imports `flow-lines.ts`, a PR2 file, from a PR1 module.
   That is acyclic and data-only, but if a reviewer objects, the alternative is to move the six builders into `restart.ts` and re-export them from `flow-lines.ts`, which changes no bytes.

2. **`restart-only.ts` and the fallthrough.**
   Giving restart-only its own module with no journal seam makes "rung 1 never writes a transaction" a type-level fact, at the cost of expressing the journal-pending fallthrough (`:1889-1892`) as "the orchestrator calls restart-only only when the journal is absent", which is one reading step away from bash's inline `if`.
   This is the single place in this spec where the port does not read 1:1 against the source, and it is also the place where getting it wrong is most dangerous.
   If the two journal-precedence parity rows cannot be made to pass, abandon the separate module and inline the rung.

3. **Incus fixture fidelity, restated without the claim revision 2 attached to it.**
   The fixture's `incus` stub rewrites `/root/luna` and `/root/.luna/.env` onto host directories in order to run at all, so a wiring error specifically in container-path plumbing is the class of bug GATE 1 is structurally least able to catch.
   Revision 2 added that "adding `$ENV_FILE` as an artifact narrows this considerably"; that sentence is WITHDRAWN under DECISION 2, because the host arm it referred to never runs on an incus target and the values it claimed to distinguish are equal by construction on the arm that does.
   What narrows it instead is GATE 2 Half A's container-side `.env` capture, which is the only observation of a real container path anywhere in this document.
   If this PR has a defect that survives GATE 1, my prediction is still that it is there.

4. **`citty`'s argument handling with a subcommand present.**
   I have specified handling `update --help` in `main.ts`'s raw-argv preamble, following `main.ts:58-67`'s documented reasoning and concern 27.
   I have NOT verified that `runMain`'s own parsing does not consume or reorder flags before the preamble sees them when a subcommand IS present, because the preamble runs before `runMain` at module scope and I read it as unconditional.
   Verify by running `deploy-cli update --help` with `NODE_ENV=test` set and confirming the usage text appears on stdout with exit 0.

5. **CLOSED in revision 3: whether `restart-only` needs the lock before the journal check.**
   Concern 23 was right that this was cheap to close by reading, so it is closed rather than carried.
   `acquire_update_lock` has exactly three occurrences in the file: its definition at `:980`, a call at `:1579` inside the releases-layout `--materialize` path, and the top-level call at `:1872`.
   `--materialize` is delegated and out of scope, and nothing between `:1883` and `:2086` re-acquires, so the restart-only fallthrough at `:1889-1913` runs under the lock taken at `:1872` and re-enters the normal flow still holding it.
   The binary's ordering is correct as specified.

6. **The selector probe in GATE 2 step 4.**
   I verified by reading that `luna_select_engine` (`:119-143`) is pure, that it is reached on the non-dry deploy path (`:524`) and on both repair rungs (`:616`), and that its refusal at `:139-140` fires for an unrecognised `LUNA_DEPLOY_ENGINE`.
   I also verified that the `sed` range extraction prints the function cleanly from the in-tree script.
   What I have NOT done is run the extracted function against a PINNED copy on a real host, so the probe in step 4 is read-verified rather than executed.
   Run it and check its three outcomes before starting Half A; this is exactly the shape of the mistake revision 1 made, and it is cheap to avoid twice.

7. **NEW in revision 3: whether stdout and stderr keep their relative order across the two drives.**
   Concern 10 is right that capturing them as two separate artifacts means no artifact constrains their interleaving, so a warn emitted at the wrong point relative to the stdout narrative diffs clean.
   I have NOT specified a merged-stream artifact, because `spawnSync` gives two buffers and merging them faithfully needs a pty or a shell redirection that changes the engine's own buffering behaviour, and I would rather state the gap than add a mechanism whose fidelity I have not measured.
   `trace.log` constrains the ordering of everything that spawns a subprocess, which covers most of it, and revision 3's move of the six restart-owned prints into `restart.ts` removes the specific case concern 10 named as most at risk.
   If a reviewer wants this closed, the cheapest honest option is a third drive per scenario that runs the same command under `2>&1` into one file and diffs only that, accepting that the interleaving it shows is buffering-dependent and therefore only comparable because both drives are buffered the same way.

8. **NEW in revision 3: whether the re-implemented `curl` and `bun` stubs stay faithful.**
   `stub-fidelity.test.ts` is specified to catch drift, but it compares the two implementations over the option matrix I could enumerate from `update-server-fixtures.ts:142-187`, not over every input a future scenario might use.
   A future option added to the original and not to the replacement would make the two drives disagree in a way that looks like a port defect.
   The mitigation is the pinning comment and the fidelity test; the residual risk is real and belongs to whoever next edits `update-server-fixtures.ts`.

9. **NEW in revision 3: the exact edit that forces setup-mode.**
   I verified the mechanism end to end by reading (`packages/ui-ws/src/server.ts:896-933` computes `mode` from `setupPty`, and `readiness_ok` rejects any body without `"mode":"normal"`), and I verified which shapes `readiness_ok` accepts and rejects.
   I did NOT write the one-line commit, so the specific edit that makes the credential gate fail is left to the operator, with the local `curl /readyz` pre-check as the thing that catches a wrong edit before it reaches the channel.

## Abandon conditions

If `apply_ref_inplace` parity diverges on the HEAD postcondition or the lockfile-hash gate, DELETE `apply-inplace.ts` and delegate the whole inplace invocation, leaving `update` a pure delegator.
A binary that reports a lying reset as success is worse than no binary.

If the claude re-pin cannot be made diffable by the fixture's claude stub AND by the `$ENV_FILE` artifact, do not ship an unproven port of a mode-600 secrets writer: delegate any invocation that would reach it, and say so in the PR body rather than implying coverage.

If the session guard can be made to proceed with live sessions under ANY binary path, revert to bash-only for restart; fail-closed is the invariant.

If the shared lock or journal proves non-interoperable in either direction, the escape hatch is fiction and the fold stops.

If any parity scenario cannot be expressed without editing `scripts/luna-update-server` or `test/helpers/update-server-fixtures.ts`, stop and re-plan rather than growing the bash diff.

If the two restart-only journal-precedence rows cannot be made to pass, the restart-only factoring is what to abandon, not the scenarios.

If any scenario other than retry-to-exhaustion turns out to need the poll-collapse normalisation, STOP and re-derive its iteration count rather than widening the rule: the exactly-one-iteration argument holds for any machine, so a scenario that violates it is telling you something about the port, not about the runner.

If GATE 2's Half B cannot be made to produce the setup-mode give-up detail, do not substitute a shape that merely fails somehow: an unprescribed failure shape means the rollback evidence proves a different rung than the one this document audited, and the run is invalid rather than merely inconclusive.

## What must be in the PR body

A "What changed, visually" section with a Mermaid diagram of the flow and its five exit codes.

An explicit statement that the old `--dry-run` acceptance gate was DELETED, with the three reasons from THE ACCEPTANCE GATE stated in full, so that nobody proposes it again.

GATE 1's result: the scenario count, the artifact list, an explicit statement that the MASKING list is exactly three rules and that no fourth was added, and a separate explicit statement of the ONE normalisation rule, which scenario it applies to, which four logs it touches, and where the retry behaviour it collapses is asserted instead.
The per-scenario readiness iteration counts, so a reader can check the determinism claim without re-deriving it.

An explicit statement that `$ENV_FILE` as a GATE 1 artifact does NOT observe the repo-dir selection, with the `:318-320` and `:1221` reasoning, so that revision 2's withdrawn credit is not quietly reinstated by the next reader.

Confirmation that `tsc` over `apps/deploy-cli` was run and is clean, since the `readinessPort` widening touches types vitest does not check.

Confirmation that `config-parity.test.ts`, `journal-parity.test.ts` and `restart-guard-parity.test.ts` were re-run green after the unconditional `ss` stub was added, and a statement that `bash-fixtures.ts:94-97`'s `LUNA_TEST_WS_COUNT` default was deliberately left in place.

GATE 2's evidence from all THREE halves: the operator lines, exit codes, journal excerpts, readiness JSON, container-side `.env` contents and mode, and shas, with any host, container or address detail redacted.
The pin sha, shown to equal the PR head, and the statement of how it was published.
Confirmation that the throwaway branch was deleted from origin before the evidence was pasted.

The KNOWN DIVERGENCES list reproduced verbatim, including the corrected `--readiness-timeout` finding with its measured bash behaviour, and the statement that the two engines now have different test-seam surfaces on purpose.

Confirmation that `git diff --stat` shows zero changes to `scripts/luna-update-server` and `test/helpers/update-server-fixtures.ts`.
