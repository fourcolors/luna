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

export interface AgentNote {
  readonly id: string
  readonly sessionId: string
  readonly parentId: string | null
  readonly kind: string
  readonly summary: string
  readonly payload: unknown | null
  readonly ts: number
}

export class NoteError extends Data.TaggedError("NoteError")<{
  readonly op: "record" | "query" | "delete" | "boot"
  readonly message: string
  readonly cause?: unknown
}> {}

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
