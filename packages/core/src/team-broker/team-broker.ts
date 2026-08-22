/**
 * TeamBroker — Phase 11c. Out-of-process peer-worker supervisor on top of
 * TaskList. DESIGN §2.1.7 (Teams), §3.3 (claimant resolution), §3.4 (hard
 * rules), §6.2 (frozen errors), §7.2 (signature).
 *
 * Invariants honored (cite §-anchor):
 *   - §3.4 #1 no cross-Scope Fiber refs: per-teammate `RunningEntry` keeps
 *     `Fiber.Fiber` INTERNAL only. Public API exposes names + Status
 *     only. `members()` returns `ReadonlyArray<TeammateName>`.
 *   - §3.4 #4 interruption cascades: `spawnIn(spec, leadScope)` links the
 *     team's private scope to a caller-supplied lead Scope so closing the
 *     lead Scope cascades teardown to the team. Plain `spawn` does NOT
 *     require a Scope — the team is torn down by the broker's own Layer
 *     scope or by explicit dissolve().
 *   - §6.2 frozen errors only: TeammateOrphanedError, TaskCompletionLagError,
 *     IntegrityError. No new TaggedErrors in this module.
 *   - §7.2 TeamBroker signature matches `TeamBrokerApi`.
 *   - Reconcile-on-spawn: TaskList.subscribe() is live-only, so on spawn we
 *     ALSO call `taskList.list({assignee, status:[...]})` to seed
 *     `claimedTaskIds` for tasks claimed before broker existed.
 *   - Idempotent dissolve: dissolve flips a flag and closes the per-team
 *     Scope; calling twice is a no-op.
 *   - Debounced lag: `laggedTaskIds: Set<TaskId>` tracks already-emitted
 *     events; cleared when task transitions to `completed`.
 *
 * Scope design (critical):
 *   Each team gets its own private `teamScope: Scope.Closeable`. ALL
 *   per-team finalizers (orphan-emit, fiber-interrupt, mailbox-shutdown) are
 *   registered into `teamScope` via `Scope.addFinalizer`. This isolates team
 *   finalizers from the broker's layer scope.
 *
 *   Layer-scope finalizer registration order (LIFO = last registered runs first):
 *     1. Queue.end(eventsQ)            ← registered FIRST → runs LAST
 *     2. close all surviving teamScopes ← registered SECOND → runs FIRST
 *
 *   LIFO ensures: team teardown (orphan-emit, fiber-interrupt) runs BEFORE
 *   Queue.end — so orphan events can be published into the still-open
 *   eventsQ during teardown. Prefer `end` over v4 `shutdown` (which discards
 *   buffered messages before Stream consumers can drain).
 *
 * Reuses the forkDetach + explicit interrupt pattern of the SupervisedPool
 * helper (packages/core/src/supervised-pool/).
 */
import { Context,
  Cause,
  Effect,
  Exit,
  Fiber,
  Layer,
  Queue,
  Ref,
  Scope,
  Stream,
} from "effect"
import { Clock } from "../clock.js"
import {
  IntegrityError,
  TaskCompletionLagError,
  TeammateOrphanedError,
} from "../errors.js"
import { TaskList, type TaskId } from "../task-list/index.js"
import type {
  TeamBrokerApi,
  TeamEvent,
  TeamMsg,
  TeamName,
  TeammateName,
  TeamSpec,
} from "./types.js"

interface RunningEntry {
  // INTERNAL only — never exposed (§3.4 #1).
  readonly fiber: Fiber.Fiber<unknown, unknown>
  readonly mailbox: Queue.Queue<TeamMsg>
  readonly claimedTaskIds: Set<TaskId>
  readonly claimedAt: Map<TaskId, number>
  readonly laggedTaskIds: Set<TaskId>
}

