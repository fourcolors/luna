/**
 * Every MUTATING argv the inplace update transaction can issue, built in
 * exactly one place (scripts/luna-update-server:1170-1250, :538-544, :1719).
 *
 * WHY THIS FILE EXISTS. target.ts's header already makes the point from the
 * other side: "NO MUTATING GIT COMMAND APPEARS IN THIS FILE ... the one
 * destructive git invocation the transaction performs lives in exactly one
 * greppable file", so an auditor asking "what can move this checkout?" gets
 * one answer from one grep (target.ts:41-49). This is that file, widened from
 * git to every command that can change the deployed system: the reset, the
 * fetch, the bun install, the bun run, and the in-container claude re-pin.
 * The argv the live path issues and the argv commands.test.ts asserts are then
 * the same bytes BY CONSTRUCTION rather than by a human transcribing one into
 * the other, which is the failure mode a "constants file diffed against the
 * transcription of itself" test has.
 *
 * WHAT IS DELIBERATELY NOT HERE, and it is most of the interesting behaviour:
 *   - ZERO IO. Nothing below spawns anything. The callers (apply-inplace.ts,
 *     fresh-run.ts, wiring.ts) push these arrays through target.ts's waist,
 *     which is the module that owns the host-versus-container decision.
 *   - ZERO branching on `dryRun`. Dry-run belongs to `luna_run`
 *     (scripts/lib/luna-deploy.sh:8-18) and therefore to target.ts's mutating
 *     arms; an argv builder that knew about it would have to decide whether it
 *     is describing a command or performing one, and it is only ever
 *     describing.
 *   - ZERO knowledge of `TargetContext`. Two of the builders below are FULL
 *     argv (they name their own binary) and four are ARGUMENT TAILS that
 *     target.ts prefixes; the split is not stylistic, see the next paragraph.
 *
 * `...Args` VERSUS `...Argv` IS THE INCUS/HOST SPLIT, and the suffix is the
 * only warning a reader gets before passing one to the wrong runner:
 *   - The `git*Args` values are the tail AFTER git's own `-C <host repo>` /
 *     `--git-dir <mirror>` prefix, which `gitArgv` (target.ts:261-265) adds.
 *     git ALWAYS runs on the host, at every layout.
 *   - `gitHashObjectArgv` is the exception that names `git` itself, because
 *     bash's `lockfile_hash` (:540) does NOT route through `git_target`: it
 *     writes a plain host-side `git -C "$HOST_REPO_DIR"` even on the releases
 *     layout, where `git_target` would have addressed the bare mirror instead.
 *     Routing it through the layout-aware arm would hash the wrong object on
 *     that layout, so it is spelled out here in full.
 *   - `bunInstallArgv`, `nodeModulesTestArgv`, `bunRunArgv` and
 *     `incusRepinArgv` are full argv for `run_target`, which wraps them in
 *     `incus exec <container> --` when a container is set (target.ts:252-253).
 *     They must therefore never carry a host path: see the repo-dir note.
 *
 * WHICH REPO DIR, which is the single most expensive thing to get wrong here
 * because it fails silently rather than loudly (:318-320, :373-383). git takes
 * the HOST repo dir, because git runs host-side and mutates the bind-mount
 * source. bun and the node_modules probe take the CONTAINER repo dir, because
 * they run inside the container where the repo is visible at its own path.
 * On a bare host the two strings are equal, so a swap is undetectable there
 * and only shows up as a deploy into the wrong filesystem on incus. The
 * parameter names below say which one each expects and nothing here defaults
 * one to the other.
 *
 * PATHS ARE CONCATENATED, NOT `path.join`ed. Bash writes
 * `"$HOST_REPO_DIR/bun.lock"` and `"$CONTAINER_REPO_DIR/node_modules"`, which
 * is a literal slash and no normalisation whatsoever. `join()` would collapse
 * a doubled slash or a `.` segment an operator typed into `--repo-dir`, and
 * the argv an operator diffs against a bash host would then differ for a
 * reason unrelated to the port. It would also introduce a platform-dependent
 * separator into a string that is always a POSIX path on the deploy target.
 */

// --- git: the argument tails target.ts prefixes ------------------------------

/**
 * `git_target fetch origin` (scripts/luna-update-server:1175, :1974). Args
 * AFTER git's own `-C`/`--git-dir` prefix, which `gitArgv` adds.
 */
export const gitFetchOriginArgs: ReadonlyArray<string> = ["fetch", "origin"]

/**
 * `git_target reset --hard "$target"` (scripts/luna-update-server:1177).
 *
 * THE ONE COMMAND IN THE ENTIRE PORT THAT CAN MOVE THE DEPLOYED CHECKOUT, and
 * the reason `reset --hard` must grep to exactly one source file. `target` is
 * pre-validated 7-64 hex by config.ts / the journal's TX_TARGET, so it is
 * passed through verbatim with no normalisation: bash does the same (:1177),
 * and lowercasing it here would make the argv disagree with the journal an
 * operator reads back.
 */
export const gitResetHardArgs = (target: string): ReadonlyArray<string> => ["reset", "--hard", target]

/**
 * `git_target_capture rev-parse HEAD` (scripts/luna-update-server:1189, :1964,
 * :2040). Read-only, but it lives here because its three call sites are the
 * checkout postcondition, PREV and NEW_HEAD, and a reader chasing "what does
 * the transaction believe HEAD is?" should find one spelling.
 */
export const gitRevParseHeadArgs: ReadonlyArray<string> = ["rev-parse", "HEAD"]

