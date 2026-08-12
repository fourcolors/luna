/**
 * The `string` to `number` seam config.ts deliberately refuses to own.
 *
 * config.ts:52-58 states the rule it follows and why: bash never coerces
 * READINESS_TIMEOUT, READINESS_INTERVAL, READINESS_PORT or
 * RESTART_SETTLE_SECS, so parsing them to `number` inside the config parser
 * would invent a coercion - and a set of refusals - that the oracle does not
 * have. "The consumer that needs a number converts at its own boundary" is
 * that header's last sentence; this file IS that boundary, and it exists as a
 * separate module rather than as two `Number()` calls at the call sites so
 * that there is exactly one place where the conversion rule, the refusal
 * message and the divergence from bash are written down.
 *
 * THE RULE, which is decided once here and applied everywhere: a config value
 * that reaches an OPERATOR-VISIBLE surface keeps its raw string spelling, and
 * only a value that needs ARITHMETIC is converted. probes.ts's `curlMaxTime`
 * field already carries that reasoning in its own doc comment; this module
 * simply stops making an exception of the readiness knobs. (No line number
 * for that field on purpose: the readinessPort widening moves it, and a
 * citation that drifts is worse than a symbol name that does not.)
 *
 * WHICH IS WHY `readinessTimeout` APPEARS TWICE. It is the one value that is
 * both. `readiness_ok` does arithmetic with it at
 * scripts/luna-update-server:1071 (`local deadline=$((SECONDS +
 * READINESS_TIMEOUT))`), and the give-up warning at :1124 interpolates
 * `${READINESS_TIMEOUT}` RAW (`readiness gave up after ${READINESS_TIMEOUT}s:
 * ...`). Bash holds one shell variable and both readings are of the same
 * string, so `--readiness-timeout 007` deadlines at 7 seconds AND prints
 * `007s`. A port that carried only the number would print `7s` and diff
 * against the oracle; a port that carried only the string could not compute
 * the deadline. Both are carried, the raw one is never re-derived from the
 * parsed one, and numbers.test.ts pins the 007 case for exactly this reason.
 *
 * WHAT IS DELIBERATELY ABSENT: `readinessPort`, `readinessCurlMaxTime` and
 * `restartSettleSecs`. None of the three is ever an operand - the port is
 * interpolated into `http://127.0.0.1:${port}/healthz` and into ss's
 * `( sport = :${port} )` filter, curl's max-time is handed to curl, and the
 * settle seconds are handed to `sleep` - so after the number-to-string
 * widening they travel straight out of UpdateConfig into the argv builders as
 * the strings config.ts already holds. An earlier revision of the spec
 * proposed REFUSING a non-canonical port spelling such as `04753`; that
 * refusal is deleted, because refusing an input bash accepts turns a working
 * deploy into an exit-1 refusal on a real host.
 *
 * DIVERGENCE FROM BASH, stated here and not discovered later. Bash validates
 * neither value. A fractional `--readiness-timeout 0.3` makes :1071 an
 * arithmetic SYNTAX error; because `readiness_ok` is always invoked as `if
 * readiness_ok ...` (:1838, :1906, :2073), errexit is suspended, the error
 * aborts the enclosing `if` COMMAND without taking either branch, and bash
 * carries on. Measured on bash 3.2 and 5.x, the practical result is that bash
 * performs the WHOLE transaction (`reset --hard`, `bun install`, stop, start),
 * falls past :2073-2083 into `fail_forward` at :2086, hits the same abort
 * inside do_rollback's `if readiness_ok` at :1838, and exits 2 with the host
 * mutated. A non-numeric `abc` diverges again, because bash arithmetic reads a
 * bare identifier as 0: the deadline equals SECONDS, the poll loop never runs,
 * and bash mutates and rolls back. This module refuses both BEFORE the lock is
 * acquired and before anything is mutated, which run-update.ts turns into
 * `error: <message>` and exit 1. That is strictly safer on an input that is
 * operator error either way, so the refusal stays and the divergence is
 * recorded rather than papered over.
 *
 * PURE, and structurally so: no imports except a type, no IO, no clock, no
 * throw on any input. A CI grep asserts this file imports no spawn module at
 * all; the token itself is left out of this comment so that a looser grep than
 * the anchored one cannot report a false positive on prose, which is the same
 * hazard the `process.exit(` grep documents.
 */

