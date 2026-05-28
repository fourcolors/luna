import { Effect, Layer } from "effect"
import type { DreamOp, DreamReasonerApi } from "./types.js"

export class DreamReasoner extends Effect.Tag("luna/DreamReasoner")<
  DreamReasoner,
  DreamReasonerApi
>() {}

/** Test/wiring double — returns a fixed op list, ignoring inputs. */
export const FakeReasoner = {
  of: (ops: ReadonlyArray<DreamOp>): Layer.Layer<DreamReasoner> =>
    Layer.succeed(DreamReasoner, { reason: () => Effect.succeed(ops) }),
} as const
