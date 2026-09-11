# Audit: how Luna decides that autonomous work is done

Date: 2026-09-11
Scope: the job scheduler, the observability pipeline, and the memory subsystem.
Method: measured a live install (101 jobs, 18,531 job runs, 6,704 ledger notes,
42,431 event lines), then traced every finding back to source on `master`
@ `0645f94b`. Counts below are measured, not estimated.

Three questions, three answers:

1. **Where can we fix errors?** Two failure families account for 100% of recent
   job failures, and both are fixable in the repo.
2. **What should improve in memory?** The belief half of the system has been
   dead for four weeks and its records are invisible to search.
3. **Do we evaluate work against intent and recover?** No. One job spent 96% of
   its runs re-deriving a conclusion it had already reached.

---

## The finding that explains most of the others

Every recovery mechanism in Luna keys off **the process**, never **the product**.

Retries, the doctor, crash reconcile, the in-flight guard, the shutdown drain:
all of it answers "is the machinery turning?" Nothing answers "is the machinery
producing the right thing?"

A job succeeds if, and only if, its worker's Effect did not fail
(`packages/core/src/jobs/job-ticker-executor.ts:286`). Nothing reads the output
back. `job_runs.output_text` is written and then read by nothing in the repo:
the WS gallery mapper strips it deliberately
(`apps/server/src/chat-server.ts:4185`), the suggested-action observer reads only
`.status` (`packages/core/src/suggested-actions/accept-handler.ts:209`), and the
doctor archives runs without analysing them
(`packages/core/src/doctor/job-heal.ts:81`). It is a write-only column.

The component built to close this gap is ADR 0001 Phase 2. It is finished and
correctly wired into the executor (`job-ticker-executor.ts:418`). Adoption is
measurably zero: **`outcome_state` is NULL on all 101 job rows**, and no shipped
job declares `payload.health`. Every wire is soldered and nothing is plugged in.

---

## 1. Where we can fix errors

In the last 14 days: **10,947 runs, 213 non-success**. Only **nine distinct error
shapes** exist in the whole window, and two families are 91% of them.

| Family | Runs (14d) | Share |
|---|---|---|
| Turn-budget exhaustion (`Reached maximum number of turns (N)`) | 150 | 70% |
| Malformed tool schema (`400 tools.N.custom.input_schema.type`) | 45 | 21% |
| Session limit, orphaned, overloaded, other | 18 | 9% |

Six recurring jobs produce every one of those failures.

### 1.1 The dream cycle has been failing 100% of the time (critical)

`dream-luna`: **45 runs, 45 failures, zero successes** across the entire
retained window, with `fail_streak` at **84**. The error is stable and
diagnostic:

```
worker_failed: dream worker failed: ... API Error: 400 tools.N.custom.input_schema.type
```

That is the Anthropic API rejecting a tool whose JSON Schema does not have
`type: "object"` at its root. It is a malformed schema constant, not an
infrastructure problem, and it is deterministic: it has failed every night for
weeks and will fail every night until the schema is fixed.

The blast radius is the entire belief system. Dream is the only writer of
belief records, so **no belief has been created since 2026-08-13**. The operator
model that gets injected into every system prompt has been frozen for four
weeks while appearing to work.

**Fix:** find the offending tool definition on the dream path and give its schema
an object root. Wrap arrays in an object rather than passing a bare array. Add a
test that asserts every schema handed to the API has `type: "object"` at the
root, because this class of bug is invisible until runtime.

### 1.2 Turn exhaustion is misclassified, and the only remedy cannot fire (critical)

**150 of 213 recent failures (70%)** are turn-budget exhaustion. Two defects
compound:

**It is classified as transient.** The failure surfaces as
`reason: "worker_failed"`, which is in `RETRYABLE_WORKER_ERROR_REASONS`
(`job-ticker-executor.ts:43`). A deterministic failure is therefore retried up
to three times on exponential backoff with the identical budget. Retrying a turn
cap with the same cap cannot succeed. It also discards the work: the failure
branch of `recordRunEnd` (`job-ticker-executor.ts:316`) passes no `outputText`,
so everything produced in those turns is thrown away.

**The doctor is blind to it.** The doctor's only auto-remedy is a `max_turns`
patch, gated on `/max(?:imum)?\s*turns|max_turns/i`
(`apps/server/scripts/luna-doctor-workflow.ts:181`). The runtime's actual wording
is `Reached maximum number of turns (15)`. The regex requires `maximum` followed
by optional whitespace and then `turns`; the real string has
`maximum number of turns`, so it does not match. Measured confirmation: a
substring census over 14 days returns **0 rows** for `max_turns`, `turn limit`,
and `turn_limit`, while 150 runs died of a turn cap in that same window.

