/**
 * The exit-code and journal-disposition tables of src/update/terminals.ts,
 * tested as PROPERTIES over the whole `Terminal` union rather than as a row
 * per branch.
 *
 * WHY PROPERTIES. The two facts worth defending are negative ones - "exit 3 is
 * never conflated with exit 4" and "the journal is never cleared on a deferred
 * or CRITICAL path" - and a negative fact about a union is only proved by
 * enumerating the union. So this file builds every inhabitant of `Terminal`
 * once (`ALL_TERMINALS`, below) and then states each invariant against that
 * enumeration. A new failure mode that maps to the wrong code fails here even
 * though nobody wrote a test for it by name.
 *
 * PURE, NO FIXTURES, RUNS ANYWHERE. No filesystem, no subprocess, no clock, no
 * platform assumption - the only import beyond vitest is the module under test
 * and the `AcquireFailureReason` type it re-uses from lock.ts. Nothing here
 * needs a timeout override; the default 10s vitest budget is orders of
 * magnitude more than these take.
 *
 * WHAT GATES AN ADDED UNION ARM. `exitCodeFor` and `journalDispositionFor`
 * each end in a `const never: never = t` guard, and every source file under
 * apps/deploy-cli/src IS covered by the root tsconfig's include list, so
 * adding a `Terminal` arm without mapping it in BOTH tables is a
 * `bun run typecheck` failure. Test files are excluded from that project (see
 * tsconfig.json's `exclude`) and vitest does not typecheck, so the
 * compile-time constructs below are a local convenience, not the gate; the
 * runtime witness for the guard is "an unmapped kind does not fall through to
 * a plausible code", asserted at the bottom of this file.
 */
import { describe, expect, it } from "vitest"
import type { AcquireFailureReason } from "../../src/update/lock.js"
import {
  type JournalDisposition,
  type Terminal,
  exitCodeFor,
  journalDispositionFor,
} from "../../src/update/terminals.js"

type TerminalKind = Terminal["kind"]
type DeferSite = Extract<Terminal, { readonly kind: "deferred" }>["site"]

/**
 * Keys of a total record, as an array. Writing the sets as `Record<K, true>`
 * literals means a missing member is a compile error and a misspelled one is
 * an excess-property error, which is a better enumeration than a hand-written
 * array that silently drifts from the union.
 */
const keysOf = <K extends string>(record: Readonly<Record<K, true>>): ReadonlyArray<K> =>
  // `Object.keys` is typed `string[]` and TS will not narrow that to a generic
  // `K` directly, so the bridge is spelled out rather than left implicit.
  Object.keys(record) as unknown as ReadonlyArray<K>

/** lock.ts:301-309, all four `return 1` paths of `acquire_update_lock`. */
const ACQUIRE_FAILURE_REASONS = keysOf<AcquireFailureReason>({
  contended: true,
  "stale-remkdir-failed": true,
  "fingerprint-unavailable": true,
  "ownership-unrecordable": true,
})

/** The five session-guard deferral points: :2000, :1950, :2059, :1831, :1895. */
const DEFER_SITES = keysOf<DeferSite>({
  "fresh-run": true,
  "recovery-resume": true,
  "mid-transaction": true,
  "rollback-restart": true,
  "restart-only": true,
})

const RESTART_ONLY_VALUES: ReadonlyArray<boolean> = [false, true]

/**
 * Every inhabitant of `Terminal`, grouped by kind. The two lock arms are
 * crossed with `restartOnly` (and `lock-unacquirable` additionally with all
 * four reasons) and `deferred` with all five sites, because those payloads are
 * exactly what the invariants below range over.
 */
