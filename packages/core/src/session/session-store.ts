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
import { Effect, Ref, Stream } from "effect"
import type {
  SessionOptions,
  SessionQuery,
  SessionStatus,
  SessionSummary,
} from "./types.js"
import {
  MESSAGE_ENVELOPE_VERSION,
  type MessageKind,
  type StoredMessage,
} from "../messages.js"
import { IntegrityError } from "../errors.js"
import { extractTextPreview } from "./projection.js"

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
  readonly lastMessageAt: number | null
  readonly lastMessagePreview: string | null
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

/**
 * Derive the session's persisted effort preference from its options.
 * Mirrors the sqlite store's effortFromOptionsJson: real levels live at
 * `sdkOptions.effort`, the ultracode mode at `sdkOptions.settings.ultracode`.
 */
const effortFromOptions = (options: SessionOptions): string | undefined => {
  const sdk = (options.sdkOptions ?? {}) as Record<string, unknown>
  const settings = sdk["settings"] as Record<string, unknown> | undefined
  if (settings !== undefined && settings["ultracode"] === true) {
    return "ultracode"
  }
  const e = sdk["effort"]
  return typeof e === "string" && e !== "" ? e : undefined
}

const toSummary = (row: SessionRow): SessionSummary => {
  const effort = effortFromOptions(row.options)
  return {
    id: row.id,
    parentId: row.parentId,
    title: row.title,
    tags: row.tags,
    createdAt: row.createdAt,
    endedAt: row.endedAt,
    model: row.model,
    ...(effort !== undefined ? { effort } : {}),
    status: row.status,
    lastMessageAt: row.lastMessageAt,
    lastMessagePreview: row.lastMessagePreview,
  }
}

export class SessionStore extends Effect.Service<SessionStore>()(
  "luna/SessionStore",
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
            lastMessageAt: null,
            lastMessagePreview: null,
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

      const getOptions = (
        id: string,
      ): Effect.Effect<SessionOptions | null, never> =>
        Ref.get(ref).pipe(
          Effect.map((s) => {
            const row = s.sessions.get(id)
            return row ? row.options : null
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
        readonly kind: MessageKind
        readonly payload: unknown
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
            kind: input.kind,
            schemaVersion: MESSAGE_ENVELOPE_VERSION,
            payload: input.payload,
          }
          const prev = state.messages.get(input.sessionId) ?? []
          const messages = new Map(state.messages)
          messages.set(input.sessionId, [...prev, stored])
          const nextSeq = new Map(state.nextSeq)
          nextSeq.set(input.sessionId, seq + 1)

          // Maintain sidebar metadata: every append bumps lastMessageAt;
          // text-bearing kinds (user/assistant) refresh the preview, others
          // (result/system/stream_event/hook/status) leave preview untouched
          // so the sidebar shows real conversation excerpts, not "tool ran".
          const sessionRow = state.sessions.get(input.sessionId)!
          const sessions = new Map(state.sessions)
          // Parented (subagent-internal) messages never refresh the preview —
          // same gate as the sqlite store: the subagent's forwarded seed
          // prompt must not become the sidebar excerpt.
          const newPreview =
            input.parentId == null &&
            (input.kind === "user" || input.kind === "assistant")
              ? extractTextPreview(input.payload) ?? sessionRow.lastMessagePreview
              : sessionRow.lastMessagePreview
          sessions.set(input.sessionId, {
            ...sessionRow,
            lastMessageAt: input.ts,
            lastMessagePreview: newPreview,
          })

          return [
            Effect.succeed(stored) as Effect.Effect<
              StoredMessage,
              IntegrityError
            >,
            { ...state, messages, nextSeq, sessions },
          ]
        }).pipe(Effect.flatten)

      /**
       * `opts.limit`, when given, bounds the returned stream to the most
       * recent N messages (seq order preserved) instead of the full history.
       * Mirrors the SQLite backend's bounded `readMessages` — see
       * session-store-sqlite.ts for the perf rationale (subscribe()'s
       * initial-snapshot read no longer scans/parses unbounded history).
       * Omitted `opts`/`opts.limit` preserves the original full-history
       * behavior for existing callers (findStoredById, dream gatherInputs).
       */
      const readMessages = (
        sessionId: string,
        opts?: { readonly limit?: number },
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
              const limit = opts?.limit
              const bounded =
                limit !== undefined && limit >= 0 && limit < msgs.length
                  ? msgs.slice(msgs.length - limit)
                  : msgs
              return Stream.fromIterable(bounded)
            }),
          ),
        )

      // First top-level user message, or null (also null for an unknown
      // session). Bounded — the SQLite twin runs a LIMIT 1 query; here the
      // in-memory list is already small so a find() is equivalent.
      const readFirstUserMessage = (
        sessionId: string,
      ): Effect.Effect<StoredMessage | null, never> =>
        Ref.get(ref).pipe(
          Effect.map((state) => {
            const msgs = state.messages.get(sessionId)
            if (!msgs) return null
            return (
              msgs.find((m) => m.kind === "user" && m.parentId === null) ?? null
            )
          }),
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
              if (q.hasUserMessage)
                rows = rows.filter((r) => {
                  const msgs = state.messages.get(r.id)
                  return (
                    msgs?.some(
                      (m) => m.kind === "user" && m.parentId === null,
                    ) ?? false
                  )
                })
              if (q.excludeIds && q.excludeIds.length > 0) {
                const excluded = new Set(q.excludeIds)
                rows = rows.filter((r) => !excluded.has(r.id))
              }
              if (q.orderBy === "lastMessageAt") {
                rows.sort(
                  (a, b) =>
                    (b.lastMessageAt ?? b.createdAt) -
                    (a.lastMessageAt ?? a.createdAt),
                )
              } else {
                rows.sort((a, b) => b.createdAt - a.createdAt)
              }
              if (q.limit !== undefined) rows = rows.slice(0, q.limit)
              return Stream.fromIterable(rows.map(toSummary))
            }),
          ),
        )

      /**
       * Patch the stored options for an existing session. Only the provided
       * fields are updated; the rest of the options object is preserved.
       * Used by setThreadConfig() to persist model/effort changes so that
       * a future re-subscribe sees the correct options without a restart.
       *
       * Best-effort: silently ignores unknown session ids (the thread may
       * have been evicted already; the durable record in thread-session-map
       * is the source of truth for cross-restart recovery).
       */
      const setOptions = (
        id: string,
        patch: Partial<SessionOptions>,
      ): Effect.Effect<void, never> =>
        Ref.update(ref, (state) => {
          const row = state.sessions.get(id)
          if (!row) return state
          // Keep the denormalized summary `model` in sync with the options
          // patch — SessionSummary.model is what thread-list/thread-created
          // report, and a stale value makes clients display the creation-time
          // model forever after a mid-thread switch.
          const nextModel =
            typeof patch.model === "string" && patch.model.trim() !== ""
              ? patch.model
              : row.model
          const updated: SessionRow = {
            ...row,
            model: nextModel,
            options: { ...row.options, ...patch },
          }
          const sessions = new Map(state.sessions)
          sessions.set(id, updated)
          return { ...state, sessions }
        })

      return {
        create,
        get,
        getOptions,
        setOptions,
        setStatus,
        appendMessage,
        readMessages,
        readFirstUserMessage,
        list,
      } as const
    }),
  },
) {}

