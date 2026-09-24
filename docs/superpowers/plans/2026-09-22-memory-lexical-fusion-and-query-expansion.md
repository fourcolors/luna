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
| weighted, query words must match 2+ terms (m = 2) | 50 to 56 | 0.350 to 0.600 (0.350 without stopwords), always net losses |
| **vector + agent keywords only (w = 0, e = 0.5), Sonnet, 3 samples** | **47 to 50 (neutral)** | **0.761 (14/0 summed)** |

Findings:
1. The two benches disagree about matching the question's OWN words: LongMemEval questions share words with their evidence (the user's own turns), so lexical matching helps; memory-suite vocab-mismatch queries are casual questions about technically worded memories (the Luna pattern: agent-written facts, user-worded questions), and any query-word lexical arm promotes wrong records, at every weight tried, with or without stopwords (stopwords did not fix it, refuting the function-word hypothesis) and with a 2-term minimum match.
2. RRF at k = 60 is flat enough that even weight 0.25 lets a lexical rank-1 overtake the vector rank-1 from vector rank ~6.
3. Agent keywords used as their own lexical arm, with the question's words kept out of lexical matching, are the only variant that never hurts: +7.8 points vocab-mismatch recall@5 on memory-suite, neutral on LongMemEval.

Deviation from the pre-registered ship rule, stated openly: no config can meet rule 1 (a significant LongMemEval gain) without failing rule 2 (memory-suite), so no config becomes the default for per-turn recall.
The locked candidate makes a narrower claim, tested as follows.

