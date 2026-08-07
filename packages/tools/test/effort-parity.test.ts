/**
 * effort-parity.test.ts - pins `protocol-descriptor.ts`'s browser-safe effort
 * vocabulary against `@luna/chat-service`'s server-side source of truth.
 *
 * WHY THIS EXISTS (#462). The effort union has to be nameable in two places
 * that cannot import each other: the Moon browser bundle can only reach
 * `@luna/tools/protocol-descriptor` (a zero-import leaf), while the
 * validity matrix and clamping rules must stay in `@luna/chat-service`,
 * which is server-side. Re-pointing chat-service at the leaf would put
 * server behavior at risk inside what is otherwise a typing-debt fix, so the
 * duplication is deliberate - and this test is the price of it.
 *
 * If this goes red, the two lists have drifted: add the new token to
 * `EFFORT_OPTIONS` in protocol-descriptor.ts (order matters, see below) or
 * explain in the diff why the client vocabulary should differ from the
 * server's. Never "fix" it by editing the expectation.
 */
import { describe, expect, it } from "vitest"
import { EFFORT_LEVELS, ULTRACODE, isEffortOption as isEffortOptionServer } from "@luna/chat-service"
import { EFFORT_OPTIONS, isEffortOption } from "../src/protocol-descriptor.js"

describe("effort vocabulary parity: @luna/tools leaf vs @luna/chat-service", () => {
  it("EFFORT_OPTIONS is exactly the server's levels plus the ultracode token, in that order", () => {
    // Order is load-bearing: it is ascending strength with the ultracode
    // SELECTOR last, and the Moon effort menu renders in array order.
    expect(EFFORT_OPTIONS).toEqual([...EFFORT_LEVELS, ULTRACODE])
  })

  it("neither list carries a token the other lacks", () => {
    expect([...EFFORT_OPTIONS].sort()).toEqual([...EFFORT_LEVELS, ULTRACODE].sort())
  })

  it("the leaf guard agrees with the server guard on every in-vocabulary token", () => {
    for (const token of EFFORT_OPTIONS) {
      expect(isEffortOption(token), token).toBe(true)
      expect(isEffortOptionServer(token), token).toBe(true)
    }
  })

  it("the leaf guard agrees with the server guard on rejections", () => {
    // Includes the shapes a hostile or stale server could advertise: wrong
    // case, whitespace, near-misses, and non-strings.
    const rejected: unknown[] = [
      "",
      " ",
      "Low",
      "LOW",
      "low ",
      " low",
      "lo",
      "lowest",
      "ultra",
      "ultracode!",
      "medium\n",
      null,
      undefined,
      0,
      1,
      true,
      false,
      [],
      ["low"],
      {},
      { toString: () => "low" },
      Symbol("low"),
    ]
    for (const value of rejected) {
      expect(isEffortOption(value), String(value?.toString?.() ?? value)).toBe(false)
      expect(isEffortOptionServer(value), String(value?.toString?.() ?? value)).toBe(false)
    }
  })

  it("the leaf guard narrows the type, not just the value", () => {
    const wire: unknown = "max"
    if (isEffortOption(wire)) {
      // Compile-time proof the guard produces the union: this assignment
      // fails tsc if `isEffortOption` ever loses its `v is EffortOption`
      // predicate, which is the whole reason the leaf carries a value.
      const narrowed: "low" | "medium" | "high" | "xhigh" | "max" | "ultracode" = wire
      expect(narrowed).toBe("max")
    } else {
      throw new Error("guard rejected a valid token")
    }
  })
})
