# The deploy binary (`apps/deploy-cli`)

This document tracks the S21-S25 fold that replaces `scripts/luna-guardian`, `scripts/luna-update-server` and `scripts/luna-autodeploy` with one compiled binary.
See [`docs/next/stack23-slices.md`](next/stack23-slices.md) for the full slice sequence and its gates.

## Architectural decision: the binary owns the state machine

**Decision:** the compiled binary at `apps/deploy-cli` becomes the deploy engine's state machine (update/journal/session-guard/readiness/rollback, then guardian's supervision loop).
`packages/server-registry/src/driver/contract.ts`'s `ServerUpdateDriver` interface gains **no new methods** for any of this.

This was a real fork in the road, not a formality.
The alternative the planning panel considered and rejected: extend `ServerUpdateDriver` with guardian-shaped methods (timer supervision, debounce journal, repair ladder) and let the existing driver abstraction absorb the fold.
That alternative was rejected because the driver contract already has a clean, narrow job - `plan` / `resolveTarget` / `apply` / `healthCheck` / `rollback` for ONE update transaction - and guardian's job is a different shape entirely: an independent, always-running supervision loop with its own debounce journal, promotion gate and repair ladder, sitting a layer above any single driver.
Bolting supervision-loop concerns onto a per-transaction driver interface would blur that boundary for every current and future driver implementation, not just the one being folded.

The charter text that authorized this fold does not disambiguate between these two shapes, which is why this decision is recorded here explicitly rather than left implicit in a diff.

**Decided 2026-08-06 (orchestrator, Operator veto until master merge): Option A, the binary owns the state machine.**
The `ServerUpdateDriver` contract stays frozen at its current four methods for this fold.
This status holds provisionally until master merge - the Operator retains the veto described above, and if it is exercised, the entire S21-S25 fold must stop and be redesigned before any further slice lands, since S22 onward all build directly on top of this premise.

## Why the artifact is named `deploy-cli`, not `luna-deploy`

`publish_engine` (`scripts/luna-guardian`) copies six named bash scripts plus `lib/*.sh` out of the deployed release into a content-addressed pin, then runs one syntax check over exactly those bash files:

```sh
chmod +x "$tmp"/luna-*; bash -n "$tmp"/luna-* "$tmp/lib/"*.sh
```

Both the `chmod` and the `bash -n` glob on the `luna-*` prefix.
A compiled artifact named `luna-deploy` would match that same glob, and `bash -n` would be handed a binary and asked to syntax-check it as a shell script.
On the platforms this pin is published to, that is not a silent success: bash detects the executable header and refuses with `cannot execute binary file` (exit 126), which would make every publish fail the moment the binary was added.

Naming the artifact `deploy-cli` sits it outside the `luna-*` glob entirely, and it is `chmod +x`'d on its own explicit line, never folded into the bash glob's `chmod`.
`test/guardian.test.ts`'s `"naming the binary luna-deploy would collide with the bash -n glob..."` test locks this in against the REAL compiled bytes, not synthetic magic bytes - a handful of raw ELF/Mach-O header bytes alone did not reliably trip bash's binary-file detection during this slice's own testing, only a real compiled executable did.

## Who builds it, and for which platform

`deploy-cli` is compiled inside `publish_engine`, using `bun build --compile`, at the moment a new engine pin is published.
It is compiled with the RUNTIME's own bun, never the publishing host's bun on its behalf: the container's bun for an incus profile, reached through the same `run_runtime`/`incus exec` seam the rest of the engine already uses for every other in-container step, or the publishing host's own bun for a bare-host profile, where host bun IS the runtime bun.

`publish_engine` runs wherever `luna-guardian` itself runs.
`luna-guardian` is systemd-only - it has no `launchd`/`launchctl` reference anywhere in the file, and its rendered unit carries `After=network-online.target incus.service` - so in production the publishing host is the Linux incus host machine that runs the guardian's systemd timer and hosts the incus containers, or the bare Linux host for a non-incus profile, never a container itself and never macOS.
arm64 macOS is the DEV and hermetic-test machine only; it never publishes a pin in production, and hermetic tests stub the container seam (`incus exec` re-executed locally against a stub bun) rather than requiring a real incus host to exercise this path.

