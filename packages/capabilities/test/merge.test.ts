import { describe, it, expect } from "vitest"
import { mergeCapabilities, type CapabilityDescriptor, type CapabilitySource } from "../src/index.js"

const cap = (kind: string, id: string, title = id): CapabilityDescriptor => ({
  kind,
  id,
  title,
  executor: "client",
  schemaVersion: 1,
})

const ui = (caps: CapabilityDescriptor[]): CapabilitySource => ({ source: "ui", precedence: 1, capabilities: caps })
const backend = (name: string, caps: CapabilityDescriptor[]): CapabilitySource => ({
  source: name,
  precedence: 0,
  capabilities: caps,
})

describe("mergeCapabilities", () => {
  it("returns empty for no sources", () => {
    expect(mergeCapabilities([])).toEqual({ merged: [], dropped: [] })
  })

  it("contributes nothing for a source with empty capabilities", () => {
    const r = mergeCapabilities([ui([]), backend("hermes", [])])
    expect(r.merged).toHaveLength(0)
    expect(r.dropped).toHaveLength(0)
  })

  it("merges a single source with no collisions, sorted by kind then id", () => {
    const r = mergeCapabilities([backend("hermes", [cap("command", "deploy"), cap("command", "build")])])
    expect(r.merged.map((m) => m.capability.id)).toEqual(["build", "deploy"])
    expect(r.merged.every((m) => m.source === "hermes")).toBe(true)
    expect(r.dropped).toHaveLength(0)
  })

  it("UI wins a (kind,id) collision over a backend; backend goes to dropped", () => {
    const r = mergeCapabilities([ui([cap("command", "clear")]), backend("hermes", [cap("command", "clear")])])
    expect(r.merged).toHaveLength(1)
    expect(r.merged[0]?.source).toBe("ui")
    expect(r.dropped).toHaveLength(1)
    expect(r.dropped[0]?.source).toBe("hermes")
    expect(r.dropped[0]?.winningSource).toBe("ui")
    expect(r.dropped[0]?.key).toContain("clear")
  })

  it("does NOT collide the same id across different kinds", () => {
    const r = mergeCapabilities([
      ui([cap("command", "share"), cap("skill", "share")]),
    ])
    expect(r.merged).toHaveLength(2)
    expect(r.dropped).toHaveLength(0)
  })

  it("breaks an equal-precedence collision deterministically by source ascending", () => {
    const r = mergeCapabilities([
      backend("openclaw", [cap("command", "x")]),
      backend("hermes", [cap("command", "x")]),
    ])
    expect(r.merged).toHaveLength(1)
    expect(r.merged[0]?.source).toBe("hermes") // "hermes" < "openclaw"
    expect(r.dropped[0]?.source).toBe("openclaw")
    expect(r.dropped[0]?.winningSource).toBe("hermes")
  })

  it("surfaces a within-source duplicate rather than silently self-shadowing", () => {
    const r = mergeCapabilities([ui([cap("command", "dup", "First"), cap("command", "dup", "Second")])])
    expect(r.merged).toHaveLength(1)
    expect(r.merged[0]?.capability.title).toBe("First") // first-seen wins
    expect(r.dropped).toHaveLength(1)
    expect(r.dropped[0]?.source).toBe("ui")
    expect(r.dropped[0]?.winningSource).toBe("ui")
  })

  it("resolves a three-way collision to one winner with two dropped", () => {
    const r = mergeCapabilities([
      ui([cap("command", "go")]),
      backend("hermes", [cap("command", "go")]),
      backend("openclaw", [cap("command", "go")]),
    ])
    expect(r.merged).toHaveLength(1)
    expect(r.merged[0]?.source).toBe("ui")
    expect(r.dropped).toHaveLength(2)
    expect(r.dropped.every((d) => d.winningSource === "ui")).toBe(true)
  })

  it("does not falsely collide ids containing separator-ish characters", () => {
    const r = mergeCapabilities([ui([cap("a", ":b"), cap("a:", "b")])])
    expect(r.merged).toHaveLength(2)
    expect(r.dropped).toHaveLength(0)
  })

  it("wraps the original descriptor by reference (identity preserved)", () => {
    const c = cap("command", "clear")
    const r = mergeCapabilities([ui([c])])
    expect(r.merged[0]?.capability).toBe(c)
  })

  it("is deterministic and does not mutate inputs", () => {
    const sources: CapabilitySource[] = [
      ui([cap("command", "b"), cap("command", "a")]),
      backend("hermes", [cap("command", "a"), cap("skill", "z")]),
    ]
    const snapshot = JSON.stringify(sources)
    const first = mergeCapabilities(sources)
    const second = mergeCapabilities(sources)
    expect(first).toEqual(second)
    expect(JSON.stringify(sources)).toBe(snapshot) // inputs untouched
  })

  it("output order is independent of input order (no collisions)", () => {
    const a = cap("command", "a")
    const b = cap("command", "b")
    const z = cap("skill", "z")
    const r1 = mergeCapabilities([ui([b]), backend("hermes", [z, a])])
    const r2 = mergeCapabilities([backend("hermes", [a, z]), ui([b])])
    expect(r1.merged.map((m) => m.capability.id)).toEqual(["a", "b", "z"])
    expect(r1).toEqual(r2)
  })

  it("equal-precedence winner is stable across source order swap", () => {
    const oc: CapabilitySource = backend("openclaw", [cap("command", "x")])
    const he: CapabilitySource = backend("hermes", [cap("command", "x")])
    expect(mergeCapabilities([oc, he]).merged[0]?.source).toBe("hermes")
    expect(mergeCapabilities([he, oc]).merged[0]?.source).toBe("hermes")
  })

  it("sorts dropped by kind, id, source", () => {
    const r = mergeCapabilities([
      ui([cap("command", "b"), cap("command", "a")]),
      backend("hermes", [cap("command", "b"), cap("command", "a")]),
    ])
    expect(r.dropped.map((d) => d.capability.id)).toEqual(["a", "b"]) // sorted, not input order
  })

  it("encodes the (kind,id) key with a NUL separator", () => {
    const r = mergeCapabilities([ui([cap("command", "clear")]), backend("hermes", [cap("command", "clear")])])
    expect(r.dropped[0]?.key).toBe(`command${String.fromCharCode(0)}clear`)
  })

  it("treats non-finite precedence as the lowest rank, deterministically", () => {
    const finite: CapabilitySource = { source: "luna", precedence: 0, capabilities: [cap("command", "x", "Finite")] }
    const nan: CapabilitySource = { source: "hermes", precedence: NaN, capabilities: [cap("command", "x", "Nan")] }
    expect(mergeCapabilities([finite, nan]).merged[0]?.capability.title).toBe("Finite")
    expect(mergeCapabilities([nan, finite]).merged[0]?.capability.title).toBe("Finite")
  })

  it("freezes the returned arrays", () => {
    const r = mergeCapabilities([ui([cap("command", "x")])])
    expect(Object.isFrozen(r.merged)).toBe(true)
    expect(Object.isFrozen(r.dropped)).toBe(true)
  })
})