interface TeamRecord {
  readonly name: TeamName
  readonly running: Ref.Ref<ReadonlyMap<TeammateName, RunningEntry>>
  readonly lagThresholdMs: number
  readonly orphanCheckIntervalMs: number
  /**
   * Per-team private scope. Closing it tears down the team: interrupts
   * fibers, shuts down mailboxes, emits orphan events.
   */
  readonly teamScope: Scope.Closeable
  /** Set true when explicit `dissolve` is called. Distinguishes orphan reason. */
  readonly dissolvedRef: Ref.Ref<boolean>
  /** Guard: ensures we only run per-team teardown once. */
  readonly closedRef: Ref.Ref<boolean>
}

const DEFAULT_LAG_MS = 60_000
const DEFAULT_TICK_MS = 5_000

export class TeamBroker extends Context.Service<TeamBroker, TeamBrokerApi>()("luna/TeamBroker") {
  static readonly Default: Layer.Layer<TeamBroker, never, Clock | TaskList> =
    Layer.effect(
      TeamBroker,
      Effect.gen(function* () {
        const clock = yield* Clock
        const taskList = yield* TaskList

        // Shared event channel — Queue (single-consumer) rather than PubSub.
        // Rationale: PubSub.publish from inside a Scope finalizer can hang
        // when a subscriber fiber is concurrently being interrupted. Queue.offer
        // on an unbounded queue is sync; queue shutdown sends an interrupt which
        // is handled gracefully by Stream consumers.
        const eventsQ = yield* Queue.unbounded<TeamEvent, Cause.Done>()

        // teamName → record.
        const teams = yield* Ref.make<ReadonlyMap<TeamName, TeamRecord>>(
          new Map(),
        )

        // ── Layer-scope finalizer LIFO ordering ──────────────────────────────
        // Registered FIRST → runs LAST (after team teardowns complete).
        yield* Effect.addFinalizer(() => Queue.end(eventsQ))

        // Registered SECOND → runs FIRST (tears down all surviving teams
        // before queue shutdown). LIFO ensures orphan events can be published
        // into the still-open eventsQ during teardown.
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            const m = yield* Ref.get(teams)
            for (const rec of m.values()) {
              const already = yield* Ref.get(rec.closedRef)
              if (already) continue
              yield* Ref.set(rec.closedRef, true)
              yield* Scope.close(rec.teamScope, Exit.void)
            }
          }),
        )

        const publish = (e: TeamEvent) =>
          Queue.offer(eventsQ, e).pipe(Effect.asVoid, Effect.ignore)

        const upsertTeam = (rec: TeamRecord) =>
          Ref.update(teams, (m) => {
            const next = new Map(m)
            next.set(rec.name, rec)
            return next
          })

        const removeTeam = (name: TeamName) =>
          Ref.update(teams, (m) => {
            if (!m.has(name)) return m
            const next = new Map(m)
            next.delete(name)
            return next
          })

        const getTeam = (name: TeamName) =>
          Ref.get(teams).pipe(Effect.map((m) => m.get(name) ?? null))

