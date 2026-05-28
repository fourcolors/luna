import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { DreamReasoner, FakeReasoner } from "./reasoner.js"
import type { DreamOp } from "./types.js"

describe("FakeReasoner", () => {
  it("returns the injected ops verbatim", async () => {
    const ops: DreamOp[] = [
      { kind: "memory_dedup", targetId: "m1", before: { id: "m1" }, after: null, rationale: "dup" },
    ]
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const r = yield* DreamReasoner
        return yield* r.reason({ sessions: [], memories: [] })
      }).pipe(Effect.provide(FakeReasoner.of(ops))),
    )
    expect(out).toEqual(ops)
  })
})