const TERMINALS_BY_KIND: Record<TerminalKind, ReadonlyArray<Terminal>> = {
  "lock-contention": RESTART_ONLY_VALUES.map((restartOnly) => ({ kind: "lock-contention", restartOnly })),
  "lock-unacquirable": ACQUIRE_FAILURE_REASONS.flatMap((reason) =>
    RESTART_ONLY_VALUES.map((restartOnly): Terminal => ({ kind: "lock-unacquirable", restartOnly, reason })),
  ),
  "preflight-refused": [{ kind: "preflight-refused" }],
  "config-refused": [{ kind: "config-refused" }],
  "corrupt-journal": [{ kind: "corrupt-journal" }],
  deferred: DEFER_SITES.map((site): Terminal => ({ kind: "deferred", site })),
  "restart-only-ok": [{ kind: "restart-only-ok" }],
  "restart-only-restart-failed": [{ kind: "restart-only-restart-failed" }],
  "restart-only-readiness-failed": [{ kind: "restart-only-readiness-failed" }],
  updated: [{ kind: "updated" }],
  "rolled-back": [{ kind: "rolled-back" }],
  "rollback-failed": [{ kind: "rollback-failed" }],
  "forward-failed-no-rollback": [{ kind: "forward-failed-no-rollback" }],
}

const ALL_TERMINALS: ReadonlyArray<Terminal> = Object.values(TERMINALS_BY_KIND).flat()

/** A stable label for `expect` failure output; the objects themselves are opaque in a diff. */
const label = (t: Terminal): string =>
  t.kind === "deferred"
    ? `deferred{${t.site}}`
    : t.kind === "lock-contention"
      ? `lock-contention{restartOnly=${String(t.restartOnly)}}`
      : t.kind === "lock-unacquirable"
        ? `lock-unacquirable{restartOnly=${String(t.restartOnly)},reason=${t.reason}}`
        : t.kind

const codesOf = (terminals: ReadonlyArray<Terminal>): ReadonlyArray<string> =>
  terminals.map((t) => `${label(t)} -> ${String(exitCodeFor(t))}`)

const labelsWithDisposition = (want: JournalDisposition): ReadonlyArray<string> =>
  ALL_TERMINALS.filter((t) => journalDispositionFor(t) === want)
    .map(label)
    .sort()

describe("terminals: the enumeration itself", () => {
  it("groups every terminal under its own kind, with at least one inhabitant each", () => {
    // Guards the table above against a copy-paste that files a terminal under
    // the wrong key, which would make an invariant below vacuously true.
    for (const [kind, terminals] of Object.entries(TERMINALS_BY_KIND)) {
      expect(terminals.length, `${kind} has no inhabitants`).toBeGreaterThan(0)
      for (const t of terminals) expect(t.kind, `filed under ${kind}`).toBe(kind)
    }
  })

  it("enumerates 25 inhabitants across 13 kinds", () => {
    // 2 lock-contention + 8 lock-unacquirable + 5 deferred + 10 payload-free
    // kinds. A deliberate count so that widening a payload (a sixth defer
    // site, a fifth acquire reason) forces a conscious edit here.
    expect(ALL_TERMINALS.length).toBe(25)
    expect(Object.keys(TERMINALS_BY_KIND).length).toBe(13)
  })
})

describe("terminals: exitCodeFor is total over {0,1,2,3,4}", () => {
  it("maps every terminal into the five-code contract", () => {
    for (const t of ALL_TERMINALS) {
      expect([0, 1, 2, 3, 4], `${label(t)} left the contract`).toContain(exitCodeFor(t))
    }
  })

  it("is a pure function of its argument", () => {
    // The tables are data; calling twice must not depend on call order or on
    // anything ambient. This is the cheapest possible witness that nothing in
    // terminals.ts reached for a clock, an env var or module-level state.
    for (const t of ALL_TERMINALS) {
      expect(exitCodeFor(t)).toBe(exitCodeFor(t))
      expect(journalDispositionFor(t)).toBe(journalDispositionFor(t))
    }
  })
})

