# Probe Contract

A **probe** is a self-contained, deterministic executable that guards one
load-bearing invariant — usually a lesson that already cost real time when it
drifted. The corpus runner (`run-corpus.sh`) discovers and runs every probe and
reports red the moment an invariant breaks.

## Rules

1. **Location & name.** A probe is an executable `*.sh` file in `probes/`.
   Name it `NNN-slug.sh` (e.g. `010-widget-tools-list.sh`). Files beginning
   with `_` (`_template.sh`, `_lib.sh`) are ignored by the runner.

2. **Exit code is the verdict** — this is the whole contract:
   | exit | verdict | meaning |
   |------|---------|---------|
   | `0`  | **PASS** | the guarded invariant holds |
   | `77` | **SKIP** | a precondition is unmet (tool absent, not on this host) — *not* a regression |
   | other | **FAIL** | drift/regression detected (a non-zero from `timeout` = `124` also fails) |

3. **Self-contained & deterministic.** No reliance on prior probe state. No
   network unless the invariant *is* a network contract, and then guard it so a
   flaky endpoint yields SKIP, not FAIL. No wall-clock/random branching.

4. **Diagnostics to stdout/stderr.** Print enough to debug a red. The runner
   captures combined output; its **last non-empty line becomes the summary**, so
   end with a crisp one-liner (e.g. `OK: widget tools/list returned 16 tools`
   or `DRIFT: tools/list threw — schema regression`).

5. **Metadata header** (optional but recommended) — parsed by the runner:
   ```sh
   # PROBE:    short human title
   # LESSON:   what red lesson / drift class this guards (cite the date)
   # SEVERITY: critical | high | normal
   ```

6. **Fast & bounded.** Each probe runs under `PROBE_TIMEOUT` (default 120s).
   Keep them quick; a timeout counts as FAIL.

## Adding a probe

1. Copy `probes/_template.sh` to `probes/NNN-slug.sh`.
2. Fill the metadata header and the single invariant check.
3. `chmod +x` it.
4. Run `./run-corpus.sh --filter slug` to confirm it goes green.
5. **Prove it bites:** deliberately break the invariant (or the probe) and
   confirm the run reports FAIL. Revert. Commit.

## Mutation gate (P3)

**No new red lesson without a probe.** Every load-bearing `🔴` lesson must be
registered in [`lessons.md`](./lessons.md) as either:
- `covered` — pointing at the probe that guards it, or
- `waived` — with a reason (use for non-deterministic lessons, or ones subsumed
  by another probe).

The `005-lesson-coverage` meta-probe enforces the linkage: it FAILs if a covered
lesson names a missing/non-executable probe, if a real lesson-probe is not
registered, or if a waiver has no reason. So you cannot delete a probe (or add an
unguarded one) without the nightly run going red.

Workflow when you learn a new `🔴` lesson:
1. Write the probe (or decide it's non-deterministic → waive it).
2. Add a row to `lessons.md`.
3. `./run-corpus.sh --filter lesson-coverage` must stay green.

## Running

```sh
./run-corpus.sh            # human table; exit 1 if any FAIL
./run-corpus.sh --json     # machine-readable, for the nightly workflow (P2)
./run-corpus.sh --filter widget
PROBE_TIMEOUT=60 ./run-corpus.sh
```
