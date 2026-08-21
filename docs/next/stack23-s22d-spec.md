# stack23 S22d - assemble deploy-cli `update`

Workflow-authored spec (15 agents: 4 readers, 3 designers, 3 judges, 1 synth, 3 auditors, 1 reviser).
Its load-bearing claims were verified against the code before any of it was acted on; PR0 shipped as #521.

## id

S22d

## title

Binary: make the engine gate actually reach deploy-cli, then assemble `update` for the inplace layout

## concern

Six tested-but-unimported primitives become an `update` command that can perform a real deploy - but only after correcting a false premise the draft was built on. The draft's PR0 (copy deploy-cli into luna_pin_engine's quarantine dir) is INERT and all three auditors are right: luna_pin_engine returns at the `.complete` marker before any copy (scripts/luna-autodeploy:178-181), and its cache key is `git -C $(dirname $UPDATE_SERVER) rev-parse HEAD` with a `sha1sum "$engine_src"` fallback (:162-165) computed over luna-update-server ALONE - a file this slice is forbidden to touch - so the key never rotates and the copy block is never re-entered. A third gap no auditor named makes the picture worse: deploy-cli exists in exactly ONE place on a live host, guardian's own engine pin (scripts/luna-guardian:1216-1219, published into $PIN_BASE/engine@<sha> = /usr/local/lib/luna-guardian), and the autodeploy TIMER's ExecStart deliberately points at the channel repo's own copy of the script (scripts/luna-autodeploy:743, :765) where no binary exists and its unit sets no LUNA_DEPLOY_ENGINE (:757-765). So the timer path is bash-only under any design, and the only invocation that can ever reach the binary is guardian-driven. The slice is still worth building, but it must be built on the right mechanism: resolve deploy-cli from where guardian actually put it rather than copying it forward, and route do_repair (scripts/luna-autodeploy:591, :599) through the gate it currently bypasses. Both corrections are in PR0. If PR0 does not put the binary in front of a live dev deploy, stop - S22a-d are unverifiable and S23 cannot flip.

## approach

PR0 - REACHABILITY. THE DRAFT'S PIN-COPY FIX IS WRONG AND IS REPLACED, NOT PATCHED.

Why not patch it. Making luna_pin_engine content-aware needs three things the auditors correctly costed: a key that includes deploy-cli's own hash (or a fingerprint file), a one-time migration for the `.complete` dirs every host already carries, and a reaper, because the pinned artifact is a ~60MB compiled binary (scripts/luna-guardian:1188-1219) and /usr/local/lib/luna has no pruner - guardian's prune_engines walks $PIN_BASE/engine@* (scripts/luna-guardian:1264-1328), a different base entirely. Healing a `.complete` dir in place is worse: rm -rf on a complete pin can hit a dir another profile's deploy is executing from, a hazard the existing stale-partial rm at :183-186 avoids precisely because a dir without `.complete` is never live.

