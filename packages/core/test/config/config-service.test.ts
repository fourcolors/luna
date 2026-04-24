/**
 * ConfigService — layered resolve with schema validation.
 */
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import {
  ConfigService,
  memorySource,
} from "../../src/config/config-service.js"

describe("ConfigService", () => {
  it("composes layers and validates the result", async () => {
    const layer = ConfigService.fromSources([
      memorySource("global", { model: "old", tags: ["global"] }),
      memorySource("project", { model: "new", tags: ["project"] }),
    ])

    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* ConfigService
        return yield* svc.resolve()
      }).pipe(Effect.provide(layer)),
    )
    expect(out.model).toBe("new")
    expect(out.tags).toEqual(["global", "project"])
  })

  it("applies per-call override at highest precedence", async () => {
    const layer = ConfigService.fromSources([
      memorySource("global", { model: "m1", idleTimeoutMs: 10_000 }),
    ])
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* ConfigService
        return yield* svc.resolve({ idleTimeoutMs: 500 })
      }).pipe(Effect.provide(layer)),
    )
    expect(out.idleTimeoutMs).toBe(500)
    expect(out.model).toBe("m1")
  })

  it("fails with ConfigError on schema-invalid composed result", async () => {
    const layer = ConfigService.fromSources([
      memorySource("bad", { model: "" }), // empty → schema rejects
    ])
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const svc = yield* ConfigService
        return yield* svc.resolve()
      }).pipe(Effect.provide(layer)),
    )
    expect(exit._tag).toBe("Failure")
  })

  it("works with zero sources + override-only", async () => {
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* ConfigService
        return yield* svc.resolve({ model: "only-override" })
      }).pipe(Effect.provide(ConfigService.Empty)),
    )
    expect(out.model).toBe("only-override")
  })
})
