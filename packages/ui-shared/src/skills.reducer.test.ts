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

describe("connector frames (PRD Part A)", () => {
  const catalog = (): ServerFrame => ({
    type: "connector-catalog",
    connectors: [
      {
        id: "google-workspace",
        name: "Google Workspace",
        blurb: "Mail & files.",
        category: "productivity",
        authKind: "oauth2",
        capabilities: [
          { id: "gmail-read", label: "Read email", scopes: ["g.read"], defaultGranted: true },
        ],
      },
    ],
  })

  it("connector-catalog populates state; connector-list replaces + clears error", () => {
    const errored = { ...initialState, connectorError: "old" }
    const s1 = reduce(errored, catalog())
    expect(s1.connectorCatalog.map((c) => c.id)).toEqual(["google-workspace"])
    const s2 = reduce(s1, {
      type: "connector-list",
      instances: [
        {
          id: "i1",
          definitionId: "google-workspace",
          label: "G",
          status: "connected",
          grantedScopes: ["g.read"],
          createdAt: 1,
          lastHealthyAt: 1,
        },
      ],
    })
    expect(s2.connectorInstances[0]?.status).toBe("connected")
    expect(s2.connectorError).toBeNull()
  })

  it("connector-status ok clears error; failure surfaces the message", () => {
    const base = reduce(initialState, catalog())
    const failed = reduce(base, {
      type: "connector-status",
      ok: false,
      message: "GOOGLE_OAUTH_CLIENT_ID is not set",
    })
    expect(failed.connectorError).toContain("GOOGLE_OAUTH_CLIENT_ID")
    const recovered = reduce(failed, { type: "connector-status", ok: true })
    expect(recovered.connectorError).toBeNull()
  })

  it("capabilities.connectors passes through hello (additive/optional)", () => {
    const withCap: ServerFrame = {
      type: "hello",
      protocolVersion: 2,
      kinds: [],
      capabilities: { chat: true, streamingDeltas: true, setup: false, connectors: true },
    }
    expect(reduce(initialState, withCap).capabilities.connectors).toBe(true)
    const without: ServerFrame = {
      type: "hello",
      protocolVersion: 2,
      kinds: [],
      capabilities: { chat: true, streamingDeltas: true, setup: false },
    }
    expect(reduce(initialState, without).capabilities.connectors).toBeUndefined()
  })

  it("connector-list never carries a token or secretRef (wire shape)", () => {
    const s = reduce(initialState, {
      type: "connector-list",
      instances: [
        {
          id: "i1",
          definitionId: "slack",
          label: "Slack",
          status: "connected",
          grantedScopes: [],
          createdAt: 1,
          lastHealthyAt: null,
        },
      ],
    })
    const keys = Object.keys(s.connectorInstances[0]!).sort()
    expect(keys).toEqual([
      "createdAt", "definitionId", "grantedScopes", "id", "label", "lastHealthyAt", "status",
    ])
    expect(keys).not.toContain("secretRef")
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
