# LoCoMo memory benchmark harness

Evaluates Luna's own long-term memory system (`packages/memory` —
SQLite + Vectorlite HNSW vector search, hybrid BM25+vector retrieval,
local Ollama embeddings) against the LoCoMo long-term conversational memory
benchmark, as a point of comparison with how the competitor product Honcho
(Plastic Labs) reports on the same benchmark family.

This directory contains ONLY harness code we wrote ourselves. It does not
vendor, copy, or adapt any code from `plastic-labs/honcho` or
`plastic-labs/honcho-benchmarks` (both AGPL-3.0 — incompatible with Luna's
move toward public open-source release). It also does not vendor the
LoCoMo dataset itself — see "Dataset & license" below.

## Dataset & license

- **Source**: [`snap-research/locomo`](https://github.com/snap-research/locomo)
  on GitHub, `data/locomo10.json`. This is the canonical release from the
  ACL 2024 paper *"Evaluating Very Long-Term Conversational Memory of LLM
  Agents"* (Maharana, Lee, Tulyakov, Bansal, Barbieri, Fang —
  arXiv:2402.17753). Cross-checked against the HuggingFace mirror uploaded
  by the paper's lead author, `adymaharana/locomo`, which independently
  confirms the license tag.
- **License**: **CC BY-NC 4.0** (Attribution-NonCommercial), per
  `LICENSE.txt` in the GitHub repo. **This is NOT the permissive MIT/CC-BY/
  Apache license this task assumed going in** — it is explicitly
  NonCommercial. See `LICENSE.txt`'s definition: "not primarily intended
  for or directed towards commercial advantage or monetary compensation."
- **What we do about it**: we treat this as internal R&D benchmarking of
  Luna's own product against a public academic benchmark — not
  redistribution or commercial exploitation of the dataset itself — and
  mitigate the risk two ways:
  1. **The dataset is never committed to this repo.** `dataset.ts` downloads
     `locomo10.json` on first run into a git-ignored `.cache/` directory
     next to this file (see `.gitignore` here). Only our own harness code
     — which we license however Luna licenses itself — is tracked in git.
  2. **This caveat is documented here, in the PR body, and in the
     `obs_note` decision log**, so if the resulting score is ever surfaced
     externally (marketing copy, a public blog post, a comparison table),
     whoever does that gets a clear flag to get separate legal sign-off
     first. Internal engineering use — "how good is our own retrieval" —
     is the only use case this harness is built for.
- If a cleaner (fully permissive) LoCoMo mirror surfaces later, swap the
  URL in `dataset.ts`; nothing else in the harness depends on the license.

## What this measures — and what it doesn't

Luna's memory system (`packages/memory`) is **pure retrieval**: a flat
namespace + kind + tags store with hybrid BM25/vector search. There is no
ingest-time reasoning or synthesis step — `memory_save` stores exactly the
text it's given, with no summarization, fact extraction, or "peer" model of
who-said-what-and-why the way Honcho's architecture does.

This harness is built around that reality:

- **Ingestion** (`ingest.ts`) writes ONE `MemoryRecord` per raw LoCoMo
  dialog turn, `kind: "episodic"`, scoped to a `locomo-eval:<sample_id>`
  namespace. We deliberately do NOT ingest LoCoMo's own pre-computed
  `observation` or `session_summary` fields — those are the paper's
  synthesis outputs (used for its own "RAG over summaries" baseline) and
  ingesting them would benchmark whoever generated those summaries, not
  Luna.
- **Retrieval** (`run.ts`) calls the exact same `MemoryRouter.search()`
  path `memory_search` uses — `mode: "hybrid"`, namespace-scoped, top-K
  configurable (`LUNA_LOCOMO_TOPK`, default 10).
- **Answering** (`answer-model.ts`) asks a model to answer using ONLY the
  retrieved excerpt texts — no full transcript, no ground truth in the
  prompt. This isolates retrieval quality from "does a model with the
  whole conversation in context know the answer," which is the fair
  comparison per the task brief.

So: **this benchmarks Luna's retrieval quality** (does the right memory
surface for a given question) **and answer-from-context quality** (given
the right memory, can a small cheap model extract the answer). It does
**not** benchmark Honcho-equivalent behavior — Honcho's ingest-time
reasoning (deriving facts, resolving contradictions, building a "theory of
mind" of each peer) has no Luna counterpart to test. A structural
comparison of "Luna score" vs "Honcho score" on this same benchmark tells
you about retrieval-only architecture vs retrieval+synthesis architecture,
not just raw memory quality — that's expected and worth stating plainly
whenever this number gets quoted.

## Scoring methodology

LoCoMo's own paper methodology (verified by reading, not copying,
`task_eval/evaluation.py` upstream — the algorithm is independently
reimplemented in `scoring.ts`) uses **token-overlap F1**, not an LLM judge:

- Categories 2 (single-hop) and 4 (open-domain): plain F1(prediction, answer).
- Category 3 (temporal): ground-truth answer is truncated at the first
  `;` before scoring (multi-part temporal answers).
