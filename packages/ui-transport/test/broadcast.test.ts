/**
 * Broadcast post-close subscribe: a subscribe() after close() must resolve
 * done:true immediately. Before the fix it replayed the stale #last value
 * and then parked a waiter that could never resolve (publish() no-ops after
 * close), hanging any for-await loop forever.
 */
import { describe, expect, it } from "vitest"
import { Broadcast } from "../src/internal/broadcast.js"

describe("Broadcast post-close subscribe", () => {
  it("resolves done:true immediately instead of replaying a stale value", async () => {
    const b = new Broadcast<string>()
    b.publish("stale")
    b.close()
    const first = await b.subscribe().next()
    expect(first.done).toBe(true)
  })

  it("for-await over a post-close subscribe exits instead of hanging", async () => {
    const b = new Broadcast<string>()
    b.publish("stale")
    b.close()
    const seen: string[] = []
    for await (const v of b.subscribe()) {
      seen.push(v)
    }
    expect(seen).toEqual([])
  })

  it("pre-close behavior is unchanged: replay-latest, live values, then done on close", async () => {
    const b = new Broadcast<string>()
    b.publish("one")
    const it = b.subscribe()
    expect(await it.next()).toEqual({ value: "one", done: false })
    b.publish("two")
    expect(await it.next()).toEqual({ value: "two", done: false })
    b.close()
    const after = await it.next()
    expect(after.done).toBe(true)
  })
})
