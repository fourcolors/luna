/**
 * Memory tools — three SDK MCP tool definitions exposed to the chat agent:
 *
 *   - memory_save(text, kind?, tags?, namespace?) → { id }
 *   - memory_search(query, kind?, limit?, namespace?)
 *       → [{ id, text, score, tags, kind, namespace, createdAt, updatedAt,
 *            scope? }]
 *   - memory_delete(id) → { deleted }
 *
 * `makeMemoryTools(router, scope?)` binds every tool to a `MemoryScope`
 * (defaulting to `OPERATOR_MEMORY_SCOPE`, i.e. `luna` observing `operator`):
 * `memory_save` stamps records with that scope plus `provenance.source =
 * "manual"`, `memory_search` filters hits to the bound observer/subject (and
 * echoes each hit's stored scope when present), and `memory_delete` no-ops
 * (returns `{ deleted: false }`) on records outside the bound scope.
 *
 * Implementation routes through `MemoryRouter` (Phase 25 router Tag) — this
 * keeps the tools agnostic to the underlying backend (sqlite-vector for the
 * chat dev rig, in-memory in tests).
 *
 * Notes:
 *   - `memory_get` was intentionally dropped per Phase 30 plan — search
 *     subsumes it for v1 (a search hit returns the full record body).
 *   - Records are stored with `content: { text }` so the sqlite-vector
 *     backend's auto-embed path (which keys off `content.text`) fires on
 *     every save.
 *   - `kind` is a first-class field on `MemoryRecord`. Conventional values
 *     are `"semantic"` (durable facts — the default), `"episodic"` (events),
 *     `"procedural"` (how-to / skills), `"prospective"` (future intentions),
 *     but the field is open — callers may pass any string. Records written
 *     before Phase 30b have `kind: "note"`.
 *   - Default namespace is `"notes"` — single-bucket so search without a
 *     namespace argument finds anything the agent has written.
 *   - `kind` filtering on search is implemented as a post-filter on the
 *     hybrid hits with a 4× over-fetch (min 20). The router/backend search
 *     surface is intentionally unchanged so the blast radius stays small.
 *   - Tools live in @luna/memory-tools (not @luna/tools) so the @luna/tools
 *     package stays a domain-free Runtime helper.
 */
import { Effect, Stream } from "effect"
import { z } from "zod"
import { defineTool, ToolError } from "@luna/tools"
import {
  makeRecord,
  matchesMemoryScope,
  OPERATOR_MEMORY_SCOPE,
  type MemoryRouter,
  type MemoryScope,
} from "@luna/memory"

const DEFAULT_NAMESPACE = "notes"
const DEFAULT_KIND = "semantic"
const MEMORY_TOOL_DISCOVERY = {
  alwaysLoad: true,
  searchHint:
    "Long-term memory tools for saving, searching, and deleting durable user facts, preferences, project context, and prior conversation notes.",
} as const

const KIND_SAVE_HINT =
  'Optional memory kind tag. Conventional values: "semantic" ' +
  "(durable facts — the default), \"episodic\" (time-stamped events), " +
  '"procedural" (how-to / skills), "prospective" (future intentions). ' +
  "The field is open — any string is accepted."

const KIND_SEARCH_HINT =
  "Restrict search to records of this kind. Conventional values match " +
  '`memory_save`: "semantic", "episodic", "procedural", "prospective". ' +
  'Records written before this field was exposed have kind "note".'

// We don't import Zod types from the SDK; the SDK accepts a raw shape
// (Record<string, ZodType>) and treats it opaquely. zod v4 ships flat
// `z.string()` etc — same shape Phase 25 already uses elsewhere.

const saveShape = {
  text: z.string().min(1).describe("The memory text to save."),
  kind: z.string().optional().describe(KIND_SAVE_HINT),
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
  kind: z.string().optional().describe(KIND_SEARCH_HINT),
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
export const makeMemoryTools = (
  router: MemoryRouter,
  scope: MemoryScope = OPERATOR_MEMORY_SCOPE,
) => {
  const save = defineTool({
    name: "memory_save",
    description:
      "Save a piece of text to long-term memory. Returns the new record id. " +
      "Use this to remember durable facts the user mentions about themselves, " +
      "their projects, or their preferences — anything you'd want to recall in " +
      "a future conversation. Optionally pass `kind` to tag the memory as " +
      '"semantic" (default), "episodic", "procedural", or "prospective".',
    inputSchema: saveShape,
    ...MEMORY_TOOL_DISCOVERY,
    handler: (args) =>
      Effect.gen(function* () {
        const id = newId()
        const namespace = args.namespace ?? DEFAULT_NAMESPACE
        const kind = args.kind ?? DEFAULT_KIND
        const rec = makeRecord({
          id,
          namespace,
          kind,
          content: { text: args.text },
          tags: args.tags ?? [],
          scope,
          provenance: { source: "manual" },
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
      "to `limit` hits ranked by hybrid BM25+vector score. Each hit includes " +
      "`id`, `text`, `score`, `tags`, `kind`, `namespace`, `createdAt`, and " +
      "`updatedAt` (epoch ms). Use this BEFORE answering questions about the " +
      "user's prior context, preferences, or anything you might have stored " +
      "earlier with memory_save. Pass `kind` to restrict to a single memory " +
      'kind (e.g. "semantic", "episodic", "procedural", "prospective").',
    inputSchema: searchShape,
    ...MEMORY_TOOL_DISCOVERY,
    handler: (args) =>
      Effect.gen(function* () {
        const limit = args.limit ?? 5
        const namespace = args.namespace ?? DEFAULT_NAMESPACE
        const kindFilter = args.kind
        // Over-fetch when a kind filter is set so the post-filter still
        // has enough candidates to return `limit` matches. 4× with a floor
        // of 20 is a heuristic — good enough for the local store sizes
        // we see in practice.
        const fetchTopK =
          kindFilter !== undefined ? Math.max(limit * 4, 20) : limit
        const hits = yield* Stream.runCollect(
          router.search({
            queryText: args.query,
            topK: fetchTopK,
            namespace,
            mode: "hybrid",
            scope: {
              observerId: scope.observerId,
              subjectId: scope.subjectId,
            },
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
        const all = Array.from(hits)
        const filtered =
          kindFilter !== undefined
            ? all.filter((h) => h.record.kind === kindFilter)
            : all
        return filtered.slice(0, limit).map((h) => ({
          id: h.record.id,
          text: extractText(h.record.content),
          score: h.score,
          tags: h.record.tags,
          kind: h.record.kind,
          namespace: h.record.namespace,
          createdAt: h.record.createdAt,
          updatedAt: h.record.updatedAt,
          ...(h.record.scope !== undefined
            ? {
                scope: {
                  observerId: h.record.scope.observerId,
                  subjectId: h.record.scope.subjectId,
                  visibility: h.record.scope.visibility,
                },
              }
            : {}),
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
    ...MEMORY_TOOL_DISCOVERY,
    handler: (args) =>
      Effect.gen(function* () {
        const existing = yield* router.get(args.id).pipe(
          Effect.mapError(
            (cause) =>
              new ToolError({
                tool: "memory_delete",
                op: "get",
                cause,
              }),
          ),
        )
        if (
          existing === null ||
          !matchesMemoryScope(existing, {
            observerId: scope.observerId,
            subjectId: scope.subjectId,
          })
        ) {
          return { deleted: false } as const
        }
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
