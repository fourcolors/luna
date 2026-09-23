# LongMemEval memory smoke (draft / thin spike)

Evaluates Luna's own long-term memory (`packages/memory` - SQLite +
Vectorlite, hybrid BM25+vector, Ollama embeddings) against a **15-question
slice** of [LongMemEval](https://github.com/xiaowu0162/LongMemEval)
(ICLR 2025). Not a full benchmark. Draft only - do not merge as a
leaderboard claim.

Mirrors `../locomo-eval/`. Dataset is fetched and cached, never vendored.

## Dataset & license

- **Source**: official cleaned release [`xiaowu0162/longmemeval-cleaned`](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned) on HuggingFace.
  Paper repo: [`xiaowu0162/LongMemEval`](https://github.com/xiaowu0162/LongMemEval).
- **License**: **MIT** (repo LICENSE + HuggingFace card), safer than LoCoMo's CC BY-NC 4.0.
  Still never committed: the files are 15MB (oracle) to 277MB (S) and larger (M).
- **Splits** (`LUNA_LME_SPLIT`): the same 500 questions with different haystacks.
  - `oracle` (default): evidence sessions only, ~20 turns per question; retrieval is near-trivial here.
  - `s`: ~50 sessions, ~500 turns per question; the first split where retrieval is tested.
  - `m` (~500 sessions) is not offered: the 2.7GB file exceeds the JS max string length.
- **Subset**: there is **no official 10-20 question sample file**, and the files are grouped by `question_type`.
  The harness takes **15 questions after a seeded Fisher-Yates shuffle (`LUNA_LME_SEED=42`) over the questions sorted by id**, so it is not cherry-picked and every split picks the same questions (the files list them in different orders).
  Set `LUNA_LME_SEED=order` for file order.
  Exact IDs are printed at run time and recorded in `RESULTS.md`.

## Luna surface hooked

| Step | Module | Same as production? |
|---|---|---|
| write | `ingest.ts` → `makeRecord` + `MemoryRouter.put` (`@luna/memory`) | yes - `memory_save` in `packages/memory-tools/src/tools.ts` |
| read | `run.ts` → `MemoryRouter.search({ mode: "hybrid" })` (`packages/memory/src/router.ts`) | yes - `memory_search` in `packages/memory-tools/src/tools.ts` |
| store | `SqliteVectorBackend.fromPath(":memory:")` + `LunaSqliteBootstrapLive` | yes - same backend the chat-server uses |
| embed | `makeOllamaEmbedderLayer` (`@luna/core`) | yes |
| answer | `answerFromContextOllama` (`locomo-eval/answer-model.ts`) | eval-only; prompt uses retrieved excerpts only |

Direct TypeScript API, not MCP - same rationale as LoCoMo.

## What this measures

Luna is **pure retrieval**: one episodic `MemoryRecord` per raw user/assistant turn.
We do **not** ingest paper-side summaries or expansion keys.
Each question gets a fresh in-memory store, and records never carry gold labels or session ids (tags are embedded into the vector input, and evidence sessions are named `answer_*`).

Official LongMemEval QA metric is a **GPT-4o yes/no judge** (`src/evaluation/evaluate_qa.py`).
This smoke does **not** call it (no paid keys).
We report cheap token-overlap **F1** and whole-word **contains-gold**, with abstention (`_abs`) questions on their own row and preference questions (rubric gold) as n/a.
Every number is printed beside its chance baseline: random top-K retrieval for recall, and an always-abstain reader for QA.
On the oracle split those baselines are high (session-level recall is ~99% by chance), so a number that does not beat its baseline means nothing.

## Running

Needs a local Ollama daemon with the embed model and (unless `--dry-run`) the answer model pulled.
Both are checked before any work; no Anthropic / OpenAI / Fable fallback.

```sh
# Retrieval-only
LUNA_EMBEDDER=ollama LUNA_OLLAMA_EMBED_MODEL=nomic-embed-text \
  bun packages/memory/src/adapters/longmemeval-eval/run.ts --dry-run

# S split, 60 questions, production search mode
LUNA_EMBEDDER=ollama LUNA_OLLAMA_EMBED_MODEL=nomic-embed-text \
  LUNA_LME_SPLIT=s LUNA_LME_QA_LIMIT=60 LUNA_LME_ANSWER_MODEL=gemma4:latest \
  bun packages/memory/src/adapters/longmemeval-eval/run.ts

# Full 15-question smoke (default)
LUNA_EMBEDDER=ollama LUNA_OLLAMA_EMBED_MODEL=nomic-embed-text \
  LUNA_LME_ANSWER_MODEL=llama3.2:1b \
  bun packages/memory/src/adapters/longmemeval-eval/run.ts

# or
bun run --filter '@luna/memory' eval:longmemeval
```

Env vars: see the `run.ts` module docstring.
`LUNA_LME_SPLIT` (default `oracle`), `LUNA_LME_QA_LIMIT` (default 15), `LUNA_LME_SEED` (default 42; `order` = file order), `LUNA_LME_TOPK` (default 10), `LUNA_LME_SEARCH_MODE` (default `hybrid`), `LUNA_LME_ANSWER_MODEL`, `LUNA_LME_NUM_CTX` (default 8192; requests forbid truncation and context shift, so an overflowing prompt or answer stops the run), `LUNA_OLLAMA_EMBED_MODEL`, and `LUNA_OLLAMA_BASE_URL` (falls back to `OLLAMA_HOST`; one URL serves both embed and answer).

Exit codes: 2 = Ollama blocker (daemon down, model not pulled, answer call failed), 3 = dataset load, 4 = invalid config, 5 = memory backend failure.
Every non-zero exit writes **no** results file: no invented scores.

## Results

See `RESULTS.md` and the committed `smoke-results*.json` / `results-*.json` artifacts.

60 questions, S split (~500 turns per question), local Ollama, $0:

- Retrieval (top-10 evidence turns): `hybrid` (production) 64.4%, identical to `vec`; `bm25` 73.1%; `hybrid-terms` 75.0%; random 2.1%.
- Answerable QA with `gemma4`: contains-gold 10/50 with `hybrid`, 16/50 with `hybrid-terms` (13/50 on the oracle haystack with `hybrid`).

Official GPT-4o judge was not run.
