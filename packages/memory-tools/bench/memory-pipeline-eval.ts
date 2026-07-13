/**
 * End-to-end scoped-memory baseline. Uses a fresh DB so corpus state is
 * deterministic; set LUNA_EMBEDDER=ollama for semantic quality runs.
 */
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
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
  extractTurnCandidates,
  packRecallContext,
  scoreExtractionEval,
  scoreRetrievalEval,
} from "@luna/memory-tools"
import {
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
const layer = Layer.unwrapEffect(
  Effect.gen(function* () {
    const backend = yield* SqliteVectorBackend
    return MemoryLayer({ rules: [{ pattern: "*", backend }] })
  }),
).pipe(
  Layer.provideMerge(SqliteVectorBackend.fromPath(":memory:")),
  Layer.provideMerge(support),
)

const result = await Effect.runPromise(
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
      const extraction = corpus.extractionCases.map((evalCase) => ({
        caseId: evalCase.id,
        expectedKinds: evalCase.expectedKinds,
        candidates: extractTurnCandidates({
          userText: evalCase.userText,
          scope: {
            observerId: "luna",
            subjectId: "operator",
            visibility: "private",
          },
        }),
      }))
      return {
        corpusVersion: corpus.version,
        embedder: {
          provider: embedder.provider,
          model: embedder.model,
          dimension: embedder.dimension,
        },
        preflight: checkEmbeddingEvalPreflight({
          activeDimension: embedder.dimension,
          storedDimensions: [embedder.dimension],
        }),
        retrieval: scoreRetrievalEval(retrieval),
        extraction: scoreExtractionEval(extraction),
      }
    }),
  ).pipe(Effect.provide(layer)),
)

console.log(JSON.stringify(result, null, 2))
if (
  !result.preflight.valid ||
  result.retrieval.recallAtK < 1 ||
  result.retrieval.forbiddenHitRate > 0 ||
  result.extraction.recall < 1
) {
  process.exitCode = 1
}
