/**
 * Stream ↔ AsyncIterable bridge — round-trip + error propagation tests
 * per DESIGN.md §12.2 invariants.
 */
import { describe, expect, it } from "vitest"
import { Effect, Stream } from "effect"
import {
  fromAsyncIterable,
  toAsyncIterable,
  toAsyncIterableEffect,
} from "../src/stream-bridge.js"

async function* produce<T>(items: T[]): AsyncIterable<T> {
  for (const x of items) yield x
}

describe("stream-bridge", () => {
  it("fromAsyncIterable round-trips values", async () => {
    const stream = fromAsyncIterable<number, Error>(
      () => produce([1, 2, 3]),
      (e) => new Error(String(e)),
    )
    const out = await Effect.runPromise(Stream.runCollect(stream))
    expect(Array.from(out)).toEqual([1, 2, 3])
  })

  it("fromAsyncIterable maps thrown errors via onError", async () => {
    async function* bad(): AsyncIterable<number> {
      yield 1
      throw new Error("boom")
    }
    const stream = fromAsyncIterable<number, string>(
      () => bad(),
      (e) => (e as Error).message,
    )
    const exit = await Effect.runPromiseExit(Stream.runDrain(stream))
    expect(exit._tag).toBe("Failure")
  })

  it("toAsyncIterable yields the stream's values", async () => {
    const stream = Stream.fromIterable([10, 20, 30])
    const iter = toAsyncIterable(stream)
    const out: number[] = []
    for await (const v of iter) out.push(v)
    expect(out).toEqual([10, 20, 30])
  })

  it("round-trips: AsyncIterable → Stream → AsyncIterable", async () => {
    const stream = fromAsyncIterable<string, Error>(
      () => produce(["a", "b", "c"]),
      (e) => e as Error,
    )
    const iter = await Effect.runPromise(toAsyncIterableEffect(stream))
    const out: string[] = []
    for await (const v of iter) out.push(v)
    expect(out).toEqual(["a", "b", "c"])
  })
})
