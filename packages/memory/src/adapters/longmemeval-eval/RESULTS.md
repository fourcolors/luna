# LongMemEval smoke results (draft)

Completed 15-question smoke. **Not a full benchmark. Not comparable to
published LongMemEval GPT-4o-judge numbers.** Artifact:
[`smoke-results.json`](./smoke-results.json).

## 1) Luna memory surface hooked

| Step | Path |
|---|---|
| write | `ingest.ts` → `makeRecord` + `MemoryRouter.put` (`@luna/memory`) — same call `memory_save` makes in `packages/memory-tools/src/tools.ts` |
| read | `run.ts` → `MemoryRouter.search({ mode: "hybrid" })` (`packages/memory/src/router.ts`) — same call `memory_search` makes |
| store | `SqliteVectorBackend.fromPath(":memory:")` + `LunaSqliteBootstrapLive` |
| embed | `makeOllamaEmbedderLayer` (`packages/core/src/embedder/embedder.ts`) |
| answer | `answerFromContextOllama` (`packages/memory/src/adapters/locomo-eval/answer-model.ts`) |

315 episodic turns ingested across 15 per-question namespaces
(`longmemeval-eval:<question_id>`). Hybrid top-10 search per question.

## 2) Subset

- Official file: `longmemeval_oracle.json` from HuggingFace
  `xiaowu0162/longmemeval-cleaned` (MIT, 500 questions). Oracle haystack =
  evidence sessions only. **No official 10–20 question sample file exists.**
- Selection: seeded Fisher–Yates (`LUNA_LME_SEED=42`) then first 15.
  File order is type-clustered (raw first-15 = all temporal-reasoning).

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

Type mix: multi-session 4, temporal-reasoning 4, single-session-assistant 3,
single-session-user 2, preference 1, knowledge-update 1.

## 3) Models + cost

| role | model | where | cost |
|---|---|---|---|
| embed | `nomic-embed-text` | local Ollama 0.34.1, CPU | $0 |
| answer | `llama3.2:1b` | local Ollama `/api/chat`, temp 0 | $0 |
| judge | **not run** | official metric is GPT-4o yes/no — refused paid keys | $0 |

Tokens (Ollama reported): 38,313 in / 225 out across 15 answer calls.
Wall-clock: **3.6 minutes** (213s). Machine: 4 vCPU, no GPU.

## 4) Scores (cheap metrics only)

Official LongMemEval QA metric = GPT-4o yes/no judge
(`src/evaluation/evaluate_qa.py`). **Not run.** We report token-overlap F1
(same helper as LoCoMo) and contains-gold (normalized gold string / all
gold tokens in the prediction). Abstention IDs (`_abs`) score 1 iff the
model abstains.

| question_type | count | mean F1 | contains-gold |
|---|---:|---:|---:|
| knowledge-update | 1 | 0.000 | 0.000 |
| multi-session | 4 | 0.266 | 0.250 |
| single-session-assistant | 3 | 0.291 | 0.000 |
| single-session-preference | 1 | 0.000 | 0.000 |
| single-session-user | 2 | 0.500 | 0.500 |
| temporal-reasoning | 4 | 0.000 | 0.000 |
| **OVERALL** | **15** | **0.196** | **0.133** |

Retrieval (independent of the 1B answer model):

- Turn-level `has_answer` coverage: **19/28 (67.9%)** in top-10
- Session-level `answer_session_ids` coverage: **28/28 (100%)**
- QA pairs with all evidence turns retrieved: **10/14** (1 abstention had
  zero `has_answer` turns, matching the paper's "skip abstention for
  retrieval" note)

Honest read: **hybrid retrieval on the oracle haystack is fine** (every
gold session landed in top-10). **Answer quality is the bottleneck.**
`llama3.2:1b` replied `No information available.` on 10/15 questions,
including several where evidence *was* retrieved (`545bd2b5`, `16c90bf4`,
`b759caee`, `gpt4_65aabe59`, `195a1a1b`, `gpt4_e05b82a6`, `08e075c7`).
The two abstention items both correctly abstained (that is most of the
contains-gold score). One real extraction hit: `58470ed2` (Borges / Library
of Babel quote, F1 0.87). Temporal-reasoning F1 is 0/4 — the 1B model
does not resolve "how many days ago" against session dates.

Do **not** quote 0.196 as "Luna's LongMemEval score." It is a 15-question
oracle-haystack smoke with a 1B extractive reader.

## 5) Blocker

None. Ollama was not on the machine at start; we installed 0.34.1
user-locally, pulled `nomic-embed-text` + `llama3.2:1b`, and ran. No paid
keys used.
