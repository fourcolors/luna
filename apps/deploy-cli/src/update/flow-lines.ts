/**
 * Every operator-facing string the update orchestration tail emits, in one
 * table, each carrying the `scripts/luna-update-server` line it was ported
 * from.
 *
 * WHAT THIS FILE IS FOR, AND WHAT IT IS NOT FOR. It exists so `update-flow.ts`
 * and its siblings are literal-free and so a reviewer diffing a bash string
 * change has exactly ONE file to open. It is NOT a proof: a human transcribing
 * bash into a constants file and then asserting the constants against the
 * transcription proves nothing, which is why `flow-lines.test.ts` says in its
 * own header that it is documentation. The proof that these bytes match the
 * bash is the dual-drive stdout/stderr diff in `update-flow-parity.test.ts`,
 * where both engines run the same scenario and their operator output is
 * compared byte for byte.
 *
 * PAYLOADS ONLY, NO PREFIX. `scripts/lib/luna-deploy.sh:4-6` owns the `-> `,
 * `warning: ` and `error: ` prefixes, and in the port `wiring.ts`'s `info`,
 * `warn` and the `luna_die` path apply them. So every builder below returns
 * what goes AFTER the prefix, the same way `rollback.ts`, `lock.ts` and
 * `preflight.ts` already draw that line. The one exception is
 * `corruptJournalLine`, which bash emits as a raw `printf` to stderr with no
 * prefix at all (:1925); its trailing newline belongs to the caller's raw
 * writer, not to the payload, matching how `rollback.ts` hands its CRITICAL
 * line to `writeStderrRaw`.
 *
 * THE EM DASHES ARE PORTS, NOT PROSE. House style in this repo is a plain
 * dash. Every U+2014 below sits inside a verbatim port of a bash string an
 * operator greps and another program may parse, so fidelity outranks style
 * here exactly as it does in `rollback.ts:13-25`. `flow-lines.test.ts` pins
 * the exact set of builders allowed to carry one, so "fixing" a dash fails a
 * test instead of silently changing what an incident responder sees.
 *
 * CONST OR BUILDER, THE RULE. A line with nothing to interpolate is exported
 * as a `string` constant; a line with an interpolation is exported as an arrow
 * function taking exactly the pieces bash interpolates. There is no zero-arg
 * function here, because a call that can only ever return one value is noise
 * at every call site.
 *
 * THIS FILE IMPORTS NOTHING, on purpose. `restart.ts` - a primitive that
 * landed in PR1 - imports its six lines from here rather than declaring its
 * own copies, so the "one file to diff" property holds for the strings emitted
 * from inside `settle_after_stop`, `sup_start` and `restart_service` too. That
 * a PR1 module depends on a PR2 module is acceptable precisely because the
 * dependency is on data, is acyclic, and this file pulls in nothing itself.
 *
 * THE FIVE SESSION-GUARD LINES ARE DELIBERATELY NOT HERE. They live in
 * `session-guard.ts` as `guardVerdictLine`, beside the already-shipped
 * `operatorOverrideLogLine`, because only that module can map the
 * `GuardVerdict` union exhaustively and get a compile error when a new arm is
 * added rather than a silent `null`.
 */

// --------------------------------------------------------------------------
// Recovery of an interrupted transaction (:1925-1949)
// --------------------------------------------------------------------------

/**
 * `luna_warn` at :1932. Bash abbreviates both shas with `${PREV:0:9}` and
 * `${REF:0:9}`, so the slicing is part of the string and belongs here rather
 * than at the call site, where a caller passing a pre-sliced sha would make
 * the width invisible to a reviewer diffing this table.
 */
export const recoveringLine = (phase: string, prev: string, ref: string): string =>
  `RECOVERING interrupted update phase=${phase} prev=${prev.slice(0, 9)} target=${ref.slice(0, 9)}`

/**
 * `printf ... >&2` at :1925, the ONE line in this table with no prefix: bash
 * writes it directly rather than through `luna_warn`/`luna_die`, because at
 * that point it is refusing to touch the checkout at all and the message is
 * addressed to a human reading a log, not to the deploy driver.
 *
 * The `\n` in bash's format string is the caller's to add through the raw
 * stderr writer, so that this stays a payload like every other entry here.
 */
export const corruptJournalLine = (journalPath: string): string =>
  `CRITICAL: corrupt update transaction journal ${journalPath} — refusing to mutate the checkout; inspect or remove it manually.`

/** `luna_warn` at :1949: the guard deferred a RESUME, so the journal stays and the next idle tick finishes it. */
export const deferredRecoveryResumeLine = (phase: string): string =>
  `DEFERRED by session guard; transaction journal retained (phase=${phase}) — resumes when sessions end`