/**
 * `git_target_capture rev-parse "${REQUESTED_REF}^{commit}"`
 * (scripts/luna-update-server:1992): the NON-hex arm of ref resolution, which
 * peels an annotated tag or a branch name to a commit.
 *
 * The `^{commit}` suffix is part of the ref string, not a separate argument -
 * bash interpolates it inside the same double-quoted word - and the braces are
 * literal bytes git parses, so nothing here quotes or escapes them.
 */
export const gitRevParseCommitArgs = (ref: string): ReadonlyArray<string> => ["rev-parse", `${ref}^{commit}`]

/**
 * `git -C "$HOST_REPO_DIR" hash-object "$HOST_REPO_DIR/bun.lock"`
 * (scripts/luna-update-server:538-544), the full argv including the binary.
 *
 * NOT routed through target.ts's layout-aware git arms, deliberately: bash
 * spells this one out rather than calling `git_target`, so on the releases
 * layout it still addresses the host checkout instead of the bare mirror. See
 * this module's header.
 *
 * `hash-object` is blob-id semantics, not a generic digest. The value is
 * persisted in the journal as `prev_lock_hash` and compared as a plain string
 * on the next run, so a port that substituted sha256 or md5 would report the
 * lockfile as changed on every single deploy and reinstall dependencies every
 * time.
 */
export const gitHashObjectArgv = (hostRepoDir: string): ReadonlyArray<string> => [
  "git", "-C", hostRepoDir, "hash-object", `${hostRepoDir}/bun.lock`,
]

// --- run_target: full argv, container-routed when a container is set ---------

/**
 * `run_target "$BUN_BIN" install --cwd "$CONTAINER_REPO_DIR" --frozen-lockfile`
 * (scripts/luna-update-server:1206).
 *
 * `--cwd` takes the IN-CONTAINER repo path in incus mode and the host repo on
 * a bare host, because `run_target` has already moved execution inside the
 * container by the time bun reads it (:1203-1205). `--frozen-lockfile` is the
 * whole point of the lockfile gate above it: the install must fail rather than
 * silently resolve a different tree than the one that was reviewed.
 */
export const bunInstallArgv = (bunBin: string, containerRepoDir: string): ReadonlyArray<string> => [
  bunBin, "install", "--cwd", containerRepoDir, "--frozen-lockfile",
]

/**
 * `run_target test -d "$CONTAINER_REPO_DIR/node_modules"`
 * (scripts/luna-update-server:1210): the postcondition that an install which
 * exited 0 actually produced its declared artifact.
 *
 * INCUS ARM ONLY as an actual subprocess. Through `run_target` this really
 * does exec an external `test(1)` inside the container, which is why it is an
 * argv at all; on a bare host the port answers the same question with a
 * filesystem stat instead of spawning `/usr/bin/test`, so this builder has one
 * caller. See apply-inplace.ts step 5.
 */
export const nodeModulesTestArgv = (containerRepoDir: string): ReadonlyArray<string> => [
  "test", "-d", `${containerRepoDir}/node_modules`,
]

/**
 * `run_target "$BUN_BIN" run "$script"` (scripts/luna-update-server:1719): the
 * post-deploy dream/wake seed.
 *
 * `script` is the CONTAINER-relative path `dream_wake_install_script` resolved
 * (:1717), not the host path it probed to find it - the same host/container
 * split as `bunInstallArgv`'s `--cwd`.
 */
export const bunRunArgv = (bunBin: string, script: string): ReadonlyArray<string> => [bunBin, "run", script]

// --- the incus claude re-pin -------------------------------------------------

/**
 * The `bash -lc` PAYLOAD of the in-container claude re-pin, byte for byte
 * (scripts/luna-update-server:1236-1237). A single string, deliberately: it is
 * one shell program, and splitting it would change what `bash -lc` receives.
 *
 * THE HARDCODED PATHS ARE NOT A TEMPLATING OVERSIGHT. `/root/luna` and
 * `/root/.luna/.env` are the CONTAINER's own repo and env file, hardcoded in
 * the bash at :1237, and no flag reaches them: the host-side `--repo-dir` and
 * `--env-file` describe the host, and interpolating them here would point the
 * helper at paths that do not exist inside the container. A parameterised
 * version would therefore diverge from the oracle on the incus drive, which is
 * the one drive that runs this line.
 *
 * `exit 9` IS A SENTINEL, not an error code to be normalised. It marks "the
 * re-pin found no usable claude" distinctly from a transport or exec failure,
 * and the caller degrades to a warning on 9 while failing the apply on
 * anything else non-zero (:1239-1242). Changing the number silently converts a
 * warn-only degradation into a rollback.
 *
 * Verified against the source by commands.test.ts, which reads line 1237 at
 * test time and applies a stated unescaping rule rather than trusting this
 * transcription.
 */
export const incusRepinPayload =
  "source /root/luna/scripts/lib/luna-deploy.sh && luna_repin_claude_executable /root/.luna/.env /root/luna && { v=$(luna_env_value /root/.luna/.env LUNA_CLAUDE_CODE_EXECUTABLE 2>/dev/null || true); [[ -n $v && -x $v ]] || exit 9; }"

/**
 * The argv `run_target` receives for the re-pin, i.e. exactly
 * `["bash", "-lc", incusRepinPayload]` (scripts/luna-update-server:1236-1237).
 *
 * Three elements, and the boundaries matter as much as the bytes: bash's
 * `run_target bash -lc "<payload>"` passes the payload as ONE argument, so a
 * port that joined it into a shell string would hand `incus exec` a payload it
 * re-splits on whitespace.
 */
export const incusRepinArgv: ReadonlyArray<string> = ["bash", "-lc", incusRepinPayload]
