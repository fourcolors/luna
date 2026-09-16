# LongMemEval memory smoke (draft / thin spike)

Evaluates Luna's own long-term memory (`packages/memory` — SQLite +
Vectorlite, hybrid BM25+vector, Ollama embeddings) against a **15-question
slice** of [LongMemEval](https://github.com/xiaowu0162/LongMemEval)
(ICLR 2025). Not a full benchmark. Draft only — do not merge as a
leaderboard claim.

Mirrors `../locomo-eval/`. Dataset is fetched and cached, never vendored.

## Dataset & license

- **Source**: official cleaned release
  [`xiaowu0162/longmemeval-cleaned`](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned)
  on HuggingFace, file `longmemeval_oracle.json`. Paper repo:
  [`xiaowu0162/LongMemEval`](https://github.com/xiaowu0162/LongMemEval).
- **License**: **MIT** (repo LICENSE + HuggingFace card). Safer than LoCoMo's
  CC BY-NC 4.0; still not committed (15MB JSON).
- **Why oracle**: it is the official smallest haystack (evidence sessions
  only). There is **no official 10–20 question sample file**. The oracle
  JSON is grouped by `question_type` (a raw first-15 is all
  temporal-reasoning). This smoke takes **15 questions after a seeded
  Fisher–Yates shuffle (`LUNA_LME_SEED=42`)** — still not cherry-picked.
  Set `LUNA_LME_SEED=order` for file order. Exact IDs are printed at run
  time and recorded in `RESULTS.md`.

## Luna surface hooked

| Step | Module | Same as production? |
|---|---|---|
| write | `ingest.ts` → `makeRecord` + `MemoryRouter.put` (`@luna/memory`) | yes — `memory_save` in `packages/memory-tools/src/tools.ts` |
| read | `run.ts` → `MemoryRouter.search({ mode: "hybrid" })` (`packages/memory/src/router.ts`) | yes — `memory_search` in `packages/memory-tools/src/tools.ts` |
| store | `SqliteVectorBackend.fromPath(":memory:")` + `LunaSqliteBootstrapLive` | yes — same backend the chat-server uses |
| embed | `makeOllamaEmbedderLayer` (`@luna/core`) | yes |
| answer | `answerFromContextOllama` (`locomo-eval/answer-model.ts`) | eval-only; prompt uses retrieved excerpts only |

Direct TypeScript API, not MCP — same rationale as LoCoMo.

## What this measures

Luna is **pure retrieval**: one episodic `MemoryRecord` per raw user/assistant
turn. We do **not** ingest paper-side summaries or expansion keys.

Official LongMemEval QA metric is a **GPT-4o yes/no judge**
(`src/evaluation/evaluate_qa.py`). This smoke does **not** call it (no paid
keys). We report cheap token-overlap **F1** and **contains-gold**, plus
turn-level / session-level retrieval evidence coverage (`has_answer` turns
and `answer_session_ids`).

## Running

Needs a local Ollama daemon. No Anthropic / OpenAI / Fable fallback.

```sh
# Retrieval-only
LUNA_EMBEDDER=ollama LUNA_OLLAMA_EMBED_MODEL=nomic-embed-text \
  bun packages/memory/src/adapters/longmemeval-eval/run.ts --dry-run

# Full 15-question smoke (default)
LUNA_EMBEDDER=ollama LUNA_OLLAMA_EMBED_MODEL=nomic-embed-text \
  LUNA_LME_ANSWER_MODEL=llama3.2:1b \
  bun packages/memory/src/adapters/longmemeval-eval/run.ts

# or
bun run --filter '@luna/memory' eval:longmemeval
```

Env vars: see `run.ts` module docstring. `LUNA_LME_QA_LIMIT` (default 15),
`LUNA_LME_SEED` (default 42; `order` = file order), `LUNA_LME_TOPK`
(default 10), `LUNA_LME_ANSWER_MODEL`, `LUNA_OLLAMA_BASE_URL`.

Exit 2 = Ollama / embedder blocker (honest stop, no invented scores).

## Results

See `RESULTS.md` + committed `smoke-results.json`.
