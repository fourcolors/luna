# Memory search tuning results (2026-09-23)

Raw outputs behind every table in `docs/superpowers/plans/2026-09-22-memory-lexical-fusion-and-query-expansion.md`.
Embedder `nomic-embed-text`, local Ollama; judge = Qwen3-Reranker-0.6B cross-encoder via llama-server unless the file name says otherwise; cross-encoder runs are deterministic; Jev runs repeat almost exactly (two q1-60 runs of the locked setup differ on one question, 86 vs 85 evidence turns); Haiku runs are not (hence two passes).
The judge-comparison files also record each judge's settings and served model id (`config.judges`) and every judge call's time, wait and attempts (`perConfig[label].judge` per question); latency in them was measured on a laptop whose network varied and is indicative only.
LongMemEval files omit each config's top-10 record ids (only the vector-rank diagnostic used them); the per-question `ev5` / `ev10` / `sess5` counts behind every paired test are kept.
Runs that used the pre-isolation (contaminated) expansion keywords are not included; configs using them were removed from the files that also held clean configs.

| file | bench | questions | what it holds |
|---|---|---|---|
| `memory-suite-tuning-lexical.json` | memory-suite | 230 | query-word lexical weights and stopword sets |
| `memory-suite-tuning-min-match.json` | memory-suite | 230 | 2-term minimum match |
| `memory-suite-tuning-judge.json` | memory-suite | 230 | candidate pool + judge at depth 8 / 20 |
| `memory-suite-tuning-judge-depth.json` | memory-suite | 230 | judge depth 20 / 30 / 40 |
| `memory-suite-clean-keywords.json` | memory-suite | 230 | agent keywords (isolated, scrubbed), Sonnet and Haiku, with and without the judge |
| `longmemeval-tuning-lexical.json` | LongMemEval S | 1-60 | query-word lexical weights and stopword sets |
| `longmemeval-tuning-min-match.json` | LongMemEval S | 1-60 | 2-term minimum match |
| `longmemeval-tuning-judge.json` | LongMemEval S | 1-60 | candidate pool + judge at depth 8 / 20 |
| `longmemeval-tuning-judge-depth.json` | LongMemEval S | 1-60 | judge depth 20 / 30 / 40 |
| `longmemeval-tuning-clean-keywords.json` | LongMemEval S | 1-60 | agent keywords (isolated, scrubbed) |
| `longmemeval-heldout-61-260-clean-keywords.json` | LongMemEval S | 61-260 | held-out test of the locked keyword config |
| `longmemeval-heldout-261-460-judge.json` | LongMemEval S | 261-460 | held-out test of the locked judge configs |
| `memory-suite-tuning-judges-ce-haiku-pass-a.json` | memory-suite | 230 | which judge: cross-encoder at depth 8 / 20 / 40 and Haiku at 20 / 40, first pass |
| `memory-suite-tuning-judges-haiku-pass-b.json` | memory-suite | 230 | which judge: Haiku second pass (run-to-run spread) |
| `memory-suite-tuning-judges-jev-v1-wording.json` | memory-suite | 230 | which judge: Jev and Jev-per-candidate, "question" wording (superseded) |
| `memory-suite-tuning-judges-jev-v2-wording.json` | memory-suite | 230 | which judge: Jev, "search query" wording (the locked version) |
| `longmemeval-tuning-judges-ce-haiku-pass-a.json` | LongMemEval S | 1-60 | which judge: cross-encoder and Haiku, first pass |
| `longmemeval-tuning-judges-haiku-pass-b.json` | LongMemEval S | 1-60 | which judge: Haiku second pass |
| `longmemeval-tuning-judges-jev-v1-wording.json` | LongMemEval S | 1-60 | which judge: Jev and Jev-per-candidate, "question" wording (superseded) |
| `longmemeval-tuning-judges-jev-v2-wording.json` | LongMemEval S | 1-60 | which judge: Jev, "search query" wording (the locked version) |
| `longmemeval-heldout-261-460-judge-comparison.json` | LongMemEval S | 261-460 | which judge, held-out, run once: all three judges at depth 20 / 40 plus the cross-encoder rows re-run |
| `jev-threshold-scores.json` | LongMemEval S 1-60 + memory-suite | 60 + 230 | Jev injection threshold: per question the reranked top 10 (LongMemEval) or top 5 (memory-suite) ids with Jev's probability, memory text dropped; `python3 jev-threshold.py` prints the threshold tables |

Re-run a row with `bench/memory-suite.ts` (`LUNA_BENCH_CONFIGS`) or `src/adapters/longmemeval-eval/sweep.ts` (`LUNA_LME_SEARCH_CONFIGS`, `LUNA_LME_QA_OFFSET`, `LUNA_LME_QA_LIMIT`) using the config labels stored in each file.
