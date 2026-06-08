---
name: subagent-memory
description: "Use in any subagent whose frontmatter sets memory to project, user, or local. Observational memory discipline: captures what was learned each invocation as dated bullets in MEMORY.md, compressing via a reflection pass before the file hits the 200-line harness injection cliff. Mirrors the working_memory style: priority-emoji bullets, date grouping."
---

# Subagent observational memory

You have a persistent memory directory because your agent definition declared `memory: project`, `memory: user`, or `memory: local`. The harness has already injected the first 200 lines / 25KB of `MEMORY.md` into your system prompt.

This skill defines an **observational memory** discipline: at the end of each invocation you extract observations about what just happened and append them as dated bullets. When the file approaches the 200-line cliff, you compress it by running a reflection pass. The pattern mirrors the project-level `working_memory` skill — same bullet syntax, same priority emoji, same append-then-reflect rhythm — adapted for a subagent observing its own task.

## When this skill applies

Four moments in your invocation:

1. **At task start** — re-read your `MEMORY.md` (already in your system prompt) with the current task in mind. Anything relevant?
2. **Mid-task, when something surprises you** — make a mental note. Don't break the task to write.
3. **At task end, before returning your summary** — run the **observer pass** to extract observations, append them to `MEMORY.md`.
4. **Right after appending** — count lines. If `MEMORY.md` is ≥ 195 lines, run the **reflector pass** to compress to ≤ 100 lines.

If a particular invocation has nothing observation-worthy (trivial lookup, repetition of work already captured), output the equivalent of `<no-new-observations/>` to yourself and skip the append. Don't write filler.

## File layout

Your memory directory contains exactly one file:

```
.claude/agent-memory/<your-name>/
└── MEMORY.md
```

There are no topic files, no frontmatter on entries, no index. The whole file is observations grouped by date. The harness reads the first 200 lines / 25KB at startup; reflection keeps you well below that cliff.

A populated `MEMORY.md` looks like this:

```markdown
# Subagent observations: codebase-analyzer

Date: May 5, 2026

* 🔴 (14:30) Webhook retry logic lives in WebhookHandler, not per-provider modules — centralized after Stripe outage 2026-Q1
* 🟡 (14:31) Webhook max_attempts read from :webhook_max_attempts config, not Oban.Job.max_attempts — custom backoff reads at insert
* ✅ (14:35) Located retry handling at lib/my_project/webhook_handler.ex:42-78

Date: May 3, 2026

* 🔴 PropertyRepo.with_property/3 is the only safe path to multi-tenant data — RLS requires it
* 🟡 Phoenix LiveView assigns flow through assign/3 — never mutate socket.assigns
```

## Observation format

Each observation is one bullet under a `Date: <Mon D, YYYY>` header. Bullets start with a priority emoji (or completion marker), an optional `(HH:MM)` 24-hour timestamp, and the content. Indent sub-bullets with `→` to group tool sequences.

```markdown
Date: May 5, 2026

* 🔴 (14:30) Critical lesson — must know for next invocation
* 🟡 (14:31) Useful project fact or tool outcome
* 🟢 (14:32) Minor detail or low-confidence observation
* ✅ (14:35) Concrete task milestone reached
  * → ran grep for "webhook_handler" in lib/, 3 hits
  * → read lib/my_project/webhook_handler.ex:42-78
  * → confirmed retry logic centralized here
```

### Priority emoji

Adapted from working_memory for subagent context (you observe your own task, not a user conversation):

- **🔴 critical** — hard constraints, gotchas with concrete consequences, parent-agent corrections, decisions that change *how* future-you should approach similar tasks. The "if I forget this, I'll repeat the mistake" tier.
- **🟡 useful** — project facts (file paths, line numbers, config keys, commit SHAs, external IDs), tool results worth remembering, patterns observed in the codebase. The "this would save me time next invocation" tier.
- **🟢 minor** — low-confidence observations, ambient context, things you're not sure are worth keeping but might be. The reflector will probably drop these.
- **✅ completed** — a concrete sub-goal of the task was achieved with a result worth recording (located a file, confirmed a behavior, ruled out a hypothesis). NOT used for "the task is done" — that's implicit.