Every turn-exhausted job therefore takes the generic branch, which patches
`max_turns: 15`. That is a **downgrade** for any job configured higher, because
`patchPatient`'s payload merge is a one-level spread
(`{...currentPayload, ...patch}` in `packages/core/src/doctor/job-heal.ts`,
misleadingly named `deepMergePayload`), so a scalar in the patch replaces the
current value outright. The doctor's verify step then checks only that the row
exists, is enabled, and parses, never that the failure stopped.

The distribution makes the cost concrete. Of 293 turn-cap deaths all-time,
**255 died at the default of 15**. Jobs configured at 25, 30, or 60 almost never
hit their ceiling. One job alone accounts for 208 of them (62%).

**Fix:** classify budget exhaustion as its own deterministic reason, exclude it
from the retryable set, and make the doctor key on that reason rather than on
prose. Never let a patch lower an existing `max_turns`. See ADR 0002 and the
change shipped with this PR.

### 1.3 `fail_streak` does not count intermittent failure (high)

`fail_streak` is **0 on every job except one**, including a job failing **55.6%
of its runs** (90 of 162) and another failing **60%** (18 of 30). `heal_state`
is `'ok'` on all 101 rows. The doctor escalates on a streak threshold, so a job
that fails more often than it succeeds, but never twice consecutively enough,
never escalates. The metric cannot see the most common real-world failure shape.

**Fix:** escalate on a failure *rate* over a window, not only on a consecutive
streak. The SLO burn-rate pattern (a short window and a long window together) is
the standard form.

### 1.4 Scheduled jobs are shipped with tools that cannot exist (high)

Background jobs mount at most one MCP server: the optional per-run
`request_input` binding. `prompt-worker.ts:335` and `workflow-worker.ts:431`
both spread `mcpServers: { [binding.serverName]: binding.server }` and nothing
else, and `SDKClient.Default` injects no base servers
(`packages/adapter-sdk/src/sdk-client.ts:52`). `allowedTools` does not help: the
SDK treats it as additive pre-approval, so a tool whose server is not mounted
does not exist for the turn.

`DESIGN.md:706` documents this and names the consequence: naming an unmounted
`mcp__*` tool "tends to waste turns ... and can exhaust `max_turns`".

Three shipped surfaces instruct jobs to do exactly that:

| Surface | Problem |
|---|---|
| `apps/server/scripts/daily-brief-install.ts:108` | `ALLOWED_TOOLS` is composed *entirely* of unreachable tools, and the prompt then instructs the job to call them step by step. |
| `apps/server/scripts/push-through-install.ts:246` | Lists four tools; only `Bash` is reachable. |
| `SYSTEM.md` (both payload examples) | Teaches the footgun to anyone authoring a job. |

This is not hypothetical. The ledger contains repeated runs reporting that
`mcp__observability__obs_note` "is not available in this session", falling back
to prose, and then dying on the turn cap. It is a direct contributor to family 1
above. This PR corrects `SYSTEM.md`; the two install scripts should follow.

### 1.5 The observability pipeline silently drops events (high)

The JSONL sink and the analytics database disagree, and the health probe does
not notice.

| | `events.jsonl` | analytics `events` |
|---|---|---|
| Rows | 42,431 | 34,401 |
| Distinct kinds | 10 | 6 |

Four kinds are **entirely absent** from the database: `WorkflowTransition` (154),
`TeammateStart`, `TeammateIdle`, `TeammateStop` (126 each). Per-kind counts also
diverge sharply for kinds that *are* present: `CostAccrued` 3,928 versus 1,547,
`RetrievalCall` 2,784 versus 809, `Error` 556 versus 130. That is ongoing loss,
not a one-time gap or a kind filter.

Meanwhile `obs_pipeline_health` reports `writeFailures: 0`. The probe counts
what the sink attempted, so a silently dropped event is invisible to the exact
instrument meant to detect it. This is the same class of defect ADR 0001 was
written for: a green light that means "nothing threw", not "nothing was lost".

Independent corroboration: `bun run test:bun` on clean `master` fails exactly
three tests, and all three are this subsystem, including
`EventSink > five events of different kinds all land in the events table` and
both `health() reports eventsReceived + eventsWritten` cases. The behaviour is
not only broken in production, it is red in the repo's own suite.

**Fix:** reconcile the two sinks and alert on divergence. A health probe that
cannot go red is not a health probe.

### 1.6 A whole ledger kind died silently (high)

