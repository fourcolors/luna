// packages/core/src/wake/reasoner.ts
//
// WakeReasoner Tag + FakeReasoner test double. Mirrors dream/reasoner.ts
// exactly: the Tag lives in core, the SDK-backed default lives in adapter-sdk
// to avoid the core → adapter-sdk dependency cycle.
import { Context, Effect, Layer } from "effect"
import type { WakeDigest, WakeReasonerApi } from "./types.js"

export class WakeReasoner extends Context.Service<WakeReasoner, WakeReasonerApi>()("luna/WakeReasoner") {}

/** Test/wiring double — returns a fixed digest, ignoring inputs. */
export const FakeWakeReasoner = {
  of: (digest: WakeDigest): Layer.Layer<WakeReasoner> =>
    Layer.succeed(WakeReasoner, {
      reason: () => Effect.succeed(digest),
    }),
} as const
