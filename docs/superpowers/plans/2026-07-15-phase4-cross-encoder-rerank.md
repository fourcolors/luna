# Phase 4: Cross-Encoder Reranker (deterministic, local, sub-second)

Status: DESIGN APPROVED-PENDING (build gated on PR #333 merge).
Author: session design; implementation delegated to Codex; verification by the session + panel.

## Why

Phase 3 (PR #333) shipped the `MemoryReranker` service dark with a generative
Haiku scorer. The adversarial panel confirmed two enable-blockers:

1. Nondeterminism: rerank scores swing 15-35 points run-to-run; kept-set
   changed on 4/10 identical queries; 2-7% of candidate scores sit in the
   fragile 70-79 band right under the 75 gate.
2. Latency: ~17-21s fixed SDK-session floor + ~9s for 20 candidates.

Cross-encoders solve both by construction: single forward pass per
(query, candidate) pair, no sampling, ~5-70ms for 20 candidates locally.
QMD (tobi/qmd, OpenClaw's memory backend) validates the shape in production
with qwen3-reranker-0.6b.

## Decisions (settled, do not relitigate in implementation)

- D1. The impl is an HTTP client behind the EXISTING `MemoryReranker` Tag.
  No new Tag, no changes to `applyRerank`, call sites, flags, or fallback
  contract. Phase 3's seam was designed for exactly this swap.
- D2. Server: llama-server (llama.cpp) sidecar exposing `/v1/rerank`,
  launched with `--reranking --pooling rank` and a Qwen3-Reranker-0.6B GGUF.
  Rationale: no native deps in the repo, OpenAI-compatible shape, ollama's
  reranker support is not yet shipped (ollama/ollama#16076).
- D3. Score mapping: `/v1/rerank` returns float relevance scores. Normalize
  to 0-100 by `Math.round(sigmoidOrIdentity * 100)` - see calibration below;
  `applyRerank` and the threshold env stay unchanged (integer 0-100 domain).
- D4. Threshold: recalibrated from data, NOT assumed 75. The bench harness
  computes the in-sample + 2-fold holdout threshold from the cross-encoder's
  score distribution; the fragile-band population around the chosen
  threshold must be reported.
- D5. Rank-band blending (QMD style) is OUT of scope until the bench shows
  pure cross-encoder scores lose to blended scores. Measure first.
- D6. Production/deploy wiring (systemd unit for the sidecar on luna-server) is
  Phase 5. Phase 4 ends at: works locally, bench-proven, variance-proven,
  real-DB-validated on a COPY.

## Deliverables

### 1. `CrossEncoderReranker` layer (packages/adapter-sdk or a new thin package)

`packages/adapter-sdk/src/cross-encoder-reranker.ts` (adapter-sdk already
holds the other MemoryReranker impl; an HTTP client has no SDK dependency
but keeping both impls side by side beats a new package for one file):

- `CrossEncoderRerankerLayer(opts?)`: `Layer<MemoryReranker, never, never>`.
  Config via opts/env:
  - `LUNA_RERANK_CE_URL` (default `http://127.0.0.1:8181`) - llama-server base.
  - `LUNA_RERANK_CE_TIMEOUT_MS` (default 2000; the whole point is speed -
    fail fast and let callers degrade).
- `rerank(args)`: POST `{model, query, documents: [texts], top_n: all}` to
  `/v1/rerank`; map results back by index to candidate ids; normalize scores
  per D3. Whole-call failures (connect refused, timeout, malformed body) =
  `RerankError` with the existing op vocabulary ("acquire" for connect,
  "timeout", "parse", "empty"). NEVER throw raw - the Phase 3 fallback
  contract depends on typed failures (plus call sites are sandboxed).
- Determinism note in code: same inputs must yield identical scores; no
  sampling parameters exist on this endpoint.

### 2. Startup calibration probe (the broken-GGUF trap)

Many community Qwen3-Reranker GGUFs are broken (missing cls.output.weight;
all scores ~e-23). A silent broken model would gate out EVERYTHING.
- Export `probeCrossEncoder(url): Effect<ProbeResult, RerankError>`: scores
  a fixed known pair - relevant ("what port does the server use" vs "the
  server listens on port 4753") and irrelevant (same query vs "bananas are
  yellow") - and asserts relevant > irrelevant AND relevant normalized
  score > 50. Returns the two raw scores (they double as the normalization
  sanity check for D3).
- The layer runs the probe lazily on FIRST rerank call (not at boot - the
  sidecar may start later); a failed probe fails that call with a clear
  RerankError message naming the broken-GGUF possibility, and retries the
  probe on the next call (the sidecar may have been fixed/restarted).

### 3. Bench integration

- `packages/memory/bench/rerank-eval.ts`: `LUNA_RERANK_ENGINE=cross-encoder`
  routes scoring through the HTTP client instead of the claude CLI (reuse
  the layer, not a reimplementation). All existing tables work unchanged.
- New determinism check in the bench when engine=cross-encoder: run the
  full scoring pass TWICE and assert byte-identical scores; print
  "determinism: PASS (N/N identical)" or fail loudly. This is the
  enable-blocker's regression test.
- Threshold recalibration output per D4 including fragile-band counts
  (scores within +/-5 of the chosen threshold).

### 4. Dev ergonomics

- `.scratch/ce-server.sh` (gitignored dir, leave in place): downloads a
  KNOWN-GOOD Qwen3-Reranker-0.6B GGUF (document the exact HF repo/file that
  passes the probe - verify at implementation time, prefer an official or
  verified-working conversion), starts
  `llama-server --reranking --pooling rank -m <gguf> --port 8181`.
  Idempotent; skips download if present.
- README note in packages/memory/bench/ on running the CE bench.

### 5. Verification (the session checks all of this independently)

1. Unit: layer maps scores/ids correctly (fake HTTP server), typed errors on
   refused/timeout/malformed, probe logic (good pair, broken-model pair).
   No em dashes. Root typecheck + all package tests green.
2. Bench corpus run (engine=cross-encoder, ollama nomic embedder):
   quality within a few points of the Haiku columns on vocab-mismatch and
   OVERALL recall@5 (report side by side); determinism check passes.
3. Real-DB validation (COPY only, session runs this part): same 10 + 5
   adversarial queries as Phase 3; variance A/B must show ZERO kept-set
   churn; latency p50 target < 500ms per 20-candidate rerank.
4. The Haiku impl remains available (env-selected); nothing about Phase 3
   behavior changes when the CE layer isn't wired.

## Env summary (all additive)

| Var | Default | Meaning |
|---|---|---|
| LUNA_RERANK_ENGINE | (unset = haiku impl) | "cross-encoder" selects the CE layer in chat-server + bench |
| LUNA_RERANK_CE_URL | http://127.0.0.1:8181 | llama-server base URL |
| LUNA_RERANK_CE_TIMEOUT_MS | 2000 | per-call ceiling; fail fast, degrade |

Existing LUNA_MEMORY_RERANK / LUNA_RECALL_RERANK / LUNA_RERANK_THRESHOLD
keep their exact semantics. Enabling the flags in any deployment remains
gated on this phase's verification PLUS Mr. Cobb's explicit call.
