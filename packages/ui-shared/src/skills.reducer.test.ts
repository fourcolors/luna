/**
 * skills.reducer.test.ts — PRD Part B §12 client state.
 *
 * Mirrors account-switcher.reducer.test.ts: pure reduce() over wire frames.
 * Covers: catalog population/replacement, hello capability passthrough,
 * skill-status ok/failure semantics (incl. error surfacing + clearing),
 * and the no-optimistic-flip contract.
 */
import { describe, expect, it } from "vitest"
import { initialState, reduce } from "./reducer.js"
import type {
  ServerFrame,
  SkillCatalogItem,
} from "./wire.js"

const item = (
  id: string,
  enabled = true,
  overrides: Partial<SkillCatalogItem> = {},
): SkillCatalogItem => ({
  id,
  name: `Skill ${id}`,
  description: `Does ${id}.`,
  whenToUse: `When ${id}.`,
  category: "workflow",
  tags: [id],
  source: "builtin",
  enabled,
  ...overrides,
})

const catalogFrame = (
  skills: ReadonlyArray<SkillCatalogItem>,
): ServerFrame => ({ type: "skill-catalog", skills })

describe("skill-catalog frame", () => {
  it("populates state.skills and replaces wholesale on re-send", () => {
    const s1 = reduce(initialState, catalogFrame([item("a"), item("b", false)]))
    expect(s1.skills.map((s) => s.id)).toEqual(["a", "b"])
    expect(s1.skills[1]?.enabled).toBe(false)

    const s2 = reduce(s1, catalogFrame([item("c")]))
    expect(s2.skills.map((s) => s.id)).toEqual(["c"])
  })

  it("clears a stale skillError", () => {
    const errored = { ...initialState, skillError: "old failure" }
    const next = reduce(errored, catalogFrame([item("a")]))
    expect(next.skillError).toBeNull()
  })
})

describe("hello capability passthrough", () => {
  it("capabilities.skills lands in state; absent on old servers", () => {
    const newServer: ServerFrame = {
      type: "hello",
      protocolVersion: 2,
      kinds: [],
      capabilities: { chat: true, streamingDeltas: true, setup: false, skills: true },
    }
    const oldServer: ServerFrame = {
      type: "hello",
      protocolVersion: 2,
      kinds: [],
      capabilities: { chat: true, streamingDeltas: true, setup: false },
    }
    expect(reduce(initialState, newServer).capabilities.skills).toBe(true)
    expect(reduce(initialState, oldServer).capabilities.skills).toBeUndefined()
  })
})

describe("skill-status frame", () => {
  const base = reduce(initialState, catalogFrame([item("a"), item("b")]))

  it("ok:true updates the matching row and clears errors", () => {
    const next = reduce(base, {
      type: "skill-status",
      id: "b",
      enabled: false,
      ok: true,
    })
    expect(next.skills.find((s) => s.id === "b")?.enabled).toBe(false)
    expect(next.skills.find((s) => s.id === "a")?.enabled).toBe(true)
    expect(next.skillError).toBeNull()
  })

  it("ok:false leaves rows untouched (no optimistic flip to revert) and surfaces the message", () => {
    const next = reduce(base, {
      type: "skill-status",
      id: "ghost",
      enabled: false,
      ok: false,
      message: 'cannot toggle unknown skill "ghost"',
    })
    expect(next.skills).toEqual(base.skills)
    expect(next.skillError).toContain("unknown skill")
  })

  it("ok:false without a message falls back to a generic error", () => {
    const next = reduce(base, {
      type: "skill-status",
      id: "a",
      enabled: false,
      ok: false,
    })
    expect(next.skillError).toBe("skill toggle failed")
  })

  it("a later ok:true clears the surfaced error", () => {
    const errored = reduce(base, {
      type: "skill-status",
      id: "a",
      enabled: false,
      ok: false,
      message: "boom",
    })
    const recovered = reduce(errored, {
      type: "skill-status",
      id: "a",
      enabled: false,
      ok: true,
    })
    expect(recovered.skillError).toBeNull()
    expect(recovered.skills.find((s) => s.id === "a")?.enabled).toBe(false)
  })
})

describe("wire invariant", () => {
  it("SkillCatalogItem on this side mirrors the server: metadata only, never a body", () => {
    // @ts-expect-error — body is not a SkillCatalogItem field on the client either
    const _illegal: SkillCatalogItem = { ...item("x"), body: "leaked" }
    expect(Object.keys(item("x")).sort()).toEqual([
      "category", "description", "enabled", "id", "name", "source", "tags", "whenToUse",
    ])
  })
})
