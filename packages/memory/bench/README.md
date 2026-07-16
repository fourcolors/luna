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
sidecar script's 16,384-token context.