`wake_digest` is the single largest kind in the notes ledger at 2,533 rows
(37.8%). It **stopped writing on 2026-07-14** and has produced nothing in nearly
two months, while its jobs continue to run 713 times per 14 days each with zero
failures. The jobs fire, succeed, and their output never lands.

This is the purest example of the audit's thesis: process health is green,
product output is absent, and nothing in the system can tell the difference.

### 1.7 The behavioural ledger is weakly typed (medium)

The typed kinds Luna's own docs instruct agents to write (`goal_declared`,
`decision`, `progress`, `reflection`) are declared in
`packages/core/src/agent-notes/types.ts:4` and **no code ever writes them**.
They depend entirely on an interactive agent choosing the right string, and
`NoteKind` is `| string`, so nothing validates it.

Separately, `packages/scheduler-tools/src/tools.ts:194` hardcodes
`kind_tag: "reminder"` into every schedule it creates and exposes no parameter
to override it, so every fire of every agent-created schedule lands under one
kind regardless of what the job does (1,069 rows, 16% of the ledger).
`SYSTEM.md` documented the default as `prompt_result`, which is only reachable by
a hand-written payload. This PR corrects that text; adding a `kind_tag`
parameter is the real fix.

Two smaller shape problems: `parent_id` is **100% NULL** across all 6,704 rows,
so the threading column is unused; and 37.3% of rows carry a duplicate `summary`
string, because the documented `dedupe_key` has no column to persist into.

### 1.8 The outcome-health alert rail thrashes (medium)

The executor writes every job's staleness alert under the shared kind
`"outcome-health"` with a per-job fingerprint (`job-ticker-executor.ts:472`),
but the dedupe helper compares against the single most recent note of that kind
(`packages/core/src/agent-notes/agent-notes.ts:577`, `getByKind(kind, 1)`). Two
jobs in a non-fresh state alternate and never suppress each other, and a 6 hour
heartbeat re-emits regardless. Fix the rail before adopting it.

### 1.9 Storage and retention problems (medium)

- **The analytics file is not DuckDB.** `analytics.duckdb` begins with
  `SQLite format 3`. Nothing on the host can open it as DuckDB. It is 1.8 GB, of
  which **99.28% is a single `metric_snapshots` table** with 16.5M rows, no
  primary key and no index. Reads also fail with `database is locked` unless the
  caller sets a busy timeout, because the file is in `journal_mode=delete` while
  the server holds it.
- **`job_runs` retains only ~30 days.** Its earliest row is 2026-08-12 while
  analytics reaches back to 2026-05-19. Any "all time" job analysis is silently
  capped at one month.
- **Orphan run rows exist:** at least one `job_id` has runs in `job_runs` with no
  corresponding row in `jobs`.
- **805 lines of 2024 test fixtures are interleaved into the production JSONL**,
  so a naive min-timestamp over that file is wrong by two years.

### 1.10 Smaller items (low)

- **Two status vocabularies.** `jobs.last_status` is `{fired, errored, running,
  NULL}` while `job_runs.status` is `{success, failed, cancelled, running}`.
  `fired` means dispatched, not succeeded: a job showing `fired` was measured
  failing 60% of its runs. These columns must not be compared.
- **`guardShip` is dead code with a false docstring.**
  `packages/adapter-sdk/src/ship-guard.ts` is the canonical, unit-tested
  "has this already been done?" check, written after the loop spent eleven cycles
  pushing already-merged branches. Its docstring claims a consumer calls it.
  Nothing does; the live check is a hand-ported shell copy in
  `push-through-install.ts:37`. Wire it up or delete it.
- **Work items are never marked done.** `push-through-install.ts:217` sets
  `next_actions.status='doing'`; nothing in the repo ever sets `'done'`.
- **A cancelled schedule cannot be restored.** `schedule_cancel` deletes the row
  (`scheduler-tools/src/tools.ts:302`) and no enable path exists in any tool or
  CLI. Any future stand-down mechanism must not use `enabled=false`.

---

## 2. The memory system

Luna's memory can **store** and **retrieve**. It cannot **correct itself**, and
half of it is currently unreachable.

Measured: `memory_keyed` holds **407 rows**. 196 are beliefs, 199 are notes, the
rest are candidates and telemetry.

### 2.1 Every belief is invisible to search (critical)

**199 of 407 rows are embedded. The 208 that are not are almost exactly the
196 belief rows.** `memory_fts` is an external-content FTS5 table over
`memory_vectors`, so it mirrors that table exactly. Beliefs are therefore
invisible to **both** the vector arm and the lexical arm of every search. They
are reachable only by exact namespace and kind filtering.