describe("terminals: 3 is never conflated with 4", () => {
  it("gives 4 to exactly the two lock arms under --restart-only", () => {
    // scripts/luna-update-server:1879. Snapshot-as-list so a new terminal that
    // wandered into 4 shows up as an added line rather than as a silent pass.
    expect(ALL_TERMINALS.filter((t) => exitCodeFor(t) === 4).map(label).sort()).toEqual([
      "lock-contention{restartOnly=true}",
      "lock-unacquirable{restartOnly=true,reason=contended}",
      "lock-unacquirable{restartOnly=true,reason=fingerprint-unavailable}",
      "lock-unacquirable{restartOnly=true,reason=ownership-unrecordable}",
      "lock-unacquirable{restartOnly=true,reason=stale-remkdir-failed}",
    ])
  })

  it("gives 3 to exactly the five session-guard deferrals", () => {
    // :2000, :1950, :2059, :1831, :1895 - and to nothing else, which is the
    // failure the bash comment at :1872-1878 exists to prevent: a responder
    // reading 3 must be able to conclude "live sessions", never "a concurrent
    // update holds the profile lock".
    expect(ALL_TERMINALS.filter((t) => exitCodeFor(t) === 3).map(label).sort()).toEqual([
      "deferred{fresh-run}",
      "deferred{mid-transaction}",
      "deferred{recovery-resume}",
      "deferred{restart-only}",
      "deferred{rollback-restart}",
    ])
  })

  it("never gives a deferral a 4 and never gives a lock arm a 3", () => {
    for (const site of DEFER_SITES) {
      expect(exitCodeFor({ kind: "deferred", site }), `deferred{${site}}`).toBe(3)
    }
    for (const restartOnly of RESTART_ONLY_VALUES) {
      expect(exitCodeFor({ kind: "lock-contention", restartOnly })).not.toBe(3)
      for (const reason of ACQUIRE_FAILURE_REASONS) {
        expect(exitCodeFor({ kind: "lock-unacquirable", restartOnly, reason })).not.toBe(3)
      }
    }
  })
})

describe("terminals: the lock arms delegate to lock.ts's mapping", () => {
  it("is 4 under --restart-only and 0 otherwise, for both lock kinds", () => {
    // :1879-1880 via lock.ts:81-82. `restart-only` is the ONLY thing that
    // moves this number; the acquire reason never does.
    expect(exitCodeFor({ kind: "lock-contention", restartOnly: true })).toBe(4)
    expect(exitCodeFor({ kind: "lock-contention", restartOnly: false })).toBe(0)
    for (const reason of ACQUIRE_FAILURE_REASONS) {
      expect(exitCodeFor({ kind: "lock-unacquirable", restartOnly: true, reason }), reason).toBe(4)
      expect(exitCodeFor({ kind: "lock-unacquirable", restartOnly: false, reason }), reason).toBe(0)
    }
  })

  it("carries the acquire reason for diagnosis without letting it change the code", () => {
    // All four of bash's paths are `return 1` (:988, :992, :1000-1006), so the
    // caller block cannot tell them apart - the reason exists so an operator
    // log can, and a divergence here would invent an exit code bash never has.
    for (const restartOnly of RESTART_ONLY_VALUES) {
      const codes = new Set(
        ACQUIRE_FAILURE_REASONS.map((reason) => exitCodeFor({ kind: "lock-unacquirable", restartOnly, reason })),
      )
      expect(codes.size, `restartOnly=${String(restartOnly)}`).toBe(1)
      expect(codes.has(exitCodeFor({ kind: "lock-contention", restartOnly }))).toBe(true)
    }
  })
})

describe("terminals: the rest of the exit-code contract", () => {
  it("maps the success, refusal and CRITICAL arms exactly as bash does", () => {
    // One row per bash `exit`, so a reader can diff this list against
    // scripts/luna-update-server:1871-2086 without running anything.
    expect(codesOf(ALL_TERMINALS.filter((t) => t.kind !== "deferred" && !t.kind.startsWith("lock-")))).toEqual([
      "preflight-refused -> 1", // :1965, :1974, :1994 (luna_die)
      "config-refused -> 1", // config.ts:68, EXIT_CONFIG_ERROR
      "corrupt-journal -> 2", // :1926
      "restart-only-ok -> 0", // :1908
      "restart-only-restart-failed -> 1", // :1896
      "restart-only-readiness-failed -> 1", // :1911
      "updated -> 0", // :2083
      "rolled-back -> 1", // :1841
      "rollback-failed -> 2", // :1857
      "forward-failed-no-rollback -> 1", // :1866
    ])
  })
})