This is deliberate, not an oversight:

- Deploy targets are Linux containers (incus), reached through `incus exec`; the publishing host is the incus HOST itself, a separate machine from any container it manages, and the incus host deliberately carries no bun of its own (`luna-container-create` installs no host bun) - only the containers it manages do.
  A binary compiled anywhere other than the runtime it targets - a CI runner, a developer's Mac, or the incus host cross-compiling on the container's behalf - is not guaranteed to match that runtime's platform, and `bun build --compile` produces a target-specific standalone executable, not a portable bytecode format, so there is no single cross-compiled artifact safe to commit for every possible target.
  Building inside the runtime at publish time guarantees the binary in a pin was built by, and for, the exact runtime and release that pin represents.
- A binary that ships committed to a public repository is also a supply-chain and reproducibility concern this fold does not need to take on.
  Building from source at publish time keeps the only trusted artifact the bash and TypeScript source already reviewed in the PR.

If the binary cannot be built inside the runtime, `publish_engine` fails the publish loudly (`set -euo pipefail` plus an explicit postcondition on the binary actually printing its own version) rather than falling back to an artifact nobody can verify.

### The host/container boundary this creates

`deploy-cli` is always a HOST-side artifact once published: the pin (and the `deploy-cli` inside it) lives on the guardian host at `/usr/local/lib/luna-guardian/engine@<sha>/deploy-cli`, never inside a container.
How it gets there differs by profile shape.
For a bare-host profile, `bun build --compile` runs directly on the publishing host and writes straight into the pin.
For an incus profile, `bun build --compile` runs INSIDE the container against the container's own bun (`/root/.bun/bin/bun`), exactly like every other bun invocation in the deploy engine - `luna-update-server` and `luna-server-install` route their work through `run_target`/`run_runtime`, which resolves to `incus exec` for an incus profile, so their bun calls already ran with the container's own bun, never the host's - and the compiled binary is read back out of the container through that SAME `incus exec` seam before it is written into the pin on the host.
The publishing host itself never needs bun for an incus profile; only the container does.

For an incus profile the compile itself reads from the CONTAINER's tree (`container_root`, the bind-mounted checkout), while the sha naming the pin and the six bash scripts `cp`'d into it come from the HOST's tree (`$root`) - the same host/container convergence assumption `unit_paths_current`/`reconcile_unit_if_idle` already make elsewhere in this engine, and just as unverified here: nothing proves the two sides are the same commit at publish time either.

This matters for S22, which is scoped to fold `luna-update-server`'s in-container steps into `deploy-cli`: `deploy-cli` is a host-side artifact with no bind-mount presence inside any container, so S22 must resolve how (or whether) `deploy-cli` gets invoked from inside the container it is meant to eventually manage, rather than assuming the pin's host-side copy alone is reachable from there.