### Good vs bad observations

```
GOOD: 🔴 (14:30) Webhook retry config key is :webhook_max_attempts in config/<env>.exs, not Oban.Job.max_attempts
BAD:  🔴 (14:30) Found something about webhook retries
        ^^ vague, no actionable detail

GOOD: 🟡 PropertyRepo.with_property/3 must wrap multi-tenant queries — RLS enforces; bypassing causes silent cross-tenant reads
BAD:  🟡 Multi-tenancy is important
        ^^ generic, derivable from CLAUDE.md, no value-add

GOOD: ✅ Located handler at lib/my_project/webhook_handler.ex:42-78 (Oban worker with custom backoff)
BAD:  ✅ Did the task
        ^^ no information, no future value
```

## Reading memory (at task start)

Your `MEMORY.md` is already in your system prompt — re-read it with the current task in mind. For any observation that looks relevant:

- **Verify named things still exist.** An observation that names a file path, function, line number, or flag is a claim about a moment in time. Before acting on it, grep or file-check. "The memory says X exists" is not "X exists now."
- **If observations conflict with what you observe in the current code or tool output, trust what you observe.** Then mark the stale observation for correction (you'll fix it during the observer pass at task end).
- **If `MEMORY.md` looks truncated or malformed at startup** (a prior invocation may have died mid-reflection), run the reflector pass immediately before doing other work. Recovery is cheap; acting on a half-file is expensive.

## The observer pass (at task end)

Before returning your summary to the parent agent, extract observations from what just happened. Treat yourself as the memory consciousness of your future self — these observations are the *only* memory of this invocation that future-you will have.

### What to observe

- **Surprises:** anything that violated your expectation. Why was it surprising? What's the underlying mechanism? (→ usually 🔴)
- **Concrete facts you discovered:** file paths, line numbers, function signatures, config keys, identifiers in external systems. (→ usually 🟡)
- **Parent-agent feedback:** corrections become 🔴 (must follow next time); confirmations of non-obvious approaches become 🔴 (validated discipline).
- **Tool sequences that produced a result:** group as a parent ✅ with `→` sub-bullets for the steps. Future-you cares about the outcome, not the keystrokes.
- **Decisions you made between two reasonable options:** record which you picked and why, so the next invocation doesn't re-debate. (→ 🔴)

### What NOT to observe

- Restatements of `CLAUDE.md`, the project README, or anything you could re-derive by reading current code or git log.
- Generic best practices ("good code is readable").
- Bookkeeping ("I started the task," "I finished the task").
- Repetition of observations already in `MEMORY.md` — check first; update an existing bullet rather than add a duplicate.
- Internal reasoning steps that didn't produce a load-bearing decision.

### Output discipline

- **1–5 observations per invocation.** Fewer is better than more. If you wrote 8 bullets, three of them are probably 🟢 noise — cut them.
- **Be specific enough to act on.** "User prefers terse responses" beats "user has preferences." Include the why if it's non-obvious.
- **Use terse language.** Dense sentences. No filler words. The token budget is finite.
- **Group related sub-steps as one parent bullet** with `→` indented children. A parent ✅ with three sub-bullets > three separate ✅s.

### Append, don't replace

Find today's `Date:` header. If it exists, append your new bullets under it. If not, add a new dated section at the bottom of the file. Never delete or rewrite existing bullets during the observer pass — that's the reflector's job.

## The reflector pass (when MEMORY.md ≥ 195 lines)

After appending new observations, count lines in `MEMORY.md`. If `≥ 195`, you must compress before returning. The harness's startup injection is hard-capped at 200 lines; without reflection, the bottom of the file falls off invisibly.

### The compression target

**Reduce to ≤ 100 lines.** This gives ~95 lines of headroom for future invocations to append before reflection fires again. Don't aim for "just under 195" — that means reflection fires every invocation, which is wasteful and slowly degrades signal as borderline observations get repeatedly re-judged.

### Preservation rules — always keep

- All 🔴 observations that name **hard constraints** the parent agent or codebase imposes (corrections, conventions, gotchas with consequences).
- 🟡 observations that name **hard-to-rederive facts**: file paths, line numbers, commit SHAs, config keys, external system IDs. Re-deriving these costs tool calls; preserving them is cheap.
- ✅ observations from the last 7 days (recent completions are still "current state").
- Anything naming a **gotcha or root cause** — these are the highest-value memories because they prevent re-encountering the same surprise.

### Preservation rules — aggressively merge

- Multiple 🟡/🟢 bullets describing one tool sequence → one parent bullet with sub-bullets summarizing the outcome.
- Repeated observations of the same fact across multiple dates → keep only the most recent statement.
- Successive ✅ completions belonging to one larger task → single rolled-up ✅.

### Preservation rules — drop

- 🟢 observations older than 7 days with no enduring value.
- ✅ completions older than 14 days that are now superseded by newer state.
- Bookkeeping observations that don't record a decision.
- Empty, redundant, or contradicted observations (newer wins).

### Format after reflection

Same structure: `Date:` headers, priority-emoji bullets. Drop `(HH:MM)` timestamps when merging across times — they only matter at original capture. Group bullets under their dates; if you collapse multi-day entries, keep the latest date for the rolled-up bullet.

### Validation

After running the reflector, count lines again. If the result is **not** ≤ 100 lines, your reflection wasn't aggressive enough — drop more 🟢 entries, merge more sequences. If the result is < 30 lines, you over-compressed and lost signal — restore from the pre-reflection state and re-do with less aggression.

If after honest reflection the file is already as tight as it can be (less than 20% reduction possible), leave it as-is and add an observation noting that you tried. The next invocation will reach the threshold sooner and you'll try again with more accumulated context to drop.

## A complete worked example

You're a `codebase-analyzer` subagent invoked with: *"Find where we handle webhook retries."*

### At task start

You re-read your `MEMORY.md` (already in system prompt). You spot:

```
* 🔴 Webhook retry logic centralized in WebhookHandler after Stripe outage 2026-Q1 — not in per-provider modules
```

You verify the file exists with `ls lib/my_project/webhook_handler.ex`. Confirmed. You skip the per-provider modules and go straight to the central handler. **The observation saved you ~5 minutes.**

### Mid-task

Reading `webhook_handler.ex`, you discover the retry count is set via `Application.get_env(:my_project, :webhook_max_attempts)`, not Oban's standard `max_attempts` field. The custom backoff function reads this config at insert time. *Surprising — you'd expected the standard Oban field. This is a gotcha worth saving.*

You also locate the precise lines (42–78) handling the retry logic.

### Observer pass (at task end, before returning summary)

You extract three observations:

```markdown
Date: May 5, 2026

* 🔴 (14:30) Webhook max_attempts read from :webhook_max_attempts config key, NOT Oban.Job.max_attempts — custom backoff reads at insert time
* 🟡 (14:31) Webhook retry handler at lib/my_project/webhook_handler.ex:42-78
* ✅ (14:35) Confirmed retry logic centralized in WebhookHandler (matches prior observation)
```

You read `MEMORY.md`, find today's `Date:` header (or add one), append the three bullets.

### Threshold check

You count lines: `MEMORY.md` is now at 47 lines. Well under 195. **No reflection needed.** You return your summary to the parent agent.

### A later invocation: reflection fires

Several invocations later, `MEMORY.md` has grown to 198 lines after a particularly observation-rich task. You count lines, see ≥ 195, and run the reflector pass.

You apply the rules: keep all 🔴 hard constraints, keep 🟡s naming file paths and line numbers, drop 🟢s older than 7 days, merge three separate ✅ bullets from yesterday's exploration into one rolled-up ✅. The compressed file is 87 lines. Within target.

You replace `MEMORY.md` with the compressed version and return your summary. The next invocation starts with a clean, dense memory and ~108 lines of headroom before the next reflection.