What replaces it. deploy-cli is ALREADY quarantined where guardian put it. Guardian invokes `$SCRIPT_DIR/luna-autodeploy` (scripts/luna-guardian:656) from $PIN_BASE/current-<profile> (:879 renders `ExecStart=$current/luna-guardian check $profile`; :11 sets SCRIPT_DIR from $SELF), autodeploy sets `UPDATE_SERVER="$(dirname "$SELF")/luna-update-server"` (:66), and publish_engine copied luna-autodeploy, luna-update-server, lib/*.sh AND deploy-cli into that same dir (scripts/luna-guardian:1151-1154, 1216-1219). That directory lives at /usr/local/lib/luna-guardian, outside every repo, so `git reset --hard` cannot touch it - the whole hazard luna_pin_engine's second-level copy exists to close for bash. And the residual hazard (guardian pruning the pin mid-deploy) does not apply the same way to a compiled binary: unlink leaves the running process's mapping intact, whereas bash reads its source incrementally and genuinely breaks. So:

(1) `luna_select_engine` takes a SECOND argument, the binary search dir, and resolves `$2/deploy-cli` instead of `dirname($pinned_engine)/deploy-cli` (scripts/luna-autodeploy:120). Both call sites pass `"$(dirname "$UPDATE_SERVER")"`. The refusal at :121-124 is unchanged and stays the single place a missing binary is reported. luna_pin_engine is NOT edited at all, so the bash engine's quarantine is byte-unchanged.

(2) do_repair routes through the gate. It currently execs `"$pinned_engine" "${repair_args[@]}" --restart-only` (:591) and `"$pinned_engine" "${repair_args[@]}"` (:599) directly - luna_select_engine has exactly one call site today, :514 in do_deploy. Guardian's whole unattended repair ladder therefore runs bash regardless of LUNA_DEPLOY_ENGINE, including rung 2, which is a FULL redeploy. Leaving that would make `--restart-only` dead code on every host and would punch a hole in the DELEGATED-marker gate-integrity argument from a direction the draft never considered: a guardian repair is a complete bash deploy that emits no marker at all. Expand both sites with the same 4-line while-read prefix do_deploy uses at :513-517. do_repair's DRY_RUN echoes (:585-588) keep printing $UPDATE_SERVER; that is a pre-existing cosmetic divergence do_deploy shares (:501-504) and S22c already accepted - note it, do not widen the diff.

(3) All three exec sites gain a command-prefix env assignment `LUNA_DEPLOY_BASH_ENGINE="$pinned_engine"`. This is how the binary learns two things it cannot derive: the co-pinned bash engine to delegate to, and the lib dir (`$(dirname $LUNA_DEPLOY_BASH_ENGINE)/lib`) whose luna-deploy.sh it must source. A command-prefix assignment keeps argv byte-identical, which is what makes delegation forwardable. The binary refuses with exit 1 before the lock if it is unset or not executable.

Tests for PR0, in the suites that actually own the code. engine-select.test.ts owns luna_select_engine; its makePin (:24-36) hand-builds one dir holding both artifacts, so it must gain a case where the bash engine and the binary live in DIFFERENT dirs - that is the shape production now has and the shape the old fixture could not express. test/deploy-scripts.test.ts owns do_repair (14 `repair` hits, and it is in HOST_ENV_TESTS, vitest.config.ts:55-59) and gets the assertion that both rungs exec the SELECTED prefix. test/engine-pin.test.ts is added to the files list only so its idempotency test (:223-224) can be re-read and confirmed still true - luna_pin_engine is unchanged, so it needs no new assertion, and any claim that it does is a leftover of the abandoned approach.

WHAT PR0 CANNOT DO, STATED PLAINLY. Even after PR0, no unattended run reaches the binary: the guardian service unit (scripts/luna-guardian:866-881) sets only HOME/LUNA_HOME/LUNA_GUARDIAN_STATE_DIR, and the autodeploy timer unit (:757-765) sets only HOME and points at the channel repo's copy where no deploy-cli exists. S22d's live acceptance is therefore an OPERATOR-INVOKED run from the guardian pin: `LUNA_DEPLOY_ENGINE=binary /usr/local/lib/luna-guardian/current-dev/luna-autodeploy dev`. Making it unattended is S23's job (flip the default at luna-autodeploy:112, or add Environment= to the guardian unit) and is recorded as an S23 precondition, not smuggled in here.

SCOPE OF `update`. The binary owns the whole transaction for LAYOUT=inplace + SUPERVISOR=systemd, bare-host AND incus. Every other topology - `--layout releases`, `--supervisor launchd`, `--user`, `--dry-run`, `--materialize` - is DELEGATED whole to $LUNA_DEPLOY_BASH_ENGINE before the lock is acquired, exit code propagated verbatim, with one stable stderr line `DELEGATED to bash engine: <flag>` so S23's accept gate can tell "the binary deployed this" from "bash deployed this while the binary watched". Delegation, not refusal, because a refusal is a stopped deploy.

MODULES under apps/deploy-cli/src/update/.

target.ts - the run_target / run_target_capture / git_target waist (:352-398). One seam closing the three separately-documented incus gaps (readiness.ts:43-47, restart.ts:12-19, session-guard.ts's bare-host scope). git ALWAYS host-side; systemctl/curl/bun/incus-test route through `incus exec` when INCUS_CONTAINER is set. Contains no mutating git command, so `git reset --hard` lives in exactly one greppable file (apply-inplace.ts).

config.ts - the 23-flag parser (:213-241) with bash's exact names and arities, plus the validation block (:245-283) in bash's ORDER, every failure exit 1. NOT PURE, and the draft's claim that it is was wrong: the block calls `luna_validate_profile "$PROFILE"` (:248, a lib function shelled through bash-lib.ts), probes PATH with `command -v launchctl` (:281), and `--launchd-label` derives LAUNCHD_PLIST from $HOME at parse time (:237). Restate the guarantee as an ORDERING invariant - no lock acquisition before validation returns - enforced by a test asserting the lock dir does not exist on every refusal path, not as a purity property. Also owns derived paths (ENV_FILE, UPDATE_STATE_DIR, CONTAINER_REPO_DIR, the SERVICE_DIR rewrite at :294-296, BUN_BIN incl. the LUNA_TEST_BUN_PATH seam) and the delegation decision. Declare-and-delegate every flag; an operator typing `--readiness-timeout 600` must never silently get the default.

preflight.ts - NEW, and the draft assigned :421-530 to nobody. Owns, in bash's order: the banner block (:423-440), the inplace clone check `[[ -d "$HOST_REPO_DIR/.git" ]]` (:469), the unit-existence preflight (:478-497) including its incus arm `incus exec "$INCUS_CONTAINER" -- test -f "$SERVICE_FILE"` (:483-485) and its DRY_RUN/MATERIALIZE_ONLY exemption (:478), default-REF resolution from `rev-parse --abbrev-ref HEAD` falling back to origin/master (:510-520), `printf 'Target ref: %s\n'` (:521), and BUN_BIN resolution (:524-530). Without these the binary mutates a checkout on a host with no unit to restart - the exact silent half-deploy the bash comment at :475-477 says the check exists to prevent. All of it IO, all of it before the lock, every refusal exit 1 with the byte-exact `error: ` line.

delegate.ts - resolve $LUNA_DEPLOY_BASH_ENGINE, exec, inherit stdio, propagate exit code, emit the DELEGATED marker. ARGV IS NOT FORWARDED WHOLE: luna_select_engine emits a two-field prefix `<cli>` then `update` (:126) and do_deploy execs it followed by the shared flags (:518), so the binary receives `update --profile dev --incus ...`. Forwarding that verbatim hits `*) luna_die "unknown option: $1"` (scripts/luna-update-server:239). Forward the flags AFTER the subcommand token (rawArgs.slice(1) where rawArgs[0] === "update"; index-computed, not hardcoded, since a compiled bun binary and `bun run main.ts` differ in argv[1]). Assert the exec'd argv equals what bash-only selection would have produced.

bash-lib.ts - `bash -c 'source <libdir>/luna-deploy.sh && <fn>'` for lunaValidateProfile, lunaFindBun, lunaEnvValue, lunaConfigureClaudeExecutable. libdir = dirname($LUNA_DEPLOY_BASH_ENGINE)/lib, resolved in preflight, exit 1 before the lock if absent.

lock.ts - acquire/release_update_lock (:950-1008): atomic mkdir, PID+starttime fingerprint (process_fingerprint at :951-960 - /proc/<pid>/stat field 20 after `sed 's/^.*) //'`, `ps -p <pid> -o lstart=` fallback), umask-077 owner write in bash's exact `pid=\nfingerprint=\n` shape, the MANDATORY self-readback re-verify (:1000-1006), and stale takeover with its `removing stale update lock for profile '<p>'` warn (:986).

probes.ts - the six ReadinessProbeOptions functions (readiness.ts:81-105) and restart.ts's runSystemctl, all through target.ts, plus two adapters at the wiring layer: RestartOutcome{code} -> rollback.ts's `number`, ReadinessResult{ready,detail} -> its `boolean`. Neither primitive loses its return type to satisfy a bash-shaped int. Note rollback.ts's layout discriminant is `"bare" | "releases"` (rollback.ts:115), not "inplace".

apply-inplace.ts - apply_ref_inplace (:1169-1252). Full contract including the two things the draft dropped: the third parameter `no_fetch="${3:-}"` and its fetch arm (:1172-1174). Both live call sites pass --no-fetch (:1821 in do_rollback, :2020 in the main flow) and journal recovery never fetches at all - the fetch at :1975 sits inside the fresh-run else arm - so a port with an unconditional fetch would make every recovery hit the network. Then: `git reset --hard` (:1176), the bidirectional case-normalized HEAD postcondition (:1177-1194), the TRANSACTION_TRACK_APPLY checkout journal write (:1195-1197), the `git hash-object bun.lock` compare gating `bun install --frozen-lockfile` with its two stdout lines (:1199-1215), the node_modules postcondition (:1207-1213), and the claude re-pin (:1218-1252).

THE CLAUDE RE-PIN IS PORTED ARM-FOR-ARM, NOT UNIFIED. The draft's "reuse the incus idiom for the host arm too" is a redesign of a mode-600 secrets writer on the deploy path, and the draft itself conceded no fixture can observe it. The two arms are genuinely different: the incus arm (:1236-1247) is `run_target bash -lc` against the CONTAINER's lib/.env/repo with a THREE-way outcome (rc 9 = warn-only degrade, other nonzero = return 1); the host arm (:1248-1255) is an IN-PROCESS `luna_configure_claude_executable "$ENV_FILE" "$REPO_DIR" || return 1` - note $REPO_DIR, not $HOST_REPO_DIR or $CONTAINER_REPO_DIR - with a TWO-way outcome plus a separate host-side warn-only degrade check. `bash -lc` is a login shell that re-sources profile files and changes what `command -v claude` (:1253) resolves against, and luna_upsert_env branches on the caller's DRY_RUN (scripts/lib/luna-deploy.sh:35-86). Port the host arm through bash-lib.ts with `bash -c` (no -l), the parent's exact environment, DRY_RUN propagated, and $REPO_DIR verbatim; keep each arm's own outcome arity. And make it diffable: bash-fixtures.ts gains a `claude` stub and a LUNA_CLAUDE_CODE_EXECUTABLE-bearing .env so the 0 / rc-9 / nonzero three-way is actually exercised on both drives.

update-flow.ts - the assembly. SYNCHRONOUS, matching every primitive's *Sync suffix, with no node:child_process import (every subprocess injected). Two corrections to the draft's control-flow claims:

  (a) IT RETURNS AN EXIT CODE AND NEVER CALLS process.exit. `process.exit()` skips `finally` in Node/Bun, so the draft's "whole body in one try/finally: lock contention -> exit 0" would leak the lock on exactly the paths the finally exists for. main.ts exits after the finally has released.

  (b) THE SIGNAL CLAIM IS DROPPED, AND THE DIVERGENCE IS STATED. Bash's `trap release_update_lock EXIT INT TERM` (:1007) fires between commands; Node dispatches SIGINT/SIGTERM on the event loop, which a synchronous body spanning a 6s settle (restart.ts:84-88) and a 60s readiness poll (readiness.ts:53) never yields to. `process.on('exit')` and uncaughtException DO fire synchronously and are wired; INT/TERM are not. The recovery is the next run's lock_owner_alive stale takeover (:961-971, :984-987), which emits the extra `removing stale update lock` warn bash never emits - assert that stderr divergence explicitly in interop-parity rather than pretending parity.

  Flow: lock contention -> 0, or 4 under --restart-only (:1872-1881). The --restart-only branch (:1883-1913) - and its exit set is {0,1,2,3,4}, NOT {0,1,3,4}, and it CAN route through rollback, because the journal-pending arm at :1889-1892 only WARNS and falls through at :1913 into the normal recovery/apply/restart/readiness flow, which reaches do_rollback via fail_forward (:2031, :2065) and can return 2. RESTART_ONLY is never re-read after :1889. Then: corrupt journal -> 2 (:1923-1927); the two recovery buckets - rolling-back/rollback-failed -> forwardRestartRan=true + doRollback, any other phase -> guard, defer keeps the journal; the fresh-run guard after ref resolution and before the first write_transaction (:1995-2002); the five checkpoints prepared->checkout->applied->restarting->verifying.

  THE JOURNAL RECORDS REF; EXPECTED_BUILD_SHA IS THE POST-APPLY HEAD. The draft said "carry the RESOLVED sha into apply, EXPECTED_BUILD_SHA and the journal" and that contradicts the oracle: on inplace, a 7-64 hex --ref passes through VERBATIM (:1991-1992), while NEW_HEAD is read AFTER apply (:2039) and only then does `EXPECTED_BUILD_SHA="$NEW_HEAD"` (:2069). With an abbreviated or uppercase --ref the two differ, changing the success line `updated $PREV -> $NEW_HEAD` (:2072) and READINESS_DETAIL's `${EXPECTED_BUILD_SHA:0:12}` (:1113-1115).

  seed_dream_wake_jobs BELONGS HERE, NOT IN apply-inplace.ts. Its only call site is :2075, inside `if readiness_ok "$RESTART_BASELINE"` (:2073) and before clear_transaction (:2076). The draft's placement would run it before the restart, on deploys that later roll back, and - since apply_ref is also called by do_rollback (:1821) - on every rollback. Its script path comes from dream_wake_install_script (:413-420), whose HOST_REPO_DIR probe and CONTAINER_REPO_DIR-relative output must be ported with it, and it fires a SECOND `bun run` that lands in bun.log.

  update-flow.ts also emits readinessGaveUpLine (readiness.ts:204) on every ready=false, reproducing :1125 - readiness.ts deliberately warns for nobody.

restart.ts GAINS THE MainPID POSTCONDITION (:1509-1569), currently excluded by design at restart.ts:15-19. Without it the binary is strictly weaker than the bash it replaces at detecting a failed stop. THE RULE IS FAIL-ONLY-ON-POSITIVE-PROOF, not the draft's "old pid == new pid means the stop silently failed": an unreadable pre-PID or pre_pid==0 skips the check entirely (:1519-1524, :1550), an unreadable POST-PID warns INCONCLUSIVE and passes (:1552-1560), post_pid==0 passes (:1566), and only a nonzero post_pid equal to a nonzero pre_pid returns 1. Extend RestartOutcome's failure variant `step` with a `"mainpid"` case carrying pre/post (restart.ts:136-139); update-flow.ts prints the two byte-exact warn lines. RESTART_PRESTART_HOOK stays excluded (releases-only, delegated).

main.ts - replace `update: stubSurface(...)` (:40) with a real command; leave autodeploy/guardian and stubSurface untouched. Handle `update --help` in the raw-argv preamble (:57-67), not citty, because :47-56 documents that per-subcommand help goes silent under NODE_ENV=test - the exit-0-no-output shape publish_engine's postcondition (scripts/luna-guardian:1227-1231) exists to catch - and reproduce the "Exit codes:" block verbatim from luna-update-server's usage since operators read it literally during an incident. exit-codes.ts and version.ts unchanged.

TESTING - dual-drive golden parity at the ASSEMBLY level, which exists at no level today. Add `runBinaryUpdate` beside `runUpdate` (bash-fixtures.ts:35-43) and `makeFixturePair()`. The shared fixture is at repo-root test/helpers/update-server-fixtures.ts, imported as `../../../../test/helpers/update-server-fixtures.js` (bash-fixtures.ts:11); IT MUST NOT BE EDITED - the 273-test hostenv suite depends on it. Every new stub goes in bash-fixtures.ts, which writes replacements INTO the bin dir makeStubBin returned: an `incus` passthrough (`shift 2; exec "$@"` after logging), and a systemctl whose `show` case answers a settable MainPID instead of the shared stub's hardcoded `printf '0\n'` (update-server-fixtures.ts:133) - which today makes every MainPID scenario take the skip branch and prove nothing. bash-fixtures.ts's Fixture interface (:46-58) must also expose curlLog and bunLog, which makeStubBin already returns (:107-110) and makeFixture drops.

DETERMINISM IS PART OF THE CONTRACT, or the byte-diff passes on wall-clock luck: makeFixturePair pins GIT_AUTHOR_DATE/GIT_COMMITTER_DATE so both repos hash identically (makeDeployRepo does not, :41-60), and the differ masks the journal's `updated_at=` (:1012-1014) and the fixture-root path prefix that bun.log lines embed (:1206 logged verbatim at :184).

SIX DIFFED ARTIFACTS, NOT FIVE. STDOUT IS THE ONE THE DRAFT OMITTED AND IT IS WHERE THE ENGINE'S ENTIRE NARRATIVE LIVES: luna_info writes to stdout (scripts/lib/luna-deploy.sh:4), luna_warn/luna_die to stderr (:5-6). A binary that printed nothing on the happy path would pass every scenario the draft listed. Diff: (1) exit code, (2) stdout byte-exact - pinning at minimum the banner block (:423-440), `Target ref:` (:521), `Current HEAD:` (:1967), the two bun.lock decision lines (:1201, :1214), `Checked out:` (:2040), the seed lines (:1718, :1721-1723) and the success line `updated $PREV -> $NEW_HEAD ($SERVICE_NAME healthy)` (:2072), (3) stderr byte-exact with `ROLLED BACK to` (:1839) pinned the way rollback-parity already pins it, (4) systemctl.log + curl.log + bun.log, (5) final journal bytes, (6) final `git rev-parse HEAD`. bun.log proves install fired only on a lockfile delta (and carries the second, seed invocation - assert both, in order); final-HEAD proves the reset postcondition against real git.

## acceptance

LIVE. On the dev host, `LUNA_DEPLOY_ENGINE=binary /usr/local/lib/luna-guardian/current-dev/luna-autodeploy dev` reaches the binary rather than the luna-autodeploy:122 refusal, and the binary completes one full inplace+incus deploy end to end (HEAD advanced, unit restarted, /readyz buildSha matches, journal cleared). The same invocation with `--repair` reaches the binary on BOTH rungs. With LUNA_DEPLOY_ENGINE unset, every path is bit-for-bit unchanged.

DUAL-DRIVE PARITY identical across all six artifacts, run in BOTH bare-host and --incus topologies for the first three scenarios: happy path (lock unchanged); happy path (lock changed -> install fires, bun.log shows install then seed); readiness-fail-rollback-OK (exit 1 + byte-exact `ROLLED BACK to`); apply-phase failure with the guard still active (exit 3, checkout at PREV); rollback-also-fails (exit 2 + the supervisor-conditional CRITICAL hint); --no-rollback (exit 1, phase=forward-failed); corrupt journal (exit 2, checkout untouched); fresh-run guard defer (exit 3, nothing written); mid-transaction guard defer (exit 3, journal retained); resume from each of the five forward phases and from rolling-back; `--ref <7-char abbrev>` and `--ref <UPPERCASE 40-hex>` (the two spellings where REF and NEW_HEAD separate - success line and READINESS_DETAIL must match bash); a resume performs ZERO `git fetch`; MainPID x {changed, unchanged -> exit 1 with the byte-exact POSTCONDITION warn, post-unreadable -> INCONCLUSIVE warn and pass}; claude re-pin x {0, rc 9 degrade warn, nonzero -> apply fails}; seed fires exactly once on the happy path and zero times on readiness-fail-rollback.

--restart-only x {ok, restart-fail -> 1, guard-defer -> 3, lock contention -> 4} PLUS the two journal-precedence scenarios the draft's exit set denied: a pending phase=verifying journal completing normally (exit 0, journal cleared) and one failing readiness (exit 1 + `ROLLED BACK to`), proving the :1889-1892 fallthrough is not short-circuited.

INTEROP, own suite: bash writes a journal at each phase via LUNA_TEST_CRASH_AFTER_PHASE (:1017-1020) and the binary completes it; in reverse, the binary's own journal writer produces the bytes and bash's load_transaction (:1028-1044) parses and completes them - the binary ships NO self-SIGKILL seam. A bash lock holder defers the binary and vice versa, with the owner file read by the other engine's lock_owner_alive; the binary-killed-mid-deploy case takes the stale-takeover path and its extra `removing stale update lock for profile '<p>'` stderr line is asserted as a KNOWN divergence, not hidden.

DELEGATION: every delegated topology (releases, launchd, --user, --dry-run, --materialize) execs bash with the post-subcommand flags byte-identical to what bash-only selection would have produced, and emits `DELEGATED to bash engine: <flag>`. Every preflight refusal exits 1 with the byte-exact `error: ` line BEFORE the lock dir exists. The lock dir is absent after every terminal path including exit 2. Per platform, the suite asserts WHICH lock-fingerprint branch ran (/proc on Linux, ps fallback on macOS) so neither silently stops being covered.

## abandonCondition

If PR0 cannot make LUNA_DEPLOY_ENGINE=binary reach the binary on a live dev host, STOP the whole slice and re-plan the arc: S22a-d are unverifiable and S23 cannot flip. Concretely, verify on the host BEFORE writing any TypeScript that `/usr/local/lib/luna-guardian/current-dev/deploy-cli` exists and is executable; if guardian has never published it there, the precondition is S21's, not this slice's.

If any parity scenario cannot be expressed without editing scripts/luna-update-server, stop and re-plan rather than growing the bash diff - that file is simultaneously the live default engine and the parity oracle, and a port cannot be proven against an oracle it mutated. The same rule applies to test/helpers/update-server-fixtures.ts: if a scenario cannot be built by layering replacement stubs in bash-fixtures.ts, stop rather than perturb the 273-test hostenv suite.

If apply_ref_inplace parity diverges on the HEAD postcondition (:1177-1194) or the lockfile-hash gate (:1199-1206), delete apply-inplace.ts and delegate the whole inplace invocation, leaving `update` a pure delegator - a binary that reports a lying reset as success is worse than no binary.

If the claude re-pin cannot be made diffable by the fixture's claude stub, do NOT ship an unproven port of a mode-600 secrets writer: delegate any invocation that would reach it, and say so in ACCEPTANCE rather than implying coverage.

If the session guard can be made to proceed with live sessions under ANY binary path, revert to bash-only for restart; fail-closed is the invariant.

If the shared lock or journal proves non-interoperable in either direction, the escape hatch is fiction and the fold stops.

If routing do_repair through luna_select_engine destabilises test/deploy-scripts.test.ts's repair coverage in a way that cannot be fixed without changing repair SEMANTICS, revert that half of PR0, descope --restart-only from S22d entirely (delete the branch and its acceptance rows), and record in S23 that the accept gate must treat any repair-driven deploy as non-proof.

## deployNote

PR0 is the only production-behavior change and it ships dark: LUNA_DEPLOY_ENGINE still defaults to bash (luna-autodeploy:112), so with the variable unset the selected argv prefix is exactly the pinned bash engine path, bit-for-bit the pre-S22c invocation. No pin dir changes shape, nothing is copied, no disk grows - the abandoned copy approach would have added a ~60MB binary per pin to a /usr/local/lib/luna that has no reaper (guardian's prune_engines walks a different base, scripts/luna-guardian:1264-1328).

Land and deploy PR0 fleet-wide FIRST, then confirm on the dev host that (a) /usr/local/lib/luna-guardian/current-dev/deploy-cli is executable and (b) `LUNA_DEPLOY_ENGINE=binary <that dir>/luna-autodeploy dev --dry-run` selects the binary rather than printing the :122 refusal. Until both hold, no amount of TypeScript is reachable.

The deploy-cli parity suites run in the DEFAULT `bun run test` gate, not the hostenv opt-in (vitest.config.ts:69 includes apps/**/*.test.ts; HOST_ENV_TESTS at :55-59 lists only the three repo-root suites), so they execute on both the self-hosted Linux runner and developer macOS. The do_repair change is covered by test/deploy-scripts.test.ts, which IS hostenv-gated - run `bun run test:hostenv` locally before merge, since CI surfaces it non-blocking.

