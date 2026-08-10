/**
 * numbers.ts: the string-to-number seam, and the one place in the port that
 * refuses an input bash accepts.
 *
 * PURE, and pure on purpose. No fixture, no spawn, no filesystem, no clock,
 * nothing platform-specific - so this file runs identically on the Linux
 * runner and on a developer machine, which is the hard rule PR1 learned the
 * expensive way. The configs under test are built by the REAL
 * `parseUpdateConfig` with two stub seams, because config.ts imports nothing
 * from node and does no IO of its own; the two readiness fields are then
 * overridden by spread, which is the only way to reach values the flag parser
 * itself rejects earlier (see the `""` case below).
 *
 * WHAT THIS FILE IS ALLOWED TO PROVE. There is no bash oracle here: bash
 * validates neither knob, so every refusal in numbers.ts is a deliberate
 * divergence rather than a port. That is why the refusal messages are asserted
 * as LITERAL bytes and not against an exported constant - asserting a constant
 * against itself would only prove that a transcription matches itself, which
 * is the trap the spec calls out for flow-lines.ts.
 *
 * NO `readinessPort` CASE EXISTS, and its absence is the point. An earlier
 * revision of the design refused a non-canonical spelling such as `04753`;
 * that refusal was deleted in favour of widening probes.ts, readiness.ts and
 * session-guard.ts from `number` to `string`, so the raw spelling reaches curl
 * and ss byte-identically on both engines. A test here would re-introduce the
 * deleted behaviour by implication.
 */

import { describe, expect, it } from "vitest"
import { type ConfigSeams, type UpdateConfig, parseUpdateConfig } from "../../src/update/config.js"
import type { NumbersOutcome, ResolvedNumbers } from "../../src/update/numbers.js"
import { resolveNumbers } from "../../src/update/numbers.js"

/**
 * config.ts's two seams, stubbed to constants. `validateProfile` answers true
 * so the default profile parses, and `hasLaunchctl` answers false because the
 * launchctl probe is only consulted under `--supervisor launchd`, which no
 * scenario here passes. Neither stub touches the host, which is what keeps
 * this suite pure.
 */
const PURE_SEAMS: ConfigSeams = {
  validateProfile: () => true,
  hasLaunchctl: () => false,
}

/** Parse with an EMPTY env, so every value is config.ts's own documented default rather than the developer's shell. */
const parse = (argv: ReadonlyArray<string>): UpdateConfig => {
  const outcome = parseUpdateConfig(argv, {}, PURE_SEAMS)
  if (outcome.kind !== "ok") throw new Error(`fixture argv did not parse: ${JSON.stringify(outcome)}`)
  return outcome.config
}

const BASE = parse([])

/**
 * Override the two fields under test on a genuinely parsed config.
 *
 * The override is not laziness: `--readiness-timeout ""` never reaches
 * numbers.ts through the flag parser at all, because config.ts:381-384 treats
 * an empty flag value as a MISSING one and returns `missing-value` first, and
 * the env path cannot produce it either because `envOr` falls back on empty
 * exactly as bash's `${VAR:-default}` does. The empty string is still a
 * reachable value of the TYPE, so numbers.ts must answer for it, and this is
 * the only way to ask.
 */
const withNumbers = (readinessTimeout: string, readinessInterval: string): UpdateConfig => ({
  ...BASE,
  readinessTimeout,
  readinessInterval,
})

const expectResolved = (outcome: NumbersOutcome): ResolvedNumbers => {
  if (!outcome.ok) throw new Error(`expected a resolution, got refusal: ${outcome.message}`)
  return outcome.value
}

const expectRefusal = (outcome: NumbersOutcome): string => {
  if (outcome.ok) throw new Error(`expected a refusal, got ${JSON.stringify(outcome.value)}`)
  return outcome.message
}

