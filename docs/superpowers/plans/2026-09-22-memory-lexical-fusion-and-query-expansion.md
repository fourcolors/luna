# Memory search: weighted lexical fusion and query expansion

Status: plan, 2026-09-22, revised after an adversarial critic review (same day).
Tracks #702.
Stacked on #703 (LongMemEval S-split harness).

## Problem

Production `memory_search` and per-turn recall call `mode: "hybrid"`.
Its BM25 arm sends the whole question to FTS5 as ONE quoted phrase (`sqlite-vector.ts` `rankByBm25(..., "phrase")`), which never matches a natural question.
So production is vector-only: identical to `vec` on all 60 LongMemEval S questions and on the synthetic memory-suite.
The existing alternative, `hybrid-terms`, ORs every query word and fuses with equal-weight RRF (k=60).
It retrieves more evidence on LongMemEval S (75.0% vs 64.4%, 13 vs 2 questions, p = 0.007) but halves vocab-mismatch recall on memory-suite (recall@10 0.85 -> 0.42), because a noisy lexical rank-1 gets the same vote as a strong vector rank-1.

## Decisions already made

- Stay on SQLite (`memory.db`, FTS5 + vectorlite); push work into SQL (owner decision, 2026-09-22).
  FTS5 ships real BM25 and the index already uses the `porter unicode61` tokenizer; Postgres `ts_rank` is not BM25.
- Experiments never touch the live memory store; real-data checks run on a COPY, before merge, because merge auto-deploys (owner decision, 2026-07-14).
- LLM-generated eval inputs are sampled N times and reported with spread, never a single cached draw (2026-07-15 methodology lesson).

## Research basis

- Weighted RRF (`score = sum w_i / (k + rank_i)`) is the standard way to de-emphasize a noisy arm without score normalization (Elastic weighted RRF, OpenSearch hybrid weights, ParadeDB).
- Convex combination of normalized scores beats RRF once a small labeled set exists (Bruch, Gai, Ingber, TOIS 2023, arXiv:2210.11934); not used here, see B4.
- FTS5 has no stopword support; the de facto query-side list is Lucene's 33-word English set; question words are kept (they can be content in short records).
- LongMemEval (Wu et al., ICLR 2025): expanding the indexed KEY with extracted facts, merged with the original value, gains Recall@5 +3.7 to +10.7%; replacing the value with the condensed form hurts.
- doc2query / docTTTTTquery: write-time expansion lifts BM25 MRR@10 0.186 -> 0.272 at zero query-time cost.
- Query-time LLM rewriting (HyDE, Query2doc, multi-query) works but is the dominant latency cost in production RAG and drifts on small, idiosyncratic corpora.
- Luna's own July result: write-time enrichment into FTS5 raised BM25 vocab-mismatch recall@5 0.133 -> 0.383, but was put on HOLD because equal-weight `hybrid-terms` fusion did not beat `hybrid`; weighted fusion is the untested piece.

## Design

### A. Lexical arm (SQL-side, deterministic)

1. Term extraction: NFKC-normalized, lower-cased runs of letters, marks and digits (`\p{L}\p{M}\p{N}`), matching FTS5 `unicode61`; fixes today's silent drop of non-ASCII words in `terms` mode.
   Note: `unicode61` treats a CJK run as one token, so CJK lexical matching stays weak without a trigram index (out of scope).
2. Stopwords are removed on the raw lower-cased word, before quoting and before FTS5's porter stemming (porter maps "was" to "wa").
   Sets swept: `lucene` (33 words), `extended` (Lucene + pronouns/auxiliaries), `question` (extended + what/when/where/who/why/how/which); whether question words should stay is measured, not assumed.
3. The remaining terms are OR'd, every token quoted (FTS5 syntax in user text is inert), capped at 32 terms.
4. If no content term survives, the lexical arm abstains (vector-only), never floods.

### B. Fusion

