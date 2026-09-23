# LongMemEval results (draft)

**Not a full benchmark.**
**Not comparable to published LongMemEval GPT-4o-judge numbers.**
All numbers use cheap metrics (token F1 and whole-word contains-gold), local Ollama models, and $0 of paid API.

## Headline

- On the **S split** (~500 turns per question), Luna's retrieval finds 64-75% of the evidence turns in its top 10, against ~2% by chance: retrieval is doing real work.
- **The production search mode (`hybrid`) is identical to pure vector search here**, question for question, because its BM25 leg is exact-phrase and never matches a natural question.
- **`hybrid-terms` (bag-of-words BM25 fused with vectors) retrieves more evidence on 13 of 60 questions and less on 2** (sign test p = 0.007), and lifts answerable contains-gold from 10/50 to 16/50 (McNemar p = 0.11, suggestive at this size).
- A 2026-07-14 synthetic bench shows the opposite on vocabulary-mismatch queries (`hybrid-terms` recall@10 0.42 vs 0.85), which is why production never flipped; see "Production implication".

## 1) Setup

| Step | Path |
|---|---|
| write | `ingest.ts` -> `makeRecord` + `MemoryRouter.put`, the same call `memory_save` makes |
| read | `run.ts` -> `MemoryRouter.search({ mode })`, the same call `memory_search` makes (production uses `mode: "hybrid"`) |
| store | a fresh `SqliteVectorBackend.fromPath(":memory:")` + `LunaSqliteBootstrapLive` per question |
| embed | `makeOllamaEmbedderLayer`, `nomic-embed-text` |
| answer | `answerFromContextOllama` (`locomo-eval/answer-model.ts`), temp 0, `num_ctx` 8192, strict context (overflow stops the run) |

Records carry only a role tag and an opaque positional id: no gold label or `answer_*` session id reaches the index.
Top-10 retrieval per question.

Splits (`LUNA_LME_SPLIT`), the same 500 questions with different haystacks:

| split | haystack | mean turns per question (60-question sample) |
|---|---|---:|
| `oracle` | evidence sessions only | 22 |
| `s` | ~50 sessions, mostly distractors | 491 |

Selection: questions sorted by id, seeded Fisher-Yates (seed 42), first N, so every split picks the same questions.
The 15-question default is a prefix of the 60-question sample.
60-question type mix (answerable / abstention): knowledge-update 8/3, multi-session 15/1, single-session-assistant 4/0, single-session-preference 4/0, single-session-user 11/0, temporal-reasoning 12/2.

Models: `nomic-embed-text` (embed), `gemma4:latest` 8B and `llama3.2:1b` (answer), local Ollama on an Apple-silicon Mac.
Answer runs used Ollama 0.34.2; the two retrieval-only runs used 0.34.3 (the app auto-updated mid-batch), recorded in each artifact's `config.ollamaVersion`.
Temp 0 runs are deterministic: the 15-question oracle runs reproduced exactly across two batches.

## 2) Retrieval, 60 questions, S split

Abstention questions excluded (nothing to find): 54 questions, 104 evidence turns, 100 answer sessions.
Random = expected hits drawing 10 turns uniformly from the same haystack.

| mode | evidence turns in top-10 | answer sessions in top-10 |
|---|---:|---:|
| random | 2.2/104 (2.1%) | 21.8/100 (21.8%) |
| `vec` | 67/104 (64.4%) | 90/100 (90.0%) |
| **`hybrid` (production)** | **67/104 (64.4%)** | **90/100 (90.0%)** |
| `bm25` | 76/104 (73.1%) | 92/100 (92.0%) |
| `hybrid-terms` | 78/104 (75.0%) | 97/100 (97.0%) |

- `hybrid` and `vec` return the same evidence and session hits on every one of the 60 questions.
- `hybrid-terms` vs `hybrid`, per question: more evidence on 13, less on 2, same on 39 (two-sided sign test p = 0.007).
- For reference, the oracle split (evidence-only haystack, `hybrid`) gives 75/104 turns (72.1%, random 46.7%) and 97/100 sessions (random 98.8%, so no signal).

## 3) QA, 60 questions, `gemma4`

Answerable questions only (54, of which the 4 preference questions are n/a because their gold is a rubric).
The always-abstain baseline scores 0 on every answerable row and 1.0 on abstention.

