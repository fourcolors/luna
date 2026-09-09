/**
 * Drift guard: every usage-limit refusal the Claude Code SDK can emit must be
 * classifiable by Luna's shared throttle table.
 *
 * THE INCIDENT THIS EXISTS FOR. On 2026-09-09 a chat thread received
 *
 *   "Claude Code returned an error result: You're out of usage credits.
 *    Switch to another model to continue."
 *
 * seventeen consecutive times while a healthy sibling account sat idle. The
 * phrase matched nothing in `classifyThrottleKind`, which returned `undefined`
 * and thereby no-op'd BOTH consumers at once: the adapter never reported a
 * throttle (so the broker never cooled the account) and `defaultIsRotatableError`
 * refused to rotate the lane. Nothing logged, nothing alerted — the classifier
 * silently answered "that isn't a throttle."
 *
 * At the time Luna's table matched 2 of the SDK's 12 canonical usage-limit
 * prefixes. That ratio is the real defect: the list is upstream's and it grows
 * on SDK bumps, so a hand-maintained copy is guaranteed to fall behind again.
 *
 * This suite reads `USAGE_LIMIT_ERROR_PREFIXES` straight from the installed SDK
 * and asserts Luna classifies every entry. A future SDK bump that adds a phrase
 * Luna doesn't know now fails HERE, loudly, at CI time — instead of silently, in
 * production, as a thread that cannot make progress.
 *
 * Lives in adapter-sdk because the dependency edge runs adapter-sdk -> core, so
 * this is the only package that can import both the SDK and @luna/core.
 */

import { describe, it, expect } from "vitest"
import { USAGE_LIMIT_ERROR_PREFIXES } from "@anthropic-ai/claude-agent-sdk"
import { defaultIsRotatableError, classifyThrottleKind } from "@luna/core"
import { classifyThrottle } from "../src/throttle.js"

/**
 * How the SDK actually surfaces these. `Query.readMessages` throws
 * `Error("Claude Code returned an error result: " + text)`, and that wrapped
 * string — not the bare prefix — is what reaches `classifyThrottle`. Asserting
 * the bare prefix alone would pass while the real-world text still failed.
 */
const wrap = (phrase: string) => `Claude Code returned an error result: ${phrase}`

describe("SDK usage-limit prefix drift guard", () => {
  it("exports the prefix list this guard is built on", () => {
    // Fail loud rather than skip: if a future SDK drops or renames this export,
    // the guard has stopped guarding and a maintainer needs to know that now.
    expect(
      Array.isArray(USAGE_LIMIT_ERROR_PREFIXES),
      "@anthropic-ai/claude-agent-sdk no longer exports USAGE_LIMIT_ERROR_PREFIXES — " +
        "this drift guard is inert until it is re-pointed at the new export.",
    ).toBe(true)
    expect(USAGE_LIMIT_ERROR_PREFIXES.length).toBeGreaterThan(0)
  })

  for (const phrase of USAGE_LIMIT_ERROR_PREFIXES) {
    describe(`"${phrase}"`, () => {
      it("classifies as a throttle, both bare and SDK-wrapped", () => {
        expect(classifyThrottle(new Error(phrase)).throttled).toBe(true)
        expect(classifyThrottle(new Error(wrap(phrase))).throttled).toBe(true)
      })

      it("rotates the lane", () => {
        // The second consumer of the shared table. A phrase that cools the
        // account but does not rotate strands the caller on a benched account.
        expect(defaultIsRotatableError(new Error(wrap(phrase)))).toBe(true)
      })

      it("resolves to a kind the broker gives a long cooldown", () => {
        const kind = classifyThrottleKind(wrap(phrase).toLowerCase())
        // `session_limit` is the pre-existing long-cooldown kind and some SDK
        // prefixes ("You've hit your…") legitimately land there; both are
        // benched for hours, which is the behavior that matters.
        expect(["credit_exhausted", "session_limit", "quota_exhausted"]).toContain(kind)
      })
    })
  }

  it("classifies the verbatim incident string", () => {
    const incident =
      "Claude Code returned an error result: You're out of usage credits. " +
      "Switch to another model to continue."
    const cls = classifyThrottle(new Error(incident))
    expect(cls.throttled).toBe(true)
    expect(cls.kind).toBe("credit_exhausted")
    expect(defaultIsRotatableError(new Error(incident))).toBe(true)
  })

  it("classifies the first-party API credit refusal", () => {
    // Console-side phrasing, absent from the CLI's list because that list is
    // CLI-only. Anthropic: "Your credit balance is too low to access the API".
    const cls = classifyThrottle(
      new Error("Your credit balance is too low to access the Anthropic API"),
    )
    expect(cls.kind).toBe("credit_exhausted")
  })

  it("does NOT widen into phrases Anthropic never emits", () => {
    // Deliberate narrowness, documented so a later reader does not 'helpfully'
    // add these. Bare "out of credits" / "insufficient credits" are not
    // substrings of any real refusal, and matching them would let arbitrary
    // tool output echoed into an error message bench a healthy account.
    expect(classifyThrottleKind("the wallet is out of credits")).toBeUndefined()
    expect(classifyThrottleKind("insufficient credits in game balance")).toBeUndefined()
  })

  it("keeps session-limit phrasing on session_limit", () => {
    // "You've hit your session limit · resets 3:30am" contains BOTH a usage-limit
    // prefix and session phrasing. The session_limit branch must keep winning, or
    // the ladder's most-specific-cause-first ordering has been broken.
    expect(
      classifyThrottleKind("you've hit your session limit · resets 3:30am"),
    ).toBe("session_limit")
  })

  it("keeps the rolling-window phrases on quota_exhausted", () => {
    // Regression guard for the branch ORDER. `credit_exhausted` sits below
    // `quota_exhausted` precisely so the broad "you've hit your" prefix cannot
    // swallow these and change their established kind.
    expect(classifyThrottleKind("you've hit your weekly limit · resets monday")).toBe(
      "quota_exhausted",
    )
    expect(classifyThrottleKind("hit your usage limit")).toBe("quota_exhausted")
  })
})