        // ─── spawnCore ────────────────────────────────────────────────────
        // Internal implementation; spawn + spawnIn both call this.
        // All per-team resources are registered into `teamScope` (not the
        // caller's scope or the layer scope).
        const spawnCore = (spec: TeamSpec): Effect.Effect<void, IntegrityError> =>
          Effect.gen(function* () {
            // Reject duplicate team names — IntegrityError per §6.2.
            const existing = yield* getTeam(spec.name)
            if (existing !== null) {
              return yield* Effect.fail(
                new IntegrityError({
                  module: "team-broker",
                  resource: "team_name_unique",
                  message: `team "${spec.name}" already spawned`,
                }),
              )
            }

            const lagThresholdMs = spec.lagThresholdMs ?? DEFAULT_LAG_MS
            const orphanCheckIntervalMs =
              spec.orphanCheckIntervalMs ?? DEFAULT_TICK_MS

            // Private scope for this team's lifetime.
            const teamScope = yield* Scope.make()

            const running = yield* Ref.make<
              ReadonlyMap<TeammateName, RunningEntry>
            >(new Map())
            const dissolvedRef = yield* Ref.make(false)
            const closedRef = yield* Ref.make(false)

            const record: TeamRecord = {
              name: spec.name,
              running,
              lagThresholdMs,
              orphanCheckIntervalMs,
              teamScope,
              dissolvedRef,
              closedRef,
            }
            yield* upsertTeam(record)

            // ── Build per-teammate mailboxes + reconcile claimed tasks ──
            const initialEntries = new Map<TeammateName, {
              mailbox: Queue.Queue<TeamMsg>
              claimedTaskIds: Set<TaskId>
              claimedAt: Map<TaskId, number>
            }>()

            const now = yield* clock.nowMs()
            for (const teammate of spec.teammates) {
              const mailbox = yield* Queue.unbounded<TeamMsg>()
              // Reconcile: prior claims (claimed | in_progress) by this name.
              const prior = yield* taskList.list({
                assignee: teammate.name,
                status: ["claimed", "in_progress"],
              })
              const claimedTaskIds = new Set<TaskId>()
              const claimedAt = new Map<TaskId, number>()
              for (const t of prior) {
                if (t.teamName !== spec.name) continue
                claimedTaskIds.add(t.id)
                // Use updatedAt so an already-late prior claim still lags.
                claimedAt.set(t.id, t.updatedAt)
              }
              void now
              initialEntries.set(teammate.name, {
                mailbox,
                claimedTaskIds,
                claimedAt,
              })
            }

            // Fork each teammate loop. Use forkDetach so the fiber is
            // independent of the calling fiber's scope. We'll interrupt it
            // from the teamScope finalizer.
            for (const teammate of spec.teammates) {
              const init = initialEntries.get(teammate.name)!
              const fiber = yield* Effect.forkDetach(teammate.loop(init.mailbox))
              const entry: RunningEntry = {
                fiber,
                mailbox: init.mailbox,
                claimedTaskIds: init.claimedTaskIds,
                claimedAt: init.claimedAt,
                laggedTaskIds: new Set<TaskId>(),
              }
              yield* Ref.update(running, (m) => {
                const next = new Map(m)
                next.set(teammate.name, entry)
                return next
              })
              yield* publish({
                _tag: "started",
                team: spec.name,
                teammate: teammate.name,
              })
            }

            // ── TaskList subscriber: keep claimedAt + laggedTaskIds in sync ──
            const subscriberFiber = yield* Effect.forkDetach(
              taskList.subscribe().pipe(
                Stream.runForEach((ev) =>
                  Effect.gen(function* () {
                    if (ev._tag === "claimed") {
                      const m = yield* Ref.get(running)
                      const entry = m.get(ev.assignee)
                      if (entry === undefined) return
                      const t = yield* taskList.get(ev.taskId)
                      if (t === null || t.teamName !== spec.name) return
                      const nowMs = yield* clock.nowMs()
                      entry.claimedTaskIds.add(ev.taskId)
                      entry.claimedAt.set(ev.taskId, nowMs)
                      entry.laggedTaskIds.delete(ev.taskId)
                    } else if (ev._tag === "completed") {
                      const m = yield* Ref.get(running)
                      for (const entry of m.values()) {
                        entry.claimedTaskIds.delete(ev.taskId)
                        entry.claimedAt.delete(ev.taskId)
                        entry.laggedTaskIds.delete(ev.taskId)
                      }
                    }
                  }),
                ),
                Effect.ignore,
              ),
            )

            // ── Watchdog: lag detection ──
            const watchdogFiber = yield* Effect.forkDetach(
              Effect.gen(function* () {
                while (true) {
                  yield* Effect.sleep(`${orphanCheckIntervalMs} millis`)
                  const closed = yield* Ref.get(closedRef)
                  if (closed) return
                  const nowMs = yield* clock.nowMs()
                  const m = yield* Ref.get(running)
                  for (const entry of m.values()) {
                    for (const [taskId, claimedAtMs] of entry.claimedAt) {
                      if (entry.laggedTaskIds.has(taskId)) continue
                      const stuckMs = nowMs - claimedAtMs
                      if (stuckMs < lagThresholdMs) continue
                      const t = yield* taskList.get(taskId)
                      if (t === null) {
                        entry.claimedAt.delete(taskId)
                        entry.claimedTaskIds.delete(taskId)
                        continue
                      }
                      if (
                        t.status !== "claimed" &&
                        t.status !== "in_progress"
                      ) {
                        entry.claimedAt.delete(taskId)
                        entry.claimedTaskIds.delete(taskId)
                        continue
                      }
                      const err = new TaskCompletionLagError({
                        taskId,
                        stuckMs,
                      })
                      entry.laggedTaskIds.add(taskId)
                      yield* publish({ _tag: "lag", error: err })
                    }
                  }
                }
              }),
            )

            // ── teamScope finalizers (LIFO order on scope close) ──────────
            // Registration order (LIFO = last registered runs FIRST on close):
            //   1. Register: interrupt subscriber daemon → runs 3rd
            //   2. Register: interrupt watchdog daemon  → runs 2nd
            //   3. Register: interrupt teammate fibers + shutdown mailboxes → runs last (actually 4th)
            //   4. Register: orphan-publisher (emit events) + remove team → runs FIRST
            //
            // LIFO execution order on teamScope.close:
            //   (a) orphan-publisher + removeTeam (registered LAST)
            //   (b) teammate fiber interrupts + mailbox shutdowns
            //   (c) watchdog interrupt
            //   (d) subscriber interrupt (registered FIRST)

            // (1) Subscriber interrupt
            yield* Scope.addFinalizer(
              teamScope,
              Fiber.interrupt(subscriberFiber).pipe(Effect.ignore),
            )

            // (2) Watchdog interrupt
            yield* Scope.addFinalizer(
              teamScope,
              Fiber.interrupt(watchdogFiber).pipe(Effect.ignore),
            )

            // (3) Teammate fiber interrupts + mailbox shutdowns
            yield* Scope.addFinalizer(
              teamScope,
              Effect.gen(function* () {
                const m = yield* Ref.get(running)
                for (const entry of m.values()) {
                  yield* Fiber.interrupt(entry.fiber).pipe(Effect.ignore)
                  yield* Queue.shutdown(entry.mailbox)
                }
              }),
            )

            // (4) Orphan-publisher + remove team (runs FIRST in LIFO)
            yield* Scope.addFinalizer(
              teamScope,
              Effect.gen(function* () {
                yield* removeTeam(spec.name)
                const dissolved = yield* Ref.get(dissolvedRef)
                const reason: "lead_exited" | "scope_closed" = dissolved
                  ? "scope_closed"
                  : "lead_exited"
                const m = yield* Ref.get(running)
                for (const teammateName of m.keys()) {
                  const err = new TeammateOrphanedError({
                    teamName: spec.name,
                    teammate: teammateName,
                    reason,
                  })
                  yield* publish({ _tag: "orphaned", error: err })
                }
              }),
            )
          })