1. Weighted RRF: `score = 1 / (60 + rank_vec) + w_lex / (60 + rank_lex) + w_exp / (60 + rank_exp)`.
2. RRF at k = 60 is flat: a lexical-only document (vector rank > 50) reaches the top 10 only if `w_lex` > ~0.87, and the top 5 only if > ~0.94.
   So the sweep covers `w_lex` in {0.1, 0.25, 0.5, 0.75, 1.0}, and a diagnostic first measures where `hybrid-terms`' extra LongMemEval evidence sits in the vector ranking (inside the vector top 50 = reorderable by weighting; outside = only reachable at weight ~1).
3. Stopwords at `w_lex` = 1 are measured on their own: vocab-mismatch queries share no content words with their target, so function-word matches may explain the whole regression.
4. Convex score combination is dropped: FTS5 `bm25()` scores are unbounded and min-max scaling breaks when one document matches.

### C. Query expansion

1. Search accepts `expansionTerms`; ONLY `hybrid-weighted` uses them, as their own lexical arm with weight `w_exp` below the query arm.
   FTS5 has no per-term boost and sums repeated terms (`"x" OR "x" OR "x"` scores 3x), so merging keywords into the query's OR would let them take over.
   Keywords are de-duplicated against the query's own terms (lower-cased, after stopwords), capped at 8 phrases of at most 6 words, and never embedded.
   `vec`, `hybrid`, `bm25` and `hybrid-terms` ignore them, so `hybrid` (production) is byte-identical.
2. In production the calling agent would write the keywords at zero added latency (it is already an LLM composing the query); that tool wiring is the rollout PR, not this one.
3. Write-time expansion (`memory_save` keywords into the FTS5 `enrichment` column) stays on HOLD: the column is weighted equal to `text` today, existing records have no keywords (no backfill), and the July hold's causes are unresolved.
   It needs a lower enrichment column weight and a real-data result first.

### D. Plumbing

1. One exported `MemorySearchMode` (@luna/core) replaces the five hand-copied mode lists (backend, router, SQLite backend, observability type and its runtime Schema); one `MemorySearchArgs` replaces three copies of the search argument type.
2. New mode `"hybrid-weighted"`; its knobs are one typed config with bench-chosen defaults, overridable per call for sweeps.
3. The contract test backend rejects `hybrid-weighted` loudly (it already rejects `hybrid-terms`).
4. NO production caller changes in this PR: `memory_search` and per-turn recall keep `mode: "hybrid"`, and the tool schema is unchanged.

## Evaluation

| bench | role | metric |
|---|---|---|
| memory-suite (230 queries, synthetic) | tuning + regression guard | recall@5 per slice, per-query win/loss vs `hybrid` |
| LongMemEval S, questions 1-60 | tuning | evidence recall@5 (production uses top 5), recall@10 secondary |
| LongMemEval S, questions 61-260 | held-out confirmation, run ONCE on the locked config | evidence recall@5, paired sign test vs `hybrid`, stratified by question type |

- Both harnesses gain multi-config retrieval: ingest once, search every config.
- Expansion keywords for eval queries are generated from the question text only, by Haiku and by Sonnet (production-class) through the `claude` CLI, 3 samples each, cached by a hash of the prompt; "no keywords" is always a reported baseline.
  On memory-suite vocab-mismatch, one LLM expanding queries another LLM wrote to avoid the record's words is close to a round trip, so those gains are labelled optimistic.
- Embedder `nomic-embed-text` for comparability with every earlier baseline.

### Ship rule (fixed before any run)

The config is chosen on the tuning sets, written into this file with its parameters, and only then run on the held-out set.
It becomes the recommended default only if:
1. held-out LongMemEval S evidence recall@5 beats `hybrid` with a paired sign test p < 0.05;
2. on memory-suite, for every slice, per-query losses vs `hybrid` do not exceed wins by more than 2 queries;
3. on memory-suite, the gap between positive and negative queries' top scores (the bench's existing `negativeSeparation`, relative to each mode's own scale) does not shrink vs `hybrid`, so a future injection floor stays possible;
4. memory-suite p95 latency stays within 20 ms of `hybrid` (a sanity check only; the real latency check is on a stable-DB copy in the rollout PR).
Expansion ships on top only if it adds a further held-out improvement under rule 1 across both keyword models.