THREE S23 PRECONDITIONS TO RECORD IN THIS PR, all of which will otherwise break the flip:
1. NO UNATTENDED PATH REACHES THE BINARY TODAY. The guardian service unit (scripts/luna-guardian:866-881) and the autodeploy timer unit (scripts/luna-autodeploy:757-765) set no LUNA_DEPLOY_ENGINE, and the timer's ExecStart points at the CHANNEL REPO's own copy of luna-autodeploy (:743, :765) where deploy-cli does not exist at all. S23 must flip the default at luna-autodeploy:112 (which fixes the guardian path) AND accept that the timer path stays bash until S24 folds autodeploy in - or retire the timer.
2. LunaChatServerDriver EXECS A FLAG-ONLY ARGV. packages/server-registry/src/driver/luna-chat-server.ts:154 and :213 build `[this.pinnedScriptPath, ...flags]` with no subcommand. Pointing pinnedScriptPath at the binary without inserting `update` reproduces exactly the failure luna-autodeploy:98-105 documents ("Unknown command stable", exit 1, before any of its own logic). The driver's exit-code switch must also be re-verified against the binary.
3. deploy.layout IS A PER-PROFILE OPT-IN (scripts/lib/luna-registry.sh:498-503). Nothing in-tree sets it today, but a releases-configured profile will DELEGATE rather than exercise the binary, so S23's accept gate must grep for `DELEGATED to bash engine:` and refuse to count such a run as proof. Same for any guardian repair once do_repair routes through the gate.

