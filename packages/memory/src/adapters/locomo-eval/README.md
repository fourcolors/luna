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

- `types.ts` — LoCoMo dataset types (verified against the actual downloaded file), plus `RetrievalRecord` (shared between `run.ts` and `judge-rescore.ts` — see below).
- `dataset.ts` — fetch (cached, gitignored) + flatten into per-turn records.
- `ingest.ts` — turn → `MemoryRecord` → `MemoryRouter.put()` (same write path as `memory_save`).
- `scoring.ts` — F1 scoring per LoCoMo's category rules, independently implemented. Also exports `isAbstained` (category-5 abstention rule), reused by `judge-rescore.ts`.
- `answer-model.ts` — answer-generation backends: local **Ollama**
  `/api/chat` (`ollama`, default), **Ollama's hosted cloud API**
  (`ollama-cloud`, `https://ollama.com/api/chat`, Bearer-authenticated), and
  the Anthropic Messages API (`anthropic`, opt-in, see below). Cost tracking
  reuses `@luna/core`'s `rateFor`/`priceTurnUsd` — the same pricing table
  the chat-server itself uses; any `ollama*` rate is always $0 in this
  harness's accounting. Exports `callOllamaCloudChat`, the shared
  retry/hard-stop HTTP client both `answerFromContextOllamaCloud` and
  `judge-rescore.ts` build on.
- `run.ts` — CLI entrypoint wiring it all together (ingest + retrieve + answer + F1-score).
- `judge-rescore.ts` — LLM-judge binary-accuracy RE-SCORING pass over an
  EXISTING `run.ts` output (no re-ingestion/retrieval/answering — see
  "LLM-judge re-scoring" below). Run via `bun run --filter '@luna/memory' eval:locomo:judge-rescore` or directly with `bun`.

## LLM-judge re-scoring: a number comparable to vendor benchmarks

LoCoMo has two different scoring conventions in circulation: this harness's
own token-overlap **F1** (see "Scoring methodology" above — the paper's own
primary metric), and **LLM-judge binary accuracy** (a judge model looks at
the question, gold answer, and prediction, and scores 1/"correct" or
0/"incorrect") — which is what memory-product vendors report as their
headline LoCoMo numbers (Honcho, Hindsight, ByteRover — see the comparison
table in the PR body). **F1 and judge-accuracy are not the same metric and
are not directly comparable** — F1 punishes a correct-but-differently-
phrased answer (e.g. "7th of May, 2023" vs "7 May 2023" scores well under
F1 by coincidence of token overlap, but a genuinely paraphrased correct
answer can score near 0), so comparing our F1 number to a vendor's judge
number head-to-head would be misleading in both directions.

`judge-rescore.ts` re-scores an EXISTING `run.ts` results file
(`.out/results-<stamp>.json`) with an LLM judge, at zero re-ingestion/
re-retrieval/re-answering cost — it's purely a re-scoring pass over
predictions we already generated:

- **Judge prompt**: independently written (see `buildJudgePrompt`), based
  on the general, publicly-described "is the predicted answer the same as
  the gold answer" methodology. NOT copied from any vendor's (Honcho,
  Hindsight, ByteRover) proprietary judge prompt — those aren't published.
- **Category 5 (adversarial)** is graded by the SAME deterministic
  abstention rule the F1 pass uses (`isAbstained`), not an LLM call — there
  is no ground-truth `answer` for category 5, only a distractor
  `adversarial_answer`, so "same as the gold answer" doesn't apply. This
  keeps category 5 identical between the F1 pass and the judge pass by
  construction (a useful cross-check, not a limitation).
- **Judge model**: `gpt-oss:120b` by default (same model as the answer
  backend, for a same-backbone comparison; override via
  `LUNA_LOCOMO_JUDGE_MODEL`).
- **Concurrency**: ~8 in-flight judge calls by default
  (`LUNA_LOCOMO_JUDGE_CONCURRENCY`), each call using the SAME
  `callOllamaCloudChat` retry/hard-stop discipline as the answer step
  (429/5xx retried with backoff, hard-stop on auth/quota/persistent
  failure — see `answer-model.ts`). On top of that, 3 consecutive
  non-hard-stop failures halve the pool's concurrency (down to
  `LUNA_LOCOMO_JUDGE_MIN_CONCURRENCY`, default 1).
- **Retrieval-vs-judge crosstab**: cross-references each QA pair's
  retrieval evidence coverage (from the matching `.out/retrieval-<stamp>.json`)
  against judge correctness to build a 2x2 — evidence found/missing ×
  correct/incorrect — overall and per category. This is what separates a
  RETRIEVAL problem (right memory never surfaced) from a MODEL problem
  (right memory surfaced, extraction/reasoning still failed).