| question_type | n | oracle F1 / CG | S `hybrid` F1 / CG | S `hybrid-terms` F1 / CG |
|---|---:|---:|---:|---:|
| knowledge-update | 8 | 0.238 / 0.125 | 0.321 / 0.250 | 0.271 / 0.250 |
| multi-session | 15 | 0.116 / 0.067 | 0.049 / 0.000 | 0.293 / 0.333 |
| single-session-assistant | 4 | 0.700 / 0.500 | 0.450 / 0.250 | 0.450 / 0.250 |
| single-session-user | 11 | 0.755 / 0.727 | 0.524 / 0.545 | 0.639 / 0.636 |
| temporal-reasoning | 12 | 0.194 / 0.083 | 0.074 / 0.083 | 0.237 / 0.083 |
| abstention | 6 | 1.000 / 1.000 | 1.000 / 1.000 | 1.000 / 1.000 |
| **ANSWERABLE (50 scored)** | **54** | **0.341 / 0.260** | **0.235 / 0.200** | **0.365 / 0.320** |

- Moving from the oracle haystack to S costs `hybrid` 3 correct answers (13 -> 10 of 50): that is the price of having to find the evidence.
- `hybrid-terms` on S beats `hybrid` on S by 6 answers (16 vs 10; 8 questions only it gets, 2 only `hybrid` gets; McNemar exact p = 0.11).
- It even edges past `hybrid` on the oracle haystack (16 vs 13), because the oracle run also uses the phrase-BM25 `hybrid`, which is vector-only in practice.
- Nearly all of the gain is multi-session (0 -> 5 of 15): questions that need several turns, where exact vocabulary overlap helps pull each one in.
- The reader still falls back to "No information available." often (29-37 of 60), so reading, not only retrieval, limits the score.
- Largest prompt: 7,122 tokens against `num_ctx` 8192; no run hit the overflow guard.

## 4) 15-question default smoke (oracle)

The default command (`LUNA_LME_QA_LIMIT` 15, oracle, `hybrid`), committed as `smoke-results.json` / `smoke-results-gemma4.json`.
All 15 are answerable.

| reader | evidence turns (random) | answerable F1 | answerable contains-gold |
|---|---:|---:|---:|
| `llama3.2:1b` | 20/22 (12.1) | 0.037 | 0/15 |
| `gemma4` | 20/22 (12.1) | 0.427 | 6/15 |

The 1B reader is at the floor; `gemma4` is the reader used for everything above.

## 5) Production implication (not changed here)

`memory_search` (`packages/memory-tools/src/tools.ts`) and per-turn recall (`turn-memory.ts`) call `mode: "hybrid"`.
On real conversational memory that is vector-only, and `hybrid-terms` retrieves significantly more evidence.
But the synthetic bench (`bench/baseline-2026-07-14.json`, 230 queries) shows `hybrid-terms` regressing badly on its vocabulary-mismatch slice (recall@10 0.42 vs 0.85) while tying or winning elsewhere.
The two benches disagree about which failure matters more, so flipping the default is a product decision, tracked separately.

## 6) Known limits

- 60 questions is enough to separate retrieval modes, not to rank QA precisely: one answer is 2 points of contains-gold.
- Contains-gold is strict (a correct "10" misses gold "10 times"), and ~11% of golds carry extra prose it can never match; F1 gives partial credit.
- The M split (~500 sessions) is not runnable: its 2.7GB file exceeds the JS max string length.
- The official GPT-4o judge was not run.

## 7) Artifacts

| file | split | n | mode | reader |
|---|---|---:|---|---|
| `smoke-results.json` | oracle | 15 | hybrid | llama3.2:1b |
| `smoke-results-gemma4.json` | oracle | 15 | hybrid | gemma4 |
| `results-oracle-n60-gemma4.json` | oracle | 60 | hybrid | gemma4 |
| `results-s-n60-gemma4-hybrid.json` | s | 60 | hybrid | gemma4 |
| `results-s-n60-gemma4-hybrid-terms.json` | s | 60 | hybrid-terms | gemma4 |
| `results-s-n60-bm25-retrieval.json` | s | 60 | bm25 | retrieval only |
| `results-s-n60-vec-retrieval.json` | s | 60 | vec | retrieval only |

Reproduce any row with `LUNA_LME_SPLIT`, `LUNA_LME_QA_LIMIT`, `LUNA_LME_SEARCH_MODE` and `LUNA_LME_ANSWER_MODEL` as listed (see `README.md`).
