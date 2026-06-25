import { describe, it, expect } from "vitest"
import {
  decodeCapabilityDescriptor,
  decodeCapabilityCatalog,
  type CapabilityDescriptor,
} from "../src/index.js"

// A minimal well-formed descriptor used as the base for mutation in scenarios.
const baseDescriptor = (): Record<string, unknown> => ({
  kind: "command",
  id: "clear",
  title: "Clear",
  executor: "client",
  schemaVersion: 1,
})

describe("decodeCapabilityDescriptor", () => {
  it("decodes a well-formed descriptor", () => {
    const r = decodeCapabilityDescriptor(baseDescriptor())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const expected: CapabilityDescriptor = {
      kind: "command",
      id: "clear",
      title: "Clear",
      executor: "client",
      schemaVersion: 1,
    }
    expect(r.value).toEqual(expected)
  })

  it("accepts an unknown kind (forward-compatible, open set)", () => {
    const r = decodeCapabilityDescriptor({ ...baseDescriptor(), kind: "workflow" })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.kind).toBe("workflow")
  })

  it("strips unknown extra fields rather than rejecting them", () => {
    const r = decodeCapabilityDescriptor({ ...baseDescriptor(), futureField: "x" })
    expect(r.ok).toBe(true)
    if (r.ok) expect("futureField" in r.value).toBe(false)
  })

  it("fails loudly when a required field is missing, naming it", () => {
    const { id, ...noId } = baseDescriptor()
    const r = decodeCapabilityDescriptor(noId)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/id/)
  })

  it("rejects an invalid executor", () => {
    const r = decodeCapabilityDescriptor({ ...baseDescriptor(), executor: "banana" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/executor/)
  })

  it("rejects a non-positive-integer schemaVersion", () => {
    for (const bad of [0, -1, 1.5, "1", null]) {
      const r = decodeCapabilityDescriptor({ ...baseDescriptor(), schemaVersion: bad })
      expect(r.ok, `schemaVersion=${JSON.stringify(bad)} should reject`).toBe(false)
      if (!r.ok) expect(r.error).toMatch(/schemaVersion/)
    }
  })

  it("rejects a wrong-typed title", () => {
    const r = decodeCapabilityDescriptor({ ...baseDescriptor(), title: 42 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/title/)
  })

  it("keeps optional fields absent when not provided (no undefined/null coercion)", () => {
    const r = decodeCapabilityDescriptor(baseDescriptor())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect("description" in r.value).toBe(false)
    expect("argHint" in r.value).toBe(false)
    expect("enabled" in r.value).toBe(false)
    expect("detail" in r.value).toBe(false)
  })

  it("carries optional fields through when present and well-typed", () => {
    const r = decodeCapabilityDescriptor({
      ...baseDescriptor(),
      description: "Start fresh",
      argHint: "[scope]",
      enabled: true,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.description).toBe("Start fresh")
    expect(r.value.argHint).toBe("[scope]")
    expect(r.value.enabled).toBe(true)
  })

  it("passes detail through opaquely", () => {
    const detail = { nested: { a: 1 }, list: [1, 2] }
    const r = decodeCapabilityDescriptor({ ...baseDescriptor(), detail })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.detail).toEqual(detail)
  })

  it("rejects non-object input", () => {
    for (const bad of [null, "str", 42, undefined, []]) {
      const r = decodeCapabilityDescriptor(bad)
      expect(r.ok, `${JSON.stringify(bad)} should reject`).toBe(false)
    }
  })
})

