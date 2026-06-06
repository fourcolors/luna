/**
 * Observability tools — five SDK MCP tool definitions for Luna's self-observation:
 *
 *   obs_note(kind, summary, payload?, session_id?)
 *     → { id, kind, summary, ts }
 *     Write a durable self-observation note. Kind is open-ended:
 *     "goal_declared", "progress", "decision", "reflection", "obstacle", etc.
 *
 *   obs_notes_recent(session_id?, kind?, limit?)
 *     → [{ id, kind, summary, ts, payload }]
 *     Query recent AgentNotes for context reconstruction or daily review.
 *
 *   obs_session_explain(session_id)
 *     → { sessionId, model, startTime, endTime, duration_ms, messageCount,
 *          toolUsageCount, errorCount, successCount }
 *     Detailed breakdown of one session's behavior from the events table.
 *
 *   obs_session_anomalies(error_rate?, duration_ms?)
 *     → [{ sessionId, model, errorCount, totalEvents, durationMs }]
 *     Find sessions above an anomaly threshold (high errors, long duration).
 *     Self-improvement entry point: surface sessions worth reviewing.
 *
 *   obs_sessions_search(session_id?, tool_name?, start_time?, end_time?, limit?)
 *     → [{ sessionId, model, startTime, endTime, toolCalls, errorCount, successCount, durationMs }]
 *     Search session history with optional filters. Returns session-level summaries.
 *
 * Implementation:
 *   - AgentNotesService and AnalyticsService are resolved by ObsToolsLayer
 *     and closed over here — handlers have no Effect requirements at the
 *     SDK boundary (same pattern as memory-tools / scheduler-tools).
 *   - DuckDbService is accessed only through AnalyticsService (not directly).
 *   - AgentNotes lives in SQLite (luna.db); events/sessions live in DuckDB
 *     (analytics.duckdb). Both are abstracted behind their Effect service tags.
 */
import { Effect } from "effect"
import { z } from "zod"
import { defineTool, ToolError } from "@luna/tools"
import type { JSONOutput } from "@luna/tools"
import type { AgentNote, AgentNotesApi, AnalyticsApi } from "@luna/core"

// ── Input schemas ─────────────────────────────────────────────────────────────

const noteShape = {
  kind: z
    .string()
    .min(1)
    .describe(
      "Kind of observation. Open-ended — common values: " +
        "'goal_declared', 'progress', 'decision', 'reflection', 'obstacle', 'goal_revised'. " +
        "Use whatever is most meaningful for the current context.",
    ),
  summary: z
    .string()
    .min(1)
    .describe(
      "Short human-readable summary of this observation (1-3 sentences). " +
        "This is what will be surfaced when reconstructing context later.",
    ),
  payload: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Optional structured metadata to attach (arbitrary JSON object)."),
  session_id: z
    .string()
    .optional()
    .describe(
      "Session ID to associate this note with. Defaults to the current session " +
        "if omitted — use an explicit id when recording notes about a past session.",
    ),
}

const notesRecentShape = {
  session_id: z
    .string()
    .optional()
    .describe(
      "Filter to notes from this session. Omit to query across all sessions.",
    ),
  kind: z
    .string()
    .optional()
    .describe("Filter to notes of this kind (e.g. 'progress', 'decision')."),
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .describe("Maximum number of notes to return. Default 20."),
}

const sessionExplainShape = {
  session_id: z
    .string()
    .min(1)
    .describe(
      "ID of the session to explain. Queries the events + sessions tables " +
        "to produce a full tool-usage and error breakdown.",
    ),
}

const sessionAnomaliesShape = {
  error_rate: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      "Sessions whose error/total-event ratio exceeds this threshold are flagged. " +
        "Default 0.3 (30% error rate). Set to 0 to return all sessions with any errors.",
    ),
  duration_ms: z
    .number()
    .positive()
    .optional()
    .describe(
      "Sessions longer than this many milliseconds are also flagged " +
        "(in addition to the error-rate threshold). E.g. 3600000 for 1 hour.",
    ),
}

const eventsSearchShape = {
  session_id: z
    .string()
    .optional()
    .describe("Filter to sessions containing this session ID."),
  tool_name: z
    .string()
    .optional()
    .describe("Filter to sessions that used this tool (e.g. 'Read', 'Bash', 'Agent')."),
  start_time: z
    .string()
    .optional()
    .describe("ISO 8601 timestamp — only return events at or after this time."),
  end_time: z
    .string()
    .optional()
    .describe("ISO 8601 timestamp — only return events at or before this time."),
  limit: z
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .describe("Maximum number of events to return. Default 50."),
}

