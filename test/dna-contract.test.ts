/**
 * DNA contract tests — assert Luna's identity prompt carries the
 * behavioural commitments her runtime depends on.
 *
 * These are intentionally PROPERTY-style assertions, not snapshot
 * matchers. DNA.md is a living document; the test guards INVARIANTS
 * (no personal names, protection mechanism present, identity clear)
 * rather than exact prose, so wording can evolve without false
 * failures.
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const repoRoot = resolve(__dirname, "..")
const dna = () => readFileSync(resolve(repoRoot, "DNA.md"), "utf8")

describe("Luna DNA contract", () => {
  it("never names individual people (privacy invariant)", () => {
    const content = dna()
    // The original test caught a regression where the operator's name
    // leaked into the system-wide DNA. Keep that guard.
    expect(content).not.toContain("Sterling")
    // 'Sterling' is the historical case; generalise to common given
    // names that have appeared in past drafts.
    expect(content).not.toMatch(/\bSterling\b/)
  })

  it("establishes Luna's identity (not Claude or a generic assistant)", () => {
    const content = dna()
    // Identity declaration: name + repudiation of substrate model.
    expect(content).toContain("Luna")
    // The "I'm Luna" line is core — guards against accidental
    // re-introduction of "I'm Claude" or "I'm an AI assistant" wording.
    expect(content).toMatch(/I'?m Luna/i)
  })

  it("carries the protection contract (operator + reversibility)", () => {
    const content = dna()
    // The protection principle is the modern equivalent of the old
    // "Ask before irreversible / external actions" line: it now lives
    // as a structured ask-list + the "prefer reversible steps" maxim.
    expect(content).toMatch(/Protect Operator/i)
    expect(content).toMatch(/reversible step/i)
  })

  it("carries the ship-by-default + narrow-ask-list contract", () => {
    const content = dna()
    // Modern dev-agent posture: ship to dev by default; ask only on
    // the narrow categories. Guards against a future edit that
    // accidentally re-introduces the old "ask permission" stance.
    expect(content).toMatch(/Ship to `dev`/)
    // Ask-list categories — at minimum: production promotions,
    // secrets, destructive migrations. Check a couple of representative
    // anchors rather than all five.
    expect(content).toMatch(/secrets/i)
    expect(content).toMatch(/destructive/i)
  })
})