- Category 1 (multi-hop): both prediction and ground truth are comma-split
  into sub-answers; per ground-truth sub-answer, take the max F1 against
  any predicted sub-answer, then average.
- Category 5 (adversarial / unanswerable): there is no ground-truth
  `answer`, only a distractor `adversarial_answer` a naive model might
  produce. Score is 1 if the prediction abstains (contains "no information
  available" or "not mentioned"), 0 otherwise. The answer-model prompt
  explicitly instructs the model to say "No information available." when
  it can't find the answer in the retrieved excerpts.

Because scoring is pure token-overlap F1 (no LLM judge call), the answer
backend choice below has **zero effect on scoring cost** — only on answer
quality and wall-clock time.

**Deviation from the paper**: the paper stems tokens with a Porter
stemmer before computing F1; we use a lightweight suffix-stripping
approximation (`lightStem` in `scoring.ts`) rather than vendoring a full
Porter implementation. Our F1 numbers are internally consistent (comparable
across our own runs, e.g. before/after a retrieval change) but **not
bit-for-bit comparable to the published LoCoMo leaderboard numbers**. We
also skip the paper's secondary metrics (BERTScore, ROUGE-L, exact-match) —
F1 is the metric the paper treats as primary.

We additionally report **retrieval evidence coverage** — for each QA pair
with annotated `evidence` dialog IDs, what fraction of those IDs actually
appear in the top-K search hits. This isolates pure retrieval recall from
answer-generation quality, independent of the LLM call.

## Directory layout

- `types.ts` — LoCoMo dataset types (verified against the actual downloaded file).
- `dataset.ts` — fetch (cached, gitignored) + flatten into per-turn records.
- `ingest.ts` — turn → `MemoryRecord` → `MemoryRouter.put()` (same write path as `memory_save`).
- `scoring.ts` — F1 scoring per LoCoMo's category rules, independently implemented.
- `answer-model.ts` — answer-generation backends: **Ollama `/api/chat`
  (default)** and Anthropic Messages API (opt-in, see below). Cost tracking
  reuses `@luna/core`'s `rateFor`/`priceTurnUsd` — the same pricing table
  the chat-server itself uses; the `ollama` rate is always $0.
- `run.ts` — CLI entrypoint wiring it all together.

## Why the direct TypeScript API, not the MCP tool surface

`ingest.ts` calls `MemoryRouter.put()` directly (same underlying call
`memory_save` makes in `packages/memory-tools/src/tools.ts`) instead of
spinning up the MCP tool server and driving it over JSON-RPC. This is a
batch script doing hundreds-to-thousands of writes/searches per run inside
the same TypeScript monorepo — the MCP surface exists to expose these
tools to an agent's tool-calling loop, which buys nothing here and adds a
protocol layer with no upside for a script that already has direct access
to the router. `run.ts`'s retrieval call (`router.search(...)`) is
identical in shape and options to what `memory_search` does, so the
result is representative of what an agent actually sees.

## Answer backend: local Ollama by default

The answer-generation step (`answer-model.ts`) defaults to a **local Ollama
model** (`llama3.1:8b` via `/api/chat`, non-streaming) — no API key, no
per-token dollar cost. This is a deliberate swap from an earlier revision
of this harness that called the raw Anthropic Messages API: that path
needed a real `ANTHROPIC_API_KEY` (not the Claude Code OAuth credential),
which wasn't available in the environment this harness was built and run
in. The Anthropic path is preserved behind
`LUNA_LOCOMO_ANSWER_BACKEND=anthropic` for a future paid-model comparison
run, but it is no longer the default.

Since LoCoMo scoring is pure F1 (see "Scoring methodology" above, no LLM
judge), swapping the answer backend only changes answer quality and
wall-clock time — never the marginal cost of scoring itself.

## Time budget, not dollar budget

With Ollama the marginal cost per QA pair is $0 (CPU/wall-clock only), so
the old `LUNA_LOCOMO_BUDGET_USD` dollar cap has been replaced with
**`LUNA_LOCOMO_MAX_MINUTES`** (default 55): `run.ts` times the answer-model
calls as they happen, projects total runtime from the observed average
seconds/QA-pair, and stops cleanly (writing all results collected so far)
if the projection would exceed the cap — instead of silently truncating
mid-run or blowing past an unbounded wall-clock budget.

**Measured throughput on the reference machine** (16 vCPU, 14 GiB RAM, no
GPU — `llama3.1:8b`, Q4 quantization, via Ollama): ~60 seconds per QA pair
end-to-end (retrieval + answer generation), dominated by CPU-only prompt
evaluation of the ~10 retrieved excerpts (topK=10) that make up each
question's context. At that rate the full LoCoMo10 dataset (1,986 QA pairs
across all 10 conversations) would take **roughly 33 hours** — far outside
any reasonable single-run budget on this hardware.

