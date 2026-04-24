/**
 * OnePasswordSecretProvider cache TTL tests — uses a mock Clock and a
 * mocked spawn to verify the layer-scoped Map cache hit/miss behavior.
 */
import { EventEmitter } from "node:events"
import { describe, expect, it, vi, beforeEach } from "vitest"
import { Effect, Layer } from "effect"

interface SpawnRecord {
  readonly args: ReadonlyArray<string>
}
const spawnLog: SpawnRecord[] = []

vi.mock("node:child_process", () => ({
  spawn: (
    _cmd: string,
    args: ReadonlyArray<string>,
  ) => {
    spawnLog.push({ args })
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter
      stderr: EventEmitter
    }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    queueMicrotask(() => {
      // Echo the ref back as the secret so we can tell refs apart.
      const ref = args[args.length - 1] ?? ""
      child.stdout.emit("data", `secret-for:${ref}`)
      child.emit("close", 0)
    })
    return child
  },
}))

import { Clock } from "../clock.js"
import { SecretProvider } from "./secret-provider.js"
import { OnePasswordSecretProvider } from "./onepassword-backend.js"

const makeMockClock = (initialMs: number) => {
  const holder = { now: initialMs }
  const layer = Layer.succeed(
    Clock,
    Clock.of({
      _tag: "experiment-agent/Clock",
      nowMs: () => Effect.sync(() => holder.now),
      nowIso: () =>
        Effect.sync(() => new Date(holder.now).toISOString()),
    }),
  )
  return { layer, setNow: (ms: number) => (holder.now = ms) }
}

beforeEach(() => {
  spawnLog.length = 0
})

describe("OnePasswordSecretProvider cache TTL", () => {
  it("two get() calls within TTL → spawn called once", async () => {
    const clock = makeMockClock(0)
    const layer = OnePasswordSecretProvider.make({
      vault: "v",
      ttlMs: 1000,
    }).pipe(Layer.provide(clock.layer))

    await Effect.runPromise(
      Effect.gen(function* () {
        const sp = yield* SecretProvider
        yield* sp.get("op://v/i/f")
        // Move clock forward but stay within TTL.
        yield* Effect.sync(() => clock.setNow(500))
        yield* sp.get("op://v/i/f")
      }).pipe(Effect.provide(layer)),
    )
    expect(spawnLog).toHaveLength(1)
  })

  it("advance past TTL → next get() spawns again (2 total)", async () => {
    const clock = makeMockClock(0)
    const layer = OnePasswordSecretProvider.make({
      vault: "v",
      ttlMs: 1000,
    }).pipe(Layer.provide(clock.layer))

    await Effect.runPromise(
      Effect.gen(function* () {
        const sp = yield* SecretProvider
        yield* sp.get("op://v/i/f")
        // Past TTL → cache entry expired.
        yield* Effect.sync(() => clock.setNow(2_000))
        yield* sp.get("op://v/i/f")
      }).pipe(Effect.provide(layer)),
    )
    expect(spawnLog).toHaveLength(2)
  })

  it("different refs within TTL → spawn called per ref (no cross-ref hit)", async () => {
    const clock = makeMockClock(0)
    const layer = OnePasswordSecretProvider.make({
      vault: "v",
      ttlMs: 60_000,
    }).pipe(Layer.provide(clock.layer))

    await Effect.runPromise(
      Effect.gen(function* () {
        const sp = yield* SecretProvider
        yield* sp.get("op://v/i/f1")
        yield* sp.get("op://v/i/f2")
        // Repeat both — should hit cache.
        yield* sp.get("op://v/i/f1")
        yield* sp.get("op://v/i/f2")
      }).pipe(Effect.provide(layer)),
    )
    expect(spawnLog).toHaveLength(2)
  })
})