// --------------------------------------------------------------------------
// The fresh-run path (:1965-2074)
// --------------------------------------------------------------------------

/**
 * `luna_warn` at :1999: the guard deferred BEFORE anything was mutated, which
 * is why this one promises nothing about a journal - there is none to retain.
 */
export const deferredFreshRunLine = "DEFERRED by session guard; nothing mutated (retry next tick)"

/**
 * `luna_warn` at :2058: the guard deferred with the checkout already moved and
 * the journal at phase=restarting, which is the third and most delicate of the
 * three defer shapes. The phase is hardcoded in bash's string, not
 * interpolated, so it is hardcoded here.
 */
export const deferredMidTransactionLine =
  "DEFERRED by session guard mid-transaction; journal retained (phase=restarting) — resumes next tick"

/** `luna_info` at :1967. */
export const currentHeadLine = (prev: string): string => `Current HEAD: ${prev}`

/** `luna_info` at :2041. */
export const checkedOutLine = (newHead: string): string => `Checked out: ${newHead}`

/** `luna_info` at :2074, the success line an operator looks for. */
export const updatedLine = (prev: string, newHead: string, serviceName: string): string =>
  `updated ${prev} -> ${newHead} (${serviceName} healthy)`

/**
 * `luna_die` message at :1965, i.e. the payload `error: ` is prefixed to.
 *
 * Near-unreachable in bash - `git rev-parse HEAD` in a repo that already
 * passed the preflight clone check has no realistic empty-output path - and
 * ported anyway, because the port's own git seam can be stubbed and a silent
 * divergence here would only ever surface during an incident.
 */
export const readHeadFailedMessage = (hostRepoDir: string): string =>
  `could not read current HEAD in ${hostRepoDir}`

/** `luna_die` message at :1974. The reassurance is the load-bearing half: nothing was touched yet. */
export const fetchFailedMessage = "fetch failed before update; checkout unchanged"

/**
 * `luna_die` message at :1994. It interpolates the ref AS REQUESTED, not the
 * resolved one, because the whole point is that resolution failed.
 */
export const refUnresolvedMessage = (requestedRef: string): string =>
  `could not resolve target ref ${requestedRef}`

// --------------------------------------------------------------------------
// The restart-only path (:1891-1910)
// --------------------------------------------------------------------------

/** `luna_warn` at :1891: `--restart-only` found a pending transaction and downgrades itself to normal recovery. */
export const restartOnlyJournalPendingLine =
  "restart-only requested but an update transaction is pending; running normal recovery instead"

/** `luna_warn` at :1896. The parenthetical is the contract: restart-only never mutates, so there is nothing to roll back. */
export const restartOnlyRestartErroredLine =
  "restart-only: restart errored (checkout untouched; no rollback)"

/**
 * `luna_info` at :1907. Bash abbreviates with `${EXPECTED_BUILD_SHA:0:12}` -
 * twelve, not the nine `recoveringLine` uses - so the width is pinned here.
 */
export const restartOnlyHealthyLine = (serviceName: string, sha: string): string =>
  `restart-only: ${serviceName} healthy at ${sha.slice(0, 12)}`

/** `luna_warn` at :1910. */
export const restartOnlyReadinessFailedLine =
  "restart-only: readiness failed after plain restart (checkout untouched; no rollback)"

// --------------------------------------------------------------------------
// apply_ref_inplace (:1192-1250)
// --------------------------------------------------------------------------

/**
 * `luna_warn` at :1192, the postcondition that catches a `git reset --hard`
 * which reported success without moving HEAD.
 *
 * `head` is what the post-reset read produced, and bash's `${head_now:-unreadable}`
 * substitutes for an UNSET OR EMPTY value, so an empty string prints
 * `unreadable` exactly as a failed read does. `null` is the port's spelling of
 * "the read failed"; both collapse to the same word here on purpose.
 */
export const headPostconditionLine = (head: string | null, target: string): string =>
  `POSTCONDITION: git reset reported success but HEAD is '${head === null || head === "" ? "unreadable" : head}', expected ${target} — refusing to continue`

/** `luna_info` at :1202. The arrow is a plain ASCII `->`, not an em dash; bash writes it that way. */
export const lockChangedLine = "bun.lock changed -> bun install --frozen-lockfile"

/** `luna_info` at :1215, the other half of the lockfile gate. */
export const lockUnchangedLine = "bun.lock unchanged -> skipping bun install"

