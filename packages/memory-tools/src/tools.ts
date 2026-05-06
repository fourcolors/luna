/**
 * Memory tools — three SDK MCP tool definitions exposed to the chat agent:
 *
 *   - memory_save(text, tags?, namespace?) → { id }
 *   - memory_search(query, limit?, namespace?) → [{ id, text, score, tags }]
 *   - memory_delete(id) → { deleted }
 *
 * Implementation routes through `MemoryRouter` (Phase 25 router Tag) — this
 * keeps the tools agnostic to the underlying backend (sqlite-vector for the
 * chat dev rig, in-memory in tests).
 *
 * Notes:
 *   - `memory_get` was intentionally dropped per Phase 30 plan — search
 *     subsumes it for v1 (a search hit returns the full record body).
 *   - Records are stored with `kind: "note"` and `content: { text }` so the
 *     sqlite-vector backend's auto-embed path (which keys off `content.text`)
 *     fires on every save.
 *   - Default namespace is `"notes"` — single-bucket so search without a
 *     namespace argument finds anything the agent has written.
 *   - Tools live in @luna/memory-tools (not @luna/tools) so the @luna/tools
 *     package stays a domain-free Runtime helper.
 */
import { Effect, Stream } from "effect"
import { z } from "zod"
import { defineTool, ToolError } from "@luna/tools"
import { makeRecord, type MemoryRouter } from "@luna/memory"

const DEFAULT_NAMESPACE = "notes"

// We don't import Zod types from the SDK; the SDK accepts a raw shape
// (Record<string, ZodType>) and treats it opaquely. zod v4 ships flat
// `z.string()` etc — same shape Phase 25 already uses elsewhere.

const saveShape = {
  text: z.string().min(1).describe("The memory text to save."),
  tags: z
    .array(z.string())
    .optional()
    .describe("Optional tags to attach to this memory."),
  namespace: z
    .string()
    .optional()
    .describe(
      `Optional namespace bucket. Defaults to "${DEFAULT_NAMESPACE}".`,
    ),
}

const searchShape = {
  query: z.string().min(1).describe("Natural-language search query."),
  limit: z
    .number()
    .int()
    .positive()
    .max(50)
    .optional()
    .describe("Maximum number of hits to return. Default 5."),
  namespace: z
    .string()
    .optional()
    .describe(
      `Restrict search to this namespace. Defaults to "${DEFAULT_NAMESPACE}".`,
    ),
}

const deleteShape = {
  id: z.string().min(1).describe("ID of the memory record to delete."),
}

function newId(): string {
  // Crockford-ish base36 timestamp + 6 random chars — stable, sortable,
  // collision-resistant enough for a single-process local store.
  const ts = Date.now().toString(36)
  const rnd = Math.random().toString(36).slice(2, 8).padEnd(6, "0")
  return `mem_${ts}_${rnd}`
}

function extractText(content: unknown): string {
  if (
    content !== null &&
    typeof content === "object" &&
    "text" in content &&
    typeof (content as { text: unknown }).text === "string"
  ) {
    return (content as { text: string }).text
  }
  return ""
}

/**
 * Build the three memory tools bound to a resolved MemoryRouter handle.
 *
 * `defineTool` requires handlers with no Effect requirements (the SDK
 * boundary uses `Effect.runPromise`, no env). We close over the router
 * here so the tool definitions are self-contained at the SDK boundary;
 * Layer wiring happens upstream in `MemoryToolsLayer`.
 */
export const makeMemoryTools = (router: MemoryRouter) => {
  const save = defineTool({
    name: "memory_save",
    description:
      "Save a piece of text to long-term memory. Returns the new record id. " +
      "Use this to remember durable facts the user mentions about themselves, " +
      "their projects, or their preferences — anything you'd want to recall in " +
      "a future conversation.",
    inputSchema: saveShape,
    handler: (args) =>
      Effect.gen(function* () {
        const id = newId()
        const namespace = args.namespace ?? DEFAULT_NAMESPACE
        const rec = makeRecord({
          id,
          namespace,
          kind: "note",
          content: { text: args.text },
          tags: args.tags ?? [],
        })
        yield* router.put(rec).pipe(
          Effect.mapError(
            (cause) =>
              new ToolError({ tool: "memory_save", op: "put", cause }),
          ),
        )
        return { id } as const
      }),
  })

  const search = defineTool({
    name: "memory_search",
    description:
      "Search long-term memory for records relevant to a query. Returns up " +
      "to `limit` hits ranked by hybrid BM25+vector score. Use this BEFORE " +
      "answering questions about the user's prior context, preferences, or " +
      "anything you might have stored earlier with memory_save.",
    inputSchema: searchShape,
    handler: (args) =>
      Effect.gen(function* () {
        const limit = args.limit ?? 5
        const namespace = args.namespace ?? DEFAULT_NAMESPACE
        const hits = yield* Stream.runCollect(
          router.search({
            queryText: args.query,
            topK: limit,
            namespace,
          }),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new ToolError({
                tool: "memory_search",
                op: "search",
                cause,
              }),
          ),
        )
        return Array.from(hits).map((h) => ({
          id: h.record.id,
          text: extractText(h.record.content),
          score: h.score,
          tags: h.record.tags,
        }))
      }),
  })

  const del = defineTool({
    name: "memory_delete",
    description:
      "Delete a memory record by id. Returns { deleted: true } when a row " +
      "was removed, { deleted: false } when no record matched. Use only " +
      "when the user explicitly asks to forget something.",
    inputSchema: deleteShape,
    handler: (args) =>
      Effect.gen(function* () {
        const removed = yield* router.delete(args.id).pipe(
          Effect.mapError(
            (cause) =>
              new ToolError({
                tool: "memory_delete",
                op: "delete",
                cause,
              }),
          ),
        )
        return { deleted: removed } as const
      }),
  })

  return [save, search, del] as const
}
