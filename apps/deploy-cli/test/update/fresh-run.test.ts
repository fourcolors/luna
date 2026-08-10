/**
 * fresh-run.ts: the no-journal prologue (scripts/luna-update-server:1954-1994).
 *
 * PURE, and pure on purpose. No fixture, no spawn, no filesystem, no clock and
 * no path resolution, so this file behaves identically on the Linux runner and
 * on a developer machine - the hard rule PR1 learned the expensive way. Every
 * seam is a recording stub, which is also what lets the ordering assertions
 * below exist at all: the ORDER of the HEAD read, the lockfile hash, the
 * `Current HEAD:` line and the fetch is a byte-visible contract on both
 * engines, and a return-value-only test cannot see it.
 *
 * WHAT THIS FILE IS ALLOWED TO PROVE, and what it is not. There is no bash
 * oracle here; the oracle for these bytes is the dual-drive diff in
 * `update-flow-parity.test.ts`, which runs the real `scripts/luna-update-server`
 * against the binary. What this suite pins is the shape the parity suite cannot
 * isolate once the prologue is buried inside a full run: which command is
 * issued in which order, which arms consult a status and which deliberately do
 * not, and which of the three `luna_die` messages a given failure produces.
 * The three messages are asserted as LITERAL bytes rather than against the
 * `flow-lines.ts` builders, because asserting a builder against itself would
 * only prove a transcription matches itself while leaving a swapped builder -
 * the realistic mistake - invisible.
 */

import { describe, expect, it } from "vitest"
import { lockfileHashSync as applyInplaceLockfileHashSync } from "../../src/update/apply-inplace.js"
import type { FreshRunOptions, FreshRunOutcome } from "../../src/update/fresh-run.js"
import { freshRunSync, lockfileHashSync, readHeadSync } from "../../src/update/fresh-run.js"
import type { CommandResult } from "../../src/update/target.js"

/** A full lowercase 40-hex sha, the shape `rev-parse HEAD` always answers. */
const PREV_SHA = "1".repeat(40)
const TARGET_SHA = "2".repeat(40)

const ok = (stdout: string): CommandResult => ({ status: 0, stdout })

interface Recorded {
  /** One shared trace across every seam, so ORDER is assertable and not just per-seam call counts. */
  readonly trace: Array<string>
  readonly info: Array<string>
}

interface Stubs {
  /** Answers for `gitTargetCapture`, keyed by the first argument after `rev-parse`. */
  readonly head?: CommandResult
  readonly peel?: CommandResult
  readonly fetch?: CommandResult
  readonly lockHash?: string
  readonly requestedRef?: string
}

/**
 * Builds a `FreshRunOptions` whose every seam appends to one trace before
 * answering. `gitTargetCapture` dispatches on the argv it receives rather than
 * on call order, so a test that expected two captures and got one fails on the
 * trace instead of silently reading the wrong stub.
 */
const makeOptions = (stubs: Stubs): { opts: FreshRunOptions; rec: Recorded } => {
  const rec: Recorded = { trace: [], info: [] }
  const opts: FreshRunOptions = {
    hostRepoDir: "/srv/luna/repo",
    requestedRef: stubs.requestedRef ?? "main",
    gitTarget: (args) => {
      rec.trace.push(`git ${args.join(" ")}`)
      return stubs.fetch ?? ok("")
    },
    gitTargetCapture: (args) => {
      rec.trace.push(`git-capture ${args.join(" ")}`)
      if (args[1] === "HEAD") return stubs.head ?? ok(`${PREV_SHA}\n`)
      return stubs.peel ?? ok(`${TARGET_SHA}\n`)
    },
    lockfileHash: () => {
      rec.trace.push("lockfile-hash")
      return stubs.lockHash ?? "abc123"
    },
    info: (line) => {
      rec.trace.push(`info ${line}`)
      rec.info.push(line)
    },
  }
  return { opts, rec }
}

/** Narrows for the assertions below, and fails with the message rather than a type error when the arm is wrong. */
const expectOk = (outcome: FreshRunOutcome): Extract<FreshRunOutcome, { ok: true }> => {
  if (!outcome.ok) throw new Error(`expected ok, got refusal: ${outcome.message}`)
  return outcome
}

const expectRefusal = (outcome: FreshRunOutcome): string => {
  if (outcome.ok) throw new Error(`expected a refusal, got ok with ref ${outcome.ref}`)
  return outcome.message
}