        // ─── spawn ────────────────────────────────────────────────────────
        const spawn: TeamBrokerApi["spawn"] = (spec) =>
          spawnCore(spec).pipe(
            Effect.withSpan("luna.team_broker.spawn", {
              attributes: { "team.name": spec.name },
            }),
          )

        // ─── spawnIn ──────────────────────────────────────────────────────
        // Links team lifecycle to the provided leadScope. When leadScope
        // closes, the team is dissolved (reason = "lead_exited").
        const spawnIn: TeamBrokerApi["spawnIn"] = (spec, leadScope) =>
          Effect.gen(function* () {
            yield* spawnCore(spec)
            // Register a finalizer into the leadScope that closes the team.
            // We look up the record at finalizer-time (not at spawn-time) so
            // a prior explicit dissolve is a no-op here.
            yield* Scope.addFinalizer(
              leadScope,
              Effect.gen(function* () {
                const rec = yield* getTeam(spec.name)
                if (rec === null) return // already dissolved
                const already = yield* Ref.get(rec.closedRef)
                if (already) return
                yield* Ref.set(rec.closedRef, true)
                yield* Scope.close(rec.teamScope, Exit.void)
              }),
            )
          })

        // ─── dispatch ─────────────────────────────────────────────────────
        const dispatch: TeamBrokerApi["dispatch"] = (team, to, taskId) =>
          Effect.gen(function* () {
            const rec = yield* getTeam(team)
            if (rec === null) {
              return yield* Effect.fail(
                new IntegrityError({
                  module: "team-broker",
                  resource: "team_exists",
                  message: `team "${team}" not found`,
                }),
              )
            }
            const m = yield* Ref.get(rec.running)
            const entry = m.get(to)
            if (entry === undefined) {
              return yield* Effect.fail(
                new IntegrityError({
                  module: "team-broker",
                  resource: "teammate_exists",
                  message: `teammate "${to}" not in team "${team}"`,
                }),
              )
            }
            const claimed = yield* taskList.claim(taskId, to).pipe(
              Effect.mapError(
                (e) =>
                  new IntegrityError({
                    module: "team-broker",
                    resource: "task_claim",
                    message: `claim failed for ${taskId} → ${to}: ${e._tag}`,
                  }),
              ),
            )
            const nowMs = yield* clock.nowMs()
            entry.claimedTaskIds.add(taskId)
            entry.claimedAt.set(taskId, nowMs)
            entry.laggedTaskIds.delete(taskId)
            yield* Queue.offer(entry.mailbox, {
              _tag: "task",
              taskId: claimed.id,
            })
          })

