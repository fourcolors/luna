# SqliteVectorBackend — BDD Scenarios (Phase 25)

These scenarios drive the Phase 1 vector-search implementation. Each becomes
one or more vitest cases in `sqlite-vector.test.ts`.

---

## Scenario 1: Stub-embedder ranking is monotonic in lexical overlap

**Given** a `SqliteVectorBackend` provided with `EmbedderService.StubLayer`
**And** records with content `{ text: "cats and dogs" }`, `{ text: "dogs and birds" }`,
        `{ text: "submarines and torpedoes" }` are put in namespace `notes:*`
**When** I `search({ queryText: "cats", topK: 3 })`
**Then** the record containing "cats" ranks first
**And** "submarines and torpedoes" ranks last
**And** all three results have `score` between 0 and 1.

## Scenario 2: namespace filter is honored

**Given** records put in namespace `notes:public` and `notes:private` with similar text
**When** I `search({ queryText: "...", namespace: "notes:public" })`
**Then** only records from `notes:public` are returned.

## Scenario 3: topK enforced inside SQL/backend, not at caller

**Given** 50 records each with distinct text are put in `notes:*`
**When** I `search({ queryText: "any", topK: 5 })`
**Then** the stream yields exactly 5 results, ordered by descending `score`
**And** the SQL trace shows `LIMIT 5` (or equivalent) — we do not embed
       the query against all 50 vectors and truncate in JS.

## Scenario 4: put() with no content.text writes keyed-only (no vector row)

**Given** a record with `content: { foo: "bar" }` (no `text` field)
**When** I `put` it then `get(id)` it
**Then** the record round-trips through the keyed table
**And** `search({ queryText: "anything" })` does not return it
**And** the `memory_vectors` row count for that id is 0.

## Scenario 5: put() with content.text auto-embeds and writes both rows

**Given** a record with `content: { text: "hello world" }`
**When** I `put` it
**Then** a row exists in `memory_keyed` with that id
**And** a row exists in `memory_vectors` with that id
**And** the embedding BLOB has the embedder's declared `dimension * 4` bytes (Float32).

## Scenario 6: Float32Array <-> BLOB property round-trip

**Given** an embedder that returns a known Float32Array
**When** I `put` a record and then read the BLOB via raw SQL
**Then** decoding the BLOB back to Float32Array yields bytes equal to the original.

## Scenario 7: hybrid mode returns "not implemented" error

**Given** any vector backend
**When** I `search({ queryText: "...", mode: "hybrid" })`
**Then** the stream fails with `MemoryBackendError("hybrid not implemented")`.

## Scenario 8: MemoryRouter.search() dispatches to first matching vector backend

**Given** a router with rules:
        - `"notes:*"` → `SqliteVectorBackend`
        - `"*"`       → `InMemoryBackend` (keyed-only, no `search`)
**When** I `router.search({ queryText: "...", namespace: "notes:work" })`
**Then** the result comes from the sqlite-vector backend
**When** I `router.search({ queryText: "...", namespace: "tmp:foo" })`
**Then** the stream fails with `MemoryBackendError("router", "no vector backend for namespace tmp:foo")`.

## Scenario 9 (gated, opt-in): OllamaLayer end-to-end

**Given** `process.env.LUNA_TEST_OLLAMA === "1"` and Ollama is running locally
**When** I provide `EmbedderService.OllamaLayer` and put + search 3 records
**Then** results rank by semantic similarity (synonym test: "feline" matches "cat" record).

---

## Out of scope for Phase 1

- BM25 / FTS5 hybrid scoring (`mode: "hybrid"` returns not-impl)
- HyDE
- sqlite-vec extension (deferred until naive >100ms @ 5k rows)
- Re-embed-on-rerun optimization (always re-embed)
- InMemoryVectorBackend (stub embedder + sqlite `:memory:` covers tests)
