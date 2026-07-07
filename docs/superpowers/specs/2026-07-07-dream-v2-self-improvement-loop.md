# Dream v2: The Self-Improvement Loop

**Status:** Approved design, phased build in progress
**Date:** 2026-07-07
**Extends:** `2026-05-28-luna-alignment-loop-design.md` (the Dream engine section)
**Fixes:** Issue #255 (dream-luna nightly failing 18/20 with "Prompt is too long")
**Research artifacts:** full recon, two design proposals, and the adversarial critique live in the working branch's `.scratch/` (designPragmatic, designRigorous, critique, lunaRecon, hermesRecon, evalResearch, portabilityResearch).

## 1. Goal

The dream state is Luna's self-improvement loop.
Nightly it reflects over recent activity and proposes memory hygiene, belief candidates, and improvement suggestions (skills, workflows, upgrades, pruning) that the operator approves as chips.
Periodically it runs gated experiments over accumulated activity windows to measurably improve any part of the system it can safely change.
A small operator-confirmed golden set is the measurement instrument, and the same golden set gates substrate upgrades on self-evolved instances.

## 2. Root cause this replaces (issue #255)

The v1 dream is a single-shot `maxTurns: 1` SDK call that stuffs everything into one prompt.
Four compounding defects were confirmed on the live instance:

1. No token budgeting anywhere: `gatherInputs` reads all messages of all window sessions plus all operator memories, and `buildDreamPrompt` JSON-stringifies every raw payload.
2. Mirror amplification: every SDK message is persisted, so 68 percent of window rows were `stream_event` deltas and system noise, storing assistant content 2 to 3 times.
3. Watermark death spiral: the watermark advances only after full success, so one oversized night makes every later night strictly larger and permanently failing (live watermark was stuck 25 days; the window reached 50 sessions, 78k messages, about 62 MB).
4. Session-granularity windowing: a session whose `lastMessageAt` is in the window brings its entire lifetime transcript.

## 3. Design principles (non-negotiable)

- **Open proposal space, closed gate taxonomy.** The dream may propose any change (skill text, workflow structure, retrieval config, embedding model, schema and meta reorganization). What is enumerated and frozen is the set of gates and the sandbox environment, never the levers.
- **Gates are substrate.** The gate router, gate implementations, golden set, scorer code, decision rules, harness-corpus probes, and CI live in the shipped checkout and are structurally unwritable by any dream-spawned worker. This includes the golden-case miner and the evidence-bundle assembler, because selection bias and framing bias are reward-hack paths that location isolation alone does not close.
- **Human answers mint ground truth.** The dream may nominate candidate cases; only operator answers confirm them.
- **Archive, never delete.** Every replaced artifact version, retired case, and losing variant is preserved with a tombstone.
- **Nothing ungated ever auto-applies.** A proposal the gate router cannot measure degrades into a suggested-action chip where the operator decides.
- **Everything long runs incrementally.** The V2 JobTicker enforces a 5-minute per-dispatch deadline, so all dream and experiment work is a resumable state machine with per-chunk committed progress.
- **The dream never talks to the user directly.** It writes to stores and queues; chips and surveys are the delivery surfaces (unchanged from the alignment-loop design).

## 4. Architecture overview

Four stages, independently shippable:

- **Stage 0, distill:** bounded, noise-free inputs for every dream pass (Phase 1, section 5).
- **Stage 1, reflect:** bounded fan-out reflection over the distilled window.
- **Stage 2, propose:** four lanes: memory hygiene (exists), belief candidates (exists), improvement proposals (new, via `SuggestedActions.propose({source: "dream"})`), pruning and reorg proposals (new).
- **Stage 3, gate:** risk-tiered application: Tier 0 auto-apply for reversible low-stakes wins above the evidence floor, chips for everything else, never-auto for anything structural or touching the loop's own machinery.

## 5. Phase 1: fix the dream pipeline (this build)

### 5.1 Input distillation (new module `packages/core/src/dream/distill.ts`)

- Keep only `user` and `assistant` message kinds; drop `stream_event`, `system`, `result`, `hook`, `status`, `other`.
- Extract readable text from the opaque SDK payload: text blocks verbatim, tool_use rendered as a one-line name plus truncated input, tool_result truncated hard.
- Window at message granularity: only messages with `ts` in `(watermark, now]` enter the excerpt.
- Per-message and per-session character caps with explicit truncation markers, so any single session distills to a bounded excerpt.
- `DreamInputs.sessions` becomes distilled excerpts (`{summary, excerpt, messageCount, windowMessageCount}`) instead of raw `StoredMessage[]`.
- Memories capped by a character budget with an explicit truncation note.
- Token estimation is chars divided by 3 (deliberately conservative; sandbox verification against the live backlog showed distilled content tokenizes denser than 4 chars per token), plus an explicit prompt-overhead reserve for the CLI's own system prompt and tool schemas; a pre-flight check fails fast with sizes in the error if a built prompt somehow exceeds the budget.

### 5.2 Chunked dreaming with per-chunk watermark advance

- Sessions sort oldest-first by `lastMessageAt` and pack greedily into chunks under a token budget.
- Each session charges `max(estimateTokens(excerpt), SESSION_OVERHEAD_TOKENS)` so empty-excerpt sessions cannot clump one chunk's prompt past the pre-flight budget (audit finding D2).
- Sessions sharing an exact `lastMessageAt` form a tie group that packs as one indivisible unit, because the re-gather filter is strictly greater-than the watermark and a committed cutoff would otherwise orphan a split same-timestamp sibling forever (audit finding D1).
- An indivisible item (an oversized single session or an oversized tie group) still runs as its own chunk even when over budget; distillation caps make this comfortably under the pre-flight limit in practice.
- Each chunk runs reason, applyOps, then `setWatermark(chunkCutoff)` before the next chunk starts.
- A failure in chunk N preserves chunks 1 through N-1; the watermark ratchets forward monotonically, which makes the death spiral structurally impossible for divisible windows and self-heals the live backlog.
- The worker checks remaining deadline between chunks and stops cleanly with partial progress; the next run continues from the committed watermark.
- Per-chunk `dreamId` stays deterministic (`dream-<chunkStart>-<chunkCutoff>`), preserving the existing crash-retry idempotency contract.