**What we actually ran**: a documented subset — the first 4 conversations
in dataset order (`conv-26`, `conv-30`, `conv-41`, `conv-42`; no
cherry-picking), first 8 QA pairs of each (`LUNA_LOCOMO_SAMPLE_LIMIT=4
LUNA_LOCOMO_QA_LIMIT=8`), 32 QA pairs total, projected at ~42 minutes
wall-clock (ingestion + answering) — comfortably under the 60-minute
target. See the PR body / `obs_note` ledger for the actual result numbers
and timing from that run.

If this harness is re-run on faster hardware (GPU-backed Ollama, or a
smaller/faster answer model), `LUNA_LOCOMO_SAMPLE_LIMIT`/
`LUNA_LOCOMO_QA_LIMIT` can be raised accordingly — nothing else about the
pipeline changes.

## Running

Ingestion + retrieval need only a local Ollama daemon (`LUNA_EMBEDDER=ollama`,
`LUNA_OLLAMA_BASE_URL`, `LUNA_OLLAMA_EMBED_MODEL` — same env vars
`bench/paraphrase-recall.ts` uses). No cost for this half either way.

```sh
# Retrieval-only smoke test — zero cost, validates ingestion + search wiring
LUNA_EMBEDDER=ollama LUNA_LOCOMO_SAMPLE_LIMIT=1 LUNA_LOCOMO_QA_LIMIT=5 \
  bun packages/memory/src/adapters/locomo-eval/run.ts --dry-run
```

Full run (answer generation + scoring) via local Ollama (default backend —
needs `llama3.1:8b` pulled: `curl -s $LUNA_OLLAMA_BASE_URL/api/pull -d
'{"name":"llama3.1:8b"}'`):

```sh
LUNA_EMBEDDER=ollama LUNA_LOCOMO_SAMPLE_LIMIT=4 LUNA_LOCOMO_QA_LIMIT=8 \
  bun packages/memory/src/adapters/locomo-eval/run.ts
```

Full run via the Anthropic backend instead (needs a real
`ANTHROPIC_API_KEY` — not the Claude Code OAuth/subscription credential —
and the exact, dated model id; check
https://docs.anthropic.com/en/docs/about-claude/models):

```sh
LUNA_LOCOMO_ANSWER_BACKEND=anthropic ANTHROPIC_API_KEY=sk-ant-... \
  LUNA_LOCOMO_ANSWER_MODEL=<current-haiku-id> \
  LUNA_EMBEDDER=ollama LUNA_LOCOMO_SAMPLE_LIMIT=1 LUNA_LOCOMO_QA_LIMIT=5 \
  bun packages/memory/src/adapters/locomo-eval/run.ts
```

`LUNA_LOCOMO_MAX_MINUTES` (default 55) is a wall-clock soft cap: the loop
projects total runtime before every answer-model call and stops cleanly
(exit code 5, partial results still written) rather than risk an
unbounded run.

## Status (see obs_note ledger for the authoritative timeline)

- Dataset acquired, license verified and documented (CC BY-NC 4.0 — see
  above).
- Ingestion + hybrid retrieval validated end-to-end on a live Ollama
  embedder against 1 conversation / 5 QA pairs (`--dry-run`): 419 turns
  ingested, retrieval evidence coverage computed successfully. Zero cost.
- Answer-generation + F1 scoring swapped from the (blocked, no-API-key)
  Anthropic path to a local Ollama `llama3.1:8b` backend, smoke-tested
  end-to-end (1 conversation / 5 QA pairs, full pipeline including answer
  generation): answers are coherent and grounded in retrieved context, not
  hallucinated.
- **Full subset run completed**: 4 conversations (`conv-26`, `conv-30`,
  `conv-41`, `conv-42`, first 8 QA pairs each — 32 QA pairs total), 31.3
  minutes wall-clock end-to-end (ingestion + retrieval + Ollama answer
  generation + F1 scoring), $0 cost. **Overall F1: 0.352.** Per category:
  cat 1 (multi-hop) 0.527/11, cat 2 (single-hop) 0.272/16, cat 3 (temporal)
  0.111/3, cat 4 (open-domain) 0.386/2 — no category-5 (adversarial) pairs
  landed in this particular subset (first-8-per-conversation didn't happen
  to include one; a larger `LUNA_LOCOMO_QA_LIMIT` would pick some up).
  Retrieval evidence coverage: 61.1% (33/54 annotated evidence dia_ids
  present in top-10 hits). See the PR body for the full write-up and
  what-to-survey notes.
- **Observed failure pattern worth flagging**: the model frequently answers
  temporal questions with a *relative* expression ("last month", "next
  month", "last Friday") instead of resolving it against the session date
  in the retrieved excerpt — this tanks category 2/3 scores under exact
  token-F1 even when the model clearly found the right memory. This is an
  `llama3.1:8b` reasoning/instruction-following limitation, not a
  retrieval miss — worth separating "found the right memory" (evidence
  coverage) from "extracted it correctly" (F1) when reading this number.