## Tuning results and locked config (recorded 2026-09-23, BEFORE any held-out run)

Tuning sets: LongMemEval S questions 1-60 (54 answerable, 104 evidence turns) and memory-suite (230 queries), recall@5.

| config | LongMemEval evidence@5 (vs hybrid) | memory-suite vocab-mismatch r@5 (W/L vs hybrid) |
|---|---:|---:|
| `hybrid` (production) | 49/104 | 0.683 |
| `hybrid-terms` | 62/104 (15/3, p = 0.008) | 0.333 (6/27) |
| `bm25` | 65/104 (19/3, p = 0.001) | 0.117 (2/36) |
| weighted, query words only, w 0.1 to 1, any stopword set | 52 to 62 | 0.217 to 0.633, always net losses |
| weighted, query words must match 2+ terms (m = 2) | 50 to 56 | 0.567 to 0.600, always net losses |
| **vector + agent keywords only (w = 0, e = 0.5), Sonnet, 3 samples** | **47 to 50 (neutral)** | **0.761 (14/0 summed)** |

Findings:
1. The two benches disagree about matching the question's OWN words: LongMemEval questions share words with their evidence (the user's own turns), so lexical matching helps; memory-suite vocab-mismatch queries are casual questions about technically worded memories (the Luna pattern: agent-written facts, user-worded questions), and any query-word lexical arm promotes wrong records, at every weight tried, with or without stopwords (stopwords did not fix it, refuting the function-word hypothesis) and with a 2-term minimum match.
2. RRF at k = 60 is flat enough that even weight 0.25 lets a lexical rank-1 overtake the vector rank-1 from vector rank ~6.
3. Agent keywords used as their own lexical arm, with the question's words kept out of lexical matching, are the only variant that never hurts: +7.8 points vocab-mismatch recall@5 on memory-suite, neutral on LongMemEval.

Deviation from the pre-registered ship rule, stated openly: no config can meet rule 1 (a significant LongMemEval gain) without failing rule 2 (memory-suite), so no config becomes the default for per-turn recall.
The locked candidate makes a narrower claim, tested as follows.

LOCKED CONFIG: `hybrid-weighted:w=0:e=0.5:s=lucene` with agent keywords (`memory_search` only; with no keywords it is identical to production `hybrid`).

Held-out test, run once:
1. Safety: LongMemEval S questions 61-260 (fresh), evidence@5 vs `hybrid`, for each of 3 Sonnet and 3 Haiku keyword samples: it must not be significantly worse (two-sided sign test, losses > wins with p < 0.05 fails).
2. Efficacy replication: memory-suite with the 3 HAIKU keyword samples (not used for selection): vocab-mismatch recall@5 must beat `hybrid` with more wins than losses on every sample, and no other slice may lose more than 2 net queries.

## Held-out result (2026-09-23, run once, recorded before any further change)

LongMemEval S questions 61-260 (185 answerable, 351 evidence turns), evidence@5:

| config | evidence@5 | vs `hybrid` (more / fewer), p |
|---|---:|---:|
| `hybrid` | 146/351 (41.6%) | - |
| `hybrid-terms` (reference) | 199/351 (56.7%) | 54 / 3, p < 0.0001 |
| locked, Sonnet keywords #0 / #1 / #2 | 39.0% / 44.4% / 41.9% | 8/15 p = 0.21; 19/12 p = 0.28; 9/8 p = 1.0 |
| locked, Haiku keywords #0 / #1 / #2 | 40.5% / 40.7% / 40.7% | 0/4 p = 0.13; 4/6 p = 0.75; 1/4 p = 0.38 |

memory-suite, Haiku keywords (efficacy replication), vocab-mismatch recall@5 vs `hybrid` 0.683: #0 0.667 (0/1), #1 0.733 (3/0), #2 0.700 (1/0).

