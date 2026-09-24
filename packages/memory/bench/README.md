# Memory rerank bench

## Choosing the rerank engine (production)

`LUNA_RERANK_ENGINE` selects the MemoryReranker Luna's server binds (Moon's Models settings tab, Memory Reranker, sets it at the next server start and wins over the environment once chosen):

- `cross-encoder` (default): the local Qwen3-Reranker sidecar below. Reranking stays opt-in per lane (`LUNA_MEMORY_RERANK=1` for the `memory_search` tool, `LUNA_RECALL_RERANK=1` for per-turn recall), 8 candidates for `memory_search`.
- `jev`: TypeSafe Jev (`packages/adapter-sdk/src/jev-reranker.ts`), the best judge measured (LongMemEval S held-out, evidence in the top 5 at depth 40: 85.5% vs 76.2% for the cross-encoder and 44.0% with no judge; results in `results/2026-09-23-search-tuning/`). Needs your own `TYPESAFE_API_KEY` in the environment or Luna's vault (never commit it). Every rerank sends the query and the candidate memories' text (each capped at 2,000 characters) to `api.typesafe.ai`. Configuring it is the opt-in: both lanes rerank unless their flag is `0`, at depth 40 (`LUNA_RERANK_MAX_CANDIDATES` overrides), pinned to `jev-1.13.0` (`LUNA_JEV_MODEL` overrides).

`LUNA_RERANK_THRESHOLD` (0-100) overrides the engine's injection threshold for both lanes.

(For the hot-tier bulletin eval - the cross-thread digest probes - see
[BULLETIN.md](./BULLETIN.md) and `bench:bulletin`. This file covers the
cold-tier reranking work.)

## Local cross-encoder

Start the verified Qwen3-Reranker-0.6B llama-server sidecar from the repository
root, then run the bench with the cross-encoder engine selected:

```sh
.scratch/ce-server.sh
LUNA_RERANK_ENGINE=cross-encoder bun packages/memory/bench/rerank-eval.ts
```

The sidecar defaults to `http://127.0.0.1:8181`. Override the client endpoint
with `LUNA_RERANK_CE_URL` and its per-call scoring ceiling with
`LUNA_RERANK_CE_TIMEOUT_MS`. `LUNA_RERANK_CE_MAX_INPUT_CHARS` controls the
whole-candidate request splitting budget. Its 48,000-character default assumes
four characters per token and leaves context headroom when used with the
sidecar script's 16,384-token context. `LUNA_RERANK_CE_PROBE_TIMEOUT_MS`
(default 30,000) is the floor for the one-time calibration probe, kept
separate from the per-call scoring ceiling because an ~860-token probe
document on a CPU-only sidecar can take several seconds. `LUNA_RERANK_CE_CONCURRENCY`
(default 1) and `LUNA_RERANK_CE_MODEL_TAG` are described below. `LUNA_RERANK_MAX_CANDIDATES` (default 8) caps how many retrieved candidates memory_search sends to the reranker, since latency is ~linear in candidate count (~0.6s each on the GPU sidecar); 8 covers the real-data retrieval ranks with ~5s latency, 5 gives ~3s.

### The physical batch size is load-bearing (read before deploying)

In rerank/embedding mode llama-server clamps the physical batch to `n_ubatch`
and, if `n_batch > n_ubatch`, forces BOTH to 512 to avoid an assertion. A
single `(query + document)` pair over ~512 tokens then returns HTTP 500
("input too large to process"). Real memories are frequently 2,000+ chars, so
a default-batch sidecar 500s on every long memory and the client silently
falls back to un-reranked order - the feature looks healthy but does almost
nothing. `ce-server.sh` therefore starts with `--batch-size 4096 --ubatch-size
4096` (equal and large), admitting single pairs up to ~4,096 tokens. **Any
production sidecar MUST carry the same sizing.** As a backstop the calibration
probe now scores an ~860-token document, so a misconfigured sidecar fails loudly
at startup instead of degrading in production.

