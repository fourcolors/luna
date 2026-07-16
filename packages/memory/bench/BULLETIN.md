# Bulletin: the hot-tier digest (design + eval plan)

## Motivation: two tiers, one memory

Luna's memory has two sides with different physics.
The cold side is a large corpus searched on demand, and it is served well by the shipped hybrid-retrieval + cross-encoder + gate pipeline.
The hot side is observational: what has been going on across threads recently, which should simply be present in every active session rather than fetched.
Beliefs already live on the hot side: the chat-server runs a belief-injection holder that refreshes active beliefs from the memory store every 30 seconds.
The missing hot-tier piece is the **bulletin**: a token-budgeted rolling digest of recent thread activity injected into active sessions, giving the agent cross-thread awareness without a search.
The resulting recall order (beliefs, then bulletin, then `memory_search`) mirrors the priority ordering the strongest published system (Hindsight) uses: curated models first, consolidated observations second, raw facts last.

## Eval first: this document ships with a harness, not a mechanism

Per the standing rule for all memory work, the probe set and harness land BEFORE any bulletin generator is built.
The harness measures an **oracle ceiling** (a hand-written ideal digest) against a **no-bulletin baseline**, which proves the probes are answerable and quantifies the maximum win available.
A future generator is judged by the same probes via a pluggable condition, and it ships only if it passes the decision gate below.

## What the bulletin must be (requirements for the future mechanism)

- **Hard token budget.** Injected content is paid on every turn of every active session. Target is <= 1,200 tokens, hard cap 1,500.
- **Wiki-bookkeeper maintenance.** The digest follows the LLM-Wiki curation rules: update canonical entries instead of appending duplicates, decay stale items, distinguish one-off events from ongoing work, keep a stable shape.
- **Injection-fenced.** Bulletin text derives from thread content, which makes it a prompt-injection surface into every session. It must pass through the same Unicode fence-neutralization used for rerank candidates before injection.
- **Privacy boundaries.** Archived and hidden threads are excluded. The bulletin is delivered on a private channel; it must never be written into `workspace.md`, which is public and prompt-injected.
- **Freshness.** Regenerated on a background cadence (the existing JobTicker is the natural home), not on the request path.

## The probe set

The fixture (`bulletin-fixture.json`) is a fully synthetic product-development universe: ten threads over five simulated days with fixed timestamps, an `oracleBulletin` written to the token budget, and labeled probes.
No real memory content, names, or infrastructure appear in the fixture; the repository is public.

Probe categories:

- **cross-thread**: what happened in a specific other thread ("what is the state of the PNG upload bug?").
- **status**: what is currently in progress across threads.
- **temporal**: what changed in a named window ("what shipped yesterday?").
- **decision**: what was decided and why.
- **negative**: topics never discussed anywhere; the correct answer is an explicit no-record.
- **exclusion**: content that exists only in an archived thread; the bulletin condition must ALSO answer no-record, proving the digest does not leak archived content.

## Answer protocol and scoring

The answering model is instructed: answer briefly from the recent-activity digest if one is present, and if you have no information, reply exactly `NO-RECORD`.
Scoring is deterministic keyword matching on the model's answer: a probe is correct when every `requiredKeywords` entry appears (case-insensitive) and no `forbiddenKeywords` entry appears.
Positive probes forbid `no-record`; negative and exclusion probes require it.
Because LLM answers vary run to run, every probe runs N samples (default 3) and the report shows per-probe flip counts; there is deliberately NO response cache, since a cached replay is one draw pretending to be a distribution.

## Conditions

- `none`: no digest injected; the model knows only the current-thread framing. This is today's production behavior.
- `oracle`: the hand-written ideal digest from the fixture. This is the ceiling.
- `generated`: reads a digest from `LUNA_BULLETIN_FILE`; this is how a future generator plugs in unchanged.

## Decision gate

Build and ship a bulletin generator only if, on this probe set, the generated digest closes at least 70% of the oracle-vs-none accuracy gap while staying within the 1,500-token hard cap, without regressing the negative and exclusion categories below 90%.
If the oracle itself does not decisively beat `none`, the probes or the premise are wrong, and the mechanism should not be built either way.

## Running it

```sh
bun packages/memory/bench/bulletin-eval.ts                 # none + oracle
LUNA_BULLETIN_FILE=digest.txt bun packages/memory/bench/bulletin-eval.ts   # + generated
```

The run writes a dated baseline JSON (raw answers included, for auditability) next to the script.
The answering model defaults to `haiku` via the claude CLI (`LUNA_BULLETIN_MODEL` to override), reusing the invocation pattern proven in `rerank-eval.ts`.
