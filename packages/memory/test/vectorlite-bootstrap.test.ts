/**
 * LunaSqliteBootstrapLive unit tests (Phase 27a).
 *
 * Covers:
 *   - The Layer builds without error in any runtime (delegates to the
 *     idempotent `initVectorlite()` which never throws).
 *   - The exposed Tag value matches `initVectorlite()`'s return shape.
 *   - Idempotent across multiple Layer.build calls — the cached result
 *     in vectorlite-init means repeated builds see the same value.
 *
 * Note: success-path coverage (ok:true) needs both bun runtime AND
 * Homebrew sqlite + the vectorlite prebuilt; under stock node+vitest we
 * only see the `ok:false, reason: "vectorlite requires bun runtime"`
 * branch. That's enough to validate Layer wiring; the bun-runtime
 * happy path is exercised by the integration-boot regression test.
 */
import { afterEach, describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { LunaSqliteBootstrap } from "@luna/core"
import { LunaSqliteBootstrapLive } from "../src/backends/vectorlite-bootstrap.js"
import { _resetVectorliteInitForTests } from "../src/backends/vectorlite-init.js"

describe("LunaSqliteBootstrapLive", () => {
  afterEach(() => {
    _resetVectorliteInitForTests()
    delete process.env.LUNA_DISABLE_VECTORLITE
  })

  it("Layer builds without error and yields a VectorliteInitResult", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          return yield* LunaSqliteBootstrap
        }).pipe(Effect.provide(LunaSqliteBootstrapLive)),
      ),
    )
    // Result is a discriminated union — must have `ok` boolean and the
    // matching companion field.
    expect(typeof result.ok).toBe("boolean")
    if (result.ok) {
      expect(typeof result.path).toBe("string")
    } else {
      expect(typeof result.reason).toBe("string")
    }
  })

  it("is idempotent across multiple builds (cached result)", async () => {
    const eff = Effect.scoped(
      Effect.gen(function* () {
        return yield* LunaSqliteBootstrap
      }).pipe(Effect.provide(LunaSqliteBootstrapLive)),
    )
    const a = await Effect.runPromise(eff)
    const b = await Effect.runPromise(eff)
    // The cached result inside vectorlite-init means both calls return
    // the exact same reference — proves the Layer doesn't re-do the
    // setCustomSQLite swap.
    expect(b).toBe(a)
  })

  it("reflects LUNA_DISABLE_VECTORLITE=1 (forced fallback path)", async () => {
    _resetVectorliteInitForTests()
    process.env.LUNA_DISABLE_VECTORLITE = "1"
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          return yield* LunaSqliteBootstrap
        }).pipe(Effect.provide(LunaSqliteBootstrapLive)),
      ),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/LUNA_DISABLE_VECTORLITE/)
    }
  })

  it("Layer is well-typed (compiles with Layer.Layer<LunaSqliteBootstrap>)", () => {
    // Type-only assertion: if this file typechecks, the Live Layer is
    // a `Layer.Layer<LunaSqliteBootstrap, never, never>` as documented.
    const _l: Layer.Layer<LunaSqliteBootstrap> = LunaSqliteBootstrapLive
    expect(_l).toBeDefined()
  })
})
