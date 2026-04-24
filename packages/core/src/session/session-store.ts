/**
 * SessionStore — authoritative record of sessions + messages.
 *
 * Per DESIGN.md §12.2 invariant #2: every SDK message is mirrored here before
 * being handed to callers. We never trust the SDK transcript alone.
 *
 * This file provides the Service interface and an in-memory `Default` layer
 * suitable for tests and the first few milestones. The SQLite-backed layer
 * per §5.1 lands in Phase 5 alongside the memory backends (same driver).
 */
import { Effect, Layer, Ref, Stream } from "effect"
import type {
  SessionOptions,
  SessionQuery,
  SessionStatus,
  SessionSummary,
} from "./types.js"
import type { SDKMessage, StoredMessage } from "../messages.js"
import { IntegrityError } from "../errors.js"

interface SessionRow {
  readonly id: string
  readonly parentId: string | null
  readonly title: string | null
  readonly tags: ReadonlyArray<string>
  readonly createdAt: number
  readonly endedAt: number | null
  readonly model: string
  readonly options: SessionOptions
  readonly status: SessionStatus
}

interface StoreState {
  readonly sessions: ReadonlyMap<string, SessionRow>
  readonly messages: ReadonlyMap<string, ReadonlyArray<StoredMessage>>
  readonly nextSeq: ReadonlyMap<string, number>
}

const emptyState = (): StoreState => ({
  sessions: new Map(),
  messages: new Map(),
  nextSeq: new Map(),
})

const toSummary = (row: SessionRow): SessionSummary => ({
  id: row.id,
  parentId: row.parentId,
  title: row.title,
  tags: row.tags,
  createdAt: row.createdAt,
  endedAt: row.endedAt,
  model: row.model,
  status: row.status,
})

export class SessionStore extends Effect.Service<SessionStore>()(
  "experiment-agent/SessionStore",
  {
    effect: Effect.gen(function* () {
      const ref = yield* Ref.make<StoreState>(emptyState())

      const create = (input: {
        readonly id: string
        readonly options: SessionOptions
        readonly createdAt: number
      }): Effect.Effect<SessionSummary, IntegrityError> =>
        Ref.modify(ref, (state) => {
          if (state.sessions.has(input.id)) {
            return [
              Effect.fail(
                new IntegrityError({
                  module: "session-store",
                  resource: "session_id_unique",
                  message: `session ${input.id} already exists`,
                }),
              ) as Effect.Effect<SessionSummary, IntegrityError>,
              state,
            ]
          }
          const row: SessionRow = {
            id: input.id,
            parentId: input.options.parentSessionId ?? null,
            title: input.options.title ?? null,
            tags: input.options.tags ?? [],
            createdAt: input.createdAt,
            endedAt: null,
            model: input.options.model,
            options: input.options,
            status: "active",
          }
          const sessions = new Map(state.sessions)
          sessions.set(input.id, row)
          const messages = new Map(state.messages)
          messages.set(input.id, [])
          const nextSeq = new Map(state.nextSeq)
          nextSeq.set(input.id, 0)
          return [
            Effect.succeed(toSummary(row)) as Effect.Effect<
              SessionSummary,
              IntegrityError
            >,
            { sessions, messages, nextSeq },
          ]
        }).pipe(Effect.flatten)

      const get = (
        id: string,
      ): Effect.Effect<SessionSummary | null, never> =>
        Ref.get(ref).pipe(
          Effect.map((s) => {
            const row = s.sessions.get(id)
            return row ? toSummary(row) : null
          }),
        )

      const setStatus = (
        id: string,
        status: SessionStatus,
        endedAt: number | null = null,
      ): Effect.Effect<void, IntegrityError> =>
        Ref.modify(ref, (state) => {
          const row = state.sessions.get(id)
          if (!row) {
            return [
              Effect.fail(
                new IntegrityError({
                  module: "session-store",
                  resource: "session_exists",
                  message: `session ${id} not found`,
                }),
              ) as Effect.Effect<void, IntegrityError>,
              state,
            ]
          }
          const updated: SessionRow = { ...row, status, endedAt }
          const sessions = new Map(state.sessions)
          sessions.set(id, updated)
          return [
            Effect.void as Effect.Effect<void, IntegrityError>,
            { ...state, sessions },
          ]
        }).pipe(Effect.flatten)

      const appendMessage = (input: {
        readonly sessionId: string
        readonly messageId: string
        readonly ts: number
        readonly parentId: string | null
        readonly payload: SDKMessage
      }): Effect.Effect<StoredMessage, IntegrityError> =>
        Ref.modify(ref, (state) => {
          if (!state.sessions.has(input.sessionId)) {
            return [
              Effect.fail(
                new IntegrityError({
                  module: "session-store",
                  resource: "message_session_exists",
                  message: `session ${input.sessionId} not found`,
                }),
              ) as Effect.Effect<StoredMessage, IntegrityError>,
              state,
            ]
          }
          const seq = state.nextSeq.get(input.sessionId) ?? 0
          const stored: StoredMessage = {
            id: input.messageId,
            sessionId: input.sessionId,
            seq,
            ts: input.ts,
            parentId: input.parentId,
            kind: input.payload.type,
            payload: input.payload,
          }
          const prev = state.messages.get(input.sessionId) ?? []
          const messages = new Map(state.messages)
          messages.set(input.sessionId, [...prev, stored])
          const nextSeq = new Map(state.nextSeq)
          nextSeq.set(input.sessionId, seq + 1)
          return [
            Effect.succeed(stored) as Effect.Effect<
              StoredMessage,
              IntegrityError
            >,
            { ...state, messages, nextSeq },
          ]
        }).pipe(Effect.flatten)

      const readMessages = (
        sessionId: string,
      ): Stream.Stream<StoredMessage, IntegrityError> =>
        Stream.unwrap(
          Ref.get(ref).pipe(
            Effect.map((state) => {
              const msgs = state.messages.get(sessionId)
              if (!msgs) {
                return Stream.fail(
                  new IntegrityError({
                    module: "session-store",
                    resource: "session_exists",
                    message: `session ${sessionId} not found`,
                  }),
                )
              }
              return Stream.fromIterable(msgs)
            }),
          ),
        )

      const list = (
        q: SessionQuery = {},
      ): Stream.Stream<SessionSummary, never> =>
        Stream.unwrap(
          Ref.get(ref).pipe(
            Effect.map((state) => {
              let rows = Array.from(state.sessions.values())
              if (q.status) rows = rows.filter((r) => r.status === q.status)
              if (q.parentId)
                rows = rows.filter((r) => r.parentId === q.parentId)
              if (q.tag) rows = rows.filter((r) => r.tags.includes(q.tag!))
              rows.sort((a, b) => b.createdAt - a.createdAt)
              if (q.limit !== undefined) rows = rows.slice(0, q.limit)
              return Stream.fromIterable(rows.map(toSummary))
            }),
          ),
        )

      return {
        create,
        get,
        setStatus,
        appendMessage,
        readMessages,
        list,
      } as const
    }),
  },
) {}

/**
 * Explicit named alias for the default in-memory layer.
 * Phase 5 will add `SessionStore.Sqlite` alongside this.
 */
export const SessionStoreMemory: Layer.Layer<SessionStore> = SessionStore.Default
