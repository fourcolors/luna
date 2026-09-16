# LongMemEval smoke results (draft)

Status: harness committed; live smoke numbers land in the next commit
(`smoke-results.json` + this file). Do not treat this page as a score until
`blocked: false` and a completed `scored` array are present.

## 1) Luna memory surface hooked

| Step | Path |
|---|---|
| write | `ingest.ts` → `makeRecord` + `MemoryRouter.put` (`@luna/memory`) — same call `memory_save` makes in `packages/memory-tools/src/tools.ts` |
| read | `run.ts` → `MemoryRouter.search({ mode: "hybrid" })` (`packages/memory/src/router.ts`) — same call `memory_search` makes |
| store | `SqliteVectorBackend.fromPath(":memory:")` + `LunaSqliteBootstrapLive` |
| embed | `makeOllamaEmbedderLayer` (`packages/core/src/embedder/embedder.ts`) |
| answer | `answerFromContextOllama` (`packages/memory/src/adapters/locomo-eval/answer-model.ts`) |

## 2) Subset

- Official file: `longmemeval_oracle.json` from
  `xiaowu0162/longmemeval-cleaned` (MIT). 500 questions; oracle haystack =
  evidence sessions only. **No official 10–20 question sample exists.**
- Selection: seeded Fisher–Yates (`LUNA_LME_SEED=42`) then first 15.
  (File order is type-clustered — a raw first-15 is all temporal-reasoning.)
- Planned IDs (seed 42, independently computed from the official JSON):

```
gpt4_2f8be40d          multi-session
e5ba910e_abs           multi-session (abstention)
545bd2b5               single-session-user
9d25d4e0               multi-session
gpt4_b5700ca9          temporal-reasoning
16c90bf4               single-session-assistant
gpt4_b4a80587          temporal-reasoning
b759caee               single-session-assistant
gpt4_65aabe59          temporal-reasoning
19b5f2b3_abs           single-session-user (abstention)
195a1a1b               single-session-preference
gpt4_e05b82a6          multi-session
b9cfe692               temporal-reasoning
58470ed2               single-session-assistant
08e075c7               knowledge-update
```

Type mix: multi-session 4, temporal-reasoning 4, single-session-assistant 3,
single-session-user 2, single-session-preference 1, knowledge-update 1
(includes 2 official abstention IDs).

## 3–5) Models / scores / blocker

Filled after the live run. If Ollama is down, this file will say **BLOCKED**
and we will not invent scores.