For an incus profile this also means the binary's build environment and its (current, S21) execution environment are not the same machine: it is compiled inside the container, then immediately run on the host for the `--version` postcondition below, and would be run on the host for every future host-side use S22+ adds.
An incus container shares the host's kernel and CPU architecture - it is not a VM - so this can never be an architecture mismatch, but the container's userspace, in particular its libc version, is independent of the host's, and `bun build --compile` links against the building system's libc.
A container image carrying a newer glibc than the guardian host's could produce a binary the host cannot load.
Nothing here detects that case ahead of time or rules it out by construction: the `deploy-cli --version` postcondition (`scripts/luna-guardian`'s `publish_engine`) is what stands in for it, failing the publish loudly - with the binary's own stderr captured into the die message, not discarded - rather than silently accepting an artifact the host cannot run.
That is a proof by execution at publish time, not a stated compatibility guarantee, and an operator changing container base images should treat it as the thing this topology currently relies on to catch a libc skew, not as a preflight that rules one out in advance.

### New operator precondition on the runtime

Before this slice, `publish_engine` had zero toolchain dependencies - a pure `cp` plus `bash -n` path.
It now additionally requires bun on the RUNTIME that builds the binary:

- Bare-host profile: `bun` resolvable via `luna_find_bun` (`scripts/lib/luna-deploy.sh`) on the publishing host itself.
- Incus profile: `bun` at `/root/.bun/bin/bun` inside the container - the same path every other in-container bun invocation in this engine already assumes.
- `install_guardian` preflights the correct one of these (`runtime_bun_bin`/`runtime_bun_executable`, `scripts/luna-guardian`) explicitly, AFTER the pending-update-transaction and runtime-health guards but BEFORE `publish_engine` is ever invoked, and DEFERS (`luna_warn` plus `return 10`, the same idiom as those two guards) rather than failing the tick if it is missing, so a runtime that has not yet installed `bun` gets a quiet skipped tick instead of a per-minute pager storm.
  Ordered after those two guards specifically so a container that is merely stopped or restarting mid-deploy is diagnosed by the guard that actually explains it, not misreported as a missing bun.
- `apps/deploy-cli/node_modules/citty` resolvable in the deployed checkout - if this is missing, `bun build --compile` fails loudly under `set -euo pipefail` with its own "Cannot find package" error; there is no separate check for it, since bun's own build failure already names the missing package.
  For an incus profile this precondition is checked against `container_root` (`/root/luna`, or `${LUNA_CONTAINER_DEPLOY_ROOT:-/root/luna}/current` for a releases layout - the same hardcoded path `unit_paths_current`/`reconcile_unit_if_idle` already assume), which is taken on faith to be the container's view of the exact same commit `$root` resolves to on the host side, the sha the pin is named for.
  Nothing verifies the two sides agree; an operator who relocates the bind mount without updating both gets bun's "Cannot find package" error with no pointer back to this assumption, or - worse, if the relocated mount happens to contain a real but different checkout - a pin silently built from one commit with scripts copied from another.

An incus container that never ran `bun install` at the repo root before this slice will need to before its profile's engine can advance past this pin; a bare-host profile needs the same on the publishing host itself.

## Why `citty`, not a hand-rolled argv switch

`apps/deploy-cli`'s own S21 surface - `--version`, `--help`, three stub subcommands - is small enough that a ~35-line argv switch would cover it.
`citty` (and its `consola` transitive) is taken on anyway, because S21 is not the surface this binary ends up with: S22-S26 port real flag surfaces from the three bash entrypoints it replaces, and those surfaces are not small.

Measured directly from the scripts being folded in:

- `scripts/luna-update-server` alone parses 24 distinct long flags (`--dry-run`, `--force`, `--incus`, `--profile`, `--ref`, `--restart-only`, `--releases-keep`, `--readiness-timeout`, and 17 more), several with argument validation.
- `scripts/luna-guardian`'s own subcommands add `--interval` (regex-validated), `--expected-sha`, `--min-cycles` (numeric range), `--repair`.
- `scripts/luna-autodeploy` adds `--dry-run`, `--force`, `--repair`, `--validate`, `--allow-active`, `--from-timer`, `--repo-dir`, `--interval`.

That is roughly three dozen flags across three command groups, several needing typed validation and per-subcommand `--help` text, landing incrementally over five more slices.
`citty` gives typed flag parsing, per-subcommand `--help` generation, and nested subcommand dispatch for that surface as it lands, rather than a hand-rolled parser this fold would otherwise have to grow and maintain slice by slice.
The cost this choice adds now - `consola`'s environment-sensitive `--version`/`--help` output (see the Operational gotcha below, sidestepped for the top-level case but not yet for per-subcommand `--help`), and `apps/deploy-cli/node_modules/citty` as a new build-time precondition - is paid once, in the scaffold slice, in exchange for not re-deriving flag parsing three more times.

## Bootstrap ordering: the engine must learn to publish binaries before any binary can be current

`publish_engine` copies the SIX bash scripts that make up the engine (including itself) out of the deployed release and into the pin.
That means the engine that knows how to build and publish `deploy-cli` must itself ship as bash, through this same pin mechanism, and be accepted on a host BEFORE any pin on that host can contain a binary.

Concretely: a pin published by a pre-S21 engine has no `deploy-cli` in it.
A pin published by this (post-S21) engine always does, unless the publish itself failed loudly.
Nothing on a host can invoke `deploy-cli` until a pin containing it has been published and accepted - there is no way to skip straight to the binary.

This is why S21 ships as a bash change first, with the binary as an inert, unwired scaffold (every subcommand exits `CRITICAL`, see the exit code contract below), rather than shipping any real deploy logic in the same slice.

### Pin completeness does not depend on the binary

The completeness classifier a pin is judged by - `.complete` on disk, plus `-x "$current/luna-guardian"` and `-x "$current/luna-pager"` (`scripts/luna-guardian`'s `install_guardian` converged fast-path and `render_control_plane`) - names neither `deploy-cli` nor any binary.
A pin published by an OLDER engine, with no `deploy-cli` in it at all, is still a fully complete, fully functional pin; the binary is additive, not a completeness requirement.
`test/guardian.test.ts`'s `"a pin published by an older (pre-deploy-cli) engine..."` test locks this in directly: it removes `deploy-cli` from an otherwise-complete pin and asserts an `install` re-run against it still succeeds via the converged fast-path.

Once this bash change is current on a host, every NEW pin that host's engine publishes is required to contain a working `deploy-cli` - a build failure at that point is a hard `luna_die`, never a silent degrade.

## Operational gotcha: `NODE_ENV`/`TEST` silently mute `citty`'s own output

`citty`'s built-in `--version`/`--help` handling prints through `consola`, which goes silent - exit `0`, empty output - whenever `NODE_ENV=test` or `TEST=<truthy>` is present in the environment.
`NODE_ENV=test` can reach a compiled binary two ways: baked in as a build-time literal by `bun build --compile`'s implied `--production` if the BUILDING process had it set, or present in the environment the binary is later RUN with.
`TEST` is read at runtime only, on every invocation, independent of what was baked in at build time.
A guardian host never sets either, but any test harness that builds and immediately runs the compiled binary - CI, `vitest`, this repo's own test suite - inherits both from its own process environment by default, and would otherwise observe an artifact that silently "succeeds" while printing nothing.

`apps/deploy-cli/src/main.ts` avoids this at the source rather than working around it at every build or test call site: `--version` and top-level `--help` are handled before `runMain` ever runs, writing straight to `process.stdout` without going through `consola` at all, so the binary's answer is independent of `NODE_ENV`/`TEST` in either the building or the running process.
`publish_engine`'s postcondition (`deploy-cli --version` must print something, not merely exit `0`) and this repo's tests exercise that path directly, with no `env -u` stripping needed anywhere.

The one surface still routed through `citty`'s own (env-sensitive) handling is per-subcommand `--help` (`deploy-cli update --help` and similar): `citty` does not export the subcommand-resolution helper `main.ts` would need to bypass it the same way `--version` and top-level `--help` do, and no subcommand has a real argv surface yet to make closing that gap worthwhile.
Future subcommand slices (S22+) that port real `citty` commands should extend `main.ts`'s own `process.stdout.write` handling to cover that case rather than reintroducing `env -u NODE_ENV -u TEST` at build/test call sites.

## Exit code contract

`deploy-cli`'s exit codes (`apps/deploy-cli/src/exit-codes.ts`) are carried forward verbatim from the bash engine they will eventually replace (`scripts/luna-update-server:171-184`, the documented `Exit codes:` block in its `--help` text), so a caller - systemd, a remote health check, an operator's shell - reads the same numbers regardless of which engine produced them:

| Code | Meaning |
|------|---------|
| 0 | Updated and healthy (or up-to-date / no-op). |
| 1 | Preflight error, OR readiness failed but rollback succeeded. |
| 2 | CRITICAL: readiness failed AND rollback also failed (manual intervention required). |
| 3 | Deferred by the session guard (live or unknown sessions). |
| 4 | `--restart-only` only: deferred because another update holds the profile lock. |

A scaffold-only stub subcommand exits `CRITICAL` (`2`) directly rather than through a separate alias constant, keeping this table a byte-faithful copy of the bash contract - `2` is the correct "something is wrong, look closer" code for a subcommand whose logic has not been ported yet.

## The state-file format contract (S22a)

This section, and the parity harness below it, scope to S22a: the first of the three PRs S22 splits into, per the deployNote minimum-slice-count for a change this size.
S22b and S22c cover session-guard/restart and readiness/rollback respectively, wiring the state machine the files below only record.

The deploy engine's crash-safety rests on three on-disk `key=value` text files, each written atomically (tmp file at mode `0600`, then `mv`/`rename()`) so a reader never observes a partial write.
The containing state directory is created at mode `0700` before each write, via `ensureStateDir` in `atomic-file.ts`.
That mirrors the bash writer's own `mkdir -p "$STATE_DIR"; chmod 700 "$STATE_DIR"` pair for two of the three files: `write_guardian_status` (`scripts/luna-guardian:287-288`) and `health_journal_write` (`scripts/luna-guardian:397-398`) each do exactly that immediately before their own printf.
`write_transaction` (`scripts/luna-update-server:1010-1021`) does NOT mkdir or chmod at all - `$UPDATE_STATE_DIR` is provisioned once, earlier in the real flow, by `acquire_update_lock` (`scripts/luna-update-server:981-982`).
`writeTransactionSync` still calls `ensureStateDir` on every write as a pragmatic stand-in until S22b/S22c port `acquire_update_lock`'s own state machine - that call is not a byte-format claim about `write_transaction` itself.

| File | Written by | Read by |
|------|-----------|---------|
| `$UPDATE_STATE_DIR/transaction-<profile>` | `write_transaction` (`scripts/luna-update-server:1010-1021`) | `load_transaction` (`scripts/luna-update-server:1028-1044`), on next-tick resumption after a crash |
| `$STATE_DIR/status-<profile>` | `write_guardian_status` (`scripts/luna-guardian:283-326`) | `status_value` (`scripts/luna-guardian:271-275`) and `scripts/luna-guardian-remote-check`'s `value()` (line 34), over ssh |
| `$STATE_DIR/health-<profile>` | `health_journal_write` (`scripts/luna-guardian:393-412`) | `status_value`, via `health_journal_read` / `health_journal_zero_recorded` (`scripts/luna-guardian:344-434`) |

FORMAT IS A CONTRACT, not an implementation detail: `scripts/luna-guardian-remote-check` parses the status file with `sed`, over ssh, from a machine that may be running either engine.
Byte-exact preservation is what lets a bash host and a binary host coexist without a flag day - the whole reason this fold ships incrementally (S21-S25) instead of as one cutover.

`apps/deploy-cli/src/update/` ports the on-disk IO for all three files, as pure readers/writers only:

- `journal.ts` - `writeTransactionSync` / `loadTransactionSync` / `clearTransactionSync`, plus `TX_PHASES`, the closed set of phases `write_transaction` accepts (`prepared`, `checkout`, `applied`, `restarting`, `verifying`, `rolling-back`, `rollback-failed`, `forward-failed`). `loadTransactionSync` is three-state: undefined when the journal is absent, a thrown `CorruptJournalError` when it is present but unreadable or fails validation, and a parsed `Transaction` otherwise - mirroring the opposite meanings bash's own `[[ -f "$UPDATE_JOURNAL" ]]` check and `load_transaction`'s own failure give those two cases (`scripts/luna-update-server:1923-1927`).
- `status-file.ts` - `writeGuardianStatusSync`.
- `health-journal.ts` - `writeHealthJournalSync`.
- `atomic-file.ts` - the shared tmp-then-rename writer, `ensureStateDir` (the mkdir+chmod pair each writer calls explicitly before writing - see the provenance note above), `readKeyValue` (matching `status_value`'s `sed -n "s/^$1=//p" | head -1` - the one bash reader both the status file and the health journal share, so the port does not fragment it into two identical copies), and `allKeyValuesLastWins` (matching `load_transaction`'s `while IFS='=' read` loop).

What this port deliberately does NOT include: the phase-sequencing and next-tick resumption logic in `scripts/luna-update-server`'s main flow (still bash-only until S22b/S22c port session-guard/restart and readiness/rollback), and guardian's own supervision-loop decisions - when a check tick runs, the freshness-window evidence gating in `health_journal_read`, the `consecutive_healthy`/`consecutive_runtime_healthy` increment arithmetic in `write_guardian_status` (still bash-only until S24 folds guardian itself).
Every writer in `apps/deploy-cli/src/update/` takes its fields explicit; nothing here decides when to call them or what value to pass.
`packages/server-registry/src/driver/contract.ts` is untouched by this slice, matching the frozen-contract decision above.

### The parity harness

`apps/deploy-cli/test/update/` proves byte parity against the real bash, not a hand-derived expectation of it, using two different techniques depending on what the bash side offers:

- **`scripts/luna-update-server` has no sourcing guard** - executing it always runs the live update flow.
  `journal-parity.test.ts` instead drives the real script end-to-end as a subprocess (a real git checkout, deterministic systemctl/curl/bun stubs), using `LUNA_TEST_CRASH_AFTER_PHASE` to `SIGKILL` it immediately after each phase write - the same seam `test/update-server.test.ts` already uses for its own recovery test.
  Every reachable phase is captured this way (crash-injected for the five forward phases and `rolling-back`; run to natural completion for the terminal failure states `rollback-failed` and `forward-failed`, which are never crash-injected because they are simply where the script itself exits) and diffed byte-for-byte against `journal.ts`'s writer.
  The `checkout` case goes one step further: a TS-authored journal (independently re-serialized, not a copy of the captured bytes) is dropped in place of the bash-authored one, and the real bash script's own recovery path is run against it to a clean exit `0` - proving the coexistence property directly, not just the format.
- **`scripts/luna-guardian` ships a documented sourcing guard** (`if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then ... fi` at its tail, with a comment naming it a test seam).
  `status-file-parity.test.ts` and `health-journal-parity.test.ts` source the real script and call `write_guardian_status` / `health_journal_write` directly against a temp `$P_REPO`/`$STATE_DIR`, then diff the result against `status-file.ts` / `health-journal.ts`.
  `status-file-parity.test.ts` additionally runs the literal `sed -n "s/^$1=//p" | head -1` idiom `scripts/luna-guardian-remote-check`'s `value()` uses against a TS-authored status file, for every field it reads - the sed-level proof standing in for a live ssh round-trip.

These three suites shell out to the real ops scripts, the same shape `vitest.config.ts`'s `HOST_ENV_TESTS` list excludes from the default blocking `bun run test` run and defers to the non-blocking `bun run test:hostenv` step, because most such suites read the HOST's own incus/tailscale/launchd/systemd/profile-lock state rather than a fixture.
They stay in the default blocking suite anyway, deliberately: every value each one touches is pinned to a hermetic per-test fixture - `--profile`/`--repo-dir`/`--luna-home`/`--service-dir`/`--supervisor`/`--readiness-port` plus `LUNA_UPDATE_STATE_DIR`, `LUNA_TEST_WS_COUNT=0`, `LUNA_TEST_BUN_PATH`, and a `PATH` pointed at deterministic stub `systemctl`/`curl`/`bun` binaries - so none of them can read or write real profile state, unlike a `HOST_ENV_TESTS` suite like `test/deploy-scripts.test.ts`.
A byte-parity proof against the real bash is only worth gating every PR on because that pinning holds; a suite that could not make the same guarantee belongs in `HOST_ENV_TESTS` instead.

## Current state (S21-S22a)

- `apps/deploy-cli` is a workspace app under `apps/*/src`, so it is typechecked from birth by the root `tsconfig.json`'s `apps/*/src/**/*.ts` include glob.
- It implements `--version`, `--help`, and three stub subcommands (`update`, `autodeploy`, `guardian`) mirroring the three bash entrypoints' top-level argv surfaces.
- Every subcommand exits `CRITICAL` (`2`) with `deploy-cli <name>: not implemented` on stderr - no deploy logic has been WIRED yet; `apps/deploy-cli/src/update/` (S22a) ports the transaction-journal and guardian status/health state-file IO those subcommands will eventually call, but nothing in `main.ts` invokes it yet.
- `publish_engine` builds and ships it in every new engine pin, named `deploy-cli`, executable, verified to print its own version before the pin is marked complete.
- The compiled binary measures ~60MB.
  `prune_engines` keeps 5 engines, so steady-state pin storage on the guardian host grows from a few hundred KB to roughly 300MB.
  `prune_engines` skips `engine@*.tmp.*` staging dirs entirely, never counting them toward `keep=5` and never deleting them as engines, and reaps a staging dir whose owner pid is dead.

No further slice-by-slice status is maintained here; see `docs/next/stack23-slices.md` for what each subsequent slice (S22-S26) is scoped to do.