        // ─── send ─────────────────────────────────────────────────────────
        const send: TeamBrokerApi["send"] = (team, to, payload) =>
          Effect.gen(function* () {
            const rec = yield* getTeam(team)
            if (rec === null) {
              return yield* Effect.fail(
                new IntegrityError({
                  module: "team-broker",
                  resource: "team_exists",
                  message: `team "${team}" not found`,
                }),
              )
            }
            const m = yield* Ref.get(rec.running)
            const entry = m.get(to)
            if (entry === undefined) {
              return yield* Effect.fail(
                new IntegrityError({
                  module: "team-broker",
                  resource: "teammate_exists",
                  message: `teammate "${to}" not in team "${team}"`,
                }),
              )
            }
            yield* Queue.offer(entry.mailbox, { _tag: "raw", payload })
          })

        // ─── members ──────────────────────────────────────────────────────
        const members: TeamBrokerApi["members"] = (team) =>
          Effect.gen(function* () {
            const rec = yield* getTeam(team)
            if (rec === null) return [] as ReadonlyArray<TeammateName>
            const m = yield* Ref.get(rec.running)
            return Array.from(m.keys())
          })

        // ─── events ───────────────────────────────────────────────────────
        const events: TeamBrokerApi["events"] = Stream.fromQueue(eventsQ)

        // ─── dissolve ─────────────────────────────────────────────────────
        // Idempotent. Closes the team's private scope which triggers all
        // per-team finalizers (orphan events, fiber interrupts, mailbox
        // shutdowns). Reason = "scope_closed" because caller explicitly chose
        // to dissolve.
        const dissolve: TeamBrokerApi["dissolve"] = (team) =>
          Effect.gen(function* () {
            const rec = yield* getTeam(team)
            if (rec === null) return
            const already = yield* Ref.get(rec.closedRef)
            if (already) return
            yield* Ref.set(rec.closedRef, true)
            yield* Ref.set(rec.dissolvedRef, true)
            yield* Scope.close(rec.teamScope, Exit.void)
          })

        return {
          spawn,
          spawnIn,
          dispatch,
          send,
          members,
          events,
          dissolve,
        } satisfies TeamBrokerApi
      }),
    )
}
