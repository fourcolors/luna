/**
 * ingest — one MemoryRecord per LongMemEval haystack turn via
 * MemoryRouter.put() (same write path memory_save uses in
 * packages/memory-tools/src/tools.ts). Direct router API, not MCP:
 * this is a batch script inside the monorepo; the MCP surface adds
 * nothing here. See locomo-eval/ingest.ts for the same rationale.
 *
 * We ingest raw user/assistant turns ONLY. One record per turn,
 * kind "episodic", namespace-scoped per question_id so retrieval
 * cannot leak across independent LongMemEval instances.
 */
import { Effect } from "effect"
import { makeRecord, type MemoryRouter } from "@luna/memory"
import type { FlatTurn } from "./types.js"

export function namespaceFor(questionId: string): string {
  return `longmemeval-eval:${questionId}`
}

function recordId(turn: FlatTurn): string {
  return `lme_${turn.questionId}_${turn.sessionId}_${turn.turnIdx}`
}

function formatContent(turn: FlatTurn): string {
  return `[${turn.sessionDate}] ${turn.role}: ${turn.text}`
}

export function ingestInstance(
  router: MemoryRouter,
  turns: ReadonlyArray<FlatTurn>,
): Effect.Effect<number, never, never> {
  return Effect.gen(function* () {
    let count = 0
    for (const turn of turns) {
      const rec = makeRecord({
        id: recordId(turn),
        namespace: namespaceFor(turn.questionId),
        kind: "episodic",
        content: { text: formatContent(turn) },
        tags: [
          turn.questionId,
          `session:${turn.sessionId}`,
          turn.role,
          ...(turn.hasAnswer ? ["has_answer"] : []),
        ],
      })
      yield* router.put(rec).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            count++
          }),
        ),
        Effect.catch((cause) =>
          Effect.logWarning(`longmemeval-eval: put failed for ${rec.id}: ${String(cause)}`),
        ),
      )
    }
    return count
  })
}

export { recordId }
