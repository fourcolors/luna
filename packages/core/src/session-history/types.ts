/**
 * Session history types — the contract for storing and querying agent session
 * transcripts in Luna's Effect/Layer architecture.
 *
 * All API methods return Effect.Effect, never raw Promises (DESIGN §1).
 */
import { Data, Effect } from "effect"

// ── Error ────────────────────────────────────────────────────────────────────

export class SessionHistoryError extends Data.TaggedError("SessionHistoryError")<{
  readonly op: "record" | "query" | "delete" | "boot"
  readonly message: string
  readonly cause?: unknown
}> {}

// ── Domain types ─────────────────────────────────────────────────────────────

/** Input shape for recording a new session transcript entry. */
export interface SessionRecordInput {
  readonly type: "user" | "assistant" | "system"
  readonly entrypoint: string
  readonly sessionId: string
  readonly parentUuid?: string
  readonly timestamp: string   // ISO 8601
  readonly requestId?: string
  readonly toolUseId?: string
  readonly textContent: string
  readonly toolName?: string
  readonly skillName?: string
}

/** A persisted session transcript entry (includes generated uuid + created_at). */
export interface SessionRecord extends SessionRecordInput {
  readonly uuid: string
  readonly created_at: string  // ISO 8601
}

export interface SessionHistoryQuery {
  readonly sessionId?: string
  readonly type?: "user" | "assistant" | "system"
  readonly toolName?: string
  readonly skillName?: string
  readonly limit?: number
}

// ── API contract ─────────────────────────────────────────────────────────────

export interface SessionHistoryApi {
  /**
   * Record a single message/event in session history.
   * Returns the UUID assigned to the recorded entry.
   */
  readonly record: (entry: SessionRecordInput) => Effect.Effect<string, SessionHistoryError>

  /**
   * Query session history with optional filters.
   */
  readonly query: (q: SessionHistoryQuery) => Effect.Effect<ReadonlyArray<SessionRecord>, SessionHistoryError>

  /**
   * Get a single session's full transcript, ordered by timestamp ASC.
   */
  readonly getSession: (sessionId: string) => Effect.Effect<ReadonlyArray<SessionRecord>, SessionHistoryError>

  /**
   * Delete entries whose timestamp (epoch ms) is older than `ts`.
   * Returns count of deleted rows.
   */
  readonly deleteOlderThan: (ts: number) => Effect.Effect<number, SessionHistoryError>
}