- **Sanity checks against the F1 pass**: per-category rank correlation
  (Spearman) between F1 and judge-accuracy, and mean F1 split by judge
  verdict — both should show the two metrics broadly agree even though the
  absolute numbers differ; a wild divergence would flag a scoring bug
  rather than an expected metric difference.

Run it: `OLLAMA_CLOUD_KEY=... bun packages/memory/src/adapters/locomo-eval/judge-rescore.ts`
(resolve `OLLAMA_CLOUD_KEY` the same way as the answer-generation step — see
"Answer backends" above; never paste it inline or commit it).

**Result on the 840-QA-pair run above**: see the PR body for the full
judge-accuracy number, the comparison table against Honcho/Hindsight/
ByteRover (with caveats), the retrieval-vs-judge failure-mode breakdown,
and the resulting recommendations (also tracked in `workspace.db`'s
`tasks` table).

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

## Answer backends: local Ollama, Ollama Cloud, or Anthropic

Three backends, selected via `LUNA_LOCOMO_ANSWER_BACKEND`:

- **`ollama-cloud` — the current default recommendation for a real run.**
  Ollama's HOSTED cloud API (`https://ollama.com/api/chat`, same
  request/response shape as local Ollama's `/api/chat`), authenticated via
  `Authorization: Bearer $OLLAMA_CLOUD_KEY` (a pre-provisioned API key,
  resolved from your own secret manager at run time; **never log, print, or
  commit this value** — only ever pass it as an in-memory env var). Model
  defaults to `gpt-oss:120b` (override via `LUNA_LOCOMO_CLOUD_MODEL` or
  `LUNA_LOCOMO_ANSWER_MODEL`). Dramatically faster than local CPU
  inference — see "Time budget" below — and gives access to a much larger,
  higher-quality open model than the 8B one that fits on this machine's
  CPU. 429/5xx responses and network errors are retried with short
  exponential backoff (`backoffDelayMs`, a handful of attempts); a HARD
  failure (bad auth, a quota/billing signal, or throttling that never
  clears) throws `LocomoHardStopError`, which `run.ts` catches specifically
  to stop the ENTIRE run immediately (not just the one QA pair) and write
  partial results — see `answer-model.ts`'s module docstring and
  `classifyOllamaCloudResponse` (unit-tested in `test/locomo-eval.test.ts`).
- **`ollama` (local, harness default when `LUNA_LOCOMO_ANSWER_BACKEND` is
  unset)** — `llama3.1:8b` via a local Ollama daemon's `/api/chat`,
  non-streaming. No API key, no per-token dollar cost, but CPU-only
  inference on the reference machine is roughly 14x slower per QA pair than
  `ollama-cloud`'s `gpt-oss:120b` (see "Time budget"). This was the ONLY
  backend available in the environment this harness was originally built in
  (no `ANTHROPIC_API_KEY`, no cloud key yet provisioned) — kept as the
  zero-dependency fallback.
- **`anthropic`** — the original Anthropic Messages API path, preserved
  behind `LUNA_LOCOMO_ANSWER_BACKEND=anthropic` for a possible future
  paid-model comparison run. Still blocked in this environment (no real
  `ANTHROPIC_API_KEY`, i.e. not the Claude Code OAuth/subscription
  credential).

Since LoCoMo scoring is pure F1 (see "Scoring methodology" above, no LLM
judge), swapping the answer backend only changes answer quality and
wall-clock time — never the marginal cost of scoring itself.

## Time budget, not dollar budget

With Ollama (local or cloud) the marginal cost per QA pair is $0 in this
harness's accounting (see "Cost tracking" above), so the old
`LUNA_LOCOMO_BUDGET_USD` dollar cap has been replaced with
**`LUNA_LOCOMO_MAX_MINUTES`** (default 55): `run.ts` times the answer-model
calls as they happen, projects total runtime from the observed average
seconds/QA-pair, and stops cleanly (writing all results collected so far)
if the projection would exceed the cap — instead of silently truncating
mid-run or blowing past an unbounded wall-clock budget. The projection is
NOT enforced until at least `TIME_CAP_WARMUP_QA` (5) real answer calls have
completed — before that there's only a rough per-backend fallback guess to
project from (60s/QA for local `ollama`, 10s/QA for `ollama-cloud`), and
multiplying a wrong guess across hundreds of remaining QA pairs on a large
subset run was previously stopping runs before the first real call even
finished (see `obs_note` ledger).