import type { UpdateConfig } from "./config.js"

/**
 * `[[ "$X" =~ ^[0-9]+$ ]]`, the same shape config.ts:324 uses for
 * `--releases-keep`. Rejects the empty string, a sign, surrounding space and
 * anything fractional; ACCEPTS `0`, which is a legitimate zero budget whose
 * behaviour readiness.ts's own header documents, and accepts leading zeros,
 * which is the 007 case above.
 */
const INTEGER = /^[0-9]+$/

/**
 * The interval is handed to `sleep "$READINESS_INTERVAL"` (:1122) and never to
 * arithmetic, so a fractional value is not merely tolerated but expected - the
 * hermetic fixtures have always driven `--readiness-interval 0.3`. Accepting
 * only what `sleep` would accept, rather than everything `Number` can parse,
 * keeps `1e3`, `Infinity` and ` 2 ` out of the deadline maths.
 */
const DECIMAL = /^[0-9]+(\.[0-9]+)?$/

/**
 * Refusal text, kept private on purpose. There is no bash oracle for these
 * lines - bash has no such refusal at all - so an exported constant asserted
 * against itself would prove nothing. numbers.test.ts asserts the LITERAL
 * bytes instead, which is the only check with any content. The shape follows
 * config.ts:134-135's `--releases-keep must be an integer >= 2 (got '<v>')`,
 * because these lines land on the same stderr an operator is already reading.
 */
const NUMBERS_ERRORS = {
  readinessTimeout: (raw: string): string => `--readiness-timeout must be an integer (got '${raw}')`,
  readinessInterval: (raw: string): string => `--readiness-interval must be a number (got '${raw}')`,
} as const

export interface ResolvedNumbers {
  /** For `readiness_ok`'s deadline arithmetic (:1071). */
  readonly readinessTimeoutSecs: number
  /** The SAME value as written by the operator, for readinessGaveUpLine (:1124), which interpolates `${READINESS_TIMEOUT}` raw. */
  readonly readinessTimeoutRaw: string
  /** For the poll sleep (:1122). */
  readonly readinessIntervalSecs: number
}

/**
 * An outcome rather than a throw, because the caller (run-update.ts step 6)
 * has to turn a refusal into a `luna_die`-shaped stderr line and an exit code,
 * and a throw would make that a catch site in the one function that must stay
 * a readable transcript of the bash tail.
 */
export type NumbersOutcome =
  | { readonly ok: true; readonly value: ResolvedNumbers }
  | { readonly ok: false; readonly message: string }

/**
 * Validate and convert, in the field order the record declares.
 *
 * The first failure wins and the second value is not examined: an operator who
 * typed two bad numbers fixes them one at a time either way, and reporting only
 * the first keeps the refusal a single line, exactly like every other
 * `luna_die` in this flow.
 */
export const resolveNumbers = (config: UpdateConfig): NumbersOutcome => {
  const timeoutRaw = config.readinessTimeout
  if (!INTEGER.test(timeoutRaw)) return { ok: false, message: NUMBERS_ERRORS.readinessTimeout(timeoutRaw) }

  const intervalRaw = config.readinessInterval
  if (!DECIMAL.test(intervalRaw)) return { ok: false, message: NUMBERS_ERRORS.readinessInterval(intervalRaw) }

  return {
    ok: true,
    value: {
      // `Number` and not `parseInt`: the regex has already proven the string is
      // digits end to end, so there is nothing left for parseInt's prefix
      // scanning to be lenient about, and `Number("007")` is 7.
      readinessTimeoutSecs: Number(timeoutRaw),
      readinessTimeoutRaw: timeoutRaw,
      readinessIntervalSecs: Number(intervalRaw),
    },
  }
}
