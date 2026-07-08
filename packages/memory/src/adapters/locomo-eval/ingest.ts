/**
 * ingest — turns a LoCoMo sample's flattened conversation turns into
 * `MemoryRecord`s and writes them via `MemoryRouter.put()` (the same
 * underlying call `memory_save` makes — see packages/memory-tools/src/
 * tools.ts). We call the router directly rather than spinning up the MCP
 * tool server: this is a batch script driving hundreds/thousands of writes
 * per run, and the MCP surface adds a JSON-RPC/tool-schema layer with no
 * benefit for a script that already lives inside the TypeScript monorepo.
 * The write path is otherwise IDENTICAL to what `memory_save` does:
 * `makeRecord` → `router.put`, `content: { text }`, same `kind` field.
 *
 * Ingestion scope (the structural-mismatch point, see README.md):
 * we ingest raw dialog turns ONLY, one MemoryRecord per turn, kind
 * "episodic". LoCoMo's own dataset ships pre-computed `observation` and
 * `session_summary` fields (Honcho-style ingest-time synthesis outputs);
 * we do NOT ingest those, because Luna's memory system has no equivalent
 * synthesis step at write time — memory_save stores exactly what it's
 * given. Ingesting the paper's own summaries would be testing THEIR
 * synthesis quality, not Luna's retrieval.
 */
import { Effect } from "effect"
import { makeRecord, type MemoryRouter } from "@luna/memory"
import type { FlatTurn } from "./types.js"

/** Namespace a sample's memories live under: one namespace per conversation. */
export function namespaceFor(sampleId: string): string {
  return `locomo-eval:${sampleId}`
}

function recordId(turn: FlatTurn): string {
  return `locomo-eval_${turn.sampleId}_${turn.diaId}`
}

function formatContent(turn: FlatTurn): string {
  return `[${turn.sessionDateTime}] ${turn.speaker}: ${turn.text}`
}

/** Ingest every turn of one sample into the router, scoped to its own namespace. */
export function ingestSample(
  router: MemoryRouter,
  turns: ReadonlyArray<FlatTurn>,
): Effect.Effect<number, never, never> {
  return Effect.gen(function* () {
    let count = 0
    for (const turn of turns) {
      const rec = makeRecord({
        id: recordId(turn),
        namespace: namespaceFor(turn.sampleId),
        kind: "episodic",
        content: { text: formatContent(turn) },
        tags: [turn.sampleId, `session:${turn.sessionNum}`, turn.speaker],
      })
      yield* router.put(rec).pipe(
        Effect.catchAll((cause) =>
          Effect.logWarning(`locomo-eval: put failed for ${rec.id}: ${String(cause)}`),
        ),
      )
      count++
    }
    return count
  })
}