Outcome against the locked rules:
1. Safety: PASS. No keyword sample is significantly worse than `hybrid` on held-out LongMemEval (neutral, one Sonnet sample leaning worse).
2. Efficacy replication: FAIL. Haiku sample #0 has more losses than wins on vocab-mismatch.
Verdict: agent-keyword expansion alone is promising (large with Sonnet keywords on the tuning set, small with Haiku) but NOT proven; it does not ship on this evidence.

The held-out set strongly confirms the other finding: bag-of-words BM25 (`hybrid-terms`) finds far more evidence on conversational memory (+15.1 points, 54 vs 3), and 63 of the 64 extra evidence turns sit at vector ranks 11-50, i.e. inside production's own candidate pool but ranked too low.
That makes a relevance judge over a wider pool the next hypothesis (see `rr=` in `src/search-config.ts`).

## Relevance judge: tuning results and second lock (recorded 2026-09-23, BEFORE its held-out run)

Tuning sets as above; judge = the local Qwen3-Reranker-0.6B cross-encoder production already uses (`rr=ce@<depth>` re-orders the top <depth> results).

| config | memory-suite vocab-mismatch r@5 (W/L vs hybrid) | LongMemEval evidence@5 (W/L vs hybrid) | memory-suite p50 on an M-series Mac |
|---|---:|---:|---:|
| `hybrid` (production recall) | 0.683 | 49/104 | 26 ms |
| `hybrid:rr=ce@8` (production `memory_search` today: rerank cap 8) | 0.767 (6/1) | 58/104 (10/3) | 300 ms |
| `hybrid:rr=ce@20` | 0.817 (11/3) | 69/104 (19/3) | 440 ms |
| `hybrid:rr=ce@40` | 0.850 (14/4) | 73/104 (23/2) | 885 ms |
| `hybrid-terms:rr=ce@40` | 0.783 (10/4) | 77/104 (26/2) | 886 ms |
| `hybrid-weighted:w=0:e=0.5` + Sonnet keywords `:rr=ce@20` | 0.833 | 68-69/104 | 757 ms |

No slice of memory-suite has more losses than wins for any `hybrid:rr=ce@N` config.
The judge fixes both benches at once; depth is the lever; a lexical pool still trades vocab-mismatch for LongMemEval even after judging.

LOCKED CANDIDATES: `hybrid:rr=ce@20` and `hybrid:rr=ce@40` (no lexical change, no keywords, so they apply to per-turn recall as well as `memory_search`).

Held-out test, run once, on FRESH LongMemEval S questions 261-460 (never used; 61-260 was spent on the keyword test):
1. Each candidate must beat `hybrid` on evidence@5 with a paired two-sided sign test p < 0.025 (Bonferroni for two candidates).
2. Each candidate must also beat `hybrid:rr=ce@8` (what `memory_search` ships today) with p < 0.025, or it is not worth raising the production cap.
memory-suite has no held-out split; its role stays a regression guard (above: no slice with net losses).
Latency is NOT settled by these numbers: the production GPU (the production server GPU) measured ~7.5 s for 8 candidates, so depth 20-40 is not shippable there as-is; a faster judge (e.g. Jev, hosted) or faster hardware is a precondition for rollout.

## Rollout PR (separate, after results)

- `LUNA_MEMORY_SEARCH_MODE` validated at startup (unknown value = loud failure), default unchanged.
- `memory_search` gains `keywords` (max 8 phrases, max 6 words each, enforced in the zod schema) only under the flag.
- RetrievalCall observability gains a config id, lexical and expansion term counts, and whether keywords were supplied.
- Per-turn recall gets its own evaluation on real user messages (up to 2,000 characters, so OR-of-terms behaves differently: likely rarest-terms capping via `fts5vocab` and a lower weight).
- Real-data run on a COPY of the stable memory DB, dev channel before stable.

## Out of scope

- Flipping the production default: a separate, flag-only change after a real-data check on a COPY of the stable memory DB.
- Query-time LLM rewriting (HyDE, multi-query): fallback-only per the research; revisit if agent keywords underdeliver.
- The superseded filter runs after the top-K cut (`sqlite-vector.ts`), so results can come back short; pre-existing, noted for knowledge-update questions.
- Moving memory to Postgres.
