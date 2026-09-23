# LongMemEval smoke results (draft)

Completed 15-question smoke.
**Not a full benchmark.**
**Not comparable to published LongMemEval GPT-4o-judge numbers.**
Artifacts: [`smoke-results.json`](./smoke-results.json) (`llama3.2:1b` reader) and [`smoke-results-gemma4.json`](./smoke-results-gemma4.json) (`gemma4` reader).

Harness revision: #697 fixes (the first draft of this file overstated both retrieval and QA; see "What changed" at the bottom).

## 1) Luna memory surface hooked

| Step | Path |
|---|---|
| write | `ingest.ts` -> `makeRecord` + `MemoryRouter.put` (`@luna/memory`), the same call `memory_save` makes in `packages/memory-tools/src/tools.ts` |
| read | `run.ts` -> `MemoryRouter.search({ mode: "hybrid" })` (`packages/memory/src/router.ts`), the same call `memory_search` makes |
| store | a fresh `SqliteVectorBackend.fromPath(":memory:")` + `LunaSqliteBootstrapLive` per question |
| embed | `makeOllamaEmbedderLayer` (`packages/core/src/embedder/embedder.ts`) |
| answer | `answerFromContextOllama` (`packages/memory/src/adapters/locomo-eval/answer-model.ts`) |

315 episodic turns ingested, one namespace (`longmemeval-eval:<question_id>`) and one fresh store per question.
Hybrid top-10 search per question.
Records carry only a role tag and an opaque positional id (`lme_<question>_s<i>_t<j>`).
No gold label reaches the index: `SqliteVectorBackend` embeds tags into the vector input, and LongMemEval session ids are themselves labels (evidence sessions are named `answer_*`), so evidence and sessions are joined back harness-side by record id.

## 2) Subset

- Official file: `longmemeval_oracle.json` from HuggingFace `xiaowu0162/longmemeval-cleaned` (MIT, 500 questions).
- Oracle haystack = evidence sessions only, so every haystack session is an answer session.
- **No official 10-20 question sample file exists.**
- Selection: seeded Fisher-Yates (`LUNA_LME_SEED=42`) then first 15, because the file order is type-clustered (raw first-15 = all temporal-reasoning).

| question_id | question_type | abstention |
|---|---|---|
| gpt4_2f8be40d | multi-session | |
| e5ba910e_abs | multi-session | yes |
| 545bd2b5 | single-session-user | |
| 9d25d4e0 | multi-session | |
| gpt4_b5700ca9 | temporal-reasoning | |
| 16c90bf4 | single-session-assistant | |
| gpt4_b4a80587 | temporal-reasoning | |
| b759caee | single-session-assistant | |
| gpt4_65aabe59 | temporal-reasoning | |
| 19b5f2b3_abs | single-session-user | yes |
| 195a1a1b | single-session-preference | |
| gpt4_e05b82a6 | multi-session | |
| b9cfe692 | temporal-reasoning | |
| 58470ed2 | single-session-assistant | |
| 08e075c7 | knowledge-update | |

## 3) Models + cost

| role | model | where | cost |
|---|---|---|---|
| embed | `nomic-embed-text` | local Ollama | $0 |
| answer | `llama3.2:1b` and `gemma4:latest` | local Ollama `/api/chat`, temp 0 | $0 |
| judge | **not run** | official metric is a GPT-4o yes/no judge; no paid keys | $0 |

Wall-clock on an Apple-silicon Mac: 0.3 min (`llama3.2:1b`), 2.9 min (`gemma4`).
Both runs are deterministic at temp 0: re-running reproduces the same predictions.

## 4) Retrieval, against chance

Abstention questions are excluded (nothing to find), leaving 13 questions.
The baseline is the expected score of drawing top-10 turns uniformly at random from the same haystack.
Haystacks average ~22 turns, and 3 of 13 have 10 or fewer, so top-10 returns everything for them.

| metric (hybrid, top-10) | measured | random top-10 |
|---|---:|---:|
| `has_answer` turns retrieved | 19/27 (70.4%) | 11.9/27 (43.9%) |
| answer sessions retrieved | 25/25 (100%) | 24.8/25 (99.1%) |

- **Turn-level recall beats chance by ~26 points**: retrieval is doing real work.
- Search returned exactly min(topK, haystack) hits for every question (`hitCount` in the artifact), which is what the random baseline assumes.
- **Session-level recall is not a signal on this split**: chance alone gets 99%.

Search-mode comparison (`LUNA_LME_SEARCH_MODE`, same 27 evidence turns, `--dry-run`):

| mode | `has_answer` turns |
|---|---:|
| `vec` | 19/27 (70.4%) |
| `hybrid` (production default) | 19/27 (70.4%) |
| `hybrid-terms` | 19/27 (70.4%) |
| `bm25` | 21/27 (77.8%) |

`hybrid` is identical to `vec` here: its BM25 leg is exact-phrase (`sqlite-vector.ts` `rankByBm25(..., "phrase")`), and no question appears verbatim in its haystack, so the lexical leg never fires.
Pure `bm25` leading is suggestive only: 27 evidence turns is far too few to rank modes.

## 5) QA (cheap metrics only)

