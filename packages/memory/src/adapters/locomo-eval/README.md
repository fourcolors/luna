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
- `answer-model.ts` — Anthropic Messages API call + cost tracking (reuses `@luna/core`'s `rateFor`/`priceTurnUsd`, the same pricing table the chat-server itself uses).
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

## Running

Ingestion + retrieval need only a local Ollama daemon (`LUNA_EMBEDDER=ollama`,
`LUNA_OLLAMA_BASE_URL`, `LUNA_OLLAMA_EMBED_MODEL` — same env vars
`bench/paraphrase-recall.ts` uses). No API spend for this half.

```sh
# Retrieval-only smoke test — zero API cost, validates ingestion + search wiring
LUNA_EMBEDDER=ollama LUNA_LOCOMO_SAMPLE_LIMIT=1 LUNA_LOCOMO_QA_LIMIT=5 \
  bun packages/memory/src/adapters/locomo-eval/run.ts --dry-run
```

Full run (answer generation + scoring) additionally needs:

- `ANTHROPIC_API_KEY` — a real Anthropic API key (not the Claude Code
  OAuth/subscription credential — the raw Messages API needs its own key).
- `LUNA_LOCOMO_ANSWER_MODEL` — the EXACT, dated Anthropic model id (the
  raw API doesn't understand "haiku"/"sonnet" tier aliases the way the
  Claude Agent SDK does). Check
  https://docs.anthropic.com/en/docs/about-claude/models for the current
  cheapest capable id before running — we deliberately don't hardcode a
  guess here since a wrong dated id fails loudly (400) rather than
  silently mispricing.

```sh
ANTHROPIC_API_KEY=sk-ant-... LUNA_LOCOMO_ANSWER_MODEL=<current-haiku-id> \
  LUNA_EMBEDDER=ollama LUNA_LOCOMO_SAMPLE_LIMIT=1 LUNA_LOCOMO_QA_LIMIT=5 \
  bun packages/memory/src/adapters/locomo-eval/run.ts
```

`LUNA_LOCOMO_BUDGET_USD` (default 50) is a hard stop: the loop checks
projected spend before every answer-model call and aborts (exit code 5)
rather than risk exceeding the cap.

## Status (see obs_note ledger for the authoritative timeline)

- Dataset acquired, license verified and documented (CC BY-NC 4.0 — see
  above).
- Ingestion + hybrid retrieval validated end-to-end on a live Ollama
  embedder against 1 conversation / 5 QA pairs (`--dry-run`): 419 turns
  ingested, retrieval evidence coverage computed successfully. Zero API
  spend.
- Answer-generation + F1 scoring is implemented but **not yet
  smoke-tested against a real model** — this harness was built in a
  session with no interactive operator client connected, so the
  `request_secret` flow for `ANTHROPIC_API_KEY` couldn't complete. Needs
  an operator to supply that key (and confirm the current Haiku-tier
  model id) before Phase A's tiny paid smoke test and Phase B's full run
  can proceed.