describe("freshRunSync ordering", () => {
  it("issues HEAD, the lockfile hash, the Current HEAD line and the fetch in bash's order (:1964-1974)", () => {
    const { opts, rec } = makeOptions({})

    const outcome = expectOk(freshRunSync(opts))

    // The exact sequence at :1964, :1966, :1967, :1974, :1992. Swapping any
    // adjacent pair leaves the return value identical and changes the bytes
    // both engines emit, which is why this is a full-sequence assertion and
    // not a set of per-seam call counts.
    expect(rec.trace).toEqual([
      "git-capture rev-parse HEAD",
      "lockfile-hash",
      `info Current HEAD: ${PREV_SHA}`,
      "git fetch origin",
      "git-capture rev-parse main^{commit}",
    ])
    expect(outcome).toEqual({ ok: true, prev: PREV_SHA, ref: TARGET_SHA, prevLockHash: "abc123" })
  })

  it("emits exactly one info line, the Current HEAD one (:1967)", () => {
    const { opts, rec } = makeOptions({})

    freshRunSync(opts)

    expect(rec.info).toEqual([`Current HEAD: ${PREV_SHA}`])
  })

  it("fetches with exactly `fetch origin` and no extra arguments (:1974)", () => {
    const { opts, rec } = makeOptions({})

    freshRunSync(opts)

    expect(rec.trace).toContain("git fetch origin")
  })
})

describe("freshRunSync ref resolution (:1989-1994)", () => {
  it("uses a full lowercase hex ref verbatim and issues NO peel", () => {
    const { opts, rec } = makeOptions({ requestedRef: TARGET_SHA })

    expect(expectOk(freshRunSync(opts)).ref).toBe(TARGET_SHA)
    expect(rec.trace.filter((line) => line.includes("^{commit}"))).toEqual([])
  })

  it("preserves an UPPERCASE hex ref without lowercasing it (:1990)", () => {
    // The inplace arm is a bare `REF="$REQUESTED_REF"`; only the releases
    // layout normalises (:1985-1988), and it is out of scope. Lowercasing here
    // would make the journal, the `git reset --hard` argv and the readiness
    // build-sha compare disagree with bash on this spelling.
    const upper = TARGET_SHA.replace(/2/g, "A")
    const { opts, rec } = makeOptions({ requestedRef: upper })

    expect(expectOk(freshRunSync(opts)).ref).toBe(upper)
    expect(rec.trace.filter((line) => line.includes("^{commit}"))).toEqual([])
  })

  it("uses a 7-char abbreviation verbatim, which is the lower bound of the pattern", () => {
    const { opts } = makeOptions({ requestedRef: "abcdef0" })

    expect(expectOk(freshRunSync(opts)).ref).toBe("abcdef0")
  })

  it("peels a 6-char value, which is one character below the bound and therefore NOT a hex ref", () => {
    const { opts, rec } = makeOptions({ requestedRef: "abcdef" })

    expect(expectOk(freshRunSync(opts)).ref).toBe(TARGET_SHA)
    expect(rec.trace).toContain("git-capture rev-parse abcdef^{commit}")
  })

  it("peels a 65-char value, which is one character above the bound", () => {
    const { opts, rec } = makeOptions({ requestedRef: "a".repeat(65) })

    expect(expectOk(freshRunSync(opts)).ref).toBe(TARGET_SHA)
    expect(rec.trace).toContain(`git-capture rev-parse ${"a".repeat(65)}^{commit}`)
  })

  it("appends `^{commit}` to the ref inside one argument, never as a second one (:1992)", () => {
    const { opts, rec } = makeOptions({ requestedRef: "v1.2.3" })

    freshRunSync(opts)

    expect(rec.trace).toContain("git-capture rev-parse v1.2.3^{commit}")
  })

  it("strips ALL trailing newlines from the peeled sha, matching `$( )`", () => {
    const { opts } = makeOptions({ peel: ok(`${TARGET_SHA}\n\n\n`) })

    expect(expectOk(freshRunSync(opts)).ref).toBe(TARGET_SHA)
  })
})