**Measured throughput, local `ollama` (default) on the reference machine**
(16 vCPU, 14 GiB RAM, no GPU — `llama3.1:8b`, Q4 quantization): ~60 seconds
per QA pair end-to-end (retrieval + answer generation), dominated by
CPU-only prompt evaluation of the ~10 retrieved excerpts (topK=10) that
make up each question's context. At that rate the full LoCoMo10 dataset
(1,986 QA pairs across all 10 conversations) would take **roughly 33
hours** — far outside any reasonable single-run budget on this hardware.
**What we ran with this backend**: a documented subset — the first 4
conversations in dataset order (`conv-26`, `conv-30`, `conv-41`,
`conv-42`; no cherry-picking), first 8 QA pairs of each
(`LUNA_LOCOMO_SAMPLE_LIMIT=4 LUNA_LOCOMO_QA_LIMIT=8`), 32 QA pairs total,
31.3 minutes wall-clock. **Overall F1: 0.352.** See the PR body for the
full per-category breakdown.

**Measured throughput, `ollama-cloud` (`gpt-oss:120b`, hosted)**: a
real-context sizing sample (16 QA pairs, 2 conversations, real retrieved
excerpts — not a trivial one-line prompt) measured ~4.2s/QA-pair, ~14x
faster than local CPU inference. Ingestion (embedding, unaffected by answer
backend) measured ~0.21s/turn. Projecting the full dataset (1,986 QA pairs,
5,882 turns total) from those rates: ~140 min answering + ~21 min ingestion
≈ **2.6 hours** — still meaningfully over a 90-minute target, so per the
same "largest well-justified, non-cherry-picked subset" discipline as the
local-Ollama run above, **what we actually ran**: ALL 10 conversations
ingested (`LUNA_LOCOMO_SAMPLE_LIMIT=10`, so retrieval evidence coverage is
computed over the FULL dataset's turns), first 84 QA pairs of each
conversation scored (`LUNA_LOCOMO_QA_LIMIT=84` — every conversation has
≥105 QA pairs, so this is a uniform, non-cherry-picked cap), **840 QA pairs
total (42.3% of the full 1,986)**, `LUNA_LOCOMO_MAX_MINUTES=85` as an
adaptive safety backstop. Actual result: **67.0 minutes wall-clock** (21.8
min ingestion + 43.2 min answering, avg 3.09s/QA-pair — faster than the
sizing sample), zero rate-limit/retry/hard-stop events across all 840
calls. **Overall F1: 0.488** — see the PR body for the full per-category
breakdown and the comparison against the local-`llama3.1:8b` number above.

If this harness is re-run again, `LUNA_LOCOMO_SAMPLE_LIMIT`/
`LUNA_LOCOMO_QA_LIMIT` can be raised or lowered per backend — nothing else
about the pipeline changes. The full 1,986-pair run is achievable within a
~2.5-3 hour single session on `ollama-cloud` if that window is ever
available; nothing in the harness prevents it, it just wasn't the
documented single-session target this time.

## Running

Ingestion + retrieval need only a local Ollama daemon (`LUNA_EMBEDDER=ollama`,
`LUNA_OLLAMA_BASE_URL`, `LUNA_OLLAMA_EMBED_MODEL` — same env vars
`bench/paraphrase-recall.ts` uses) regardless of answer backend. No cost for
this half either way.

```sh
# Retrieval-only smoke test — zero cost, validates ingestion + search wiring
LUNA_EMBEDDER=ollama LUNA_LOCOMO_SAMPLE_LIMIT=1 LUNA_LOCOMO_QA_LIMIT=5 \
  bun packages/memory/src/adapters/locomo-eval/run.ts --dry-run
```

Full run via **`ollama-cloud`** (recommended — see "Answer backends" above;
resolve `OLLAMA_CLOUD_KEY` from your own secret manager first, never paste
it inline or commit it, e.g. via Luna's `SecretProvider` conventions
(`op://<vault>/<item>/<field>`, `env:NAME`, etc. — see `DESIGN.md` §2.2.11):

```sh
OLLAMA_CLOUD_KEY="$(resolve-your-secret ollama-cloud-key)"   # your own retrieval command
LUNA_EMBEDDER=ollama LUNA_LOCOMO_ANSWER_BACKEND=ollama-cloud \
  LUNA_LOCOMO_SAMPLE_LIMIT=10 LUNA_LOCOMO_QA_LIMIT=84 LUNA_LOCOMO_MAX_MINUTES=85 \
  OLLAMA_CLOUD_KEY="$OLLAMA_CLOUD_KEY" \
  bun packages/memory/src/adapters/locomo-eval/run.ts
```

Full run via local Ollama instead (needs `llama3.1:8b` pulled: `curl -s
$LUNA_OLLAMA_BASE_URL/api/pull -d '{"name":"llama3.1:8b"}'`):

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
unbounded run. Exit code 6 means an `ollama-cloud` hard-stop instead (bad
auth / quota / persistent throttling — see "Answer backends" above).

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
- **`ollama-cloud` backend added** (`answer-model.ts`:
  `answerFromContextOllamaCloud`, `classifyOllamaCloudResponse`,
  `LocomoHardStopError`) — Ollama's hosted cloud API
  (`https://ollama.com/api/chat`), Bearer-authenticated via a
  1Password-provisioned key. Retries 429/5xx/network errors with backoff,
  hard-stops cleanly on auth/quota/persistent-throttle failures instead of
  burning through the rest of the dataset one failed retry-loop at a time.
  6 new unit tests cover the retry/hard-stop decision logic (17 total, all
  passing).
- **Full-dataset-scale run completed on `ollama-cloud` (`gpt-oss:120b`)**:
  all 10 conversations ingested (full-dataset retrieval evidence coverage),
  first 84 QA pairs per conversation scored (840 QA pairs total, 42.3% of
  the full 1,986 — see "Time budget" above for the exact sizing math and
  selection method), 67.0 minutes wall-clock, $0 cost (pre-provisioned
  key), zero rate-limit/retry/hard-stop events. **Overall F1: 0.488** —
  substantially higher than the local `llama3.1:8b` run's 0.352 on the same
  retrieval pipeline. Per category: cat 1 (multi-hop) 0.397/277, cat 2
  (single-hop) 0.585/319, cat 3 (temporal) 0.289/93, cat 4 (open-domain)
  0.569/148, cat 5 (adversarial) 0.667/3. Retrieval evidence coverage:
  63.4% (1019/1607 annotated evidence dia_ids present in top-10 hits,
  across the FULL 10-conversation dataset — a materially more representative
  number than the prior 4-conversation subset's 61.1%, since it now spans
  the whole dataset's retrieval difficulty distribution). See the PR body
  for the full write-up and what-to-survey notes.
- **Observed failure pattern worth flagging**: the model frequently answers
  temporal questions with a *relative* expression ("last month", "next
  month", "last Friday") instead of resolving it against the session date
  in the retrieved excerpt — this tanks category 2/3 scores under exact
  token-F1 even when the model clearly found the right memory. This is an
  `llama3.1:8b` reasoning/instruction-following limitation, not a
  retrieval miss — worth separating "found the right memory" (evidence
  coverage) from "extracted it correctly" (F1) when reading this number.
- **Judge-rescore of the 840-QA-pair run** (`judge-rescore.ts`, see that
  module's docstring): overall judge accuracy 52.6%. Category 1 (multi-hop,
  277/840, the largest category) has only 36.1% evidence-found rate and
  78.3% of its failures are retrieval misses, not model reasoning failures.
  Category 3 (temporal, 93/840) has 47.2% evidence-found and 63.6%
  retrieval-attributable failures, plus a real secondary reasoning
  weakness (wrong 47.6% of the time even when evidence IS found, above the
  31.4% baseline).
- **Category-1 diagnosis** (re-ran retrieval at topK up to 100 for
  category-1 QA pairs across two conversations, `conv-26` and `conv-42`,
  202 evidence dia_ids checked): the DOMINANT cause of category-1 misses is
  a result-COUNT budget problem, not an embedding-quality problem — 68% of
  the evidence missing from a top-10 result set was already present in the
  SAME ranked candidate list, just below rank 10 (recoverable by raising
  `LUNA_LOCOMO_TOPK`); the model/embedder found the right turns, `topK=10`
  just didn't have enough slots to hold them alongside noise from other
  sub-topics. Category-1 questions need 2-19 (median ~2-3) distinct
  evidence turns each, 96% of which span MULTIPLE sessions. The remaining
  32% of the gap never surfaced even at rank ≤100 — a real, smaller,
  genuinely-not-retrieved component. See `retrieval-modes.ts`'s module
  docstring for the three retrieval strategies this motivated
  (`LUNA_LOCOMO_RETRIEVAL_MODE=flat|decompose|hierarchical`) and the PR
  body for full before/after numbers.
- **Category-3 fix**: a deterministic (zero-LLM-call) per-session date
  index is now available via `LUNA_LOCOMO_DATE_INDEX=1` — injects an
  explicit "Session dates for reference" block into the answer prompt
  (see `answer-model.ts`'s `buildDateIndexBlock`) so the model can resolve
  relative-date language against real dates instead of guessing. Off by
  default (baseline prompt unchanged).
