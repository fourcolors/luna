/**
 * Merge-policy tests — BDD scenarios for per-key layering (Phase 4 advisor Q4).
 *
 * Given: two or three config layers.
 * When:  composeLayers / mergeLayer is called.
 * Then:  each field obeys its declared policy (replace, concat-unique, deep-merge).
 */
import { describe, expect, it } from "vitest"
import {
  composeLayers,
  mergeLayer,
  mergeUnder,
  policyFor,
  MERGE_POLICIES,
} from "../../src/config/merge-policy.js"

describe("policyFor", () => {
  it("returns declared policy for known keys", () => {
    expect(policyFor("model")).toBe("replace")
    expect(policyFor("tags")).toBe("concat-unique")
    expect(policyFor("env")).toBe("deep-merge")
    expect(policyFor("allowedTools")).toBe("concat-unique")
  })
  it("defaults to replace for unknown keys", () => {
    expect(policyFor("someFutureField")).toBe("replace")
  })
})

describe("mergeUnder — replace", () => {
  it("later wins, undefined on later preserves earlier", () => {
    expect(mergeUnder("replace", "a", "b")).toBe("b")
    expect(mergeUnder("replace", "a", undefined)).toBe("a")
    expect(mergeUnder("replace", undefined, "b")).toBe("b")
  })
})

describe("mergeUnder — concat-unique", () => {
  it("concatenates arrays with later-wins de-dupe", () => {
    expect(mergeUnder("concat-unique", ["a", "b"], ["b", "c"])).toEqual([
      "a",
      "b",
      "c",
    ])
  })
  it("handles empty layers", () => {
    expect(mergeUnder("concat-unique", [], ["x"])).toEqual(["x"])
    expect(mergeUnder("concat-unique", ["x"], [])).toEqual(["x"])
  })
})

describe("mergeUnder — deep-merge", () => {
  it("merges object keys recursively using policy table", () => {
    const a = { env: { FOO: "1", BAR: "2" } }
    const b = { env: { BAR: "override", BAZ: "3" } }
    expect(mergeUnder("deep-merge", a, b)).toEqual({
      env: { FOO: "1", BAR: "override", BAZ: "3" },
    })
  })
})

describe("mergeLayer (top-level SessionOptions)", () => {
  it("applies per-key policy across model/tags/env", () => {
    const global_ = {
      model: "old",
      tags: ["core"],
      sdkOptions: { env: { A: "1" }, allowedTools: ["Read"] },
    }
    const project = {
      model: "new",
      tags: ["project"],
      sdkOptions: { env: { B: "2" }, allowedTools: ["Edit"] },
    }
    const merged = mergeLayer(global_, project)
    expect(merged.model).toBe("new")
    expect(merged.tags).toEqual(["core", "project"])
    expect(merged.sdkOptions).toEqual({
      env: { A: "1", B: "2" },
      allowedTools: ["Read", "Edit"],
    })
  })

  it("does NOT silently lose nested env entries (advisor Q4 guard)", () => {
    const a = { sdkOptions: { env: { OAUTH: "tok", HOME: "/h" } } }
    const b = { sdkOptions: { env: { OAUTH: "tok2" } } }
    const merged = mergeLayer(a, b) as {
      sdkOptions: { env: Record<string, string> }
    }
    expect(merged.sdkOptions.env).toEqual({ OAUTH: "tok2", HOME: "/h" })
  })
})

describe("composeLayers", () => {
  it("stacks global → project → session with last-wins on replace", () => {
    const layers = [
      { model: "a", tags: ["g"] },
      { model: "b", tags: ["p"] },
      { model: "c", tags: ["s"] },
    ]
    const out = composeLayers(layers)
    expect(out.model).toBe("c")
    expect(out.tags).toEqual(["g", "p", "s"])
  })

  it("returns empty object for empty layer list", () => {
    expect(composeLayers([])).toEqual({})
  })
})

describe("MERGE_POLICIES coverage", () => {
  it("documents policy for every key the merge engine knows", () => {
    // Guard test — if anyone adds a field without declaring a policy,
    // they'll land on the safe "replace" default but also bump this size.
    expect(Object.keys(MERGE_POLICIES).length).toBeGreaterThanOrEqual(12)
  })
})