describe("terminals: the journal is never cleared on a defer or a CRITICAL", () => {
  it('returns "cleared" for exactly `updated` and `rolled-back`', () => {
    // clear_transaction runs at :2076 and :1840, and at no other exit.
    expect(labelsWithDisposition("cleared")).toEqual(["rolled-back", "updated"])
  })

  it('never returns "cleared" for a terminal whose exit code is 2 or 3', () => {
    // The load-bearing invariant: a CRITICAL (2) or a defer (3) that destroyed
    // the journal would strand a transaction the next tick is meant to resume.
    for (const t of ALL_TERMINALS) {
      const code = exitCodeFor(t)
      if (code === 2 || code === 3) {
        expect(journalDispositionFor(t), `${label(t)} exits ${String(code)}`).not.toBe("cleared")
      }
    }
  })

  it("retains a resumable journal at exactly the six sites that have one", () => {
    expect(labelsWithDisposition("retained")).toEqual([
      "corrupt-journal", // :1925-1926, refuses to mutate and leaves it
      "deferred{mid-transaction}", // :2058, phase=restarting
      "deferred{recovery-resume}", // :1949, phase=$TX_PHASE
      "deferred{rollback-restart}", // :1830, phase=rolling-back
      "forward-failed-no-rollback", // :1865 writes phase=forward-failed
      "rollback-failed", // :1856 writes phase=rollback-failed
    ])
  })

  it("leaves the journal untouched on every arm that exits before the first write", () => {
    // :2002 is the first `write_transaction`. Everything here exits before it,
    // or (restart-only) runs on the arm :1890 proved has no journal at all.
    expect(labelsWithDisposition("untouched")).toEqual([
      "config-refused",
      "deferred{fresh-run}", // :1998-2000, "nothing mutated"
      "deferred{restart-only}", // :1895, reached only when :1890 found no journal
      "lock-contention{restartOnly=false}",
      "lock-contention{restartOnly=true}",
      "lock-unacquirable{restartOnly=false,reason=contended}",
      "lock-unacquirable{restartOnly=false,reason=fingerprint-unavailable}",
      "lock-unacquirable{restartOnly=false,reason=ownership-unrecordable}",
      "lock-unacquirable{restartOnly=false,reason=stale-remkdir-failed}",
      "lock-unacquirable{restartOnly=true,reason=contended}",
      "lock-unacquirable{restartOnly=true,reason=fingerprint-unavailable}",
      "lock-unacquirable{restartOnly=true,reason=ownership-unrecordable}",
      "lock-unacquirable{restartOnly=true,reason=stale-remkdir-failed}",
      "preflight-refused",
      "restart-only-ok",
      "restart-only-readiness-failed",
      "restart-only-restart-failed",
    ])
  })

  it("assigns every terminal exactly one of the three dispositions", () => {
    const total = labelsWithDisposition("cleared").length + labelsWithDisposition("retained").length + labelsWithDisposition("untouched").length
    expect(total).toBe(ALL_TERMINALS.length)
    for (const t of ALL_TERMINALS) {
      expect(["cleared", "retained", "untouched"], label(t)).toContain(journalDispositionFor(t))
    }
  })
})

describe("terminals: the exhaustiveness guard is a trap, not a default", () => {
  it("does not answer an unmapped kind with a plausible code or disposition", () => {
    // Runtime witness for the `const never: never = t` guard in both switches.
    // The compile-time gate is `bun run typecheck` over src/ (test files are
    // excluded from that project), so what this asserts is the shape of the
    // fallthrough: there is no catch-all `return 1` / `return "untouched"`
    // that would let a newly added arm ship with a silently wrong contract.
    const unmapped = { kind: "not-a-terminal" } as unknown as Terminal
    expect([0, 1, 2, 3, 4]).not.toContain(exitCodeFor(unmapped))
    expect(["cleared", "retained", "untouched"]).not.toContain(journalDispositionFor(unmapped))
  })
})
