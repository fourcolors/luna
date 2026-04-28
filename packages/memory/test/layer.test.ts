/**
 * MemoryLayer tests — composition helper that provides MemoryRouterTag.
 */
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { InMemoryBackend } from "../src/backends/in-memory.js"
import { MemoryLayer } from "../src/layer.js"
import { MemoryRouterTag } from "../src/router.js"
import type { MemoryBackend } from "../src/backend.js"
import { makeRecord } from "../src/types.js"

async function makeInMem(): Promise<MemoryBackend> {
  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* InMemoryBackend
    }).pipe(Effect.provide(InMemoryBackend.Default)),
  )
}

describe("MemoryLayer", () => {
  it("dispatches by namespace prefix to the matching backend", async () => {
    const sessionBe = await makeInMem()
    const defaultBe = await makeInMem()
    const layer = MemoryLayer({
      rules: [
        { pattern: "session:*", backend: sessionBe },
        { pattern: "*", backend: defaultBe },
      ],
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const router = yield* MemoryRouterTag
        yield* router.put(
          makeRecord({
            id: "x",
            namespace: "session:abc",
            kind: "k",
            content: 1,
          }),
        )
      }).pipe(Effect.provide(layer)),
    )

    const inSession = await Effect.runPromise(sessionBe.get("x"))
    const inDefault = await Effect.runPromise(defaultBe.get("x"))
    expect(inSession?.id).toBe("x")
    expect(inDefault).toBeNull()
  })

  it("falls through to the default '*' rule when no prefix matches", async () => {
    const sessionBe = await makeInMem()
    const defaultBe = await makeInMem()
    const layer = MemoryLayer({
      rules: [
        { pattern: "session:*", backend: sessionBe },
        { pattern: "*", backend: defaultBe },
      ],
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const router = yield* MemoryRouterTag
        yield* router.put(
          makeRecord({
            id: "y",
            namespace: "knowledge:foo",
            kind: "k",
            content: 2,
          }),
        )
      }).pipe(Effect.provide(layer)),
    )

    const inSession = await Effect.runPromise(sessionBe.get("y"))
    const inDefault = await Effect.runPromise(defaultBe.get("y"))
    expect(inSession).toBeNull()
    expect(inDefault?.id).toBe("y")
  })

  it("roundtrips put → get via the Tag-resolved router", async () => {
    const be = await makeInMem()
    const layer = MemoryLayer({
      rules: [{ pattern: "*", backend: be }],
    })

    const got = await Effect.runPromise(
      Effect.gen(function* () {
        const router = yield* MemoryRouterTag
        yield* router.put(
          makeRecord({
            id: "z",
            namespace: "anything",
            kind: "k",
            content: { hello: "world" },
          }),
        )
        return yield* router.get("z")
      }).pipe(Effect.provide(layer)),
    )

    expect(got?.id).toBe("z")
    expect((got?.content as { hello: string }).hello).toBe("world")
  })

  it("fails when no default '*' rule is provided", async () => {
    const be = await makeInMem()
    const badLayer = MemoryLayer({
      rules: [{ pattern: "session:*", backend: be }],
    })

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          return yield* MemoryRouterTag
        }).pipe(Effect.provide(badLayer)),
      ),
    ).rejects.toThrow(/default rule/)
  })
})