CORRECT THE RECORD IN THE SAME PR: apply_ref appears in NO slice in docs/next/stack23-plan.json (S22 scopes journal/guard/restart/readiness/rollback/flip; S24 scopes autodeploy/guardian/registry). The comment at apps/deploy-cli/src/update/rollback.ts:11 asserting "apply_ref's own git/bun work is S24's" is one author's note, not a plan record; apply_ref_inplace is pulled into S22d here, and the releases arm is NEW, newly-budgeted S24 scope rather than an inheritance. Also correct the draft's own claim that `update` assembles nine primitives: it assembles SIX (journal.ts, atomic-file.ts, session-guard.ts, restart.ts, readiness.ts, rollback.ts). status-file.ts:1-16 and health-journal.ts:1-16 are guardian ports that stay bash-only until S24, and atomic-replace.ts serves the releases-layout symlink flip, which this slice delegates.

## files

- scripts/luna-autodeploy
- apps/deploy-cli/src/main.ts
- apps/deploy-cli/src/update/target.ts
- apps/deploy-cli/src/update/config.ts
- apps/deploy-cli/src/update/preflight.ts
- apps/deploy-cli/src/update/delegate.ts
- apps/deploy-cli/src/update/bash-lib.ts
- apps/deploy-cli/src/update/lock.ts
- apps/deploy-cli/src/update/probes.ts
- apps/deploy-cli/src/update/apply-inplace.ts
- apps/deploy-cli/src/update/update-flow.ts
- apps/deploy-cli/src/update/restart.ts
- apps/deploy-cli/src/update/rollback.ts
- apps/deploy-cli/test/update/bash-fixtures.ts
- apps/deploy-cli/test/update/engine-select.test.ts
- apps/deploy-cli/test/update/lock-parity.test.ts
- apps/deploy-cli/test/update/config-preflight-parity.test.ts
- apps/deploy-cli/test/update/delegate-parity.test.ts
- apps/deploy-cli/test/update/apply-inplace-parity.test.ts
- apps/deploy-cli/test/update/update-flow-parity.test.ts
- apps/deploy-cli/test/update/interop-parity.test.ts
- apps/deploy-cli/test/main.test.ts
- test/engine-pin.test.ts
- test/deploy-scripts.test.ts
- docs/deploy-binary.md
- docs/next/stack23-plan.json
- docs/next/stack23-slices.md

