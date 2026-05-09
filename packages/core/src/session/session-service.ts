/**
 * SessionService — the session lifecycle authority per DESIGN.md §3 and §7.1.
 *
 * Responsibility split:
 *   - SessionStore owns the *record* (sessions + messages table state).
 *   - SessionService owns the *lifecycle* (open → active → closed) and the
 *     Scope that pins every resource attached to that session (§3.1).
 *
 * The record-level surface is `open/resume/fork/list/close`. `openScoped`
 * adds the Scope-pinned variant sketched in §3.5 — the one TeamBroker and
 * any other in-process consumer should use. It composes the caller's Scope
 * with the SDK adapter's Scope so closing the outer Scope interrupts the
 * underlying subprocess (§3.4 #4) and flips the record status to "closed".
 *
 * A local `SDKAdapter` Tag is declared here with the SAME identifier string
 * used by `@luna/adapter-sdk`. This lets SessionService consume
 * the adapter as a runtime `R` requirement WITHOUT creating a package-level
 * core → adapter-sdk dependency cycle (§4 topology: core is Persistence;
 * adapter-sdk is above Persistence; `packages/core` cannot import from it).
 * Any layer that provides "luna/SDKAdapter" satisfies the
 * requirement — including `SDKAdapter.Default` from adapter-sdk.
 */
import { Clock } from "../clock.js"
import { Context, Effect, Queue, Ref, Scope, Stream } from "effect"
import { IntegrityError } from "../errors.js"
import type {
  ScopedSession,
  SDKMessageLike,
  SDKUserMessageLike,
  SessionOptions,
  SessionQuery,
  SessionSummary,
} from "./types.js"
import { SessionStore } from "./session-store.js"

/**
 * Structural surface of the SDK adapter that SessionService consumes.
 * Must stay in sync with `SDKAdapterService` in adapter-sdk, but core keeps
 * it SDK-free by using opaque `unknown` aliases (DESIGN.md §12.2 #6).
 */
export interface SDKAdapterLike {
  readonly query: (req: {
    readonly sessionId: string
    readonly prompt: Stream.Stream<SDKUserMessageLike>
    readonly sessionOptions: SessionOptions
    readonly resumeFromSessionId?: string
    readonly boundAccountId?: string
  }) => Effect.Effect<
    Stream.Stream<SDKMessageLike, unknown>,
    unknown,
    Scope.Scope
  >
}

/**
 * Local Tag alias for the SDK adapter. Uses the EXACT identifier string
 * `"luna/SDKAdapter"` so it resolves to the same Context slot
 * as the adapter-sdk's own `SDKAdapter` Tag — Effect v3 keys Tags by
 * identifier (see `Effect.Tag(id)` behavior).
 */
export const SDKAdapter = Context.GenericTag<SDKAdapterLike>(
  "luna/SDKAdapter",
) as Context.Tag<SDKAdapterLike, SDKAdapterLike> & {
  readonly key: "luna/SDKAdapter"
}

