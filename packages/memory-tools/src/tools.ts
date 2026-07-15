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
 *   - memory_search reranking (Phase 3, PR #332 bench): when
 *     LUNA_MEMORY_RERANK=1 AND a MemoryReranker was passed to
 *     makeMemoryTools, search over-fetches to at least 20 candidates,
 *     reranks them, and gates via applyRerank (score>=LUNA_RERANK_THRESHOLD,
 *     default 75) before slicing to `limit`. DEFAULT OFF - with no reranker
 *     passed and/or the flag unset, behavior is byte-identical to before.
 *     A rerank failure (timeout/parse/SDK error) falls back to the
 *     un-reranked hybrid order; it never fails the tool call.
 */
import { Effect, Stream } from "effect"
import { z } from "zod"
import { defineTool, ToolError } from "@luna/tools"
import {
  applyRerank,
  type MemoryRerankerApi,
  type ObservabilityApi,
} from "@luna/core"
import {
  makeRecord,
  matchesMemoryScope,
  OPERATOR_MEMORY_SCOPE,
  type MemoryRecord,
  type MemoryRouter,
  type MemoryScope,
} from "@luna/memory"
import {
  emitRerankObservability,
  logRerankFailureOnce,
  rerankFlagEnabled,
  resolveRerankThreshold,
} from "./rerank-support.js"

/** Minimum over-fetch when rerank is active - matches the bench's TOP_K=20
 * (packages/memory/bench/rerank-eval.ts), the pool size the 0.734 -> 0.878
 * recall@1 lift was measured against. */
const RERANK_OVERFETCH_TOP_K = 20

export interface MakeMemoryToolsOptions {
  readonly reranker?: MemoryRerankerApi
  readonly observability?: ObservabilityApi
}

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
 * Build the wire DTO for one search hit. `llmScore` is present only when
 * memory_search reranked this result (LUNA_MEMORY_RERANK=1 + a reranker was
 * provided) - absent on the default, un-reranked path, so the DTO shape is
 * byte-identical to before when rerank isn't in play.
 */
function toSearchHitDTO(
  hit: { readonly record: MemoryRecord; readonly score: number },
  llmScore?: number,
) {
  return {
    id: hit.record.id,
    text: extractText(hit.record.content),
    score: hit.score,
    tags: hit.record.tags,
    kind: hit.record.kind,
    namespace: hit.record.namespace,
    createdAt: hit.record.createdAt,
    updatedAt: hit.record.updatedAt,
    ...(llmScore !== undefined ? { llmScore } : {}),
    ...(hit.record.scope !== undefined
      ? {
          scope: {
            observerId: hit.record.scope.observerId,
            subjectId: hit.record.scope.subjectId,
            visibility: hit.record.scope.visibility,
          },
        }
      : {}),
  }
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
  options: MakeMemoryToolsOptions = {},
) => {
  const { reranker, observability } = options
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
        const rerankRequested =
          reranker !== undefined && rerankFlagEnabled("LUNA_MEMORY_RERANK")
        // Over-fetch when a kind filter is set so the post-filter still has
        // enough candidates to return `limit` matches (4× with a floor of
        // 20 - a heuristic good enough for the local store sizes we see in
        // practice), OR when rerank is active (floor of RERANK_OVERFETCH_TOP_K,
        // the pool size the bench's recall lift was measured against).
        const kindOverfetch =
          kindFilter !== undefined ? Math.max(limit * 4, 20) : limit
        const fetchTopK = rerankRequested
          ? Math.max(kindOverfetch, RERANK_OVERFETCH_TOP_K)
          : kindOverfetch
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

        if (!rerankRequested) {
          return filtered.slice(0, limit).map((h) => toSearchHitDTO(h))
        }

        const startMs = Date.now()
        // sandbox() (not just either()) so DEFECTS in SDK/broker plumbing
        // degrade to un-reranked results too - memory_search must never
        // fail because reranking failed, matching recallForTurn's
        // catchAllCause guarantee.
        const outcome = yield* reranker!
          .rerank({
            queryText: args.query,
            candidates: filtered.map((h) => ({
              id: h.record.id,
              text: extractText(h.record.content),
              retrievalScore: h.score,
            })),
          })
          .pipe(Effect.sandbox, Effect.either)

        if (outcome._tag === "Left") {
          yield* logRerankFailureOnce("memory_search", outcome.left)
          return filtered.slice(0, limit).map((h) => toSearchHitDTO(h))
        }

        const threshold = resolveRerankThreshold()
        const byId = new Map(filtered.map((h) => [h.record.id, h] as const))
        const { kept, droppedCount } = applyRerank(
          filtered.map((h) => ({ id: h.record.id })),
          outcome.right,
          { threshold },
        )
        const rerankMs = Date.now() - startMs
        yield* emitRerankObservability(observability, {
          queryText: args.query,
          namespace,
          mode: "hybrid",
          rerankMs,
          kept: kept.length,
          dropped: droppedCount,
        })

        return kept.slice(0, limit).map(({ candidate, llmScore }) =>
          toSearchHitDTO(byId.get(candidate.id)!, llmScore),
        )
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