This is why belief injection works (it queries by namespace) while a semantic
search for the same content returns nothing. Two retrieval paths disagree about
what the system knows.

### 2.2 Belief formation is dead (critical)

No belief has been written since **2026-08-13**, because dream has failed 45 of
45 runs (see 1.1). The confidence numbers rendered into the system prompt are
four weeks stale and getting staler, with no visible signal that they are frozen.

### 2.3 Nothing can be corrected (high)

There is no update or edit primitive. `memory_save` mints a fresh id on every
call, so saving a corrected fact creates a **second record** and both stay
retrievable forever. `apps/server/src/core-apps.ts:226` states the hole plainly:
delete is "the ONLY mutation exposed", and edit "needs a primitive that doesn't
exist".

`MemoryRecord` has no `supersededBy`, `replaces`, `version`, or `status` field.
Beliefs get accidental upsert-by-hash through `deriveBeliefId`, which breaks the
moment the statement's wording changes by one word. The measurable symptom:
37.3% duplicate summaries in the adjacent notes ledger, and a store that returns
confidently stated facts later work has contradicted, with no marker that they
are contested.

### 2.4 Retrieval ignores time (high)

Ranking is Reciprocal Rank Fusion over cosine and BM25
(`packages/memory/src/backends/sqlite-vector.ts:877`). `updatedAt` is rendered to
the model but never influences ranking. A note from three months ago and a note
from this morning rank identically, and in practice the older ones win, because
there are more of them. The only recency weighting in the entire system is
`beliefStrength` (`packages/core/src/beliefs/scoring.ts:18`), which applies to
beliefs only, which are the records search cannot reach.

### 2.5 Nothing ages out (medium)

No decay, no TTL, no archival tier, no `last_accessed_at`, no eviction. The
20-belief cap is the only bounded set. `DESIGN.md:1044` is explicit that
retention is "composition policy" with "no enforcement code", and no composer
enforces it.

### 2.6 Dream's dedup and contradiction ops cannot work as built (medium)

`buildDreamPrompt` renders memories as **metadata only**:
`MEMORY <id> namespace=... kind=...`
(`packages/adapter-sdk/src/dream-reasoner.ts:205`). The dream model never sees
memory text. It is then asked to nominate exact duplicates by id, which means
comparing things it cannot read. And `memory_dedup` is the one op with
`materialize: true` that **deletes** (`packages/core/src/dream/types.ts:68`), so
a destructive operation is auto-applied from a blind comparison.

Meanwhile `memory_staleness` and `memory_contradiction` are inert
(`materialize: false`) with **zero production readers**. Those rows accumulate in
`dream_audit` and are never seen. There is no embedding-similarity dedupe
anywhere, despite HNSW being available and populated.

### 2.7 Confidence is invented, never calibrated (medium)

`BeliefContent.confidence` is a float the dream model is asked to produce
(`dream-reasoner.ts:319` validates only `0 <= c <= 1`). Nothing ever updates it.
It feeds `beliefStrength`, then ranking, then the system prompt, where it is
rendered to two decimal places and reads like a measurement.

### 2.8 Recommended order

1. **Fix the dream tool schema.** Everything else in this section is downstream
   of a cycle that has not completed successfully in four weeks.
2. **Embed beliefs**, or make the belief path explicitly non-searchable by
   design and document it. Today's split is an accident, not a decision.
3. **Add a supersession primitive.** `memory_save` gains an optional `supersedes`
   id; superseded records leave recall by default and stay readable.
4. **Show the dream model the text it is judging**, or stop auto-applying
   `memory_dedup`. A blind destructive op is the wrong default.
5. **Consume `memory_contradiction`** through the existing survey rail.
6. **Add a recency term to retrieval ranking**, matching what `beliefStrength`
   already does for beliefs.

Sequencing constraint: items 5 and 6 change ranking and render format, and
ADR 0001 records that format changes invalidate the measured eval gates. Do 1
through 4 first.

---

## 3. Do we evaluate work against intent, and recover?

No.

Intent exists only as prose inside a prompt string. The payload type is
`{ label: string, source?: string } & Record<string, unknown>`
(`packages/core/src/jobs/jobs-store-types.ts:51`), where `label` is a display
string. A repo-wide search for `success_criteria`, `acceptance_criteria`,
`expected_outcome`, `postcondition`, and `verify_with` finds hits only in deploy
shell scripts reasoning about their own install, never in the job system.

### The measurement

One agent-created schedule, running on a `*/10` cron, exists to drive three pull
requests to merge. All three merged on 2026-09-06.

