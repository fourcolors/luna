import { describe, expect, it } from "vitest"
import type { MemoryRecord } from "@luna/memory"
import {
  deriveBeliefId,
  makeBeliefRecord,
  readBelief,
  isActiveBelief,
  BELIEF_KIND,
  BELIEF_NAMESPACE,
} from "./types.js"

describe("deriveBeliefId", () => {
  it("is deterministic for the same (domain, statement)", () => {
    const a = deriveBeliefId("comms", "Operator prefers terse answers")
    const b = deriveBeliefId("comms", "Operator prefers terse answers")
    expect(a).toBe(b)
  })
  it("differs across domain or statement", () => {
    expect(deriveBeliefId("comms", "x")).not.toBe(deriveBeliefId("finance", "x"))
    expect(deriveBeliefId("comms", "x")).not.toBe(deriveBeliefId("comms", "y"))
  })
  it("is whitespace/case insensitive on the statement", () => {
    expect(deriveBeliefId("comms", "Terse  Answers")).toBe(deriveBeliefId("comms", "terse answers"))
  })
})

describe("makeBeliefRecord", () => {
  it("builds an operator/belief record with proposed defaults", () => {
    const r = makeBeliefRecord({
      statement: "Operator prefers terse answers",
      confidence: 0.6,
      domain: "comms",
      evidence: ["session:abc#msg12"],
      now: 1000,
    })
    expect(r.kind).toBe(BELIEF_KIND)
    expect(r.namespace).toBe(BELIEF_NAMESPACE)
    expect(r.id).toBe(deriveBeliefId("comms", "Operator prefers terse answers"))
    expect(r.tags).toEqual(["comms"])
    expect(r.createdAt).toBe(1000)
    const c = readBelief(r)
    expect(c.status).toBe("proposed")
    expect(c.confidence).toBe(0.6)
    expect(c.statement).toBe("Operator prefers terse answers")
    expect(c.domain).toBe("comms")
    expect(c.evidence).toEqual(["session:abc#msg12"])
    expect(c.validationHistory).toEqual([])
    expect(c.outreachRights).toEqual({ enabled: false, minConfidence: 0.8 })
  })
  it("honors an explicit status", () => {
    const r = makeBeliefRecord({ statement: "s", confidence: 0.9, domain: "d", status: "active", now: 0 })
    expect(readBelief(r).status).toBe("active")
  })
  it("honors custom outreachRights", () => {
    const r = makeBeliefRecord({
      statement: "s",
      confidence: 0.9,
      domain: "d",
      outreachRights: { enabled: true, minConfidence: 0.5 },
      now: 0,
    })
    expect(readBelief(r).outreachRights).toEqual({ enabled: true, minConfidence: 0.5 })
  })
})

describe("isActiveBelief", () => {
  it("returns true for an active belief record", () => {
    const r = makeBeliefRecord({ statement: "s", confidence: 0.9, domain: "d", status: "active", now: 0 })
    expect(isActiveBelief(r)).toBe(true)
  })
  it("returns false for a proposed (default) belief record", () => {
    const r = makeBeliefRecord({ statement: "s", confidence: 0.6, domain: "d", now: 0 })
    expect(isActiveBelief(r)).toBe(false)
  })
  it("returns false for a non-belief record", () => {
    const r: MemoryRecord = {
      id: "x",
      namespace: "operator",
      kind: "note",
      content: {},
      schemaVersion: 1,
      createdAt: 0,
      updatedAt: 0,
      tags: [],
    }
    expect(isActiveBelief(r)).toBe(false)
  })
})
