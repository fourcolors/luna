/**
 * TrainingHarness — tests (Phase 20).
 */
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { Clock } from "../src/clock.js"
import {
  TrainingHarness,
  exactMatchScore,
  type Runner,
} from "../src/training-harness/index.js"

const stubRunner = (replies: ReadonlyArray<string>): Runner => {
  let i = 0
  return {
    run: (_prompt: string) =>
      Effect.sync(() => {
        const r = replies[i] ?? ""
        i += 1
        return r
      }),
  }
}

const echoRunner: Runner = {
  run: (prompt) => Effect.succeed(`echo:${prompt}`),
}

const run = <A>(
  eff: Effect.Effect<A, unknown, TrainingHarness>,
  runner: Runner,
) =>
  Effect.runPromise(
    eff.pipe(
      Effect.provide(TrainingHarness.makeLayer(runner)),
      Effect.provide(Clock.Default),
    ),
  )

describe("TrainingHarness", () => {
  it("runEval: exact match → 1.0", async () => {
    const score = await run(
      Effect.gen(function* () {
        const h = yield* TrainingHarness
        return yield* h.runEval("hi", "echo:hi")
      }),
      echoRunner,
    )
    expect(score.value).toBe(1.0)
    expect(score.actual).toBe("echo:hi")
    expect(score.prompt).toBe("hi")
    expect(score.expected).toBe("echo:hi")
    expect(typeof score.ts).toBe("string")
  })

  it("runEval: mismatch → 0.0", async () => {
    const score = await run(
      Effect.gen(function* () {
        const h = yield* TrainingHarness
        return yield* h.runEval("hi", "different")
      }),
      echoRunner,
    )
    expect(score.value).toBe(0.0)
  })

  it("runEval: custom scoreFn", async () => {
    const lengthScore = (a: string, e: string) =>
      Math.min(1, e.length === 0 ? 1 : a.length / e.length)
    const score = await run(
      Effect.gen(function* () {
        const h = yield* TrainingHarness
        return yield* h.runEval("p", "1234", lengthScore)
      }),
      stubRunner(["12"]),
    )
    expect(score.value).toBe(0.5)
  })

  it("runBatch: returns score array of same length", async () => {
    const scores = await run(
      Effect.gen(function* () {
        const h = yield* TrainingHarness
        return yield* h.runBatch([
          { prompt: "a", expected: "echo:a" },
          { prompt: "b", expected: "echo:b" },
          { prompt: "c", expected: "echo:nope" },
        ])
      }),
      echoRunner,
    )
    expect(scores).toHaveLength(3)
    expect(scores[0]?.value).toBe(1.0)
    expect(scores[1]?.value).toBe(1.0)
    expect(scores[2]?.value).toBe(0.0)
  })

  it("runBatch: average score reflects mixed outcomes", async () => {
    const scores = await run(
      Effect.gen(function* () {
        const h = yield* TrainingHarness
        return yield* h.runBatch([
          { prompt: "a", expected: "echo:a" },
          { prompt: "b", expected: "wrong" },
        ])
      }),
      echoRunner,
    )
    const avg = scores.reduce((s, x) => s + x.value, 0) / scores.length
    expect(avg).toBe(0.5)
  })

  it("exactMatchScore helper exposed", () => {
    expect(exactMatchScore("a", "a")).toBe(1)
    expect(exactMatchScore("a", "b")).toBe(0)
  })
})
