# Luna Alignment Loop — Design

> Status: **Approved design (pre-implementation)** · Date: 2026-05-28 · Author: fourcolors/luna contributors
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

**Category boundary — transcripts vs. telemetry.** The two are different *kinds*
of evidence and feed different signals:

- **Transcripts tell you about Operator.** A belief about Operator can *only*
  come from the conversation. This is the sole source for the
  **belief-validation** stream.
- **Telemetry/observability tells you about Luna.** Tool failures, latencies,
  cost, retries are about Luna's *performance*, not about Operator. Deriving a
  belief about Operator from telemetry is a category error. Telemetry feeds the
  **task-quality** stream only — never belief-validation.

**Implicit signals (no survey needed).** Some objective events are unambiguous
alignment labels on their own. The strongest is `PermissionDecision` **denials**
(`observability/types.ts`): every denied tool call is a recorded instance of
Luna misjudging, and feeds the task-quality stream directly without waiting for
a survey. Telemetry thus **pre-biases** the task-quality score (objective rough
draft); the survey **confirms or overrides** it (subjective ground truth).

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

A plain Effect program scheduled by `TriggerAgent` cron (5-field expr).

**Durability = the watermark, not the workflow.** `WorkflowRuntime` exists but
its `WorkflowState` is in-memory today, so it can't deliver cross-restart
durability — wrapping Dream in it would be ceremony for a guarantee it can't
make. Instead, the persisted SQLite **watermark** (§3.1.1) is the resume point:
a crashed dream simply re-runs from the last committed watermark on the next
tick. Transaction boundary that makes this safe:

- **Reason *outside* any DB transaction** (the LLM step is slow).
- **Apply ops + advance the watermark in ONE atomic transaction.**
- **Ops are idempotent state-sets ("set memory X to Y"), never deltas** — so a
  re-run after a crash mid-reason (watermark unmoved → re-reason, wasteful but
  safe) or mid-apply (rollback → watermark unmoved → re-run) is harmless.

(`WorkflowRuntime` becomes a viable wrapper once `WorkflowState` gets a SQL
codec — out of scope for v1.)

- **Reads:** see §3.1.1 (Dream inputs).
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

#### 3.1.1 Dream inputs

Dream is **incremental and idempotent**, driven by a persisted watermark
`last_dream_at`. Each run:

1. **Advance from the watermark.** Query `SessionStore`
   (`session/session-store-sqlite.ts`) for sessions touched since
   `last_dream_at`, ordered by `SessionSummary.lastMessageAt`. Pull each
   session's message log.
2. **Pull behavioral evidence.** For each session, filter the
   `ObservabilityService` JSONL sink (`observability/types.ts`) by `sessionId` +
   the session's time window, aggregating `ToolCall` (durations),
   `Error`, `PermissionDecision` (denials), `RetrievalCall`, `CostAccrued`, and
   `SessionEnd.durationMs`.
3. **Pull current state.** `@luna/memory` router `query({ kind, since })` +
   semantic `search()` for beliefs and memories relevant to the sessions under
   review — the state to reconcile against.
4. **Reason** (per the three reasoning targets above), routing evidence by the
   §2.3 category boundary: transcripts → belief candidates + memory hygiene;
   telemetry/observability → task-quality observations only.
5. **Advance the watermark** to the latest processed `lastMessageAt`.

The watermark makes re-runs safe: a session is never double-processed, and a
crashed dream resumes from the last committed watermark.

**Source-of-signal map:**

| Input source | Layer / file | Routes to |
|---|---|---|
| Transcripts | `SessionStore` · `SessionSummary` | belief candidates + memory hygiene |
| Memory / beliefs | `@luna/memory` router (`query` / `search`) | state to reconcile |
| Observability events | `ObservabilityService` JSONL sink | task-quality observations |
| `PermissionDecision` denials | `observability/types.ts` | task-quality (implicit, no survey) |

**Transcript source — v1 decision.** Dream reads the **live `SessionStore`**
(`session/session-store-sqlite.ts`) — the wired, proven store. The nightly
incremental scan (days of recent sessions, not years) is well within its reach.
luna also has a denormalized, analytics-shaped `SessionHistory` table
(`session-history/`, currently built-but-unconsumed) which — optionally fronted
by DuckDB (§5.3) — is the documented **future read-layer** for when scans grow
heavy or the §9 analytics arrive. Because "Reads" is an abstract interface,
swapping the source later is **non-breaking** and never touches Dream's
reasoning core (a CQRS write-model → read-model split). Not in v1 scope.

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
sessions + beliefs + memories + observability/telemetry
        │  (transcripts → beliefs/hygiene; telemetry → task-quality only)
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

### 5.2 New SQLite tables (append-only event/audit logs, not "memories")

These are **append-only, time-ordered event logs** — *not* time-series in the
TSDB sense. Volume is low (handfuls/day), and access is indexed point/range
lookup, not analytical aggregation. See §5.3 for why SQLite, not DuckDB.