/**
 * `luna_warn` at :1211. The path is `$CONTAINER_REPO_DIR/node_modules`, i.e.
 * the path AS THE TARGET SEES IT, which on the incus arm is not a path that
 * exists on the host - so the caller must pass `containerRepoDir` and never
 * `hostRepoDir`.
 */
export const nodeModulesPostconditionLine = (containerRepoDir: string): string =>
  `POSTCONDITION: bun install exited 0 but ${containerRepoDir}/node_modules is missing`

/**
 * `luna_warn` at :1240 (incus arm) and :1250 (host arm), byte-identical in
 * both, which is why one constant serves both call sites.
 */
export const claudeDegradedLine =
  "POSTCONDITION degraded: no usable claude executable after re-pin — server will boot but cannot spawn claude"

// --------------------------------------------------------------------------
// The six restart.ts emits from inside its own ports (:1276-1563)
//
// These do not belong to the orchestration tail: bash prints them from inside
// settle_after_stop, sup_start and restart_service, which means all three
// callers of restart_service see them and they interleave with the restart's
// own steps. They live here anyway so that the "one file to diff" property
// covers every operator string in the flow, and restart.ts imports them.
// --------------------------------------------------------------------------

/**
 * `luna_warn` at :1276, emitted when RESTART_SETTLE_SECS fails
 * settle_after_stop's own `^[0-9]+(\.[0-9]+)?$` check (:1275).
 *
 * The remediation half is not decoration: skipping the settle is how the
 * DuckDB/SQLite WAL/SHM race that motivated the settle comes back, so the line
 * names both flag spellings and a working value.
 */
export const settleInvalidLine = (settleSecs: string): string =>
  `RESTART_SETTLE_SECS='${settleSecs}' is not a non-negative number of seconds; SKIPPING the post-stop settle — the DuckDB/SQLite WAL/SHM race may recur. Set --restart-settle / LUNA_RESTART_SETTLE_SECS to a valid value (e.g. 6).`

/**
 * `luna_info` at :1279. Bash prints this BEFORE attempting the sleep at :1282,
 * so a sleep that then fails produces this line AND `settleSleepFailedLine`,
 * in that order - two lines, not one.
 */
export const settlingLine = (settleSecs: string): string =>
  `settling ${settleSecs}s after stop so DuckDB/SQLite release WAL/SHM before start`

/** `luna_warn` at :1283: the sleep itself failed, so the start proceeds with no settle at all. */
export const settleSleepFailedLine = (settleSecs: string): string =>
  `post-stop settle sleep failed (RESTART_SETTLE_SECS='${settleSecs}'); proceeding to start WITHOUT a settle — the WAL/SHM race may recur.`

/**
 * `luna_warn` at :1375, printed by `sup_start` BETWEEN its `is-failed` probe
 * (:1374) and the `reset-failed` that clears the latch (:1376). The position
 * matters as much as the bytes: an operator reading `systemctl.log` beside
 * stderr should see the warn land between those two calls.
 */
export const startLimitLatchedLine = (serviceName: string): string =>
  `sup_start: ${serviceName} is start-limit latched failed; clearing with reset-failed and retrying once`

/**
 * `luna_warn` at :1559. A post-restart MainPID that cannot be read is NOT
 * evidence the old process survived, so the postcondition is skipped rather
 * than failed and readiness still gates the build - the line says so, because
 * the alternative reading routes a healthy deploy into a rollback.
 */
export const mainPidInconclusiveLine =
  "restart postcondition INCONCLUSIVE: post-restart MainPID unreadable (transport failure?); skipping the PID-change check — readiness still gates"

/** `luna_warn` at :1563, the one positive proof the stop failed: systemd answered, and the answer is the OLD pid. */
export const mainPidUnchangedLine = (prePid: string, postPid: string): string =>
  `POSTCONDITION: restart did not replace the server process (MainPID before=${prePid} after=${postPid}) — the stop silently failed`

// --------------------------------------------------------------------------
// The post-deploy dream/wake seed (:1718-1722)
// --------------------------------------------------------------------------

/** `luna_info` at :1718. */
export const seedStartLine = "post-deploy: seeding V2 dream/wake job rows (idempotent)"

/** `luna_info` at :1720. */
export const seedOkLine = "post-deploy: dream/wake job rows ensured"

/**
 * `luna_warn` at :1722. Non-fatal by design, which is why it hands the
 * operator the exact command to run: a failed seed does not fail the deploy,
 * it just means wake/dream go dark until someone notices.
 */
export const seedFailedLine = (bunBin: string, script: string): string =>
  `post-deploy: dream/wake seed FAILED (non-fatal); if wake/dream go dark, run manually: ${bunBin} run ${script}`
