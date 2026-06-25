import { describe, it, expect } from "vitest"
import { createCapabilityRegistry } from "../src/index.js"

// Renderers are frontend-specific; the package never inspects R. Use a string stand-in.
describe("createCapabilityRegistry", () => {
  it("register then get returns the renderer and has is true", () => {
    const reg = createCapabilityRegistry<string>()
    const r = reg.register("command", "slash-menu")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.replaced).toBe(false)
    expect(reg.get("command")).toBe("slash-menu")
    expect(reg.has("command")).toBe(true)
  })

  it("get/has on an unregistered or unknown kind never throws", () => {
    const reg = createCapabilityRegistry<string>()
    expect(reg.get("workflow")).toBeUndefined()
    expect(reg.has("workflow")).toBe(false)
    expect(() => reg.get("never-registered")).not.toThrow()
  })

  it("kinds() returns registered kinds sorted ascending", () => {
    const reg = createCapabilityRegistry<string>()
    reg.register("skill", "s")
    reg.register("command", "c")
    reg.register("tool", "t")
    expect(reg.kinds()).toEqual(["command", "skill", "tool"])
  })

  it("re-register replaces by default and reports replaced:true", () => {
    const reg = createCapabilityRegistry<string>()
    reg.register("command", "first")
    const r = reg.register("command", "second")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.replaced).toBe(true)
    expect(reg.get("command")).toBe("second")
  })

  it("re-register with overwrite:false keeps the original and fails loudly", () => {
    const reg = createCapabilityRegistry<string>()
    reg.register("command", "first")
    const r = reg.register("command", "second", { overwrite: false })
    expect(r.ok).toBe(false)
    expect(reg.get("command")).toBe("first")
  })

  it("handles dangerous kinds without prototype pollution", () => {
    const reg = createCapabilityRegistry<string>()
    reg.register("__proto__", "x")
    reg.register("constructor", "y")
    expect(reg.get("__proto__")).toBe("x")
    expect(reg.get("constructor")).toBe("y")
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    // a different, unregistered dangerous-ish kind is still undefined
    expect(reg.get("toString")).toBeUndefined()
  })

  it("is instance-isolated — two registries do not share state", () => {
    const a = createCapabilityRegistry<string>()
    const b = createCapabilityRegistry<string>()
    a.register("command", "a-cmd")
    expect(b.has("command")).toBe(false)
    expect(b.get("command")).toBeUndefined()
  })
})