## verification

- bun run test -- apps/deploy-cli/test/update/
- bun run test -- apps/deploy-cli/test/main.test.ts
- bun run test -- test/engine-pin.test.ts   # owns luna_pin_engine; runs in the DEFAULT gate (vitest.config.ts:69-70), never in test:hostenv
- bun run test:hostenv   # test/deploy-scripts.test.ts owns do_repair (14 'repair' sites) and IS in HOST_ENV_TESTS (vitest.config.ts:55-59)
- bash -n scripts/luna-autodeploy
- git diff --stat scripts/luna-update-server   # MUST be empty: the parity oracle is untouched
- git diff --stat test/helpers/update-server-fixtures.ts   # MUST be empty: the 273-test hostenv suite depends on it
- grep -rn 'ROLLED BACK to' apps/deploy-cli/src scripts/luna-update-server packages/server-registry/src   # the marker survives in all three
- grep -rn 'child_process' apps/deploy-cli/src/update/update-flow.ts   # MUST be empty: the assembly is purely injected
- grep -rn 'process.exit' apps/deploy-cli/src/update/   # MUST be empty: update-flow returns a code, main.ts exits after the finally
- grep -rn 'reset --hard' apps/deploy-cli/src   # MUST appear in exactly one file (apply-inplace.ts)
- bash -c 'eval "$(awk "/^luna_select_engine\\(\\)/{f=1} f{print} f&&/^}$/{exit}" scripts/luna-autodeploy)"; d1=$(mktemp -d); d2=$(mktemp -d); printf "#!/bin/bash\n" > $d1/luna-update-server; chmod +x $d1/luna-update-server; printf "#!/bin/bash\n" > $d2/deploy-cli; chmod +x $d2/deploy-cli; LUNA_DEPLOY_ENGINE=binary luna_select_engine $d1/luna-update-server $d2'   # resolves the binary from the SEARCH dir, not beside the bash engine
- bash -c 'source scripts/lib/luna-deploy.sh; declare -f load_transaction' >/dev/null; bun run test -- apps/deploy-cli/test/update/interop-parity.test.ts   # bash load_transaction parses a binary-written journal (replaces the draft's luna-guardian-remote-check line: `update` never writes /var/lib/luna-guardian/status-<profile>, which is guardian's file and S24's concern)