- **866 runs** between 2026-09-05 and 2026-09-11.
- **831 of them (96.0%)** report having found the work already done.
- **808 runs** contain the phrase "already merged".
- That is roughly **144 runs per day** re-deriving a settled fact.

Its own prompt instructs it: *"Be idempotent: check state before acting, act
once, report."* It complied perfectly. It checked state, found nothing to do,
and reported that, 831 times. The instruction was followed and the waste
happened anyway, because **compliance was never the missing piece**. The job had
no way to record that it was finished and no way to act on knowing it.

This is the argument against fixing this class of problem with prompt wording.
ADR 0001 already made it in different words: judgment does not survive a context
reset. Here it did not even need to survive a reset. It was correct on every
single run and still could not change anything.

For contrast, a second watcher job reports "no change" on 50.6% of its runs, and
that is **correct behaviour**: its prompt asks it to report only on change. The
difference between 50.6% and 96.0% is the difference between a job doing its job
and a job that finished days ago.

### Recovery has the same shape

Retry is purely transport-class: `deadline_passed`, `worker_failed`, and
`defect` retry; `bad_payload` and `unknown_kind` do not
(`job-ticker-executor.ts:43`). **Nothing anywhere retries because the result was
wrong.** Retry exhaustion is not recorded as a distinct state, so it is
indistinguishable from a first failure. And as section 1.2 shows, the one class
that is genuinely deterministic is currently *in* the retryable set, so the
system retries exactly the thing that cannot succeed while never retrying the
things that might.

The self-improvement loop is open at the same joint by design. It is
propose-only, and an experiment's conclusion is never re-tested against
production after a promotion merges. Its own runbook records that skipping a
dedup check "caused 5 experiments on one task and 7 on another, pure wasted
motion". The fix applied was a prompt rule, not a mechanism.

### What we should not do

The obvious move is a declarative `intent` block on the payload with a
satisfaction predicate, mirroring `payload.health`. That was designed and
rejected; ADR 0002 records why. In short: the job that motivated it **cannot
declare one**, because agent-created schedules have no authoring path; the
predicate registry cannot express the condition, because it holds one string
with no combinators and no git or authenticated HTTP source; a pre-dispatch gate
would violate ADR 0001's constraint that predicate I/O stay out of the tick loop;
and ADR 0001 set the bar at three concrete instances before adding
config-as-data, while the existing predicate mechanism has **zero adopters and
`outcome_state` NULL on all 101 rows**.

Zero adoption is not adoption lag. It is evidence that job-creation time is not
where the knowledge lives.

### What we should do

The knowledge lives **in the run**. The agent reached the right conclusion 831
times. It had no channel to persist it or act on it. Three in-band pieces follow,
each reachable by agent-created jobs, none requiring a schema change:

1. **Classify budget exhaustion.** Ships in this PR. It stops one deterministic
   failure from consuming three budgets, and it makes the doctor's existing
   remedy reachable for the 70% of failures it was written for.
2. **Let a run stand itself down.** A per-run `job_stand_down` tool through the
   existing `JobRunToolsProvider.forRun` seam, bound to its own job id and
   guarded exactly as `schedule_cancel` is. Pair it with a `max_fires` or
   one-shot option on `schedule_create`, so a finite goal stops being encoded as
   an infinite cron.
3. **Inject the previous run.** Prepend the last run's status, age, and the head
   of its `output_text`, age-stamped per ADR 0001 Phase 1. This converts turns of
   re-derivation into one turn of verification, and it gives the agent the
   evidence it needs to call stand-down.

The first is smallest and most certain, which is why it leads.

---

## Method and limits

Line numbers in this document are pinned to `master` @ `0645f94b` and will drift
as the file changes; prefer the named symbol over the line when following a
citation.

Runtime claims come from a live install measured on 2026-09-11: `luna.db`
(101 jobs, 18,531 runs, 6,704 notes), `memory.db` (407 records), the analytics
store (34,401 events, 442 sessions), and `events.jsonl` (42,431 lines). Source
claims were traced on `master` @ `0645f94b`.

Four limits worth stating:

- `job_runs` retains about 30 days, so no job trend can be measured further back.
- The analytics store and the JSONL sink disagree by roughly 8,000 events, so
  event-level totals should be read as lower bounds until 1.5 is fixed.
- This audit did not measure token or dollar cost of the redundant runs, because
  no per-run cost column joins to `job_runs`. Waste is argued from run counts.
- Findings were measured on one install. The defects are all in shared code
  paths, but adoption numbers such as "zero jobs declare `payload.health`" are
  observations about shipped defaults, not proofs about every deployment.
