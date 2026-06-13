/**
 * Durability tests (V2-native) — a schedule is a durable RECURRING
 * `kind:"prompt"` row in the `jobs` table. There is no in-process fiber to
 * register and nothing to reload at boot: the V2 JobTicker reads the table on
 * every tick, so a chat-server restart is a zero-tick gap.
 *
 * Scenarios:
 *   (1) schedule_create persists a recurring prompt row in JobsStore.
 *   (2) The row survives a "restart" (a fresh SchedulerToolsLayer over the same
 *       store still lists it — no re-registration needed).
 *   (3) schedule_cancel deletes the row so it does not come back.
 *
 * Uses JobsStoreService.Memory so they're deterministic.
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { Clock, JobsStoreService } from "@luna/core"
import { makeSchedulerTools } from "../src/tools.js"

interface ToolText {
  readonly content?: ReadonlyArray<{ type: string; text: string }>
  readonly isError?: boolean
}
const parseJson = <T,>(r: ToolText): T => {
  expect(r.isError).toBeFalsy()
  return JSON.parse((r.content?.[0] as { text: string }).text) as T
}

const withStore = <A>(prog: Effect.Effect<A, unknown, JobsStoreService>) =>
  prog.pipe(Effect.provide(JobsStoreService.Memory.pipe(Layer.provide(Clock.Default))))

describe("scheduler durability (V2)", () => {
  it("persists a recurring prompt row, survives a restart, and cancel removes it", async () => {
    await Effect.runPromise(
      withStore(
        Effect.gen(function* () {
          const jobs = yield* JobsStoreService

          // ── Boot 1: create a schedule ──────────────────────────────────
          const [create1] = makeSchedulerTools(jobs)
          const created = parseJson<{ triggerId: string }>(
            yield* Effect.promise(() =>
              create1.handler(
                { expr: "*/5 * * * *", prompt: "poll the queue", label: "poll" },
                undefined,
              ),
            ),
          )

          // (1) A durable recurring prompt row exists.
          const row = yield* jobs.getById(created.triggerId)
          expect(row?.kind).toBe("prompt")
          expect(row?.spec).toBe("*/5 * * * *")
          expect(row?.enabled).toBe(true)
          expect(row?.payload.source).toBe("scheduler-tools")

          // ── Boot 2 (simulated restart): a fresh tools binding over the SAME
          //     store still lists the schedule — nothing to re-register. ────
          const [, list2] = makeSchedulerTools(jobs)
          const listed = parseJson<{
            triggers: Array<{ triggerId: string; expr: string | null; source: string }>
          }>(yield* Effect.promise(() => list2.handler({}, undefined)))
          const survivor = listed.triggers.find((t) => t.triggerId === created.triggerId)
          expect(survivor).toBeDefined()
          expect(survivor?.expr).toBe("*/5 * * * *")
          expect(survivor?.source).toBe("agent")

          // (3) cancel via the ORIGINAL id removes the row; it does not come back.
          const [, , cancel2] = makeSchedulerTools(jobs)
          const cancelled = parseJson<{ cancelled: boolean }>(
            yield* Effect.promise(() =>
              cancel2.handler({ triggerId: created.triggerId }, undefined),
            ),
          )
          expect(cancelled.cancelled).toBe(true)
          expect(yield* jobs.getById(created.triggerId)).toBeNull()
        }),
      ),
    )
  })
})