LOCKED CONFIG: `hybrid-weighted:w=0:e=0.5:s=lucene` with agent keywords (`memory_search` only; with no keywords it ranks like `vec`, which equals production `hybrid` whenever hybrid's exact-phrase arm finds nothing, i.e. on all 60 tuning questions).

Held-out test, run once:
1. Safety: LongMemEval S questions 61-260 (fresh), evidence@5 vs `hybrid`, for each of 3 Sonnet and 3 Haiku keyword samples: it must not be significantly worse (two-sided sign test, losses > wins with p < 0.05 fails).
2. Efficacy replication: memory-suite with the 3 HAIKU keyword samples (not used for selection): vocab-mismatch recall@5 must beat `hybrid` with more wins than losses on every sample, and no other slice may lose more than 2 net queries.

## Correction (2026-09-23, after a code review): the memory-suite keyword numbers above are contaminated

The keyword generator ran `claude -p` from the repo, which loaded the user's and the project's CLAUDE.md and auto-memory.
The memory-suite corpus describes Luna itself, so generated keywords named internal terms the query never mentioned but the target record contains (vectorlite, LUNA_* variables; in 24/180 Sonnet and 35/180 Haiku vocab-mismatch samples), and some carried personal details.
So the "+7.8 points, 14/0" vocab-mismatch result for Sonnet keywords, and the Haiku replication, over-state what query-only keywords can do (the clean re-run below measures about +2 points).
The LongMemEval keyword files show no such leakage (their questions are about fictional users' lives), and no LOCKED judge candidate uses keywords, so the judge results and their held-out test are unaffected.
Fix: `bench/isolated-claude.ts` (no setting sources, tools, MCP or session persistence; fresh temp cwd; verified it no longer knows the user); every keyword file is regenerated and the keyword measurements re-run; the contaminated files never entered git history.

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
1. Safety: PASS.
   No keyword sample is significantly worse than `hybrid` on held-out LongMemEval (neutral, one Sonnet sample leaning worse).
2. Efficacy replication: FAIL.
   Haiku sample #0 has more losses than wins on vocab-mismatch.
Verdict: agent-keyword expansion alone is promising (large with Sonnet keywords on the tuning set, small with Haiku) but NOT proven; it does not ship on this evidence.

The held-out set strongly confirms the other finding: bag-of-words BM25 (`hybrid-terms`) finds far more evidence on conversational memory (+15.1 points, 54 vs 3).
Of the evidence turns `hybrid-terms` alone finds but `hybrid` misses, 54 of 55 sit at vector ranks 11-50 (the sweep's diagnostic counts all non-baseline configs together: 63 of 64), i.e. inside production's own candidate pool but ranked too low.
That makes a relevance judge over a wider pool the next hypothesis (see `rr=` in `src/search-config.ts`).

## Relevance judge: tuning results and second lock (recorded 2026-09-23, BEFORE its held-out run)

Tuning sets as above; judge = the local Qwen3-Reranker-0.6B cross-encoder production already uses (`rr=ce@<depth>` re-orders the top <depth> results).

| config | memory-suite vocab-mismatch r@5 (W/L vs hybrid) | LongMemEval evidence@5 (W/L vs hybrid) | memory-suite p50 on an M-series Mac |
|---|---:|---:|---:|
| `hybrid` (production recall) | 0.683 | 49/104 | 26 ms |
| `hybrid:rr=ce@8` (approximates `memory_search` with rerank on: cap 8) | 0.767 (6/1) | 58/104 (10/3) | 300 ms |
| `hybrid:rr=ce@20` | 0.817 (11/3) | 69/104 (19/3) | 440 ms |
| `hybrid:rr=ce@40` | 0.850 (14/4) | 73/104 (23/2) | 885 ms |
| `hybrid-terms:rr=ce@40` | 0.783 (10/4) | 77/104 (26/2) | 886 ms |
| `hybrid-weighted:w=0:e=0.5` + Sonnet keywords `:rr=ce@20` | 0.817 (clean keywords; the 0.833 first measured used contaminated keywords) | not re-run with clean keywords | 457 ms |

No slice of memory-suite has more losses than wins for any `hybrid:rr=ce@N` config.
Latency is indicative only: the same config measured 440 ms in one sweep and 763 ms in another, because some sweeps overlapped with other runs on the same machine; recall numbers are deterministic, latencies are not.
The judge fixes both benches at once; depth is the lever; a lexical pool still trades vocab-mismatch for LongMemEval even after judging.

LOCKED CANDIDATES: `hybrid:rr=ce@20` and `hybrid:rr=ce@40` (no lexical change, no keywords, so they apply to per-turn recall as well as `memory_search`).

Held-out test, run once, on FRESH LongMemEval S questions 261-460 (never used; 61-260 was spent on the keyword test):
1. Each candidate must beat `hybrid` on evidence@5 with a paired two-sided sign test p < 0.025 (Bonferroni for two candidates).
2. Each candidate must also beat `hybrid:rr=ce@8` with p < 0.025, or it is not worth raising the production cap.
   `hybrid:rr=ce@8` approximates `memory_search` with rerank enabled; production additionally drops candidates scoring below 40/100, sorts on rounded scores, over-fetches 20 and filters by kind, and does not cap documents at 2000 characters, so gains transfer directionally, not one-for-one.
memory-suite has no held-out split; its role stays a regression guard (above: no slice with net losses).
Latency is NOT settled by these numbers: the production GPU (the production server GPU) measured ~7.5 s for 8 candidates, so depth 20-40 is not shippable there as-is; a faster judge (e.g. Jev, hosted) or faster hardware is a precondition for rollout.

## Relevance judge: held-out result (2026-09-23, run once on fresh questions 261-460)

193 answerable questions, 366 evidence turns, evidence@5:

| config | evidence@5 | evidence@10 | vs `hybrid` | vs `hybrid:rr=ce@8` |
|---|---:|---:|---:|---:|
| `hybrid` (production recall) | 161/366 (44.0%) | 61.7% | - | - |
| `hybrid:rr=ce@8` | 204/366 (55.7%) | 61.7% | 44 / 1 | - |
| **`hybrid:rr=ce@20`** | **265/366 (72.4%)** | 78.7% | 86 / 1, p ~ 1e-24 | 52 / 1, p ~ 1e-14 |
| **`hybrid:rr=ce@40`** | **279/366 (76.2%)** | 85.0% | 92 / 1, p ~ 2e-26 | 61 / 1, p ~ 3e-17 |
| `hybrid-terms:rr=ce@40` (reference) | 284/366 (77.6%) | 86.6% | 97 / 1 | 66 / 1 |

`hybrid:rr=ce@40` vs `hybrid:rr=ce@20`: 17 / 4, p = 0.007.

By question type (evidence turns found in the top 5, `hybrid` -> `hybrid:rr=ce@8` -> `hybrid:rr=ce@40`): knowledge-update 24 -> 35 -> 52 of 59; multi-session 52 -> 66 -> 94 of 144; temporal-reasoning 39 -> 52 -> 76 of 100; single-session-user 19 -> 22 -> 25 of 26; single-session-assistant 21 -> 23 -> 23 of 24; preference 6 -> 6 -> 9 of 13.

Outcome against the locked rules: BOTH candidates PASS (beat `hybrid` and `hybrid:rr=ce@8`, every p far below 0.025).

Conclusion: the biggest single improvement available to Luna's memory is judging more candidates, not changing lexical matching.
Production retrieval already has most of the right memories in its top 40; it ranks them too low, and today's rerank (when enabled) only looks at 8.
The open question is purely operational: latency of judging 20-40 candidates on the production hardware (a precondition for rollout, below).

## Clean keyword re-run (2026-09-23, isolated generator, identity-scrubbed keywords)

Every keyword measurement above was repeated with the regenerated keywords; these numbers REPLACE the contaminated ones.

memory-suite vocab-mismatch recall@5 (`hybrid` 0.683), locked config `hybrid-weighted:w=0:e=0.5:s=lucene`, per keyword sample:

| keywords | #0 | #1 | #2 |
|---|---:|---:|---:|
| Sonnet | 0.700 (1/0) | 0.700 (1/0) | 0.717 (2/0) |
| Haiku | 0.683 (0/0) | 0.700 (1/0) | 0.700 (1/0) |

Other slices unchanged except one temporal loss on one Sonnet sample; keyword weight 0.25 to 1 barely matters at w = 0.
Adding the query's own words back (w 0.1 / 0.25 / 1) again loses vocab-mismatch queries (net -3 / -35 / -68 summed over samples).
Keywords on top of the judge (`:rr=ce@20`) give 0.817, the same as the judge alone: no added value.

LongMemEval tuning (1-60): keyword-only configs 45-51/104 vs `hybrid` 49 (neutral).
LongMemEval held-out (61-260), locked config: Sonnet 39.3% / 42.2% / 42.5%, Haiku 41.6% / 41.9% / 40.7% vs `hybrid` 41.6%; no sample significantly different (smallest p = 0.15, Sonnet #0, 3 / 9).

Corrected verdict: query-only agent keywords are SAFE (never significantly worse) and give a small vocab-mismatch gain (about +2 points, not significant), far below the contaminated "+7.8".
The efficacy replication still fails (Haiku #0 has no wins).
The relevance judge makes them redundant.

## Which judge: Jev and Haiku against the cross-encoder (tuning results and third lock, recorded 2026-09-23, BEFORE its held-out run)

Judges (all rerank the same `hybrid` candidate pool, every candidate capped at 2,000 characters):

- `ce`: the local Qwen3-Reranker-0.6B cross-encoder, as above.
- `jev`: TypeSafe Jev (served as `jev-1.13.0`), one request per search with one yes/no question (Noul) per candidate; the score is the probability of yes.
- `jevpair`: Jev with one request per candidate (the shape of TypeSafe's rerank cookbook).
- `haiku`: `claude-haiku-4-5-20251001` through the Agent SDK on the Claude subscription, one call scoring every candidate 0-100 with the July production rubric (deleted in #412), candidates listed in search order, thinking disabled, the next call's process pre-warmed with `startup()`.

Why Haiku is back in: the July reranker was dropped as "~20-30 s per call"; that was hidden thinking (700-2,500 output tokens for a ~130-token JSON reply), not Haiku.
With thinking disabled, 20 short candidates take ~1.4 s warm.

One change was made during tuning, before any held-out run: Jev's wording moved from "does the memory help answer the user's question" (v1) to "is the memory relevant to the search query: does it contain what the query asks about or describes" (v2).
Diagnosis: memory-suite `q_verbatim_022` is a phrase, not a question; v1 scored its verbatim match 0.21 and dropped it from the top 10, v2 scores it 0.47.
Production queries are often not questions (per-turn recall searches with the user's message; agents search with phrases).
Haiku's prompt is unchanged.

Tuning results (LongMemEval S questions 1-60: evidence@5 out of 104 evidence turns; memory-suite: vocab-mismatch recall@5):

| config | LongMemEval evidence@5 | memory-suite vocab-mismatch | memory-suite verbatim |
|---|---:|---:|---:|
| `hybrid` | 49 | 0.683 | 1.000 |
| `hybrid:rr=ce@20` / `@40` | 69 / 73 | 0.817 / 0.850 | 1.000 / 1.000 |
| `hybrid:rr=haiku@20` / `@40` (two passes) | 71-72 / 76-80 | 0.883 / 0.967 (both passes) | 1.000 / 1.000 |
| `hybrid:rr=jev@20` / `@40` (v1 wording) | 77 / 85 | 0.883 / 0.967 | 0.975 / 0.975 |
| **`hybrid:rr=jev@20` / `@40` (v2 wording)** | **79 / 86** | **0.883 / 0.967** | 1.000 / 0.975 |
| `hybrid:rr=jevpair@20` / `@40` (v1 wording) | 77 / 83 | 0.883 / 0.967 | 0.975 / 0.975 |

The `ce` rows reproduce the tables above exactly, and the shared `hybrid` baseline is identical in every run.
Paired LongMemEval (questions with more / fewer evidence turns in the top 5): `jev@40` vs `ce@40` 13 / 3 (p = 0.021); `jev@40` vs `haiku@40` 8 / 1 and 5 / 2 over Haiku's two passes (p = 0.039, 0.45); `haiku@40` vs `ce@40` 10 / 7 (p = 0.63).
Haiku's two passes gave the same best rank on 222-223 of 230 memory-suite queries and identical recall@5; on LongMemEval they differ by 1-4 evidence turns.
Jev's scores are calibrated enough to gate on: on memory-suite the median score of a right memory is 0.94, the median top score for a query with no right answer 0.04-0.05.
`jevpair` equals `jev` on quality with a much worse slow tail (up to 61 s on the laptop), so it is dropped.

Latency here is indicative only: these runs were on a laptop whose network varies, several runs overlapped, and the SDK's process start is network-bound (0.6 s on a good connection, 4.6-10 s on a slow one).
Laptop per-call medians (depth 20 / 40): `jev` 0.23 / 0.27 s, `haiku` 1.8 / 2.9 s, `ce` 1.4 / 2.7 s.
Latency is decided separately, on the production server against a COPY of the memory database (Rollout, step 1).

LOCKED: one held-out run of `hybrid`, `hybrid:rr=ce@8`, `hybrid:rr=ce@20`, `hybrid:rr=ce@40`, `hybrid:rr=jev@20`, `hybrid:rr=jev@40`, `hybrid:rr=haiku@20`, `hybrid:rr=haiku@40`, with the judge code and prompts at this commit.

Held-out set: LongMemEval S questions 261-460 again.
Jev and Haiku were never tuned or selected on them; they were used once, for the cross-encoder, whose rows re-run here so every comparison is paired within one run.
Reproduction check: `ce@20` and `ce@40` should reproduce 265/366 and 279/366; if they do not (for example after an Ollama update), the in-run numbers are used and the difference is reported.

Primary comparisons, at depth 40, paired two-sided sign test on evidence@5, Bonferroni for three (p < 0.0167):

1. `jev@40` vs `ce@40`.
2. `haiku@40` vs `ce@40`.
3. `jev@40` vs `haiku@40`.

A judge "beats" another only with more wins and p < 0.0167; otherwise the result is "no detectable difference", and the evidence@5 gap is reported with it.
The same three comparisons at depth 20, and every judge against `hybrid`, are reported but not claimed.
Haiku runs once on held-out; its tuning pass-to-pass spread is reported next to it.

What the outcome decides (latency still has to fit, and sending memory text to a vendor is the owner's decision):

- Jev beats Haiku, or no detectable difference: recommend Jev (as good or better, about 7x faster per call, calibrated scores that can gate injection).
- Haiku beats Jev: recommend Haiku only if it fits the latency budget on the server; otherwise present the trade-off as a decision.
- Neither beats `ce@40`: the local cross-encoder stays the judge, and its latency on the production GPU remains the blocker.

## Which judge: held-out result (2026-09-23, run once on questions 261-460, locked commit 5c76619a)

193 answerable questions, 366 evidence turns; one run, no resumes; served models `jev-1.13.0` and `claude-haiku-4-5-20251001`.
Reproduction check: every `hybrid` and `ce` row reproduces the earlier held-out exactly (161 / 204 / 265 / 279).

| config | evidence@5 | evidence@10 | vs `hybrid` |
|---|---:|---:|---:|
| `hybrid` (production recall) | 161/366 (44.0%) | 61.7% | - |
| `hybrid:rr=ce@20` / `@40` | 265 (72.4%) / 279 (76.2%) | 78.7% / 85.0% | 86 / 1, 92 / 1 |
| `hybrid:rr=haiku@20` / `@40` | 270 (73.8%) / 290 (79.2%) | 77.9% / 85.8% | 85 / 3, 93 / 3 |
| **`hybrid:rr=jev@20` / `@40`** | **285 (77.9%) / 313 (85.5%)** | **80.9% / 91.8%** | **94 / 2, 107 / 2** |

Primary comparisons (depth 40, bar p < 0.0167):

1. `jev@40` vs `ce@40`: 31 / 6, p = 4.1e-5: **Jev beats the cross-encoder.**
2. `haiku@40` vs `ce@40`: 23 / 19, p = 0.64: no detectable difference (+11 evidence turns).
3. `jev@40` vs `haiku@40`: 28 / 7, p = 5.1e-4: **Jev beats Haiku.**

Reported, not claimed: at depth 20, `jev` vs `ce` 22 / 5 (p = 0.0015), `haiku` vs `ce` 15 / 11 (p = 0.56), `jev` vs `haiku` 21 / 7 (p = 0.013); `jev@40` vs `jev@20` 28 / 5 (p = 6.6e-5).
Haiku's tuning passes differed by 1-4 evidence turns, far less than its 23-turn gap to Jev here.

By question type (evidence turns in the top 5, `hybrid` -> `ce@40` -> `haiku@40` -> `jev@40`): multi-session 52 -> 94 -> 104 -> 115 of 144; temporal-reasoning 39 -> 76 -> 79 -> 87 of 100; knowledge-update 24 -> 52 -> 50 -> 55 of 59; single-session-user 19 -> 25 -> 25 -> 25 of 26; single-session-assistant 21 -> 23 -> 24 -> 23 of 24; single-session-preference 6 -> 9 -> 8 -> 8 of 13.

Per-call judge time on the laptop (indicative only; median / p95, depth 40): `jev` 0.21 / 0.33 s, `ce` 2.2 / 2.8 s, `haiku` 2.9 / 3.6 s; over the 2.5 s per-turn budget: `jev` 0 of 200, `ce` 33, `haiku` 167.
One `jev@20` call took 61 s (a network hang, retried once, counted in the table above).

Outcome against the locked rules: Jev beats Haiku, so the recommendation is Jev: better on quality than both, about 10x faster per call, and scores calibrated enough to gate on.
Latency on the production server and the owner's decision on sending memory text to TypeSafe remain preconditions for turning it on anywhere.

## Jev as a configurable engine, and its injection threshold (2026-09-23, tuning sets only)

Shipped in this PR, opt-in (the owner: make Jev configurable; never put a key in the public repo):
`LUNA_RERANK_ENGINE=jev` plus the operator's own `TYPESAFE_API_KEY` (resolved like every server secret: vault, Keychain or environment).
The default is unchanged: the local cross-encoder, reranking off in both lanes unless `LUNA_MEMORY_RERANK=1` / `LUNA_RECALL_RERANK=1`.
Configured, Jev reranks both `memory_search` and per-turn recall (flag `0` turns a lane off), judges the top 40, pins `jev-1.13.0`, and sends the exact held-out request (one builder in `@luna/core`, byte-identical to the benchmarked one).

Threshold: production drops a scored candidate below `LUNA_RERANK_THRESHOLD` (the cross-encoder's calibrated default is 40), but the held-out run measured ordering only.
Jev's probabilities are spread lower than the cross-encoder's: on LongMemEval tuning the evidence turns in the top 5 score a median 0.75, a tenth under 0.33.
Gating the tuning sets offline (Jev at depth 40):

| threshold | LongMemEval evidence@5 kept (of 85) | memories packed per abstention question | memory-suite relevant top-5 hits kept (of 186) | memory-suite negative queries still injecting |
|---:|---:|---:|---:|---:|
| 0 | 85 | 5.0 | 186 | 40 / 40 |
| 5 | 85 | 4.2 | 186 | 22 / 40 |
| 10 | 83 | 2.2 | 186 | 9 / 40 |
| 20 | 79 | 0.8 | 186 | 4 / 40 |
| 40 (the cross-encoder's) | 72 | 0.2 | 185 | 0 / 40 |

Decision: Jev's default threshold is 0, the configuration the held-out run validated (reorder, never drop; also what production does today with no judge).
The cross-encoder's 40 would have thrown away 13 of 85 evidence turns.
Threshold 5 loses nothing on either tuning set and halves memory-suite's negative-query injections; it needs a held-out check before it becomes the default (`LUNA_RERANK_THRESHOLD=5` applies it now).

## Rollout (revised 2026-09-23 after the judge result)

1. Done in this PR: Jev as an opt-in engine (above); the default path is unchanged.
2. Before enabling it on the owner's server (merge auto-deploys, but nothing changes until `LUNA_RERANK_ENGINE=jev` and a key are set there): measure Jev latency and recall on a COPY of the stable memory DB with real `memory_search` queries at depth 8 / 20 / 40, including the recall lane's 160-row backend fetch inside the 2.5 s budget and cold starts (the first call after idle measured 9-19 s; the layer sends one data-free warm-up call at boot).
3. Held-out check of threshold 5 (fresh questions or a new split), then make it Jev's default if it holds.
4. End-to-end QA like-for-like with published memory scores (running: LongMemEval S, all 500 questions, Claude Sonnet reading Luna's recall, official judge prompts graded by gpt-4o-2024-08-06 and grok-4.5).
5. Agent keywords (`memory_search` `keywords` argument) stay out: safe but not proven, and the judge already delivers the vocabulary-mismatch gain they were meant to.

## Out of scope

- Flipping the production default: a separate, flag-only change after a real-data check on a COPY of the stable memory DB.
- Query-time LLM rewriting (HyDE, multi-query): fallback-only per the research; revisit if agent keywords underdeliver.
- The superseded filter runs after the top-K cut (`sqlite-vector.ts`), so results can come back short; pre-existing, noted for knowledge-update questions.
- Moving memory to Postgres.
