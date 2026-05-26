import { Effect, Stream } from "effect"
import type { MemoryRouter } from "@luna/memory"
import type { MemorySearchHit, MemorySearchState } from "./panel-types.js"

export const runMemorySearch = async (
  router: MemoryRouter,
  query: string,
  topK: number,
): Promise<MemorySearchState> => {
  const trimmed = query.trim()
  if (trimmed.length === 0) return { status: "idle" }

  const program = Stream.runCollect(router.search({ queryText: trimmed, topK }))

  try {
    const chunk = await Effect.runPromise(program)
    const hits: MemorySearchHit[] = Array.from(chunk).map(({ record, score }) => ({
      id: record.id,
      kind: record.kind,
      content: typeof record.content === "string" ? record.content : JSON.stringify(record.content),
      score,
    }))
    return { status: "ready", query: trimmed, hits }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { status: "error", query: trimmed, message }
  }
}
