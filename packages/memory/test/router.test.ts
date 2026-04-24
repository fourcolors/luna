/**
 * MemoryRouter tests — pattern dispatch + fan-out.
 */
import { describe, expect, it } from "vitest"
import { Effect, Stream } from "effect"
import { InMemoryBackend } from "../src/backends/in-memory.js"
import { makeRouter, type Rule } from "../src/router.js"
import type { MemoryBackend } from "../src/backend.js"
import { makeRecord } from "../src/types.js"

async function makeInMem(): Promise<MemoryBackend> {
  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* InMemoryBackend
    }).pipe(Effect.provide(InMemoryBackend.Default)),
  )
}

describe("MemoryRouter", () => {
  it("requires at least one rule and a default", async () => {
    expect(() => makeRouter([])).toThrow()
    const be = await makeInMem()
    expect(() =>
      makeRouter([{ pattern: "session:*", backend: be }]),
    ).toThrow()
  })

  it("dispatches writes by namespace pattern", async () => {
    const sessionBe = await makeInMem()
    const defaultBe = await makeInMem()
    const router = makeRouter([
      { pattern: "session:*", backend: sessionBe },
      { pattern: "*", backend: defaultBe },
    ])

    await Effect.runPromise(
      router.put(
        makeRecord({
          id: "a",
          namespace: "session:abc",
          kind: "k",
          content: 1,
        }),
      ),
    )
    await Effect.runPromise(
      router.put(
        makeRecord({
          id: "b",
          namespace: "profile:me",
          kind: "k",
          content: 2,
        }),
      ),
    )

    const aInSession = await Effect.runPromise(sessionBe.get("a"))
    const aInDefault = await Effect.runPromise(defaultBe.get("a"))
    const bInSession = await Effect.runPromise(sessionBe.get("b"))
    const bInDefault = await Effect.runPromise(defaultBe.get("b"))

    expect(aInSession?.id).toBe("a")
    expect(aInDefault).toBeNull()
    expect(bInSession).toBeNull()
    expect(bInDefault?.id).toBe("b")
  })

  it("get falls through backends in order", async () => {
    const a = await makeInMem()
    const b = await makeInMem()
    const router = makeRouter([
      { pattern: "ns:a", backend: a },
      { pattern: "*", backend: b },
    ])
    // Put into the non-matching backend for id lookup to still find it.
    await Effect.runPromise(
      b.put(
        makeRecord({ id: "only-in-b", namespace: "other", kind: "k", content: 0 }),
      ),
    )
    const hit = await Effect.runPromise(router.get("only-in-b"))
    expect(hit?.id).toBe("only-in-b")
  })

  it("query without namespace fans out across all backends", async () => {
    const a = await makeInMem()
    const b = await makeInMem()
    const router = makeRouter([
      { pattern: "x:*", backend: a },
      { pattern: "*", backend: b },
    ])
    await Effect.runPromise(
      a.put(makeRecord({ id: "1", namespace: "x:z", kind: "k", content: 0 })),
    )
    await Effect.runPromise(
      b.put(makeRecord({ id: "2", namespace: "other", kind: "k", content: 0 })),
    )
    const all = await Effect.runPromise(Stream.runCollect(router.query({})))
    const ids = Array.from(all)
      .map((r) => r.id)
      .sort()
    expect(ids).toEqual(["1", "2"])
  })

  it("exportAll returns one envelope per backend", async () => {
    const a = await makeInMem()
    const b = await makeInMem()
    const router = makeRouter([
      { pattern: "a:*", backend: a },
      { pattern: "*", backend: b },
    ])
    await Effect.runPromise(
      a.put(makeRecord({ id: "1", namespace: "a:x", kind: "k", content: 0 })),
    )
    const envs = await Effect.runPromise(router.exportAll())
    expect(envs.length).toBe(2)
    expect(envs.map((e) => e.backend).sort()).toEqual([
      "in-memory",
      "in-memory",
    ])
  })
})