describe("resolveNumbers: readinessTimeout", () => {
  it("accepts a plain integer and carries it as both a number and its raw spelling", () => {
    const resolved = expectResolved(resolveNumbers(withNumbers("60", "2")))
    expect(resolved.readinessTimeoutSecs).toBe(60)
    expect(resolved.readinessTimeoutRaw).toBe("60")
  })

  /**
   * THE 007 CASE, which is the whole reason ResolvedNumbers carries the value
   * twice. scripts/luna-update-server:1071 does arithmetic with
   * $READINESS_TIMEOUT (`local deadline=$((SECONDS + READINESS_TIMEOUT))`)
   * while :1124 interpolates it RAW into `readiness gave up after
   * ${READINESS_TIMEOUT}s: ...`. Bash holds one string and gets 7 seconds of
   * budget and a literal `007s` in the give-up line; a port that derived the
   * operator-facing text from the parsed number would print `7s` and diff
   * against the oracle on the one line an operator reads after a rollback.
   */
  it("accepts a zero-padded 007, yielding 7 for arithmetic and '007' for the operator line", () => {
    const resolved = expectResolved(resolveNumbers(withNumbers("007", "2")))
    expect(resolved.readinessTimeoutSecs).toBe(7)
    expect(resolved.readinessTimeoutRaw).toBe("007")
  })

  it("carries 007 intact all the way from the operator's argv", () => {
    // The same case again, but through the REAL flag parser rather than a
    // spread override, which is what proves config.ts hands the string over
    // unnormalised instead of coercing it on the way past.
    const resolved = expectResolved(resolveNumbers(parse(["--readiness-timeout", "007"])))
    expect(resolved.readinessTimeoutSecs).toBe(7)
    expect(resolved.readinessTimeoutRaw).toBe("007")
  })

  it("accepts 0, because a zero budget is a legitimate value and not an error", () => {
    // readiness.ts's header documents the zero-budget behaviour of the poll
    // loop, and bash's `while (( SECONDS < deadline ))` simply never iterates.
    // Refusing 0 here would invent a refusal on a value bash runs happily.
    const resolved = expectResolved(resolveNumbers(withNumbers("0", "2")))
    expect(resolved.readinessTimeoutSecs).toBe(0)
    expect(resolved.readinessTimeoutRaw).toBe("0")
  })

  it("rejects a fractional value, an empty string and a non-numeric value", () => {
    for (const raw of ["0.3", "", "abc"]) {
      expect(resolveNumbers(withNumbers(raw, "2")).ok, `readinessTimeout=${JSON.stringify(raw)}`).toBe(false)
    }
  })
})

describe("resolveNumbers: readinessInterval", () => {
  it("accepts a fractional interval, because bash hands it straight to sleep", () => {
    // scripts/luna-update-server:1122 is `sleep "$READINESS_INTERVAL"`, never
    // arithmetic, and the hermetic fixtures have always driven 0.3.
    const resolved = expectResolved(resolveNumbers(withNumbers("60", "0.3")))
    expect(resolved.readinessIntervalSecs).toBe(0.3)
  })

  it("accepts an integer interval", () => {
    expect(expectResolved(resolveNumbers(withNumbers("60", "2"))).readinessIntervalSecs).toBe(2)
  })

  it("rejects an empty or non-numeric interval", () => {
    for (const raw of ["", "abc"]) {
      expect(resolveNumbers(withNumbers("60", raw)).ok, `readinessInterval=${JSON.stringify(raw)}`).toBe(false)
    }
  })
})

describe("resolveNumbers: the refusal itself", () => {
  /**
   * THIS TEST PINS A KNOWN DIVERGENCE, and it is the reason the divergence is
   * named in docs/next/stack23-s22d-pr2-spec.md under "Known divergences" as
   * "A non-integer --readiness-timeout refuses before the lock instead of
   * mutating and rolling back".
   *
   * Bash does not refuse. `readiness_ok` is always invoked as `if readiness_ok
   * ...` (:1838, :1906, :2073), which suspends errexit, so the arithmetic
   * syntax error at :1071 aborts the enclosing `if` COMMAND without taking
   * either branch and execution carries on: measured on bash 3.2 and 5.x,
   * `--readiness-timeout 0.3` makes bash perform the whole transaction, fall
   * past :2073-2083 into fail_forward at :2086, hit the same abort inside
   * do_rollback's `if readiness_ok` at :1838, and exit 2 with the host
   * mutated. `abc` diverges differently again, because bash arithmetic reads a
   * bare identifier as 0, so the poll loop never runs and bash mutates and
   * rolls back.
   *
   * The port refuses BEFORE the lock is taken and before anything is mutated.
   * That is strictly safer on an input that is operator error either way, so
   * the bytes are pinned here rather than the behaviour being aligned to bash.
   */
  it("emits the exact refusal line for a fractional --readiness-timeout", () => {
    expect(expectRefusal(resolveNumbers(withNumbers("0.3", "2")))).toBe(
      "--readiness-timeout must be an integer (got '0.3')",
    )
  })

  it("emits the exact refusal line for a non-numeric --readiness-interval", () => {
    expect(expectRefusal(resolveNumbers(withNumbers("60", "abc")))).toBe(
      "--readiness-interval must be a number (got 'abc')",
    )
  })

  it("reports the timeout first when both values are bad", () => {
    // The first failure wins, so the refusal stays one line like every other
    // luna_die in this flow; run-update.ts step 6 prefixes it with `error: `.
    expect(expectRefusal(resolveNumbers(withNumbers("0.3", "abc")))).toBe(
      "--readiness-timeout must be an integer (got '0.3')",
    )
  })

  it("never throws, on any input shape", () => {
    // The caller is a straight-line transcript of the bash tail and must not
    // grow a catch site, so every rejection has to arrive as a value.
    // Every shape `Number` would happily parse but `^[0-9]+$` must not, plus
    // the whitespace and separator spellings a copy-paste produces.
    for (const raw of ["", " ", "-1", "+1", " 7", "7 ", "1e3", "Infinity", "0x10", "NaN", "7.0", ".5", "1_000"]) {
      expect(() => resolveNumbers(withNumbers(raw, raw)), JSON.stringify(raw)).not.toThrow()
      expect(resolveNumbers(withNumbers(raw, raw)).ok, JSON.stringify(raw)).toBe(false)
    }
  })
})
