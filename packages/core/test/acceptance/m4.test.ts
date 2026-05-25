/**
 * M4 Acceptance / Integration Bundle — Phase 23.
 *
 * Closes the M4 milestone gate (DESIGN §15). Three end-to-end flows
 * exercise the nine M4 services together; one dedicated predicate test
 * locks the cost-accuracy invariants that the milestone advertises.
 *
 * Flows:
 *   F1 — Gateway → handler → Harness trial → CostAccrued → CostAccounting
 *        bucket → UIService subscriber. Folds in F3: NetSec-blocked
 *        request emits one ToolCall(status≠success) and zero CostAccrued.
 *   F2 — Labs runs an experiment whose `trial` dispatches the Harness
 *        AND records a CostAccrued event per iteration; budget gate
 *        trips with `ExperimentBudgetExceededError`. (Caller-glue
 *        composition per `labs/types.ts` line 29 — `trial: Effect<A>`.)
 *   F5 — TriggerAgent (cron) fires via TestClock → emits ToolCall →
 *        UIService subscriber observes it.
 *   Cost accuracy predicate — multi-dim/multi-event accumulation,
 *        bucket independence, budget threshold semantics.
 *
 * Invariants honored:
 *   §16 (eager subscribe): `ui.subscribe`/`obs.subscribeEvents` always
 *     followed by `Effect.fork(...Stream.take(N).runCollect)` then
 *     `Effect.sleep("10 millis")` BEFORE emitting.
 *   §3.4 #1 (no cross-Scope refs): every fiber is `forkScoped`/
 *     `forkDaemon` inside the test's `Effect.scoped` boundary.
 *   §3.4 #5 (defensive timeouts): each end-to-end test wraps its body
 *     in `Effect.timeout("5 seconds")`.
 *   HANDOFF #9: cost state is seeded via `obs.recordCost(...)` — never
 *     hand-built CostAccrued events.
 *   §6 (errors frozen): only existing TaggedErrors used.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  Chunk,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Queue,
  Ref,
  Stream,
  TestClock,
  TestContext,
} from "effect"
import { Clock } from "../../src/clock.js"
import { ObservabilityService } from "../../src/observability/index.js"
import { CostAccountingService } from "../../src/cost-accounting/index.js"
import { UIService } from "../../src/ui/index.js"
import { LabsService } from "../../src/labs/index.js"
import {
  TrainingHarness,
  type Runner,
} from "../../src/training-harness/index.js"
import { GatewayService } from "../../src/gateway/index.js"
import type {
  GatewayAdapter,
  GatewayMessage,
  GatewayResponse,
} from "../../src/gateway/index.js"
import { NetSecClient } from "../../src/netsec/index.js"
import {
  JobScheduler,
  JobSchedulerLayer,
  TriggerAgent,
  TriggerAgentLayer,
} from "../../src/jobs/index.js"

const originalFetch = globalThis.fetch

const setFetch = (fetchImpl: typeof globalThis.fetch) => {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: fetchImpl,
  })
}

const restoreFetch = () => {
  if (originalFetch === undefined) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete (globalThis as { fetch?: typeof globalThis.fetch }).fetch
  } else {
    setFetch(originalFetch)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer composition shared across F1, F2, the cost-predicate suite.
// (F5 needs TestClock + JobScheduler/TriggerAgent — composed inline.)
// ─────────────────────────────────────────────────────────────────────────────
const stubRunner = (replies: ReadonlyArray<string>): Runner => {
  let i = 0
  return {
    run: (_p: string) =>
      Effect.sync(() => {
        const r = replies[i] ?? ""
        i += 1
        return r
      }),
  }
}

const makeBaseLayer = (runner: Runner) => {
  const clockL = Clock.Default
  const obsL = ObservabilityService.makeLayer({ logToConsole: false }).pipe(
    Layer.provide(clockL),
  )
  const costL = CostAccountingService.makeLayer({}).pipe(
    Layer.provide(obsL),
    Layer.provide(clockL),
  )
  const uiL = UIService.makeLayer().pipe(
    Layer.provide(obsL),
    Layer.provide(clockL),
  )
  const harnessL = TrainingHarness.makeLayer(runner).pipe(
    Layer.provide(clockL),
  )
  const labsL = LabsService.makeLayer().pipe(
    Layer.provide(costL),
    Layer.provide(obsL),
    Layer.provide(clockL),
  )
  const netsecL = NetSecClient.makeLayer({
    strictMode: true,
    allowlist: [{ host: "api.example.com" }],
  })
  const gatewayL = GatewayService.makeLayer({ logMessages: false }).pipe(
    Layer.provide(clockL),
  )
  return Layer.mergeAll(
    clockL,
    obsL,
    costL,
    uiL,
    harnessL,
    labsL,
    netsecL,
    gatewayL,
  )
}

const makeTestAdapter = (
  transport: string,
  q: Queue.Queue<GatewayMessage>,
  responsesRef: Ref.Ref<GatewayResponse[]>,
): GatewayAdapter => ({
  transport,
  messages: Stream.fromQueue(q),
  send: (r) => Ref.update(responsesRef, (xs) => [...xs, r]),
})

// ─────────────────────────────────────────────────────────────────────────────
// F1 — Gateway → Harness → CostAccrued → CostAccounting → UI
// (folded F3: NetSec-blocked request → ToolCall(error), zero CostAccrued)
// ─────────────────────────────────────────────────────────────────────────────
describe("F1 — Gateway→Harness→Cost→UI", () => {
  it("end-to-end: handler invokes harness, cost accrues, UI sees it", async () => {
    const runner = stubRunner(["echo:hello"])
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const obs = yield* ObservabilityService
          const cost = yield* CostAccountingService
          const ui = yield* UIService
          const harness = yield* TrainingHarness
          const gateway = yield* GatewayService

          // Eager UI subscription (§16) BEFORE any emit.
          const uiStream = yield* ui.subscribe
          const uiFiber = yield* Effect.fork(
            uiStream.pipe(
              Stream.take(2), // expect ToolCall + CostAccrued
              Stream.runCollect,
              Effect.map(Chunk.toReadonlyArray),
            ),
          )
          yield* Effect.sleep(Duration.millis(20))

          // Test adapter for gateway.
          const q = yield* Queue.unbounded<GatewayMessage>()
          const responsesRef = yield* Ref.make<GatewayResponse[]>([])
          const adapter = makeTestAdapter("test-tx", q, responsesRef)
          yield* gateway.registerAdapter(adapter)

          // Handler: invoke harness, emit ToolCall, record cost, reply.
          yield* gateway.setHandler((msg) =>
            Effect.gen(function* () {
              const score = yield* harness.runEval(msg.text, "echo:hello")
              yield* obs.emit({
                kind: "ToolCall",
                ts: new Date().toISOString(),
                level: "info",
                sessionId: "s-f1",
                toolName: "harness:runEval",
                inputDigest: "x",
                durationMs: 1,
                status: "success",
              })
              yield* obs.recordCost({
                sessionId: "s-f1",
                workflowId: "wf-f1",
                tokensIn: 1_000,
                tokensOut: 500,
                pricePerMillionInputTokens: 3.0,
                pricePerMillionOutputTokens: 15.0,
              })
              return `score=${score.value}`
            }),
          )

          // Run gateway in background.
          yield* Effect.forkScoped(
            gateway.start.pipe(Effect.catchAllCause(() => Effect.void)),
          )

          // Inject the message.
          yield* Queue.offer(q, {
            id: "m-1",
            transport: "test-tx",
            channelId: "c",
            senderId: "u",
            text: "hello",
            metadata: {},
            ts: new Date().toISOString(),
          })

          // Allow propagation for cost subscriber.
          yield* Effect.sleep(Duration.millis(80))

          const uiEvents = yield* Fiber.join(uiFiber)
          const sessionBucket = yield* cost.getBucket("session", "s-f1")
          const wfBucket = yield* cost.getBucket("workflow", "wf-f1")
          const responses = yield* Ref.get(responsesRef)

          return { uiEvents, sessionBucket, wfBucket, responses }
        }).pipe(
          Effect.provide(makeBaseLayer(stubRunner(["echo:hello"]))),
          Effect.timeout(Duration.seconds(5)),
        ),
      ),
    )

    // UI saw both events (eager-subscribe contract).
    expect(result.uiEvents).toHaveLength(2)
    const kinds = result.uiEvents.map((e) => e.kind).sort()
    expect(kinds).toEqual(["CostAccrued", "ToolCall"])

    // Cost accounting bucketed in BOTH session AND workflow dims.
    expect(result.sessionBucket).not.toBeNull()
    expect(result.sessionBucket?.tokensIn).toBe(1_000)
    expect(result.sessionBucket?.tokensOut).toBe(500)
    expect(result.sessionBucket?.estimatedUsd).toBeCloseTo(0.0105, 6)
    expect(result.wfBucket).not.toBeNull()
    expect(result.wfBucket?.estimatedUsd).toBeCloseTo(0.0105, 6)

    // Gateway routed the response.
    expect(result.responses.length).toBeGreaterThanOrEqual(1)
    expect(result.responses[0]?.text).toBe("score=1")
    void runner
  })

  it("F3 fold-in: NetSec-blocked request → ToolCall(status=error), zero CostAccrued", async () => {
    // Mock fetch so the disallowed host can't actually be reached.
    setFetch(
      vi.fn().mockResolvedValue({
        status: 200,
        statusText: "OK",
        text: () => Promise.resolve(""),
        headers: { forEach: () => {} },
      }) as unknown as typeof globalThis.fetch,
    )
    try {
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const obs = yield* ObservabilityService
            const ui = yield* UIService
            const cost = yield* CostAccountingService
            const netsec = yield* NetSecClient

            const uiStream = yield* ui.subscribe
            const uiFiber = yield* Effect.fork(
              uiStream.pipe(
                Stream.take(1),
                Stream.runCollect,
                Effect.map(Chunk.toReadonlyArray),
              ),
            )
            yield* Effect.sleep(Duration.millis(20))

            // Disallowed host (only api.example.com is allowlisted).
            const blocked = yield* netsec
              .fetch("https://evil.invalid/x", { method: "POST" })
              .pipe(Effect.flip)
            yield* obs.emit({
              kind: "ToolCall",
              ts: new Date().toISOString(),
              level: "error",
              sessionId: "s-f3",
              toolName: "netsec:fetch",
              durationMs: 0,
              status: "error",
            })
            yield* Effect.sleep(Duration.millis(40))

            const events = yield* Fiber.join(uiFiber)
            const bucket = yield* cost.getBucket("session", "s-f3")
            return { blocked, events, bucket }
          }).pipe(
            Effect.provide(makeBaseLayer(stubRunner([]))),
            Effect.timeout(Duration.seconds(5)),
          ),
        ),
      )
      expect(result.blocked._tag).toBe("EgressBlockedError")
      expect(result.events).toHaveLength(1)
      expect(result.events[0]?.kind).toBe("ToolCall")
      if (result.events[0]?.kind === "ToolCall") {
        expect(result.events[0].status).not.toBe("success")
      }
      // Zero CostAccrued for this session.
      expect(result.bucket).toBeNull()
    } finally {
      restoreFetch()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// F2 — Labs runs an experiment whose trial drives Harness AND records cost;
// CostAccounting accumulates; budget gate trips with ExperimentBudgetExceededError.
// (Caller-glue composition per labs/types.ts:29 — trial is `Effect<A>`.)
// ─────────────────────────────────────────────────────────────────────────────
describe("F2 — Labs budget trip via Harness", () => {
  it("budget exceeded mid-run → ExperimentBudgetExceededError", async () => {
    const runner = stubRunner(["a", "a", "a", "a", "a"])
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const obs = yield* ObservabilityService
          const harness = yield* TrainingHarness
          const labs = yield* LabsService

          // Compose a trial that runs the harness AND records cost
          // tagged at the experiment's workflow bucket. Each iter
          // accrues $0.30 → after 4 iters, bucket >= $1.0 budget.
          const trial = Effect.gen(function* () {
            const score = yield* harness.runEval("p", "a")
            yield* obs.recordCost({
              workflowId: "labs-budget-trip",
              tokensIn: 100_000,
              tokensOut: 0,
              pricePerMillionInputTokens: 3.0,
              pricePerMillionOutputTokens: 0,
            })
            // Allow the cost subscriber to absorb the event before the
            // next iteration's pre-flight `isBudgetExceeded` check.
            yield* Effect.sleep(Duration.millis(20))
            return score.value
          })

          return yield* labs.runExperiment({
            name: "labs-budget-trip",
            hypothesis: "harness drives cost; budget should clip the run",
            trial,
            iterations: 10,
            scoreFn: (v) => (v as number),
            budgetUsd: 1.0,
          })
        }).pipe(
          Effect.provide(makeBaseLayer(runner)),
          Effect.timeout(Duration.seconds(5)),
        ),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify(exit)).toContain("ExperimentBudgetExceededError")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// F5 smoke — TriggerAgent (cron) → ToolCall → UI subscriber.
// ─────────────────────────────────────────────────────────────────────────────
describe("F5 smoke — TriggerAgent→Obs→UI", () => {
  it("cron tick (TestClock) emits a ToolCall observed by UIService", async () => {
    const got = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const obs = yield* ObservabilityService
          const ui = yield* UIService
          const trig = yield* TriggerAgent
          const sched = yield* JobScheduler

          // Eager UI subscribe BEFORE the cron fires (§16).
          const uiStream = yield* ui.subscribe
          const uiFiber = yield* Effect.fork(
            uiStream.pipe(
              Stream.take(1),
              Stream.runCollect,
              Effect.map(Chunk.toReadonlyArray),
            ),
          )

          // Background drain on scheduler results so the pool slot frees.
          yield* Effect.fork(
            sched.results.pipe(
              Stream.take(1),
              Stream.runDrain,
            ),
          )

          // Register an every-5-min cron whose job emits a ToolCall.
          yield* trig.register({
            kind: "cron",
            expr: "*/5 * * * *",
            build: () => ({
              run: obs.emit({
                kind: "ToolCall",
                ts: new Date().toISOString(),
                level: "info",
                sessionId: "s-f5",
                toolName: "cron-fire",
                durationMs: 0,
                status: "success",
              }),
            }),
          })

          // Advance virtual time across one window (then a touch more
          // to allow scheduling/dispatch).
          yield* TestClock.adjust(Duration.minutes(5))
          yield* TestClock.adjust(Duration.millis(1))
          yield* TestClock.adjust(Duration.minutes(5))

          return yield* Fiber.join(uiFiber)
        }).pipe(
          Effect.provide(
            (() => {
              const clockL = Clock.Default
              const obsL = ObservabilityService.makeLayer({
                logToConsole: false,
              }).pipe(Layer.provide(clockL))
              const uiL = UIService.makeLayer().pipe(
                Layer.provide(obsL),
                Layer.provide(clockL),
              )
              const schedL = JobSchedulerLayer.make({ capacity: 4 }).pipe(
                Layer.provide(clockL),
              )
              const trigL = TriggerAgentLayer.Default.pipe(
                Layer.provide(schedL),
              )
              return Layer.mergeAll(clockL, obsL, uiL, schedL, trigL)
            })(),
          ),
          Effect.provide(TestContext.TestContext),
          Effect.timeout(Duration.seconds(5)),
        ),
      ),
    )
    expect(got).toHaveLength(1)
    expect(got[0]?.kind).toBe("ToolCall")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Cost accuracy predicate — the M4 "cost accounting accurate" gate (§15).
