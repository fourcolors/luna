import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { WakeReasoner, FakeWakeReasoner } from "./reasoner.js"
import type { WakeDigest, WakeInputs } from "./types.js"

describe("FakeWakeReasoner", () => {
  it("returns the injected digest verbatim", async () => {
    const digest: WakeDigest = {
      workspaceSlug: "luna",
      observations: ["nothing new"],
      pickedActionId: null,
      pickedReason: "all open actions blocked on operator input",
      proposedActions: [],
    }
    const inputs: WakeInputs = {
      workspaceSlug: "luna",
      workspaceMd: "",
      openGoals: [],
      openNextActions: [],
      recentWakes: [],
    }
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const r = yield* WakeReasoner
        return yield* r.reason(inputs)
      }).pipe(Effect.provide(FakeWakeReasoner.of(digest))),
    )
    expect(out).toEqual(digest)
  })
})
