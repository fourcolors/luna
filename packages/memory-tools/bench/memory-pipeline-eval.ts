/**
 * End-to-end scoped-memory baseline. Uses a fresh DB so corpus state is
 * deterministic; set LUNA_EMBEDDER=ollama for semantic quality runs.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect, Layer, Stream } from "effect"
import {
  Clock,
  EmbedderService,
  ObservabilityService,
  StubEmbedderLayer,
} from "@luna/core"
import {
  checkEmbeddingEvalPreflight,
  packRecallContext,
  scoreRetrievalEval,
} from "@luna/memory-tools"
import {
  getMemoryVectorStatus,
  LunaSqliteBootstrapLive,
  makeRecord,
  MemoryLayer,
  MemoryRouterTag,
  SqliteVectorBackend,
  type MemoryScope,
  type MemoryScopeQuery,
} from "@luna/memory"

type CandidateKind = "durable-fact" | "belief-evidence"
interface Corpus {
  readonly version: string
  readonly records: ReadonlyArray<{
    readonly id: string
    readonly text: string
    readonly scope: MemoryScope
  }>
  readonly retrievalCases: ReadonlyArray<{
    readonly id: string
    readonly query: string
    readonly scope: MemoryScopeQuery
    readonly relevantIds: ReadonlyArray<string>
    readonly forbiddenIds: ReadonlyArray<string>
  }>
  readonly extractionCases: ReadonlyArray<{
    readonly id: string
    readonly userText: string
    readonly expectedKinds: ReadonlyArray<CandidateKind>
  }>
}

const here = dirname(fileURLToPath(import.meta.url))
const corpus = JSON.parse(
  readFileSync(resolve(here, "memory-pipeline-corpus.json"), "utf8"),
) as Corpus
const embedderLayer =
  process.env["LUNA_EMBEDDER"]?.toLowerCase() === "ollama"
    ? (await import("@luna/core")).makeOllamaEmbedderLayer({
        ...(process.env["LUNA_OLLAMA_EMBED_MODEL"] !== undefined
          ? { model: process.env["LUNA_OLLAMA_EMBED_MODEL"] }
          : {}),
      })
    : StubEmbedderLayer
const support = Layer.mergeAll(
  embedderLayer,
  Clock.Default,
  LunaSqliteBootstrapLive,
  ObservabilityService.Default.pipe(Layer.provide(Clock.Default)),
)
// On-disk DB (not :memory:) so the preflight can reopen the same file after the
// backend scope closes and read the ACTUAL stored vector dimensions, rather
// than echoing the active dimension back at itself.
const dbDir = mkdtempSync(join(tmpdir(), "luna-pipeline-eval-"))
const dbPath = join(dbDir, "memory.db")
const layer = Layer.unwrapEffect(
  Effect.gen(function* () {
    const backend = yield* SqliteVectorBackend
    return MemoryLayer({ rules: [{ pattern: "*", backend }] })
  }),
).pipe(
  Layer.provideMerge(SqliteVectorBackend.fromPath(dbPath)),
  Layer.provideMerge(support),
)

const scored = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const router = yield* MemoryRouterTag
      const embedder = yield* EmbedderService
      for (const record of corpus.records) {
        yield* router.put(
          makeRecord({
            id: record.id,
            namespace: "pipeline-eval",
            kind: "semantic",
            content: { text: record.text },
            scope: record.scope,
            provenance: { source: "migration" },
          }),
        )
      }
      const retrieval = []
      for (const evalCase of corpus.retrievalCases) {
        const hits = yield* Stream.runCollect(
          router.search({
            queryText: evalCase.query,
            namespace: "pipeline-eval",
            mode: "hybrid",
            topK: 5,
            scope: evalCase.scope,
          }),
        )
        const ranked = Array.from(hits)
        const packed = packRecallContext(ranked)
        retrieval.push({
          caseId: evalCase.id,
          relevantIds: evalCase.relevantIds,
          forbiddenIds: evalCase.forbiddenIds,
          returnedIds: ranked.map((hit) => hit.record.id),
          packedChars: packed?.text.length ?? 0,
          truncated: packed?.truncated ?? false,
        })
      }
      return {
        corpusVersion: corpus.version,
        embedder,
        retrieval: scoreRetrievalEval(retrieval),
      }
    }),
  ).pipe(Effect.provide(layer)),
)

try {
  // The backend scope has closed, so the file holds every committed vector.
  // Read the real per-row dimensions the corpus was embedded at; the preflight
  // then refuses to score when they disagree with the active embedder.
  const status = await Effect.runPromise(
    getMemoryVectorStatus({ dbPath, embedder: scored.embedder }),
  )
  const result = {
    corpusVersion: scored.corpusVersion,
    embedder: {
      provider: scored.embedder.provider,
      model: scored.embedder.model,
      dimension: scored.embedder.dimension,
    },
    preflight: checkEmbeddingEvalPreflight({
      activeDimension: scored.embedder.dimension,
      storedDimensions: status.groups.map((group) => group.dimension),
    }),
    retrieval: scored.retrieval,
  }

  console.log(JSON.stringify(result, null, 2))
  if (
    !result.preflight.valid ||
    result.retrieval.recallAtK < 1 ||
    result.retrieval.forbiddenHitRate > 0
  ) {
    process.exitCode = 1
  }
} finally {
  rmSync(dbDir, { recursive: true, force: true })
}
