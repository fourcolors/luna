import type { Effect } from "effect"
import { Data } from "effect"

export type NoteKind =
  | "goal_declared"
  | "goal_revised"
  | "progress"
  | "obstacle"
  | "decision"
  | "reflection"
  | string

/**
 * Fallback surfaced in `AgentNote.payload` when a row's `payload_json` column
 * cannot be JSON-parsed (e.g. an out-of-band writer INSERTed raw markdown
 * instead of an encoded value).
 *
 * A malformed payload must NEVER fail the whole query — one poisoned row used
 * to blank every read path, which took `obs_notes_recent()` (the "what was I
 * working on?" context-recovery path) offline entirely. The row is returned
 * with all of its other columns intact and only `payload` degraded to this
 * envelope.
 *
 * Why an envelope and not `null` or the raw string:
 *   - `null` is indistinguishable from a genuinely NULL `payload_json`, so the
 *     original text would be silently lost with no signal.
 *   - a bare string is indistinguishable from a legitimately-stored string
 *     payload (`record({ payload: "text" })` round-trips as one), so the
 *     corruption would look like intentional content.
 *   - the envelope is an object (matching what callers expect), preserves the
 *     original text under `raw`, and is self-describing / greppable.
 *
 * READ-SIDE ONLY: this is never written back to `payload_json`.
 */
export interface UnparsedPayload {
  /** Discriminator. Always `true`; marks this as a parse failure, not data. */
  readonly __unparsed: true
  /** The original, unparseable column text (truncated if very large). */
  readonly raw: string
  /** The `JSON.parse` failure, stringified. */
  readonly error: string
  /** Present only when `raw` was truncated to bound the envelope's size. */
  readonly truncated?: true
}

/** Narrow an `AgentNote.payload` to the malformed-payload envelope. */
export const isUnparsedPayload = (v: unknown): v is UnparsedPayload =>
  typeof v === "object" &&
  v !== null &&
  (v as { __unparsed?: unknown }).__unparsed === true

export interface AgentNote {
  readonly id: string
  readonly sessionId: string
  readonly parentId: string | null
  readonly kind: string
  readonly summary: string
  /**
   * The decoded `payload_json`, or `null` when the column was NULL.
   *
   * On the SQLite layer this is an {@link UnparsedPayload} envelope when the
   * stored text was not valid JSON — see that type for the rationale. Use
   * {@link isUnparsedPayload} to detect it. (Declared `unknown` because the
   * payload is caller-defined; `unknown | null` collapses to `unknown`.)
   */
  readonly payload: unknown | null
  readonly ts: number
}

export class NoteError extends Data.TaggedError("NoteError")<{
  readonly op: "record" | "query" | "delete" | "boot"
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * Read/write contract for the agent-notes ledger.
 *
 * Read paths (`getRecent`, `getRecentAcrossSessions`, `getChain`, `getByKind`,
 * `getById`) are total with respect to payload corruption: they never fail
 * because a stored `payload_json` is unparseable. Such a row is still returned
 * with its id/session/kind/summary/ts intact and its `payload` set to an
 * {@link UnparsedPayload} envelope. A `NoteError` from these methods therefore
 * signals a real query/IO failure, not one bad row.
 */
export interface AgentNotesApi {
  readonly record: (input: {
    readonly sessionId: string
    readonly kind: NoteKind
    readonly summary: string
    readonly parentId?: string
    readonly payload?: unknown
    /** Optional caller-supplied id. Used by the feedback-screenshot flow,
     *  which must know the note's id BEFORE the INSERT (to name the
     *  screenshot file `<id>.png` and put its path in payload_json — there is
     *  no UPDATE, so the payload must be complete up front). Omitted →
     *  unchanged behavior, a UUID is generated server-side (every existing
     *  caller is unaffected). */
    readonly id?: string
  }) => Effect.Effect<AgentNote, NoteError>

  readonly getRecent: (
    sessionId: string,
    limit?: number,
  ) => Effect.Effect<ReadonlyArray<AgentNote>, NoteError>

  /**
   * Return the most-recent `limit` notes across ALL sessions, newest first.
   * Used by `obs_notes_recent()` when no session_id / kind filter is supplied
   * — the documented "what was I working on?" context-recovery path.
   */
  readonly getRecentAcrossSessions: (
    limit?: number,
  ) => Effect.Effect<ReadonlyArray<AgentNote>, NoteError>

  readonly getChain: (
    sessionId: string,
  ) => Effect.Effect<ReadonlyArray<AgentNote>, NoteError>

  readonly getByKind: (
    kind: NoteKind,
    limit?: number,
  ) => Effect.Effect<ReadonlyArray<AgentNote>, NoteError>

  readonly getById: (
    id: string,
  ) => Effect.Effect<AgentNote | null, NoteError>

  readonly deleteForSession: (
    sessionId: string,
  ) => Effect.Effect<number, NoteError>
}