describe("freshRunSync refusals", () => {
  it("refuses an empty HEAD before hashing, printing or fetching anything (:1964-1965)", () => {
    const { opts, rec } = makeOptions({ head: ok("\n") })

    // luna_die exits, so bash never reaches lockfile_hash, the info line or
    // the fetch. A port that computed the hash first would spawn git on a run
    // bash leaves silent.
    expect(expectRefusal(freshRunSync(opts))).toBe("could not read current HEAD in /srv/luna/repo")
    expect(rec.trace).toEqual(["git-capture rev-parse HEAD"])
  })

  it("refuses a failed fetch AFTER the Current HEAD line, and resolves no ref (:1974)", () => {
    const { opts, rec } = makeOptions({ fetch: { status: 1, stdout: "" } })

    expect(expectRefusal(freshRunSync(opts))).toBe("fetch failed before update; checkout unchanged")
    expect(rec.trace).toEqual([
      "git-capture rev-parse HEAD",
      "lockfile-hash",
      `info Current HEAD: ${PREV_SHA}`,
      "git fetch origin",
    ])
  })

  it("treats a signal-killed fetch (status null) as failure, as bash's non-zero would", () => {
    const { opts } = makeOptions({ fetch: { status: null, stdout: "" } })

    expect(expectRefusal(freshRunSync(opts))).toBe("fetch failed before update; checkout unchanged")
  })

  it("refuses a peel that printed nothing, naming the ref AS REQUESTED (:1994)", () => {
    const { opts } = makeOptions({ requestedRef: "no-such-branch", peel: ok("") })

    expect(expectRefusal(freshRunSync(opts))).toBe("could not resolve target ref no-such-branch")
  })

  it("refuses a peel that printed a non-hex value, naming the ref AS REQUESTED (:1994)", () => {
    const { opts } = makeOptions({ requestedRef: "weird", peel: ok("refs/heads/weird\n") })

    // The message interpolates the REQUESTED ref, never the resolved one:
    // the resolved one is precisely what does not exist.
    expect(expectRefusal(freshRunSync(opts))).toBe("could not resolve target ref weird")
  })
})

describe("freshRunSync consults status only where bash does", () => {
  it("accepts a HEAD capture that exited non-zero but printed a sha (:1964)", () => {
    // `PREV="$(...)"` discards the substitution's status; bash tests emptiness
    // at :1965 and nothing else. A port that checked status would refuse runs
    // bash completes, e.g. a git that warns on stderr and still prints.
    const { opts } = makeOptions({ head: { status: 1, stdout: `${PREV_SHA}\n` } })

    expect(expectOk(freshRunSync(opts)).prev).toBe(PREV_SHA)
  })

  it("accepts a peel that exited non-zero but printed a sha (:1992)", () => {
    const { opts } = makeOptions({ peel: { status: 128, stdout: `${TARGET_SHA}\n` } })

    expect(expectOk(freshRunSync(opts)).ref).toBe(TARGET_SHA)
  })
})

describe("freshRunSync carries the lockfile hash through untouched", () => {
  it("returns the empty string the missing-bun.lock arm produces (:539-543)", () => {
    // The empty string is a legal `prev_lock_hash` (journal.ts:78), so this
    // must not be coerced into a sentinel or refused.
    const { opts } = makeOptions({ lockHash: "" })

    expect(expectOk(freshRunSync(opts)).prevLockHash).toBe("")
  })

  it("calls the hash seam exactly once", () => {
    const { opts, rec } = makeOptions({})

    freshRunSync(opts)

    expect(rec.trace.filter((line) => line === "lockfile-hash")).toHaveLength(1)
  })
})

describe("the two shared helpers", () => {
  it("readHeadSync issues `rev-parse HEAD` and strips all trailing newlines", () => {
    const seen: Array<ReadonlyArray<string>> = []

    const head = readHeadSync((args) => {
      seen.push(args)
      return ok(`${PREV_SHA}\n\n`)
    })

    expect(head).toBe(PREV_SHA)
    expect(seen).toEqual([["rev-parse", "HEAD"]])
  })

  it("readHeadSync returns the empty string rather than throwing when git printed nothing", () => {
    // Emptiness is the caller's policy, not this helper's: :1965 dies on it,
    // :1189's postcondition warns on it, :2040 records it.
    expect(readHeadSync(() => ok(""))).toBe("")
  })

  it("lockfileHashSync is the SAME function apply-inplace.ts exports, not a second copy", () => {
    // The spec asks fresh-run.ts to export the helper the apply gate and the
    // rollback path share "so they have one implementation". This identity
    // check is what makes that literally true: a future adapter or transcribed
    // copy fails here instead of drifting from `lockfile_hash` (:538-544) in
    // silence.
    expect(lockfileHashSync).toBe(applyInplaceLockfileHashSync)
  })
})