```
alignment_log (id, at, signal_kind, score_delta, ewma_after, ref)
  -- signal_kind ∈ {task_quality, belief_validation, outreach_welcome}
  -- ref → the task / belief / outreach the signal came from
  -- belief_validation rows stay isolatable for action-gating even though
  --   task_quality + outreach_welcome roll into the global EWMA for cadence
  -- index (signal_kind, at)

alignment_state (id, ewma, updated_at)
  -- single-row denormalized cache of the current global EWMA, for O(1) reads
  -- on the cadence/gate hot path. alignment_log is the source of truth; this
  -- is derivable and rebuildable (e.g. if the smoothing constant changes).

dream_audit (id, dream_id, at, op, target_id, before, after, reverted_at)
  -- op ∈ {memory_edit, belief_add, belief_retire, belief_confidence}
  -- before/after = JSON snapshots → this IS undo + debug trace + training corpus
  -- indexes (dream_id), (target_id)
```

### 5.3 Storage engine decision — SQLite operational, DuckDB optional lens

**These tables live in SQLite** (`bun:sqlite`), alongside beliefs (`@luna/memory`).
Rationale:

- **System of record.** `DNA.md` mandates SQLite as the system of record;
  `session-history.ts` already migrated *off* a DuckDB stub onto `bun:sqlite`.
  DuckDB is not a current dependency.
- **Transaction boundary is decisive.** A gate decision writes a belief *and*
  logs its alignment signal as **one atomic transaction**. Beliefs are in
  SQLite, so the log must be too — splitting across engines turns an atomic
  write into a two-phase sync problem with no rollback.
- **Workload is OLTP, not OLAP.** Single-row appends + indexed point/range reads
  + concurrent mixed read/write. That is SQLite's shape; DuckDB's columnar
  engine is the wrong tool for single-row transactional writes.

**DuckDB is the right tool only for read-only analytics** over the accumulated
corpus (the §9 training-corpus future — e.g. "belief-validation accuracy by
domain, week over week"). When that arrives, DuckDB reads the SQLite file
directly (`sqlite_scanner` / `ATTACH`) or a Parquet export — **additive, never a
migration.** SQLite stays the live store; DuckDB becomes an analytical lens over
the same data.

## 6. Testing strategy

- **Dream:** fixture session corpus → assert exact store mutations + audit rows.
  Deterministic; no user surface to mock.
- **Dream input routing (category boundary):** given fixture transcripts +
  observability events, assert transcripts produce belief candidates / hygiene
  ops and telemetry produces *only* task-quality observations (never a belief).
  Watermark advances; re-run on the same corpus is a no-op (idempotency).
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

1. **Dream engine + `dream_audit` + watermark** — batch reasoner; fixture-driven
   tests; no user surface. **Auto-apply is restricted to exact-duplicate dedup**
   (the safest op) plus a `revert(auditId)` undo; **all other op classes
   (staleness, contradiction, belief candidates) are logged as *proposed* ops
   and held, not applied** — because the survey that would catch a bad
   auto-apply doesn't exist until Phase 3. The reasoner is an **injectable port**
   (`DreamReasoner`): tests inject a fake returning fixed ops; the real impl
   calls the model. Cron wiring (`TriggerAgent`) is the final, discrete task so
   the reasoner core is tested independently of the clock.
2. **Belief set** — `kind:"belief"`, ≤20 cap + eviction, per-thread injection.
   Dream begins promoting candidates.
3. **Survey + cadence controller + `alignment_log`** — closes the human loop.
   Cadence math unit-tested as a pure function. *Loop is now alive and
   self-correcting.* **Prerequisite (net-new work):** `ObservabilityService` is
   **write-only today** (live PubSub + JSONL sink, no historical query API —
   `observability/types.ts`). Phase 3 must add a read path — either a JSONL
   reader keyed by `(sessionId, time window)` or a query method on the service —
   before task-quality signals can be sourced from telemetry. This also unblocks
   Phase 1's deferred op classes: once the survey exists, staleness/contradiction
   proposals can begin auto-applying under the alignment governor.
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

## 10. Pre-existing cleanup surfaced during design (not blocking)

Found while grounding this spec; tracked here so they aren't lost. None block
the alignment loop:

- **Stale doc:** `session-history/README.md` says "MVP, mocked, DuckDB driver
  pending," but `session-history.ts` is a finished `bun:sqlite` implementation
  (Phase 28). Update the README.
- **Built-but-unconsumed module:** `SessionHistory` is exported from
  `core/index.ts` but has no real consumers. Either wire it (it's the natural
  future Dream read-layer, §3.1.1) or mark it explicitly pending.
- **Vestigial dependency reference:** `telemetry/session-sync.ts` imports a
  `DuckDbService` (`../db/duckdb-service.js`) though DuckDB is no longer a
  dependency (0 lockfile hits). Confirm it's a live stub vs. dead code.