### 5.3 Out of scope for Phase 1

The reasoner prompt semantics, sampling passes, calibration writes, op kinds, and apply semantics are unchanged.
Phases 2 and beyond (chips wiring, evidence-bundle survey, experiments) are separate builds.

## 6. Experiments (Phase 5+, design locked)

An experiment is a free-form hypothesis plus a change expressed as a script or diff applied to a **shadow-copy sandbox** (SQLite files cloned; live state untouched), judged by a fixed gate bundle chosen by a substrate **gate router** from what the change actually touched:

1. **Behavioral gate:** golden set plus judge, black-box end to end; works for any lever.
2. **Retrieval gate:** recall and ranking metrics on query-to-memory pairs, live vs shadow, for memory, embedding, and index changes.
3. **Integrity gate:** row counts, referential checks, and a demonstrated down-migration on the copy, for structural changes; plus harness-corpus probes as a binary floor for everything.
4. **Cost and latency gate:** telemetry deltas surfaced as trade-offs.

Windows are **volume quanta, not calendar periods**: roughly a week's worth and a month's worth of activity, measured in sessions, confirmed answers, and message tokens; cron ticks only check whether the quantum has filled.
Tiers map to memory horizons: short window tests working and episodic levers (the only tier eligible for Tier 0 auto-apply), mid window tests consolidation levers (skills, workflows, retrieval config), long window tests semantic and structural levers (embedding model, schema, GEPA-class rewrites; always chip-gated).

Statistical honesty at tiny N: paired BCa bootstrap plus sign-flip permutation, resampled at the case level with seeds averaged within case first; below roughly 8 to 10 confirmed holdout cases the gate is advisory and everything routes to chips.
Every promotion is followed by a 7-day warm-baseline shadow watch with auto-rollback.
Judge config is pinned (model id recorded, different family than the generator), and a Cohen's kappa of at least 0.6 against operator labels is required each cycle or all experiments return inconclusive.

## 7. Golden set and elicitation (Phase 3, design locked)

- The dream mines candidate cases from real traces, but the miner and bundle assembler are frozen substrate prompts; selection criteria are computed by fixed code.
- Every elicitation question carries an evidence bundle: what happened, the verbatim excerpt as primary ground truth, what the agent did, the alternatives, and a show-full-trace expansion; framing fields are labeled agent-generated.
- `not_enough_context` is a first-class answer that never counts as a label and penalizes the question template (with a cap so categories are not silently starved).
- Caps: at most 3 questions per survey and about 5 per week; selection blends uncertainty, coverage, and impact, never only "what flips a pending gate".
- One answer dual-writes: it mints or confirms a golden case and flows through the existing belief validation ladder, making the write-only calibration pipeline load-bearing.
- Holdout is hidden from every generator and only ever populated with never-optimized cases; rotation retires stale cases to archive on the long cadence.

## 8. Update distribution for self-evolved instances (Phase 4+, design locked)

- **Substrate vs evolved state:** substrate is the git checkout plus `seeds/` defaults, moved by `luna update`; evolved state is everything under `~/.luna/`. A `luna doctor` check asserts updates touch nothing under `~/.luna/`.
- Seeded skills carry a hash manifest; an update refreshes only unmodified copies and marks modified ones `user_modified`, skipped forever.
- Declarative-additive schema reconciliation tolerates live-evolved tables (the live instance already has several, including a `proposals` table with personal data that must gain an instance-local never-shareable tag before any sharing path ships).
- **The golden set is the upgrade gate:** before the swap, the instance's confirmed holdout runs against the new substrate in a sandbox; material regression (case-clustered test, not one noisy case) holds the update and emits a chip. Security-tagged releases bypass; holds auto-expire with escalating notice; both versions re-score in one batch under a pinned judge.
- **Packs** share improvements between the operator's instances: artifact text plus an eval summary only, never cases, excerpts, memories, or provenance identifiers; opt-in install; the receiving instance re-gates against its own golden set; a local artifact of the same name always shadows the pack.
- Upstream contribution to the public repo: sanitizer (necessary, not sufficient) plus deterministic secret scan plus mandatory human PR review; never auto-push.

## 9. Build order

1. **Phase 1 (this build):** distillation plus chunked watermark; the dream runs again.
2. **Phase 2:** dream ops to `propose(source: "dream")` chips; also start the per-turn `(tool_request, tool_response, model_id)` recorder so counterfactual replay becomes possible forward-only.
3. **Phase 3:** evidence-bundle survey fix, `not_enough_context` verdict, golden-case mining and confirmation.
4. **Phase 4:** substrate/state split named and doctor-checked, hash manifests, declarative-additive reconciliation.
5. **Phase 5:** experiment MVP: shadow-copy sandbox, behavioral gate, gate router with chip degradation, volume-quantum windows for short and mid tiers, full stat gate, chips only.
6. **Phase 6+:** retrieval and integrity gates, Tier 0 auto-apply, replay, GEPA-class long-window experiments, the upgrade gate, packs.

## 10. Open decisions for the operator

- Weekly elicitation budget (default proposal: 3 per survey, about 5 per week).
- Whether security-tagged updates bypass the personal eval gate silently or always notify.
- Whether incoming packs on a second instance require that operator's explicit approval chip beyond opt-in install.