## What the baseline shows (ce-rerank-baseline-2026-07-16.json)

Cross-encoder reranking versus raw hybrid retrieval on the 200-record /
230-query corpus, and the honest comparison to the Phase 3 generative Haiku
scorer it replaces:

- Beats hybrid on every slice: OVERALL recall@1 0.734 -> 0.794, recall@5
  0.868 -> 0.928, nDCG@10 0.826 -> 0.879; vocab-mismatch recall@1
  0.483 -> 0.583.
- Below the Haiku scorer on this SYNTHETIC vocab-mismatch slice (Haiku 0.767
  vs cross-encoder 0.583). Haiku was never enable-able (nondeterministic +
  ~20-30s/call). On REAL data (below) the recall gap is much smaller, so the
  spec's optional Haiku top-k tiebreaker is deferred as likely-unnecessary -
  it would only reintroduce the nondeterminism the cross-encoder eliminated.
- Determinism: bit-exact (4600/4600) across two SEQUENTIAL passes. This proves
  same-order/same-state reproducibility; a `--parallel > 1` sidecar under
  concurrent load can still drift +/-1 point from matmul-reduction reordering,
  which is why `ce-server.sh` defaults `--parallel 1` (set `CE_PARALLEL` to
  trade determinism for throughput) and the bench defaults
  `LUNA_RERANK_CE_CONCURRENCY=1`.
- Latency on this SHORT-RECORD synthetic corpus is ~500ms p50. Real memories
  are longer; see the real-data section for the honest number.

## Real-data calibration (Phase 5, on a copy of the stable memory DB)

Measured against a snapshot of the real store (isolation rule: copy, never the
live DB), with the batch size correctly configured:

- The injection gate performs BETTER on real memories than the synthetic
  holdout predicted. On a labeled set (15 queries whose answer is verified
  present, 12 whose topic is verified absent), real answers score a median of
  100 and real junk scores a median of 0 (max 2). A threshold anywhere from
  ~30-50 keeps 93-100% of correct memories and rejects 100% of junk. The
  synthetic "rejects only 72.5%" figure was a genuine synthetic measurement,
  not a batch artifact: its negative queries were adversarially constructed to
  be topically plausible, whereas real queries about genuinely-absent topics
  score near 0, so the gate separates them cleanly. (The 512-token batch bug
  affected the real-data DETERMINISM run, not the synthetic gate baseline,
  whose committed artifact correctly shows zero fallbacks.)
- Determinism holds on real long memories: 0/15 fallbacks, 0/15 kept-set churn,
  bit-exact.
- Latency is hardware-bound and ~LINEAR in candidate count. On an Apple
  Metal GPU it was ~1.2s for 20 candidates; on the production box (luna-server,
  AMD Radeon Pro Vega 20 via Vulkan) it is ~0.6s PER CANDIDATE (CPU-only was
  15-26s and contends with the chat-server, so GPU is required). This is why
  `memory_search` reranks only `LUNA_RERANK_MAX_CANDIDATES` (default 8 -> ~5s
  for this engine) rather than the full pool, and why `LUNA_RECALL_RERANK`
  (per-turn) stays off by default for this engine - with the cross-encoder,
  reranking is for the explicit `memory_search` tool. (`LUNA_RERANK_ENGINE=jev`
  is ~0.2 s at depth 40 and reranks both; see the top of this file.)

### Cap sweep (LUNA_BENCH_CAP_SWEEP=1)

The committed, reproducible artifact behind the cap default. Post-hoc recall
over the 190 positive synthetic queries when only the top-`cap` retrieved
candidates are reranked (no extra model calls):

| cap | ~latency | recall@1 | recall@5 |
|---:|---:|---:|---:|
|   3 | ~1.8s | 0.755 | 0.818 |
|   5 | ~3.0s | 0.762 | 0.868 |
|   8 | ~4.8s | 0.768 | 0.907 |
|  12 | ~7.2s | 0.778 | 0.918 |
|  20 | ~12.0s | 0.789 | 0.928 |