## PR split

### PR0

PR0 - reach the binary at all (~35 lines bash, ~120 lines test). luna_select_engine takes a binary-search-dir argument and resolves $2/deploy-cli (replacing dirname($pinned_engine)/deploy-cli at luna-autodeploy:120); do_deploy (:513-518) and BOTH do_repair rungs (:591, :599) route through it with the same while-read prefix expansion; all three exec sites gain the command-prefix assignment LUNA_DEPLOY_BASH_ENGINE="$pinned_engine". luna_pin_engine is NOT touched. Tests: engine-select.test.ts gains cases where the bash engine and the binary live in DIFFERENT dirs (its makePin at :24-36 can only express one dir today); test/deploy-scripts.test.ts asserts both repair rungs exec the SELECTED prefix and that an unset LUNA_DEPLOY_ENGINE leaves both byte-identical; test/engine-pin.test.ts is re-read to confirm its idempotency test (:223-224) still holds unchanged. Independently useful, independently revertible, a hard precondition for every later PR. Deploy fleet-wide and confirm on dev before proceeding.

### PR1

PR1 - primitives (~600 src + ~550 test). target.ts, config.ts, preflight.ts, delegate.ts, bash-lib.ts, lock.ts, probes.ts, plus restart.ts's MainPID postcondition and its RestartOutcome `mainpid` step. bash-fixtures.ts gains the incus passthrough stub, the settable-MainPID systemctl replacement, the claude stub + .env, curlLog/bunLog on Fixture, and the date-pinned makeFixturePair. Each module lands with its own parity suite (lock-parity, config-preflight-parity, delegate-parity) in the S22a-c shape. `update` stays a stub and main.ts is untouched, so main.test.ts's shared stub loop (:68-75) still passes unedited.

### PR2

PR2 - assembly (~500 src + ~650 test). apply-inplace.ts, update-flow.ts, the real update command in main.ts, update-flow-parity.test.ts, interop-parity.test.ts, apply-inplace-parity.test.ts; drop only 'update' from main.test.ts:68-75's shared loop (leaving autodeploy/guardian) and add one real update assertion against the actual `bun build --compile` artifact beside the existing --version compiled test (main.test.ts:88-111), since publish_engine ships precisely that artifact. This is the only safe cut line: any split INSIDE PR2 lands a partially-wired update, which is the half-ported engine the whole design exists to avoid.
