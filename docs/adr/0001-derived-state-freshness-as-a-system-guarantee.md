# 0001: Make derived-state freshness a system guarantee, not agent discipline

Status: Accepted

## Context

Luna injects derived/cached state into agent context: the recent-activity bulletin, memory recall hits, belief summaries, workspace tracker rows. None carried visible age or provenance, so agents asserted stale claims as current fact. Recurring incidents: a PR misreported as blocked on a "typecheck OOM" from a stale digest; a financial sync reporting "ok" for 57 days while its upstream link was dead; a task tracker drifting from git merge state. Each got a bespoke patch; the failure class persisted. Alternatives considered: (a) prompt-layer discipline only (a "verify before assert" skill) — rejected as the sole fix because judgment does not survive context resets; (b) hard-fail unstamped context entries — rejected because bulletin bullets are LLM-authored and cannot be individually stamped, so fail-closed would break prompt assembly over an unfixable case; (c) a declarative reconciler engine (source query + mirror query + diff rule as config) — rejected because two of the three motivating incidents have git/HTTP sources of truth that a SQL-config engine cannot express, and only three heterogeneous instances exist (config-as-data needs numerous homogeneous instances to pay off).

## Decision

1. Stamp mechanically at the injection layer, fail-open. Every injected derived-state surface carries a code-owned generation timestamp rendered as visible age (bulletin wrapper, memory hits, beliefs). Unstampable entries render "age unknown" rather than being dropped. The injection block instructs the agent to verify claims older than a threshold before asserting them. The wrapper age is a lower bound on staleness of LLM-authored content, and is documented as such.
2. Job health means outcome freshness, not exit success (Phase 2). Jobs may declare a registered TS health predicate (parameterized by payload data, e.g. newest-row-age, file-mtime-age, http-ok) evaluated outside the producer tick; the ticker tracks last outcome-success separately from last run-success and staleness alerts flow through the existing doctor/agent-notes dedupe rails as notify-only findings.
3. Drift repair is standardized as a reconciler workflow template + skill, not an engine. A generic declarative reconciler is explicitly rejected (see Context); revisit only after three or more concrete DB-to-DB reconcilers exist.

## Consequences

Easier: stale context is visible at read time everywhere at once; silent connector/job rot is detected by the platform; drift fixes follow one template. Harder: render-format changes invalidate measured eval gates (memory pack + bulletin benches must be re-run when formats change); the jobs table takes an additive schema migration (V5) with contract-test updates; predicate evaluation adds executor-side I/O that must stay out of the tick loop. Risk: age labels add tokens to every prompt; kept compact deliberately. This ADR governs phases: P1 (stamps) and P2 (predicates) are built; P3 is a template + skill only.