export class SessionService extends Effect.Service<SessionService>()(
  "luna/SessionService",
  {
    effect: Effect.gen(function* () {
      const store = yield* SessionStore
      const clock = yield* Clock
      /** In-process guard: prevent double-close of the same id. */
      const closedIds = yield* Ref.make<ReadonlySet<string>>(new Set())
      /**
       * Monotonic id-sequence counter, §3.1 Clock discipline. Replaces the
       * module-level `let _seq` — one counter per SessionService instance,
       * so layer-swapped tests get an isolated sequence.
       */
      const seqRef = yield* Ref.make<number>(0)

      /** Generate a unique id driven by the injected Clock + Ref counter. */
      const genId = (prefix: string): Effect.Effect<string> =>
        Effect.gen(function* () {
          const nowMs = yield* clock.nowMs()
          const seq = yield* Ref.getAndUpdate(seqRef, (n) => n + 1)
          // Randomness still sourced from Math.random — not lifetime state,
          // just anti-collision for same-tick concurrent opens.
          const rand = Math.random().toString(36).slice(2, 8)
          return `${prefix}_${nowMs.toString(36)}_${seq.toString(36)}_${rand}`
        })

      const open = (
        opts: SessionOptions,
      ): Effect.Effect<SessionSummary, IntegrityError> =>
        Effect.gen(function* () {
          const id = yield* genId("ses")
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
          const parentOpts = yield* store.getOptions(id)
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
            // Slot systemPrompt into sdkOptions so the SDKAdapter sees it.
            // The adapter reads ONLY sessionOptions.sdkOptions — the top-level
            // systemPrompt field above is consumed by merge-policy only. Without
            // this, fork() overrides are silently dropped before reaching Claude.
            sdkOptions: {
              ...(parentOpts?.sdkOptions ?? {}),
              ...(overrides?.systemPrompt !== undefined
                ? { systemPrompt: overrides.systemPrompt }
                : {}),
              ...(overrides?.sdkOptions ?? {}),
            },
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

      /**
       * Scope-pinned session. Per DESIGN.md §3.1 + §3.5:
       *   - Runs inside the caller's Scope.
       *   - Registers a finalizer that flips status → "closed".
       *   - The SDK adapter's `query` also registers finalizers into the
       *     same Scope (AbortController firing, handle dropped) — LIFO
       *     ordering means the subprocess is interrupted BEFORE we mark
       *     the record closed.
       *
       * Invariants §3.4 #1 (no cross-Scope Fiber refs) and #4 (interruption
       * cascade) are honored structurally: we never `Effect.fork` anything;
       * we just wire the adapter's already-scoped Stream through.
       */
      const openScoped = (
        opts: SessionOptions,
      ): Effect.Effect<
        ScopedSession,
        IntegrityError,
        SDKAdapterLike | Scope.Scope
      > =>
        Effect.gen(function* () {
          const summary = yield* open(opts)
          const adapter = yield* SDKAdapter

          // Mailbox for send() — lives in the session Scope.
          const mailbox = yield* Queue.unbounded<SDKUserMessageLike>()
          yield* Effect.addFinalizer(() => Queue.shutdown(mailbox))

          const prompt: Stream.Stream<SDKUserMessageLike> =
            Stream.fromQueue(mailbox)

          // adapter.query has error channel `unknown` in our local shape
          // (we type-erased across the package boundary). Swallow errors
          // from the outer Effect — the real adapter never fails synchronously
          // on query-construction; per-stream errors surface inside the
          // returned Stream and are the consumer's problem. We type the
          // ScopedSession.replies stream as `never`-error for caller
          // ergonomics; the adapter's own error signalling will still
          // appear as a stream-termination that the consumer observes.
          const replies = yield* adapter
            .query({
              sessionId: summary.id,
              prompt,
              sessionOptions: opts,
            })
            .pipe(
              Effect.orDie, // integrity-failure to build the stream = halt
            )

          // §3.1 finalizer: when the caller's Scope closes, flip status.
          // `Effect.orDie` because IntegrityError here means our own store
          // is inconsistent; we prefer defect over silent drop.
          yield* Effect.addFinalizer(() => close(summary.id).pipe(Effect.orDie))

          const send = (
            msg: SDKUserMessageLike,
          ): Effect.Effect<void, never> => Queue.offer(mailbox, msg).pipe(
            Effect.asVoid,
            Effect.catchAllCause(() => Effect.void), // post-close offers no-op
          )

          const handle: ScopedSession = {
            id: summary.id,
            send,
            replies: replies.pipe(
              Stream.catchAllCause(() => Stream.empty),
            ) as Stream.Stream<SDKMessageLike, never>,
            close: close(summary.id).pipe(Effect.orDie),
          }
          return handle
        })

      return { open, resume, fork, list, close, openScoped } as const
    }),
  },
) {}
