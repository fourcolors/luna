# Luna Alignment Loop — Design

> Status: **Approved design (pre-implementation)** · Date: 2026-05-28 · Author: Sterling Cobb + Luna
>
> A closed, human-in-the-loop alignment system for Luna: it reflects over past
> sessions ("Dream"), maintains a small bounded model of Operator ("Beliefs"),
> calibrates its own self-trust via a short adaptive survey, and — once trust is
> earned, per belief — reaches out proactively. Local-first, SQLite-backed,
> built on Luna's existing Effect-TS layers.

## 1. Motivation

Luna already has durable memory (`@luna/memory`: file / SQLite / Vectorlite HNSW),
an identity file loaded into every thread (`DNA.md`), background job
infrastructure (`JobScheduler`, `TriggerAgent`, `WorkflowRuntime`), and
advisor/auditor subagents. What it lacks is a way to **improve its model of
Operator over time and verify that model against reality.**

Comparable systems (e.g. Honcho's "Dreaming") derive user models by reasoning
over raw interaction logs — but *unsupervised*: the derived conclusions are
never checked against the actual user. Luna is local and single-operator, which
makes a **supervised** loop possible: Luna proposes/auto-applies changes to its
own state, then a lightweight survey lets Operator judge whether those changes
were right. That judgment becomes the training signal that governs how much
autonomy Luna earns.

The goal: **develop validated intuition about Operator in order to proactively
help, with trust earned per-belief and a fast clawback when wrong.**

## 2. The trust model (load-bearing)

Trust is split into two distinct signals. Conflating them into one global scalar
is unsafe and is explicitly rejected here.

### 2.1 Global alignment score → survey cadence ONLY

A single EWMA scalar answering "how often should I ask Operator to check my
work?" This is an **attention-budget** decision, not an action-authorization.

- Starts at the dormant floor → surveys fire **daily**.
- As alignment proves high, the survey interval **eases toward 30 days** (slow,
  capped backoff).
- On bad signal, the interval **snaps back toward 1 day** (fast clawback).
- Asymmetric hysteresis: trust is slow to grant, fast to revoke.

### 2.2 Per-belief confidence + validation history → ACTIONS

Auto-apply aggressiveness and autonomous outreach are gated by the **specific
belief's** confidence and validation track-record — never by aggregate good
behavior in an unrelated domain.

> Rejected anti-pattern: a global scalar would let a week of great *coding* help
> unlock autonomous outreach about *finances* — a domain where Luna has zero
> validated beliefs. Aggregate behavior must never authorize a specific
> high-stakes action in an unvalidated area.

The global alignment score may act as a **ceiling/multiplier** (low global trust
→ outreach disabled entirely, regardless of any single belief's confidence). But
the **gate that fires an action is always per-belief.**

### 2.3 Three signals (not one number)

| Signal | Question | Feeds | Notes |
|---|---|---|---|
| **Task quality** | "How did I do on X?" | global alignment | rolls into cadence EWMA |
| **Belief validation** | "Was this auto-applied belief correct?" | **per-belief track record** | kept isolated — gates actions |
| **Outreach welcome** | "Was this unprompted message wanted?" | per-belief track record **+** global | fed back *immediately*, bypassing the survey clock |

The "outreach welcome" signal must not be suppressed by survey backoff: the
riskiest action (unprompted messages) cannot be allowed to run in the
lowest-oversight window with drift undetected for up to 30 days.

### 2.4 Graduated autonomy ladder & cold start

Stakes increase down the ladder; each rung is gated by the right-grained signal:

1. **Internal state edits** (memory hygiene, belief confidence) — lowest stakes.
2. **Asking for attention** (survey) — gated by global alignment.
3. **Unprompted action** (outreach) — gated by per-belief track record + global ceiling.

**Cold start:** Luna boots **dormant** — outreach OFF, auto-apply conservative,
surveys daily. It *climbs* the ladder by earning validated beliefs. Nothing
risky is on by default.

## 3. Components

### 3.1 Dream engine

A durable multi-step workflow (`WorkflowRuntime`) scheduled via `TriggerAgent` /
`JobScheduler`. Crash mid-dream resumes cleanly.

- **Reads:** sessions since the last dream + current beliefs + relevant memories
  (via the `@luna/memory` router).
- **Reasons about:**
  - **Memory hygiene** — contradictions, staleness, duplicates.
  - **Candidate beliefs** — patterns worth promoting to the bounded belief set.
  - **Task-quality observations** — which recent tasks to surface in the survey.
- **Writes:** auto-applied changes (audit-logged) + queued survey items + queued
  outreach candidates.
- **Boundary:** Dream **never talks to the user.** It only writes to
  stores/queues. This keeps it a pure batch reasoner, testable as
  `fixture sessions → expected store mutations`.
- **Default cadence:** nightly / on idle. (Configurable; correct in review.)

### 3.2 Belief set

Beliefs are `MemoryRecord`s with `kind: "belief"` — **no record-level migration**
(content is already `unknown`, records key on `kind` + `tags`).

- **Capped at 20.** When a 21st wants in, the weakest belief
  (confidence × staleness × validation track-record) is **retired** (status
  flip, not deleted — kept for audit/undo).
- A ranked top-N injects into every thread's system prompt the way `DNA.md` does
  today, but from SQLite, refreshed per session. Flat per-thread context cost.
- The cap + eviction is enforced by the **belief writer**, not the store.

### 3.3 Survey + cadence controller

- Surfaces in the chat/TUI surface as a short structured check-in.
- Collects the three signals (§2.3).
- Updates the **global alignment EWMA** (→ next survey interval) and each touched
  belief's **validation history** (→ that belief's action rights).
- **Cadence controller is a pure function** — no I/O — so it is trivially
  unit-testable:
  ```
  nextSurveyAt(alignmentEwma, lastSurveyAt, history) -> timestamp
    low  alignment -> interval snaps toward 1 day   (fast clawback)
    high alignment -> interval eases toward 30 days (slow, capped backoff)
  ```

### 3.4 Outreach

- A `TriggerAgent` watcher. **Ships dormant.**
- Fires an unprompted message only when a *specific belief's* confidence + clean
  validation track-record clears its bar **and** the global alignment ceiling
  permits outreach at all.
- Every outreach message carries an inline "was this welcome?" control whose
  answer feeds back **immediately** (bypassing the survey clock, §2.3).

## 4. Data flow (one cycle)

```
sessions + beliefs + memories
        │
        ▼
   ┌─────────┐   auto-apply (tiered) ──▶ memory/beliefs  +  audit log
   │  DREAM  │   queue survey items   ──▶ survey queue
   └─────────┘   queue outreach cands ──▶ outreach queue (gated)
        │
        ▼
  global alignment ──▶ survey cadence ──▶ ┌────────┐
                                          │ SURVEY │──▶ updates alignment (EWMA)
  per-belief track record ───────────────│        │──▶ updates belief rights
                                          └────────┘
        │                                      ▲
        ▼                                      │
   ┌──────────┐  per-belief gate + global     │
   │ OUTREACH │  ceiling ──▶ unprompted msg ──┘ (inline welcome signal, immediate)
   └──────────┘
```

**Clean interfaces:**
- Dream is write-only to stores/queues; Survey + Outreach are the only
  user-facing surfaces.
- The cadence controller is a pure function of alignment history.

## 5. Data model

### 5.1 Belief — `MemoryRecord` with `kind: "belief"`

`namespace: "operator"`, domain mirrored into `tags`, structured `content`:

```jsonc
{
  "statement": "Operator prefers terse answers, pushes back when wrong",
  "confidence": 0.0,            // 0–1, set by Dream
  "status": "proposed" | "active" | "retired",
  "domain": "comms",            // also mirrored to tags for query()
  "evidence": ["session:abc#msg12", "memory:def"],   // provenance
  "validationHistory": [        // per-belief track record — gates ACTIONS
    { "at": 0, "verdict": "confirmed" | "corrected" | "rejected", "via": "survey" | "outreach" }
  ],
  "outreachRights": { "enabled": false, "minConfidence": 0.8 }
}
```

Reusing the memory record gives beliefs vector search, export/import, and the
existing backends for free.

### 5.2 New SQLite tables (operational time-series, not "memories")

```
alignment_log (id, at, signal_kind, score_delta, ewma_after, ref)
  -- signal_kind ∈ {task_quality, belief_validation, outreach_welcome}
  -- ref → the task / belief / outreach the signal came from
  -- belief_validation rows stay isolatable for action-gating even though
  --   task_quality + outreach_welcome roll into the global EWMA for cadence

dream_audit (id, dream_id, at, op, target_id, before, after, reverted_at)
  -- op ∈ {memory_edit, belief_add, belief_retire, belief_confidence}
  -- before/after = JSON snapshots → this IS undo + debug trace + training corpus
```

## 6. Testing strategy

- **Dream:** fixture session corpus → assert exact store mutations + audit rows.
  Deterministic; no user surface to mock.
- **Belief writer:** cap/eviction unit tests (21st belief retires the weakest;
  retired beliefs persist for audit).
- **Cadence controller:** pure-function table tests — low alignment snaps to 1
  day, high eases toward the 30-day cap, hysteresis is asymmetric.
- **Survey:** signal-routing tests — each verdict updates the correct stream
  (task_quality/outreach → EWMA; belief_validation → per-belief track record).
- **Outreach:** gating tests — dormant by default; fires only when per-belief bar
  AND global ceiling both pass; welcome signal writes back immediately.
- **Audit/undo:** every `op` is reversible from `before` snapshot.

## 7. Implementation phasing (build order)

Riskiest component last and dormant. Luna is useful and safe after Phase 3 even
if Phase 4 never ships — the calibration loop stands on its own.

1. **Dream engine + `dream_audit`** — batch reasoner; fixture-driven tests; no
   user surface. Tiered auto-apply (conservative defaults).
2. **Belief set** — `kind:"belief"`, ≤20 cap + eviction, per-thread injection.
   Dream begins promoting candidates.
3. **Survey + cadence controller + `alignment_log`** — closes the human loop.
   Cadence math unit-tested as a pure function. *Loop is now alive and
   self-correcting.*
4. **Outreach** — `TriggerAgent` watcher, **ships dormant**, per-belief +
   global-ceiling gate, inline welcome signal. Enabled only after Phases 1–3
   have logged real alignment.

## 8. Open questions (resolve during planning, non-blocking)

- **Dream cadence trigger:** fixed nightly vs idle-detection vs session-count
  threshold. Default: nightly.
- **EWMA constants:** smoothing factor + the alignment→interval mapping curve
  (and the 1-day / 30-day bounds) need concrete numbers + a tuning method.
- **Confidence bar for outreach** per domain — single global `minConfidence` vs
  per-domain. Default: per-belief `minConfidence`, global ceiling on top.
- **Survey surface:** TUI-only first, or all surfaces (web/Tauri) at once.
- **Belief injection ranking:** confidence alone vs confidence × recency ×
  domain-relevance-to-current-thread.

## 9. Non-goals (v1)

- Multi-user / multi-peer modeling (Luna is single-operator; no Honcho-style
  "Peers" graph).
- Learning a parametric update policy from the audit corpus (the corpus is
  *captured* for this future, not consumed in v1).
- Cloud sync of beliefs/alignment (local-first; `~/.luna/` is the system of
  record).
