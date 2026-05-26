import type { LunaHeadlessSession } from "../chat/headless.js"
import type { MemorySearchHit, MemorySearchState } from "./panel-types.js"

type SessionWithSearchMemory = Pick<LunaHeadlessSession, "searchMemory">

export const runMemorySearch = async (
  session: SessionWithSearchMemory,
  query: string,
  topK: number,
): Promise<MemorySearchState> => {
  const trimmed = query.trim()
  if (trimmed.length === 0) return { status: "idle" }

  const frame = await session.searchMemory({ queryText: trimmed, topK })

  if (frame.type === "memory-search-error") {
    return { status: "error", query: trimmed, message: frame.message }
  }

  const hits: MemorySearchHit[] = frame.hits.map((h) => ({
    id: h.id,
    kind: h.kind,
    content: h.content,
    score: h.score,
  }))
  return { status: "ready", query: trimmed, hits }
}