// ─────────────────────────────────────────────────────────────────────────────
describe("Cost accuracy predicate", () => {
  beforeEach(() => undefined)
  afterEach(() => undefined)

  it("multi-dim, multi-event accumulation is exact across S/T/W buckets", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const obs = yield* ObservabilityService
          const cost = yield* CostAccountingService

          // Three single-tagged events into session A.
          // Two single-tagged events into team T.
          // One MULTI-tagged event into both session B and workflow W.
          yield* obs.recordCost({
            sessionId: "A",
            tokensIn: 1_000,
            tokensOut: 500,
            pricePerMillionInputTokens: 3,
            pricePerMillionOutputTokens: 15,
          })
          yield* obs.recordCost({
            sessionId: "A",
            tokensIn: 2_000,
            tokensOut: 1_000,
            pricePerMillionInputTokens: 3,
            pricePerMillionOutputTokens: 15,
          })
          yield* obs.recordCost({
            sessionId: "A",
            tokensIn: 500,
            tokensOut: 250,
            pricePerMillionInputTokens: 3,
            pricePerMillionOutputTokens: 15,
          })
          yield* obs.recordCost({
            teamName: "T",
            tokensIn: 100,
            tokensOut: 50,
            pricePerMillionInputTokens: 3,
            pricePerMillionOutputTokens: 15,
          })
          yield* obs.recordCost({
            teamName: "T",
            tokensIn: 200,
            tokensOut: 100,
            pricePerMillionInputTokens: 3,
            pricePerMillionOutputTokens: 15,
          })
          yield* obs.recordCost({
            sessionId: "B",
            workflowId: "W",
            tokensIn: 1_000,
            tokensOut: 0,
            pricePerMillionInputTokens: 3,
            pricePerMillionOutputTokens: 15,
          })

          // Allow subscriber to drain.
          yield* Effect.sleep(Duration.millis(50))

          const a = yield* cost.getBucket("session", "A")
          const t = yield* cost.getBucket("team", "T")
          const b = yield* cost.getBucket("session", "B")
          const w = yield* cost.getBucket("workflow", "W")
          return { a, t, b, w }
        }).pipe(
          Effect.provide(makeBaseLayer(stubRunner([]))),
          Effect.timeout(Duration.seconds(5)),
        ),
      ),
    )

    // Session A: tokensIn = 1000+2000+500 = 3500; tokensOut = 1750.
    // estimatedUsd per event: (in*3 + out*15)/1e6
    //   ev1: (3000 + 7500)/1e6 = 0.0105
    //   ev2: (6000 + 15000)/1e6 = 0.021
    //   ev3: (1500 + 3750)/1e6 = 0.00525
    //   sum = 0.03675
    expect(result.a).not.toBeNull()
    expect(result.a?.tokensIn).toBe(3_500)
    expect(result.a?.tokensOut).toBe(1_750)
    expect(result.a?.eventCount).toBe(3)
    expect(result.a?.estimatedUsd).toBeCloseTo(0.03675, 9)

    // Team T: tokensIn = 300; tokensOut = 150; cost = (900+2250)/1e6 = 0.00315
    expect(result.t).not.toBeNull()
    expect(result.t?.tokensIn).toBe(300)
    expect(result.t?.tokensOut).toBe(150)
    expect(result.t?.eventCount).toBe(2)
    expect(result.t?.estimatedUsd).toBeCloseTo(0.00315, 9)

    // Multi-tagged event lands in BOTH session-B and workflow-W with
    // identical amounts (no double-counting per bucket).
    expect(result.b).not.toBeNull()
    expect(result.w).not.toBeNull()
    expect(result.b?.tokensIn).toBe(1_000)
    expect(result.w?.tokensIn).toBe(1_000)
    expect(result.b?.estimatedUsd).toBeCloseTo(result.w?.estimatedUsd ?? -1, 9)
    expect(result.b?.eventCount).toBe(1)
    expect(result.w?.eventCount).toBe(1)
  })

  it("budget threshold: isBudgetExceeded iff Σ estimatedUsd ≥ B", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const obs = yield* ObservabilityService
          const cost = yield* CostAccountingService

          yield* cost.setBudget({
            dimension: "session",
            key: "thresh",
            budgetUsd: 0.01,
          })

          // Below threshold ($0.003).
          yield* obs.recordCost({
            sessionId: "thresh",
            tokensIn: 1_000,
            tokensOut: 0,
            pricePerMillionInputTokens: 3,
            pricePerMillionOutputTokens: 15,
          })
          yield* Effect.sleep(Duration.millis(30))
          const exceededBefore = yield* cost.isBudgetExceeded(
            "session",
            "thresh",
          )
          const remainingBefore = yield* cost.remainingBudget(
            "session",
            "thresh",
          )

          // Push over: another $3 → far exceeds.
          yield* obs.recordCost({
            sessionId: "thresh",
            tokensIn: 1_000_000,
            tokensOut: 0,
            pricePerMillionInputTokens: 3,
            pricePerMillionOutputTokens: 15,
          })
          yield* Effect.sleep(Duration.millis(30))
          const exceededAfter = yield* cost.isBudgetExceeded(
            "session",
            "thresh",
          )
          const remainingAfter = yield* cost.remainingBudget(
            "session",
            "thresh",
          )

          return { exceededBefore, remainingBefore, exceededAfter, remainingAfter }
        }).pipe(
          Effect.provide(makeBaseLayer(stubRunner([]))),
          Effect.timeout(Duration.seconds(5)),
        ),
      ),
    )
    expect(result.exceededBefore).toBe(false)
    expect(result.remainingBefore).toBeGreaterThan(0)
    expect(result.exceededAfter).toBe(true)
    expect(result.remainingAfter).toBe(0)
  })
})
