# Memory rerank bench

## Local cross-encoder

Start the verified Qwen3-Reranker-0.6B llama-server sidecar from the repository
root, then run the bench with the cross-encoder engine selected:

```sh
.scratch/ce-server.sh
LUNA_RERANK_ENGINE=cross-encoder bun packages/memory/bench/rerank-eval.ts
```

The sidecar defaults to `http://127.0.0.1:8181`. Override the client endpoint
with `LUNA_RERANK_CE_URL` and its fail-fast ceiling with
`LUNA_RERANK_CE_TIMEOUT_MS`. `LUNA_RERANK_CE_MAX_INPUT_CHARS` controls the
whole-candidate request splitting budget. Its 48,000-character default assumes
four characters per token and leaves context headroom when used with the
sidecar script's 16,384-token context. `LUNA_RERANK_CE_CONCURRENCY` (default 1)
and `LUNA_RERANK_CE_MODEL_TAG` are described below.

## What the baseline shows (ce-rerank-baseline-2026-07-16.json)

Cross-encoder reranking versus raw hybrid retrieval on the 200-record /
230-query corpus, and the honest comparison to the Phase 3 generative Haiku
scorer it replaces:

- Beats hybrid on every slice: OVERALL recall@1 0.734 -> 0.794, recall@5
  0.868 -> 0.928, nDCG@10 0.826 -> 0.879; vocab-mismatch recall@1
  0.483 -> 0.583.
- Below the Haiku scorer (which was never enable-able: nondeterministic +
  ~20-30s/call). Haiku hit OVERALL recall@1 0.878 and vocab-mismatch 0.767;
  the cross-encoder trades that raw-recall headroom for determinism and speed.
  Spec verification bar 2 ("within a few points of Haiku on vocab-mismatch")
  is therefore NOT met on vocab-mismatch; recovering it is the Phase 5
  optional-Haiku-tiebreaker lever.
- Determinism: bit-exact (4600/4600) across two SEQUENTIAL passes. This proves
  same-order/same-state reproducibility; a `--parallel > 1` sidecar under
  concurrent load can still drift +/-1 point from matmul-reduction reordering,
  which is why `ce-server.sh` defaults `--parallel 1` (set `CE_PARALLEL` to
  trade determinism for throughput) and the bench defaults
  `LUNA_RERANK_CE_CONCURRENCY=1`.
- Latency: ~500ms p50 per query on this corpus (right at the target, not
  comfortably under; run-to-run p50 sits ~485-505ms), versus Haiku's
  ~20-30s. Fast enough to make per-turn recall reranking viable.
- Injection gate: score separation is real (positive top-1 clusters near 100,
  negatives near 0) but NOT a clean win - the best 95%-keep threshold rejects
  only ~72.5% of negatives on a 2-fold holdout, below Haiku's ~97.5%, and the
  synthetic-corpus threshold does not transfer to real memories (which cluster
  on-topic). Gate calibration on real data is a Phase 5 item, not a shipped
  claim.

`LUNA_RERANK_CE_MODEL_TAG` (default `qwen3-reranker-0.6b-q4km`) is folded into
the response cache key: the client cannot fingerprint the sidecar's GGUF, so
bump this tag whenever you change the model, or a cache populated by a
different model would silently serve stale scores.
