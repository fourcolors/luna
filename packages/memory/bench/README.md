# Memory rerank bench

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
- Latency is ~1.2s p50 per query on real memories (longer than synthetic).
  Fine for the explicit `memory_search` tool; over the per-turn recall budget,
  so `LUNA_RECALL_RERANK` stays off by default.

`LUNA_RERANK_CE_MODEL_TAG` (default `qwen3-reranker-0.6b-q4km`) is folded into
the response cache key: the client cannot fingerprint the sidecar's GGUF, so
bump this tag whenever you change the model, or a cache populated by a
different model would silently serve stale scores.
