/**
 * luna-doctor-workflow.test.ts — unit coverage for `clampMaxTurns`, the pure
 * clamp extracted from the `apply` subcommand's max_turns patch logic.
 *
 * WHY THIS EXISTS. Nothing in the repo executes this script directly (it's
 * invoked as a CLI step by the doctor's kind=workflow pipeline), so the clamp
 * — which NEVER lowers max_turns, even for an LLM-authored plan.json patch —
 * had zero test coverage. Importing the module is safe because its top-level
 * arg-parsing side effects (the usage-error exit, and `main()` itself) are
 * gated behind `import.meta.main`, same convention as
 * vault-migrate-keychain.ts.
 */
import { describe, expect, it } from "vitest"
import { clampMaxTurns } from "./luna-doctor-workflow.js"

describe("clampMaxTurns", () => {
  it("keeps the higher current value when current > proposed (never downgrades)", () => {
    expect(clampMaxTurns(30, 15)).toBe(30)
  })

  it("adopts the proposed value when proposed > current", () => {
    expect(clampMaxTurns(10, 20)).toBe(20)
  })

  it("falls back to proposed when current is missing", () => {
    expect(clampMaxTurns(undefined, 15)).toBe(15)
  })

  it("falls back to proposed when current is non-numeric", () => {
    expect(clampMaxTurns("thirty", 15)).toBe(15)
    expect(clampMaxTurns(null, 15)).toBe(15)
    expect(clampMaxTurns({}, 15)).toBe(15)
  })

  it("falls back to proposed when current is NaN", () => {
    expect(clampMaxTurns(NaN, 15)).toBe(15)
  })

  it("returns undefined when proposed is undefined, regardless of current", () => {
    expect(clampMaxTurns(30, undefined)).toBeUndefined()
    expect(clampMaxTurns(undefined, undefined)).toBeUndefined()
  })
})
