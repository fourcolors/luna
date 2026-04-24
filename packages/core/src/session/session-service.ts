/**
 * SessionService — the session lifecycle authority per DESIGN.md §3 and §7.1.
 *
 * Responsibility split:
 *   - SessionStore owns the *record* (sessions + messages table state).
 *   - SessionService owns the *lifecycle* (open → active → closed) and the
 *     Scope that pins every resource attached to that session (§3.1).
 *
 * The SDK adapter (Phase 3) hooks into `open` to spawn the actual query
 * stream; until then we provide the open/close/list/fork/resume surface so
 * downstream services can wire against a real Service.
 */
import { Clock } from "../clock.js"
import { Effect, Ref, Stream } from "effect"
import { IntegrityError } from "../errors.js"
import type {
  SessionOptions,
  SessionQuery,
  SessionSummary,
} from "./types.js"
import { SessionStore } from "./session-store.js"

/** Generate a monotonically-unique session id without external deps. */
let _seq = 0
const genId = (prefix: string): string =>
  `${prefix}_${Date.now().toString(36)}_${(_seq++).toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`

export class SessionService extends Effect.Service<SessionService>()(
  "experiment-agent/SessionService",
  {
    effect: Effect.gen(function* () {
      const store = yield* SessionStore
      const clock = yield* Clock
      /** In-process guard: prevent double-close of the same id. */
      const closedIds = yield* Ref.make<ReadonlySet<string>>(new Set())

      const open = (
        opts: SessionOptions,
      ): Effect.Effect<SessionSummary, IntegrityError> =>
        Effect.gen(function* () {
          const id = genId("ses")
          const createdAt = yield* clock.nowMs()
          return yield* store.create({ id, options: opts, createdAt })
        })

      const resume = (
        id: string,
      ): Effect.Effect<SessionSummary, IntegrityError> =>
        Effect.gen(function* () {
          const row = yield* store.get(id)
          if (!row) {
            return yield* Effect.fail(
              new IntegrityError({
                module: "session-service",
                resource: "session_exists",
                message: `session ${id} not found`,
              }),
            )
          }
          if (row.status === "closed") {
            yield* store.setStatus(id, "active", null)
            return (yield* store.get(id))!
          }
          return row
        })

      const fork = (
        id: string,
        overrides?: Partial<SessionOptions>,
      ): Effect.Effect<SessionSummary, IntegrityError> =>
        Effect.gen(function* () {
          const parent = yield* store.get(id)
          if (!parent) {
            return yield* Effect.fail(
              new IntegrityError({
                module: "session-service",
                resource: "fork_parent_exists",
                message: `parent session ${id} not found`,
              }),
            )
          }
          const childOpts: SessionOptions = {
            model: overrides?.model ?? parent.model,
            ...(overrides?.systemPrompt !== undefined
              ? { systemPrompt: overrides.systemPrompt }
              : {}),
            ...(overrides?.title !== undefined
              ? { title: overrides.title }
              : {}),
            ...(overrides?.tags !== undefined ? { tags: overrides.tags } : {}),
            parentSessionId: id,
            ...(overrides?.sdkOptions !== undefined
              ? { sdkOptions: overrides.sdkOptions }
              : {}),
          }
          return yield* open(childOpts)
        })

      const list = (q?: SessionQuery): Stream.Stream<SessionSummary, never> =>
        store.list(q)

      const close = (id: string): Effect.Effect<void, IntegrityError> =>
        Effect.gen(function* () {
          const already = yield* Ref.get(closedIds)
          if (already.has(id)) return
          const ts = yield* clock.nowMs()
          yield* store.setStatus(id, "closed", ts)
          yield* Ref.update(closedIds, (s) => new Set(s).add(id))
        })

      return { open, resume, fork, list, close } as const
    }),
  },
) {}