describe("decodeCapabilityCatalog", () => {
  const validCap = baseDescriptor
  const validCap2 = (): Record<string, unknown> => ({
    kind: "command",
    id: "model",
    title: "Model",
    executor: "client",
    schemaVersion: 1,
  })

  it("decodes an all-valid catalog with no rejects", () => {
    const r = decodeCapabilityCatalog({
      generation: 1,
      agreedSchema: 1,
      capabilities: [validCap(), validCap2()],
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.capabilities).toHaveLength(2)
    expect(r.value.generation).toBe(1)
    expect(r.value.agreedSchema).toBe(1)
    expect(r.rejected).toHaveLength(0)
  })

  it("keeps valid capabilities and surfaces invalid ones (resilient, no silent gaps)", () => {
    const { id, ...badNoId } = validCap2()
    const r = decodeCapabilityCatalog({
      generation: 3,
      agreedSchema: 1,
      capabilities: [validCap(), badNoId],
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.capabilities).toHaveLength(1)
    expect(r.value.capabilities[0]?.id).toBe("clear")
    expect(r.rejected).toHaveLength(1)
    expect(r.rejected[0]?.index).toBe(1)
    expect(r.rejected[0]?.error).toMatch(/id/)
  })

  it("fails loudly when the envelope is malformed", () => {
    expect(decodeCapabilityCatalog({ generation: 1, agreedSchema: 1, capabilities: "nope" }).ok).toBe(false)
    expect(decodeCapabilityCatalog({ agreedSchema: 1, capabilities: [] }).ok).toBe(false)
    expect(decodeCapabilityCatalog({ generation: 1, capabilities: [] }).ok).toBe(false)
    expect(decodeCapabilityCatalog({ generation: "x", agreedSchema: 1, capabilities: [] }).ok).toBe(false)
  })

  it("rejects non-object catalog input", () => {
    for (const bad of [null, "x", 42, undefined]) {
      expect(decodeCapabilityCatalog(bad).ok, `${JSON.stringify(bad)} should reject`).toBe(false)
    }
  })

  it("rejects NaN/Infinity for generation and agreedSchema", () => {
    for (const bad of [NaN, Infinity, -Infinity, 1.5]) {
      expect(decodeCapabilityCatalog({ generation: bad, agreedSchema: 1, capabilities: [] }).ok).toBe(false)
      expect(decodeCapabilityCatalog({ generation: 1, agreedSchema: bad, capabilities: [] }).ok).toBe(false)
    }
  })
})

// Post-audit hardening: a trust boundary must own its output, never throw, and
// never let prototype pollution or coercion through. See SPEC.md "Hardening".
describe("decode hardening (post-audit)", () => {
  const base = (): Record<string, unknown> => ({
    kind: "command",
    id: "clear",
    title: "Clear",
    executor: "client",
    schemaVersion: 1,
  })

  it("returns a deep copy of detail (no aliasing in either direction)", () => {
    const detail: Record<string, unknown> = { nested: { a: 1 } }
    const r = decodeCapabilityDescriptor({ ...base(), detail })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.detail).not.toBe(detail) // not the same reference
    // mutating the source must not change the decoded value
    ;(detail.nested as { a: number }).a = 999
    expect((r.value.detail as { nested: { a: number } }).nested.a).toBe(1)
  })

  it("is total — never throws, even on a throwing getter; fails loudly instead", () => {
    const evil = Object.defineProperty({ ...base() }, "title", {
      get() {
        throw new Error("boom")
      },
      enumerable: true,
    })
    let result: ReturnType<typeof decodeCapabilityDescriptor>
    expect(() => {
      result = decodeCapabilityDescriptor(evil)
    }).not.toThrow()
    expect(result!.ok).toBe(false)
    // and inside a catalog, the bad entry is surfaced, not thrown
    const cat = decodeCapabilityCatalog({ generation: 1, agreedSchema: 1, capabilities: [evil] })
    expect(cat.ok).toBe(true)
    if (cat.ok) expect(cat.rejected).toHaveLength(1)
  })

  it("never lets a literal __proto__ key pollute or leak into the output", () => {
    const poisoned = JSON.parse(
      '{"kind":"command","id":"x","title":"T","executor":"client","schemaVersion":1,"__proto__":{"polluted":true}}',
    )
    const r = decodeCapabilityDescriptor(poisoned)
    expect(r.ok).toBe(true)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined() // no global pollution
    if (r.ok) expect((r.value as Record<string, unknown>).polluted).toBeUndefined()
  })

  it("rejects an empty-string kind or id", () => {
    expect(decodeCapabilityDescriptor({ ...base(), kind: "" }).ok).toBe(false)
    expect(decodeCapabilityDescriptor({ ...base(), id: "" }).ok).toBe(false)
  })

  it("rejects coercible wrong types on boolean/string fields", () => {
    expect(decodeCapabilityDescriptor({ ...base(), enabled: 0 }).ok).toBe(false)
    expect(decodeCapabilityDescriptor({ ...base(), enabled: "true" }).ok).toBe(false)
    expect(decodeCapabilityDescriptor({ ...base(), title: true }).ok).toBe(false)
    expect(decodeCapabilityDescriptor({ ...base(), description: 5 }).ok).toBe(false)
  })

  it("rejects NaN/Infinity for schemaVersion", () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(decodeCapabilityDescriptor({ ...base(), schemaVersion: bad }).ok).toBe(false)
    }
  })

  it("rejects array or null detail", () => {
    expect(decodeCapabilityDescriptor({ ...base(), detail: [] }).ok).toBe(false)
    expect(decodeCapabilityDescriptor({ ...base(), detail: null }).ok).toBe(false)
    expect(decodeCapabilityDescriptor({ ...base(), detail: 42 }).ok).toBe(false)
  })

  it("rejects control characters in kind or id (they would forge merge keys)", () => {
    expect(decodeCapabilityDescriptor({ ...base(), id: `a${String.fromCharCode(0)}b` }).ok).toBe(false)
    expect(decodeCapabilityDescriptor({ ...base(), kind: `c${String.fromCharCode(1)}d` }).ok).toBe(false)
    expect(decodeCapabilityDescriptor({ ...base(), id: `tab${String.fromCharCode(9)}x` }).ok).toBe(false)
    expect(decodeCapabilityDescriptor({ ...base(), id: `del${String.fromCharCode(127)}x` }).ok).toBe(false)
  })
})
