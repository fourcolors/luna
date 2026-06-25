import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"

// Packaging firebreak: the main barrel must never (transitively) pull vitest into the
// browser IIFE bundle. The conformance suite lives behind the "./testing" subpath only.
describe("packaging firebreak", () => {
  it("the main barrel references neither the testing entry nor vitest", () => {
    const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8")
    expect(src).not.toMatch(/testing/)
    expect(src).not.toMatch(/vitest/)
  })

  it("no runtime module under src (excluding src/testing) imports vitest", () => {
    // descriptor/registry/merge/provider/reference-provider/index must be vitest-free.
    for (const f of ["descriptor", "registry", "merge", "provider", "reference-provider", "frame-provider", "command", "index"]) {
      const src = readFileSync(new URL(`../src/${f}.ts`, import.meta.url), "utf8")
      expect(src, `${f}.ts must not import vitest`).not.toMatch(/from ["']vitest["']/)
    }
  })
})