const OBS_TOOL_DISCOVERY = {
  alwaysLoad: true,
  searchHint:
    "Observability tools for writing self-observation notes and inspecting recent notes, session history, anomalies, and tool usage.",
} as const

// ── Tool factory ──────────────────────────────────────────────────────────────

/**
 * Build the five observability tools closed over the resolved service handles.
 *
 * `currentSessionId` is a thunk (not a static string) so it resolves lazily
 * at tool-call time, letting the chat-server set the binding after the thread
 * has been created.
 */
export const makeObsTools = (
  notes: AgentNotesApi,
  analytics: AnalyticsApi,
  /** Returns the current session id (or null if unknown). */
  currentSessionId: () => string | null,
) => {
  // ── obs_note ────────────────────────────────────────────────────────────────

  const obsNote = defineTool({
    name: "obs_note",
    description:
      "Write a durable self-observation note — a record in Luna's behavioral ledger. " +
      "Use this to capture goals, progress, decisions, and reflections throughout a session. " +
      "These notes survive context resets and form the foundation for daily self-review. " +
      "Examples: kind='goal_declared' when Operator states intent; kind='progress' at " +
      "key milestones; kind='decision' when choosing between approaches; " +
      "kind='reflection' at session end to summarize what was accomplished.",
    inputSchema: noteShape,
    ...OBS_TOOL_DISCOVERY,
    handler: (args) =>
      Effect.gen(function* () {
        const sessionId = args.session_id ?? currentSessionId() ?? "unknown"
        const note = yield* notes
          .record({
            sessionId,
            kind: args.kind,
            summary: args.summary,
            payload: args.payload,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ToolError({ tool: "obs_note", op: "record", cause }),
            ),
          )
        return {
          id: note.id,
          kind: note.kind,
          summary: note.summary,
          ts: note.ts,
        } as const
      }),
  })

  // ── obs_notes_recent ────────────────────────────────────────────────────────

  const obsNotesRecent = defineTool({
    name: "obs_notes_recent",
    description:
      "Query recent self-observation notes. Use this to reconstruct context after a " +
      "context-window reset ('what was I working on?'), or to review prior session " +
      "goals/decisions before starting new work. Filters by session, kind, or both. " +
      "Returns notes sorted newest-first.",
    inputSchema: notesRecentShape,
    ...OBS_TOOL_DISCOVERY,
    handler: (args) =>
      Effect.gen(function* () {
        const limit = args.limit ?? 20

        let noteList: ReadonlyArray<AgentNote> = []

        if (args.session_id) {
          if (args.kind) {
            // session + kind filter — fetch more than limit to avoid missing
            // matches when the first `limit` rows belong to other sessions
            const byKind = yield* notes
              .getByKind(args.kind, limit * 5)
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new ToolError({
                      tool: "obs_notes_recent",
                      op: "getByKind",
                      cause,
                    }),
                ),
              )
            noteList = byKind.filter((n) => n.sessionId === args.session_id)
          } else {
            const bySession = yield* notes
              .getRecent(args.session_id, limit)
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new ToolError({
                      tool: "obs_notes_recent",
                      op: "getRecent",
                      cause,
                    }),
                ),
              )
            noteList = bySession
          }
        } else if (args.kind) {
          noteList = yield* notes
            .getByKind(args.kind, limit)
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ToolError({
                    tool: "obs_notes_recent",
                    op: "getByKind",
                    cause,
                  }),
              ),
            )
        } else {
          // No filter — return globally most-recent notes across ALL sessions.
          // This is the documented "what was I working on?" context-recovery
          // path; previously this branch returned `[]` if no current session,
          // and current-session-only otherwise, both of which defeat the
          // tool's purpose after a context reset. See issue #10.
          noteList = yield* notes
            .getRecentAcrossSessions(limit)
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ToolError({
                    tool: "obs_notes_recent",
                    op: "getRecentAcrossSessions",
                    cause,
                  }),
              ),
            )
        }

        return noteList.slice(0, limit).map((n) => ({
          id: n.id,
          kind: n.kind,
          summary: n.summary,
          ts: n.ts,
          payload: n.payload as JSONOutput,
        }))
      }),
  })

  // ── obs_session_explain ─────────────────────────────────────────────────────

  const obsSessionExplain = defineTool({
    name: "obs_session_explain",
    description:
      "Get a detailed breakdown of one session: model used, start/end times, " +
      "total duration, per-tool usage counts, error count, and success count. " +
      "Use this to understand why a past session behaved as it did — prerequisite " +
      "to any targeted self-improvement on tool efficiency or error patterns.",
    inputSchema: sessionExplainShape,
    ...OBS_TOOL_DISCOVERY,
    handler: (args) =>
      Effect.gen(function* () {
        const detail = yield* analytics
          .explainSession(args.session_id)
          .pipe(
            Effect.mapError(
              (cause) =>
                new ToolError({
                  tool: "obs_session_explain",
                  op: "explainSession",
                  cause,
                }),
            ),
          )
        return {
          sessionId: detail.sessionId,
          model: detail.entrypoint,
          startTime: detail.sessionStartTime,
          endTime: detail.sessionEndTime,
          durationMs: detail.metrics.totalDuration,
          messageCount: detail.messageCount,
          toolUsageCount: detail.metrics.toolUsageCount,
          errorCount: detail.metrics.errorCount,
          successCount: detail.metrics.successCount,
        } as const
      }),
  })

  // ── obs_session_anomalies ───────────────────────────────────────────────────

  const obsSessionAnomalies = defineTool({
    name: "obs_session_anomalies",
    description:
      "Find sessions that look anomalous: high error rates or unusually long duration. " +
      "The default error-rate threshold is 0.3 (30%). Returned sessions are worth " +
      "reviewing with obs_session_explain or obs_sessions_search to understand what " +
      "went wrong. Primary entry point for daily self-improvement feedback loops.",
    inputSchema: sessionAnomaliesShape,
    ...OBS_TOOL_DISCOVERY,
    handler: (args) =>
      Effect.gen(function* () {
        const anomalies = yield* analytics
          .findAnomalies({
            errorRate: args.error_rate ?? 0.3,
            ...(args.duration_ms !== undefined
              ? { duration: args.duration_ms }
              : {}),
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ToolError({
                  tool: "obs_session_anomalies",
                  op: "findAnomalies",
                  cause,
                }),
            ),
          )
        return anomalies.map((s) => ({
          sessionId: s.sessionId,
          model: s.entrypoint,
          errorCount: s.metrics.errorCount,
          successCount: s.metrics.successCount,
          totalEvents: s.messageCount,
          durationMs: s.metrics.totalDuration,
          startTime: s.sessionStartTime,
          endTime: s.sessionEndTime,
        }))
      }),
  })

  // ── obs_sessions_search ─────────────────────────────────────────────────────

  const obsSessionsSearch = defineTool({
    name: "obs_sessions_search",
    description:
      "Search session history with optional filters. Returns session-level summaries — " +
      "each entry has sessionId, model, start/end times, per-tool call counts, error/success " +
      "counts, and duration. Use to answer: 'which sessions used tool X?', 'what ran between " +
      "time A and B?', 'which sessions had errors?'. For a deep dive into one session, follow " +
      "up with obs_session_explain. Complements obs_session_anomalies (anomaly detection) with " +
      "general-purpose session search.",
    inputSchema: eventsSearchShape,
    ...OBS_TOOL_DISCOVERY,
    handler: (args) =>
      Effect.gen(function* () {
        const limit = args.limit ?? 50

        // Query session-level aggregates via AnalyticsService. Filters are
        // applied at the DB level by querySessionMetrics (sessionId, toolName,
        // time range). Returns one row per matching session.
        const result = yield* analytics
          .querySessionMetrics({
            ...(args.session_id !== undefined
              ? { sessionId: args.session_id }
              : {}),
            ...(args.tool_name !== undefined
              ? { toolName: args.tool_name }
              : {}),
            ...(args.start_time !== undefined
              ? { startTime: args.start_time }
              : {}),
            ...(args.end_time !== undefined
              ? { endTime: args.end_time }
              : {}),
            limit,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ToolError({
                  tool: "obs_sessions_search",
                  op: "querySessionMetrics",
                  cause,
                }),
            ),
          )

        // Return session-level summaries. Each entry represents one session,
        // with its aggregated tool usage and error state. For the agent's
        // self-review purposes this is the right granularity — true per-event
        // rows would flood the context window. The agent can drill into a
        // specific session with obs_session_explain if it needs more detail.
        return result.sessions.map((s) => ({
          sessionId: s.sessionId,
          model: s.entrypoint,
          startTime: s.sessionStartTime,
          endTime: s.sessionEndTime,
          messageCount: s.messageCount,
          toolCalls: Object.entries(s.metrics.toolUsageCount).map(
            ([tool, count]) => ({ tool, count }),
          ),
          errorCount: s.metrics.errorCount,
          successCount: s.metrics.successCount,
          durationMs: s.metrics.totalDuration,
        }))
      }),
  })

  return [
    obsNote,
    obsNotesRecent,
    obsSessionExplain,
    obsSessionAnomalies,
    obsSessionsSearch,
  ] as const
}
