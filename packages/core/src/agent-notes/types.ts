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
  }) => Effect.Effect<AgentNote, NoteError>

  readonly getRecent: (
    sessionId: string,
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
