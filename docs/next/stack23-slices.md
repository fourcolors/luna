# Stack 2+3 completion plan - 27 slices

This is the validated execution plan that completes NEXT.md Stack 2 (remainder) and Stack 3.
The canonical machine-readable spec is [stack23-plan.json](stack23-plan.json); this page is the human summary.

## Provenance

Produced 2026-08-03 by a 19-agent planning workflow: 5 scope readers, 3 competing architect proposals, a 9-judge adversarial panel (correctness, deploy-safety, simplicity), a synthesizer, and a plan auditor.
Two audit rounds returned FIX; all 17 corrections were resolved, several via direct empirical measurement on a macOS host (rename(2) semantics, bun launcher behavior, port-guard predicates).
Implementation protocol: Sonnet implements each slice; an Opus auditor, critic, and reviewer gate it; the orchestrator reviews the diff and lands it as one stacked PR on `luna-next`.

## Operator adjudications

- S25 full-bash-deletion variant APPROVED (2026-08-03): the deploy bash engine is deleted outright once the binary holds; the engine pin is the escape hatch, with both manual recovery procedures documented and exercised.
- Dream+wake unification remains REJECTED (2026-08-03); no slice re-proposes it.
- The defineToolPackage factory and all ten tool-package migrations already landed (#417-#423); the chat-service, job-ticker, and main.rs splits already landed (#424-#426).

## Slices

| ID | Title | One concern |
|----|-------|-------------|
| S01 | Portable atomic replace via perl rename | Six GNU-only atomic flips make the hostenv suite unrunnable on macOS, so no deploy slice can be locally verified. |
| S02 | Clear the systemd start limiter before every restart | `systemctl reset-failed` exists nowhere in scripts/, so a failed-start burst locks the unit out for 30 minutes and both guardian repair rungs fail identically. |
| S03 | Memory backend by parameter injection, with no env branch | MemoryRouterLayer hardcodes SqliteVectorBackend, so the backend is swappable at the type level but not at the wiring point. |
| S04 | Swap-proof: one shared contract, run against a second vector backend | Nothing mechanically proves a different backend satisfies the same semantics through the router. |
| S05 | Delete SPA static serving from the daemon | The daemon resolves apps/ui-web/dist through a sibling-directory lookup, the one coupling that fails silently across a relocation. |
| S06 | Run the luna.db schema-continuity gate before any cutover, and make it blocking | NEXT.md requires the contract established before any daemon cutover; it landed as docs+test but has never been run against real state and its CI gate is advi... |
| S06a | Retire the completed-rename guard and its README pointer before any path moves | A blocking-gate test pins ~40 literal daemon paths, so S07's ExecStart change and S08's git mv would each turn CI red for reasons unrelated to their own conc... |
| S07 | One path-independent unit, forever: repo-root TypeScript launcher plus guardian path-drift detection | The supervisor unit is host-persistent state naming a version-dependent path, and nothing re-renders it on rollback, so any later path change breaks rollback... |
| S08 | Move the daemon to apps/server/src as a pure rename | Relocate the 21-file server-runtime closure with zero deploy-artifact edits and no compatibility stub. |
| S09 | Typecheck apps/server and retire the orphaned smoke files | The daemon boot path has never been typechecked; relocating it under apps/*/src makes that possible for the first time. |
| S10 | Relocate the ops and install CLIs to apps/server/scripts | Twelve deploy-invoked operator CLIs still live under the app about to be deleted. |
| S11 | Remove the ui-web build and the dist completeness precondition from the deploy path | The deploy engine builds and postcondition-checks a frontend that nothing serves, and gates release completeness on its artifact. |
| S12 | Delete apps/ui-web, packages/design-system, and the two Stack 1 husks | Remove the retired frontend tree and the packages only it consumed. |
| S13 | Point install-mac.command at Moon instead of the Vite web UI | macOS onboarding still guards port 5174 and boots a dev server for a frontend that no longer exists. |
| S14 | Moon chat: ChatCtx seam plus a frozen typed declaration for the sanitizer | Establish the typed contract the chat rebuild mounts onto, with zero change to chat.html. |
| S15 | Moon chat: React message list and streaming render | Replace the hand-written DOM renderer and its rAF loop with React, calling the audited sanitizer unchanged. |
| S16 | Moon chat: composer, attachments and slash menu to React | The input surface is still inline DOM bindings. |
| S17 | Moon chat: thread drawer to React, wrapping the drag state machine unchanged | The thread drawer is the largest single inline subsystem and contains the most feel-critical interaction in Moon. |
| S18 | Moon chat: connection lifecycle onto ESM transport, retiring the vendored bundle | Chat's WebSocketEngine and PoolEngine still run on a generated vendor global, and the protocol version is triplicated. |
| S19 | Moon chat: remaining engines to React | Convert the last vanilla engines so the inline script can be deleted. |
| S20 | Delete the vanilla chat layer, the dual-mount bridge and the legacy fixtures | Remove the superseded vanilla shells and the tests that read them off disk, and settle the disposition of every vendor script chat.html loads. |
| S21 | Scaffold the deploy binary and teach the engine pin to publish it | Stand up the compiled artifact and its publish path before any logic is ported into it. |
| S22 | Binary: update, journal, session guard, readiness and rollback with golden parity | Port the update engine's crash-safety and rollback primitives with byte-level proof against the bash they replace. |
| S23 | Flip the deploy engine default to the binary | Make the binary the default after an accept-grade gate proves it on live hosts. |
| S24 | Fold autodeploy and guardian into the binary | Move the pull-trigger wrapper and guardian's supervision state machine into the binary. |
| S25 | Delete the bash deploy engine; the engine pin is the escape hatch (Operator-approved) | Collect the fold's deletion payoff instead of leaving two engines and a parity harness forever, without silently dropping the escape hatch the charter promised. |
| S26 | Full-agent E2E verification, gate promotion, probe retirement and docs truth-up | Prove the reshaped system end to end against real state, retire the last transient migration branch, and retire the docs describing the deleted architecture. |

## Sequencing

Verification capability first, then recovery capability, then the one structural change that makes every later move reversible.
S01 is first because 59 of 60 local hostenv failures share one root cause and CI hides the suite (continue-on-error), so without it no Sonnet agent can locally verify any deploy edit in S02, S07, S10, S11 or the whole Stack 3 fold.
S02 is second because `systemctl reset-failed` exists nowhere in scripts/ while the unit carries StartLimitBurst=10 over 1800s with RestartSec=5 - ten failed starts exhaust the burst in ~50s, inside the 60s readiness budget, after which rollback's own restart also fails and the host is hard-down for 30 minutes.
Every later unit-touching slice needs that net already in place.
S03/S04 are zero-deploy-surface and land before the tree churns so the cutover window is unconfounded.
S05 kills SPA static serving before anything moves, deleting the one coupling (`__uiWebDir` resolving one level up) that degrades silently rather than crashing; deleting it also removes any need for transitional `LUNA_UI_WEB_STATIC_ROOT` wiring in the unit templates, and eliminates the add-then-remove churn both reviewed plans inflicted on production systemd and launchd files.
S06 runs the luna.db gate BEFORE the cutover, as NEXT.md line 42 requires; both reviewed plans ran it at the very end, after the cutover it governs.
S06a is a new one-file prep slice and it exists because of a fact only reading the test surfaces: apps/ui-web/scripts/__tests__/rename-chat-server.test.ts is a blocking-gate regression guard for a COMPLETED 2024 rename, and three of its assertions pin `scripts/luna-server-install` to the literal `run scripts/chat-server.ts` while ~40 more pin the daemon's current path.
S07 breaks the first group and S08 breaks the rest, so retiring the path literals down to the live invariant (the extinct `dev-server-chat` name) must precede both, or CI stays red across two merged PRs.
Doing it here is what lets S08 be renames-only.
S07 is the pivot and the plan's main structural departure.
The supervisor unit is host-persistent state naming a version-dependent path, and I verified nothing re-renders it on rollback - `luna-server-install` appears in luna-update-server only in comments, and do_rollback flips the tree and restarts the same unit.
So one unit file must be correct for the new release AND every rollback target simultaneously.
A forwarding shim cannot achieve that (it lives in the new tree; a rollback replaces the tree), which is why the reviewed plan's shim ladder leaves a reachable bricked state.
A repo-root launcher that probes for whichever daemon entry exists in the release it runs from makes the unit path-independent forever: exactly ONE unit change in the whole plan, and the last one ever needed.
The launcher is TYPESCRIPT, not bash: measured on this Mac, `bun run` on a bash-shebang file interprets it with bun's own shell and can exit 0 SILENTLY, which under Type=notify is an immediate no-READY exit and a restart spiral with nothing in the exit code to diagnose.
The TypeScript launcher was measured too - it runs the daemon's exported bootstrap in the SAME PID (required by Type=notify plus WatchdogSec=90) and leaves `import.meta.main` false in the imported module, while a direct `bun run <daemon>` leaves it true, so both invocation paths boot exactly once.
It is paired with guardian's path-drift check because unit_hardened() inspects only Type and WatchdogUSec and its sole caller is gated on it, so nothing would otherwise adopt a re-render; and the drift check is itself gated on `previous` also carrying the launcher, so the flip can never strand the release do_rollback_releases would select.
S08 then becomes a pure rename with no unit edit and no shim at all - which also sidesteps the reviewed plan's fatal `import.meta.main` defect, where a side-effect-import shim exits cleanly without booting and every host times out silently.
With S06a done and tsconfig.judgeprobe.json gone, S08 carries only `git mv` plus the two artifacts CI's `bun install --frozen-lockfile` mechanically requires.
S09-S10 clean up behind it.
S11 strictly precedes S12 because `release_artifacts_ok` hard-requires apps/ui-web/dist/index.html, and because the deploying engine is a PINNED copy of an older SHA - a pre-S11 engine cannot materialize a post-S12 release, so the gate is engine-pin advancement per profile, not merely a deploy window.
Stack 3 starts only after S13.
Moon (S14-S20) comes before the control-plane fold because it rides the Tauri updater and cannot brick a host, and because chat.html is 12005 lines with an 8930-line inline script - honest sizing is seven slices with explicit split-on-contact triggers, following panel.html's proven incremental pattern where the page stays bootable at every commit.
S15 now carries a measured re-estimation checkpoint because the coupled Moon test surface is 15,602 lines across 39 files, 28 of them tied to the pages S20 deletes.
The fold (S21-S25) is last and most gated: S21 must ship as bash first because publish_engine copies six named bash files and runs `bash -n` over the `luna-*` glob, so the publisher must learn about binaries before any binary can be current.
S25 exists because a fold that never deletes is a fork - it collects the deletion payoff while keeping the charter's promised bash escape hatch in its smallest honest form, and names the engine pin, already holding five prior working engines on every host, as the second hatch that works when the new artifact is the broken thing.
S26 closes the loop by retiring S07's transient entry probe once every profile's `previous` is post-S08, so the migration leaves no permanent branching behind.

## Evals

Three standing gates run on every slice: `bun run test` (blocking vitest), `bun run test:bun` (promoted to blocking in S06), and `bun run test:hostenv` (locally runnable from S01 onward; still continue-on-error in CI, so treat red as blocking by convention on any deploy slice).
`bun run typecheck` is promoted to blocking in S26 once S09 has held apps/server at zero.
Atomic-replace fixture, S01: a four-case table test asserting the measured rename(2) semantics - symlink-onto-symlink EXIT 0 with the link repointed, directory-onto-vacated-name EXIT 0, directory-onto-non-empty-directory EXIT 1 with destination contents intact, directory-onto-symlink-to-directory EXIT 1 - so the helper's comment table is machine-checked rather than asserted in prose.
The two failure cases assert destination state, not just exit code, because the whole reason perl beats `mv -fh` is that `mv -fh` returns 0 while corrupting the tree.
Launcher gates, S07: the negative test is STATIC plus behavioral, deliberately not exit-code-only.
Measured on this Mac, `bun run` on a `#!/usr/bin/env bash` file containing `set -euo pipefail` prints `bun: command not found: set` and EXITS 0, so an exit-code assertion would pass against the exact broken shape the audit found.
The test therefore asserts (a) the rendered ExecStart target ends in `.ts` and the file at that path does not begin with a shebang, and (b) a bash-shebang launcher fixture never emits the daemon's ready marker.
Positive tests: the launcher boots a pre-move tree and a post-move tree to a listening 4753 with /readyz green, in ONE process (daemon PID equals launcher PID, which Type=notify plus WatchdogSec=90 make load-bearing).
Guardian fixtures cover three reconcile branches - idle (renders exactly once), active sessions >0 (defers), and `luna_active_ws_count` NON-ZERO EXIT (the 'session count unknown' branch at luna-guardian:525-526) - plus a fourth where `previous` lacks the launcher and the old unit must be left installed.
The .prev unit restore is exercised once on dev with the transcript attached.
Memory swap eval, S04: one shared `runMemoryBackendContract` runs against both real backends, plus the actual swap proof - a second backend that implements `search` (satisfying MemoryVectorBackend across vec|hybrid|bm25|hybrid-terms) driven end to end through `makeMemoryRouterLayer` so memory_search returns ranked results with a zero-line production diff.
Deliberately test-only: shipping a second production backend with one consumer is the speculative abstraction NEXT.md decision 2 forbids.
Negative control: breaking one backend's delete() must fail only that backend's contract run.
Retrieval quality is guarded separately by `bun run --filter '@luna/memory' bench:memory`, whose recall baseline is RECORDED in S06 against a copy of the real memory.db and re-compared in S26 with a 5% abandon band.
Daemon cutover gate, S06 (before the move, per NEXT.md): the docs/next/luna-db-contract.md 3-step run against COPIES - clean no-op migration boot, bench replay, job-reconciliation smoke with an orphaned job_runs row and a sticky jobs.last_status='running' row.
S08 re-runs test:bun as a hard abandon condition.
Deploy gates: S07 and S11 are gated on per-profile engine-pin advancement (`readlink previous` post-S07; pinned engine SHA post-S11), verified per host before the dependent slice merges - not on a prose "deploy window".
S22/S24 are gated by a golden parity harness diffing exit codes, the literal `ROLLED BACK to` stderr marker, and on-disk state-file BYTES, including crash-injection between journal phases and bidirectional bash/binary interop.
S25 is gated on BOTH escape hatches being actually exercised on a non-production profile: the retained scripts/luna-recover stop/flip/start, and an engine-pin rollback.
Moon gates: `bun run test -- apps/ui-moon-tauri/test/ws-contract.test.ts` (CI HARD GATE 5) on every Moon slice; `git show --stat -M` byte-identity on moon-markdown.js, highlight.min.js, widget-sandbox.js and thread-drag-session.js (the last surviving a `git mv` into the bundle in S20); `cargo build` in S20 for the include_str! path; real-Tauri screenshots per surface, with S17's drag held for manual Operator exercise because feel cannot be screenshot-proved.
S20 adds a mechanical vendor-layer gate: the thirteen-file disposition manifest is reproduced in the PR body with its grep output, and `grep -c '<script src="/vendor/' chat.html` must equal 2.
S15 carries a measurement gate rather than a pass/fail one: the Moon suite baseline is 39 test files, 15,602 lines, 28 of them referencing panel.html or index.html, and S15 records how many it actually touched so S16-S20 are re-estimated from data.
Final, S26: full-agent E2E through Moon against a deployed apps/server daemon - streaming, tool call, every artifact kind, memory write and recall, job creation delivered into the thread, drawer drag-out, slash commands - plus one binary update with a forced rollback, plus retirement of S07's transient entry probe with the per-profile readlink evidence recorded.

## Docs duty

Docs update in the slice that changes the thing, not deferred wholesale - both reviewed plans deferred all path truth to their final slice, which made their own S09/S12 verification greps unsatisfiable on live docs (AGENTS.md:23, PROJECT.md:11, README.md:301, docs/HOW_TO_TEST_AND_VERIFY.md:107 all name paths those slices moved).
Per-slice: S03 records the rejected env-var backend selector in DESIGN.md so the decision is on the record.
S06 updates docs/next/luna-db-contract.md with the recorded baseline and flips the test:bun CI comment.
S06a fixes README.md:301, which documents invoking the rename-guard test that slice rewrites (this edit moved out of S08, which is now renames-only).
S09 updates docs/HOW_TO_TEST_AND_VERIFY.md:107, which documents a smoke file that slice deletes.
S10 updates AGENTS.md:23 and PROJECT.md:11 alongside the CLI relocation.
S12 closes TODO.md:31 (watercolor-token duplication), which the design-system deletion resolves.
S21 writes docs/deploy-binary.md carrying the architectural decision requiring Operator sign-off (binary owns the state machine; ServerUpdateDriver gains no methods).
S25 documents THREE things in docs/deploy-binary.md: the retained scripts/luna-recover with its exact three-step capability and its explicit non-capabilities, the copy-pasteable engine-pin rollback command, and the recorded-but-unexecuted full-bash-deletion variant awaiting Operator sign-off.
S07 is a docs-in-the-PR-body slice rather than a docs-file slice: the .prev unit restore sequence and the per-profile `previous` readlink evidence are recorded in the PR body, because they are operational runbook steps tied to one rollout, not standing documentation.
S26 is truth-up, not catch-up: NEXT.md Stack 2/3 sections marked against what actually landed, DESIGN.md architecture sections, TESTING.md, and deletion of any live doc describing the ui-web SPA or the vanilla Moon chat.
The closing grep is scoped to LIVE docs only (README, DESIGN, AGENTS, PROJECT, TESTING, NEXT, docs/HOW_TO_TEST_AND_VERIFY.md, docs/next/).
Archival records under docs/superpowers/plans, docs/briefs, docs/audits and docs/discussions are excluded by design - roughly 20 of the ~35 files matching `apps/ui-web` are historical records that correctly describe what was true when written, and rewriting them to satisfy a gate would destroy the record.
Nothing destined for any PR body names a personal host: fourcolors/luna is public.

## Risks

- S07 is a real flag day and no plan can remove it, only bound it. Verified: `grep -n 'luna-server-install' scripts/luna-update-server` hits only comments (18/31/462/466/474); do_rollback (1780) and do_rollback_releases (1723) flip the tree and restart the SAME unit without re-rendering. Two distinct exposures, now separately bounded. (a) A BAD RENDER: mitigated by S02 landing first (reset-failed clears the start limiter so it self-heals rather than locking out for 30 minutes) and by the new in-place `.prev` copy-aside with a documented restore sequence. (b) A GOOD RENDER OVER A STALE ROLLBACK TARGET: a pre-S07 release contains no scripts/luna-chat-server-entry.ts, so the new unit cannot boot the release do_rollback_releases flips to ($PREV). Mitigated by making unit_paths_current report 'not current' only when BOTH `current` and `previous` carry the launcher, so the flip is self-gating and never leaves an unbootable rollback target. Dev-profile-first with a two-cycle soak still applies.
- Guardian's reconcile path has a documented no-self-heal branch: if `luna_active_ws_count` exits nonzero, reconcile_unit_if_idle warns 'session count unknown; deferring' and returns 1 (luna-guardian:525-526). A down or start-limit-locked daemon is exactly when that probe is most likely inconclusive, so automatic adoption silently will not happen at the worst moment. S07 now carries a fixture for that branch as an acceptance clause, and the operator fallback is the same documented `--units-only` invocation the guardian would have made; the residual risk is that adoption is manual on precisely the hosts that most need it.
- The engine-pin lag is a deadlock generator, not just a delay. The deploying engine is a PINNED copy of an older SHA, so pre-S11 engines refuse to build post-S12 releases (release_artifacts_ok hard-requires apps/ui-web/dist/index.html, and the build call is `return 1`, not a warn). If S12 merges before every profile's pin has advanced past S11, `current` never advances, which means the pin never advances either - the fix ships inside the tree the old engine refuses to build. The gate must be per-profile pin-SHA verification, not a calendar window.
- Stable runs a 15-minute unattended autodeploy timer tracking origin/master with autoUpdate on, so merging luna-next to master auto-deploys within 15 minutes with no human in the loop. Nothing in this plan flips that flag. Before S07 or S11 reaches master, either the timer is disarmed for the cutover or a per-profile merge fuse is added; a prose deployNote is not a control.
- Promotion freshness sits on a knife edge: guardian_status_evidence gates on LUNA_GUARDIAN_HEALTH_WINDOW_SEC (default 900) while stable's timer interval is also 15min = 900s, and the code's own comment warns a cadence at or beyond the window reads every heartbeat as stale and starves auto-promotion. Every Stack 3 slice assumes the new engine eventually promotes. S23 must measure and tune this rather than assume it.
- The Stack 3 guardian fold replaces working, heavily-tested bash running as root against production restarts, with no user-visible payoff. Its invariants - atomic writes, re-read-after-write, PID+fingerprint lock liveness, phase-resumable journal, single-evidence-path shared by human accept and auto-promotion, redact() before diagnose captures hit disk at mode 600 - are exactly what a rewrite drops silently. Every slice from S22 is gated by golden parity including bidirectional interop, and S24's redaction abandon condition stops the entire fold rather than risking a token on disk in a public-repo project.
- Moon's S19 remains the largest unsplit unknown: roughly 4000 lines across a dozen engines, with the secure secret-entry path (secrets must never enter the transcript) as a non-negotiable property that React state could silently violate. The slice mandates a four-way split and a hard stop on that property, but it is the place a regression is most likely to hide.
- MEASURED, not estimated: apps/ui-moon-tauri/test/ holds 39 .ts files totalling 15,602 lines, of which 28 reference panel.html or index.html - not the ~9,200 lines and 17 files the audited draft asserted, and not the 10 one reviewed plan assumed. Every Moon slice implicitly rewrites part of that suite, and ws-contract.test.ts is a blocking CI gate. This is the largest unbudgeted cost in Stack 3; S15 now carries an acceptance clause requiring the remaining Moon sequence to be re-estimated against these numbers before S16 opens, and re-planning S16-S20 is the expected response to a bad extrapolation.
- S24's registry consolidation now has a hard precondition rather than a hope: scripts/lib/luna-registry.sh has live consumers in scripts/luna-guardian, scripts/luna-autodeploy and scripts/luna-doctor, and luna-doctor stays bash through S25. Unless S24 either repoints luna-doctor at the binary's registry subcommand or folds it too, the 'one parser' outcome is unachievable and S25 must not delete luna-registry.sh. Discovering this at S25 instead of S24 would mean either shipping two parsers or an unplanned luna-doctor rewrite inside a deletion PR.
- S25 now defaults to charter compliance by keeping scripts/luna-recover, which means the fold's deletion payoff is slightly smaller than the audited draft claimed and there is a small bash artifact to maintain. The countervailing risk is real and is why the smallness is capped in acceptance: a recovery script that grows conditionals, health checks or a journal becomes a second engine and defeats the fold. The full-deletion variant remains available but is now blocked on Operator sign-off, so the stack can close with either outcome without re-planning.
- The chat vendor layer only partially dies, and that is now explicit rather than implicit. Of the thirteen scripts chat.html loads, eight are KEPT because other Moon surfaces (frontend-react index.html, panel.html, widget.html) load them, and two are KEPT as frozen dependencies inside chat itself (moon-markdown.js and highlight.min.js, which the sanitizer reads as window.hljs). The charter's 'delete the vanilla vendor layer' is satisfied for CHAT - two script tags remain instead of thirteen - but the vendor directory survives for the hub, panels and widgets, and collapsing it is a separate future concern this plan deliberately does not open.
- NEXT.md's chat-service / job-ticker / main.rs split is NOT missing from this plan - I verified it already landed (#424 job-ticker, #425 chat-service, #426 main.rs) with the sibling modules present on disk (job-ticker-producer/executor/reconcile, chat-service-tools/thread-lifecycle/sdk-messages/account-rotation, and main.rs alongside lifecycle/windows/connection/updater/oauth/shell/notify). The parent files remain 1556/657/463 lines because the splits extracted along seams rather than shrinking the entry points; no further slice is warranted, and one judge's claim that this scope is unaddressed is rebutted here rather than acted on. The same accounting covers NEXT.md Stack 2's opening item: the defineToolPackage factory + all ten tool-package migrations ALREADY LANDED (#417-#423; all ten packages import defineToolPackage from packages/tools/src/define-tool-package.ts), which is why no slice re-proposes them - Stack 2 coverage is complete.
