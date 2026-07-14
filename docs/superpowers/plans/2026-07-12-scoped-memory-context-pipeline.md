# Scoped Memory Context Pipeline

**Date:** 2026-07-12
**Status:** implementation plan

## Goal

Turn Luna's explicit memory tools and nightly Dream loop into a measurable,
low-latency memory pipeline:

1. automatically recall a small amount of relevant memory before each turn;
2. keep memories isolated by observer and subject;
3. asynchronously capture durable-memory and belief-evidence candidates after
   a completed turn without promoting unreviewed beliefs.

The response-critical path may perform one existing hybrid retrieval call. It
must not add another model call. Candidate extraction happens only after the
SDK's exactly-once `result` event and must never delay or fail the chat turn.

## Invariants

- The user message persisted in `SessionStore` and the SDK transcript remains
  byte-for-byte free of injected memory context. Recall-enabled threads use a
  finite resumed SDK query per turn and put current recall only in that query's
  system-prompt configuration, replacing it on the next turn.
- A private record is visible only when both its subject matches and its
  observer matches. Shared records still require a matching subject. The MCP
  delete tool applies the same scope check before mutating by id.
- Legacy records get an explicit compatibility scope at read time; the schema
  migration is additive and does not require a destructive rewrite.
- Retrieved text is bounded, escaped as untrusted historical data, and cannot
  override the system prompt.
- Candidate extraction is conservative and inert. It writes candidate records,
  not active semantic memories or active beliefs.
- Beliefs retain the existing `proposed -> survey -> active` path. Nothing in
  the turn pipeline bypasses `Dream` or the alignment survey.
- Retrieval quality runs are invalid when stored vector dimensions do not match
  the configured embedder dimension. The eval harness reports that condition
  instead of publishing a misleading score.

## Design

### 1. Portable scope and provenance

Extend `MemoryRecord` with optional, portable metadata:

```ts
scope: {
  observerId: string
  subjectId: string
  visibility: "private" | "shared"
}
provenance: {
  source: "manual" | "turn-extraction" | "dream" | "migration"
  sessionId?: string
  messageIds?: string[]
}
```

`MemoryQuery` and `MemoryRouter.search` accept a scope selector. Backends persist
the metadata, while shared helpers enforce the same visibility semantics for
keyed and vector reads. Records written before this change are interpreted via
a documented compatibility scope.

### 2. Bounded automatic recall

Add a pure context packer plus an Effect service in `@luna/memory-tools`.
Before `ChatService` starts the turn's finite SDK query, the per-thread binding
asks the service for scoped hybrid hits. The query resumes the same clean SDK
transcript and receives only the current packed context as a system-prompt
suffix; previous recall is replaced rather than accumulated. The packer:

- excludes inert candidates and non-active beliefs;
- deduplicates normalized text;
- caps hit count, per-record characters, and total characters;
- preserves record ids and scores for evaluation/debugging;
- renders a clearly delimited, untrusted `<memory_context>` block.

Search failure degrades to no injected context and emits a warning; it never
rejects the user turn. Recall must inject before the SDK turn (unlike
`observeTurn`, it cannot be backgrounded), so `ChatService` also bounds it with
a wall-clock ceiling: on timeout it increments `luna.chat.recall.timeouts` and
degrades to no injected context. The bound defaults to 2.5s and is overridable
via `LUNA_CHAT_RECALL_TIMEOUT_MS` (`0` disables the bound; recall may then block
the turn indefinitely).

### 3. Post-turn candidate capture

`ChatService` keeps the raw user text/message id and accumulated top-level
assistant text for the in-flight turn. At the SDK `result` event it invokes an
optional provider hook in a supervised background fiber.

The first extractor is deliberately deterministic and conservative. It emits
inert candidates for explicit durable signals such as `remember that`, `I
prefer`, `my ... is`, `we decided`, and direct operating instructions. Each
candidate carries its source session/message ids and a stable content-derived
id, making retries idempotent. Belief-shaped evidence is tagged separately for
future Dream/eval use but is never materialized as a belief by this path.
Candidate content intentionally does not use the vector backend's `content.text`
shape, so unreviewed candidates cannot crowd the live recall index.

Both runtime paths default on and have fail-safe operator switches:
`LUNA_MEMORY_AUTO_RECALL=0` and `LUNA_MEMORY_TURN_EXTRACTION=0`.

### 4. Eval seams

Keep evaluation logic pure and data-driven:

- retrieval cases declare observer/subject scope, query, relevant ids, and
  forbidden ids;
- extraction cases declare a turn and expected candidate kinds/fragments;
- context metrics include recall@k, MRR, forbidden-hit rate, packed character
  count, and truncation rate;
- extraction metrics include candidate precision/recall over labeled fixtures;
- every run records embedder provider/model/dimension and corpus version.

The existing paraphrase bench remains the live-embedder quality check. It gains
preflight metadata and a hard invalid-result guard for dimension mismatch. Unit
tests exercise scope isolation, packing budgets, prompt-injection boundaries,
idempotent extraction, and chat hook lifecycle with deterministic fakes.

## Delivery slices

1. Add record metadata, additive SQLite migrations, and scope filtering.
2. Add the context packer/extractor and bind them through per-thread hooks.
3. Wire the chat server to the operator scope (`luna` observing `operator`).
4. Add eval fixtures/metrics and focused tests.
5. Run targeted tests, full repo tests/typecheck, no-mistakes review gates, then
   publish a draft PR.

## Explicit follow-ups

- Replace or augment the conservative extractor with a separately budgeted
  structured-output model after the labeled corpus is large enough to compare
  it against the deterministic baseline.
- Calibrate score thresholds and context budgets from logged retrieval outcomes;
  do not hard-code a semantic relevance threshold before measurement.
- Add multi-human identity resolution only when Luna has an authoritative
  subject-id source; do not infer identity from display names.