Recall is modelled the way production returns results: only the top-`cap`
reranked candidates are returnable, so a below-K cap cannot exceed recall@cap
(cap=3's recall@5 = its recall@3 = 0.818). On this adversarial synthetic set
the cap is a real tradeoff: cap=8 costs ~2 points recall@1 and ~2 points
recall@5 versus the full 20-pool for a ~2.5x speedup; cap=5 costs another ~4
points recall@5. On a real-DB-copy sample (personal data, not committed) every
labeled target sat within retrieval rank 6, so cap=8 lost nothing there.
Default 8; raise it if you observe misses, lower it for speed.

`LUNA_RERANK_CE_MODEL_TAG` (default `qwen3-reranker-0.6b-q4km`) is folded into
the response cache key: the client cannot fingerprint the sidecar's GGUF, so
bump this tag whenever you change the model, or a cache populated by a
different model would silently serve stale scores.

## Query-expansion keywords (expand-queries.ts)

`expand-queries.ts` generates cached QUERY-EXPANSION keywords, simulating a
calling agent that writes search-expansion terms before hitting memory
search. The model sees ONLY the query text - never a memory record, never
the gold `relevantIds`/answer - so the keywords it produces are exactly what
a real caller could produce, no more.

For each query it asks for up to 8 short keywords/phrases (each at most 6
words: synonyms, related entities, alternate phrasings, terms a relevant
memory might contain) that do not just restate the query's own words. Each
requested sample is its own independent LLM request/batch, never "give me 3
variants in one response", so repeated samples are genuine independent
draws rather than one call's imagined diversity.

```sh
bun packages/memory/bench/expand-queries.ts --source memory-suite --model haiku
bun packages/memory/bench/expand-queries.ts --source longmemeval --model sonnet --limit 260
```

Flags: `--source` (`memory-suite` or `longmemeval`, required), `--model`
(default `haiku`), `--samples` (default 3, independent draws per query),
`--limit` (first N queries; default 260 for `longmemeval`, all queries for
`memory-suite`), `--concurrency` (default 2), `--batch` (queries per LLM
call, default 10), `--force` (discard an incompatible existing sidecar),
`--out` (override the sidecar path).

`memory-suite` reads `queries[]` (`id`, `text`) from
`memory-suite-corpus.json`. `longmemeval` reads the first N questions of the
LongMemEval oracle split via `selectSubset(instances, limit, 42)` from
`../src/adapters/longmemeval-eval/dataset.ts`, using `question_id` as id and
`question` as text.

Sidecar output: `packages/memory/bench/expansion/<source>-<model>.json`,
shape:

```json
{
  "source": "memory-suite",
  "model": "haiku",
  "promptHash": "13d871f5127cea5c",
  "generatedAt": "2026-09-23T00:00:00.000Z",
  "samples": 3,
  "keywords": { "<queryId>": [["kw", "kw"], ["kw"], ["kw", "kw", "kw"]] }
}
```

`keywords[id][sampleIndex]` is that sample's keyword list.
`promptHash` is the first 16 hex characters of the sha256 of the exact
prompt template text.
If an existing sidecar's `promptHash` or `model` does not match the current
run, the script refuses (exit 3) rather than mixing stale samples with a
changed prompt - pass `--force` to discard it and start fresh.

Idempotent and resumable: a `(query id, sample index)` slot already present
in the sidecar is skipped. Samples are filled in index order per query
(sample `i` is only attempted once sample `i - 1` is filled), so
`keywords[id]` on disk is always a dense array, never holey, even when
batches complete out of order under concurrency. A query id missing or
malformed in a model response is left absent from that slot (never stored
as `[]`) so the next run retries it. The sidecar is flushed atomically to
disk after every completed batch.

Exit codes: `0` every requested slot filled, `1` some batches failed or
some ids were missing after the retry-once guard, `3` bad config/input.
