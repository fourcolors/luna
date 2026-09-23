/**
 * ingest - one MemoryRecord per LongMemEval haystack turn via
 * MemoryRouter.put() (same write path memory_save uses in
 * packages/memory-tools/src/tools.ts). Direct router API, not MCP:
 * this is a batch script inside the monorepo; the MCP surface adds
 * nothing here. See locomo-eval/ingest.ts for the same rationale.
 *
 * We ingest raw user/assistant turns ONLY. One record per turn,
 * kind "episodic", namespace-scoped per question_id so retrieval
 * cannot leak across independent LongMemEval instances.
 *
 * NEVER put gold labels in `tags`: SqliteVectorBackend embeds tags into the
 * vector input (formatMemoryRecordEmbeddingInput), so a label tag lets
 * retrieval see the answer key. That includes `has_answer` AND the session
 * id: LongMemEval names evidence sessions `answer_*` (the official
 * run_retrieval.py finds evidence by that substring). On the oracle split
 * every session is `answer_*`, but on S/M only evidence sessions are.
 * Evidence and sessions stay on the harness-side FlatTurn, matched back by
 * an opaque record id built from positions, never from session ids.
 *
 * A failed put() fails the whole ingest: scoring a partial haystack as if
 * it were complete would silently corrupt every downstream number.
 */
import { Effect } from "effect"
import type { MemoryBackendError } from "@luna/core"
import { makeRecord, type MemoryRouter } from "@luna/memory"
import type { FlatTurn } from "./types.js"

export function namespaceFor(questionId: string): string {
  return `longmemeval-eval:${questionId}`
}

function recordId(turn: FlatTurn): string {
  return `lme_${turn.questionId}_s${turn.sessionIdx}_t${turn.turnIdx}`
}

function formatContent(turn: FlatTurn): string {
  return `[${turn.sessionDate}] ${turn.role}: ${turn.text}`
}

export function ingestInstance(
  router: MemoryRouter,
  turns: ReadonlyArray<FlatTurn>,
): Effect.Effect<number, MemoryBackendError> {
  return Effect.gen(function* () {
    for (const turn of turns) {
      yield* router.put(
        makeRecord({
          id: recordId(turn),
          namespace: namespaceFor(turn.questionId),
          kind: "episodic",
          content: { text: formatContent(turn) },
          tags: [turn.role],
        }),
      )
    }
    return turns.length
  })
}

export { recordId }