Official LongMemEval QA metric = GPT-4o yes/no judge (`src/evaluation/evaluate_qa.py`), **not run**.
We report token-overlap F1 (same helper as LoCoMo) and contains-gold (normalized gold answer appears in the prediction as a whole-word phrase).
Abstention (`_abs`) questions are reported on their own row, never blended into the answerable score.
`single-session-preference` gold is a grading rubric, so both metrics are n/a there.
The baseline is a reader that always replies `No information available.`, which is the answer prompt's own fallback.

`llama3.2:1b` reader:

| question_type | count | mean F1 | contains-gold | always-abstain F1 | always-abstain contains-gold |
|---|---:|---:|---:|---:|---:|
| knowledge-update | 1 | 0.000 | 0.000 | 0.000 | 0.000 |
| multi-session | 3 | 0.000 | 0.000 | 0.000 | 0.000 |
| single-session-assistant | 3 | 0.291 | 0.000 | 0.000 | 0.000 |
| single-session-preference | 1 (0 scored) | n/a | n/a | n/a | n/a |
| single-session-user | 1 | 0.000 | 0.000 | 0.000 | 0.000 |
| temporal-reasoning | 4 | 0.029 | 0.000 | 0.000 | 0.000 |
| abstention | 2 | 1.000 | 1.000 | 1.000 | 1.000 |
| **ANSWERABLE** | **13 (12 scored)** | **0.082** | **0.000** | 0.000 | 0.000 |

`gemma4` reader:

| question_type | count | mean F1 | contains-gold | always-abstain F1 | always-abstain contains-gold |
|---|---:|---:|---:|---:|---:|
| knowledge-update | 1 | 1.000 | 1.000 | 0.000 | 0.000 |
| multi-session | 3 | 0.222 | 0.000 | 0.000 | 0.000 |
| single-session-assistant | 3 | 0.640 | 0.333 | 0.000 | 0.000 |
| single-session-preference | 1 (0 scored) | n/a | n/a | n/a | n/a |
| single-session-user | 1 | 0.000 | 0.000 | 0.000 | 0.000 |
| temporal-reasoning | 4 | 0.700 | 0.750 | 0.000 | 0.000 |
| abstention | 2 | 1.000 | 1.000 | 1.000 | 1.000 |
| **ANSWERABLE** | **13 (12 scored)** | **0.532** | **0.417** | 0.000 | 0.000 |

Honest read:

- **The 1B reader is at the floor**: answerable contains-gold 0/12, F1 0.082, and 12/15 replies are the fallback phrase.
  Its 2/2 abstention score is the always-abstain baseline, not judgement.
- **A stronger local reader (`gemma4`) lifts answerable F1 from 0.082 to 0.532 and contains-gold from 0/12 to 5/12** on identical retrieval, so the reader was the main bottleneck.
- `gemma4` still falls back on questions whose evidence *was* fully retrieved (`545bd2b5`, `16c90bf4`), so reading loses more than retrieval on this split.
- Removing the tag noise from the embedding input (section 6) moved 1 evidence turn into the top-10 and changed which excerpts the reader saw, which shifted `gemma4` from 0.382 to 0.532; with 12 scored questions, treat that swing as noise-sized.
- Contains-gold is strict: `"10"` vs gold `"10 times"` and a correct Borges paraphrase vs a gold that starts "According to Borges, ..." both score 0 (F1 still credits them).
- Contains-gold still passes an "A or B?" answer that names both options; only a judge can grade that.

Do **not** quote any number here as "Luna's LongMemEval score."
It is a 15-question oracle-haystack smoke with cheap metrics.

## 6) What changed from the first draft of this file (#697)

The first draft reported overall F1 0.196 / contains-gold 0.133 and concluded "hybrid retrieval on the oracle haystack is fine".
Both conclusions were unsupported:

- **Contains-gold 0.133 was exactly the always-abstain baseline** (2/15 = the two `_abs` items); answerable contains-gold was 0/13.
- **Session-level 100% was chance** (99.1% expected at random).
- **`has_answer` was a record tag**, and tags are embedded into the vector input.
  Measured effect on this slice: none (19/28 with and without the tag, old harness), but it was a live leak for any other slice.
- **The `session:<id>` tag was a label too**: LongMemEval names evidence sessions `answer_*` (the official `run_retrieval.py` finds evidence by that substring).
  On oracle every session is `answer_*`, so nothing leaked here, but on `longmemeval_s` only evidence sessions are; the tag is gone and sessions are joined harness-side.
- **A missing answer model scored an all-zero file with exit 0.** It now exits 2 and writes nothing.
- `containsGold` matched substrings (`"12 hours"` contained `"2 hours"`), and markdown-escaped answers (`@jessica\_poole\_jewellery`) scored 0; both fixed with regression tests.

## 7) Open follow-ups

- `answerFromContextOllama` sets no `num_ctx`; prompts average ~3.1k tokens, so a model with a small default context may silently truncate.
  It is shared with LoCoMo, so the fix belongs in its own change.
- `answerFromContextOllama` has no request timeout, so a hung daemon hangs the run; same shared-code caveat.
- `locomo-eval/run.ts` still sends embeddings and answers to different URLs when only `OLLAMA_HOST` is set (the bug fixed here).
- The next informative run is `longmemeval_s` (~40 sessions per question), where retrieval is no longer near-trivial; set `LUNA_LME_DATASET_URL` (the cache is keyed by file name).
