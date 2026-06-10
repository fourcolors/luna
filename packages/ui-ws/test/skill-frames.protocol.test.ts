/**
 * skill-frames.protocol.test.ts — wire-serializability proofs for the
 * PRD Part B skill frames (same style as survey-frames.protocol.test.ts:
 * plain TS unions, JSON roundtrips, type-level union membership).
 *
 * The load-bearing assertion here is the METADATA-ONLY invariant:
 * SkillCatalogItem has no `body` field by construction, and the runtime
 * check proves a serialized catalog frame carries no body-like key. The
 * chat-server adapter strips bodies before the handle reaches ui-ws —
 * this test pins the wire type so a future field addition that smuggles
 * prompt content to clients fails review loudly.
 */
import { describe, expect, it } from "vitest"
import type {
  ClientFrame,
  ServerFrame,
  SkillCatalogFrame,
  SkillCatalogItem,
  SkillStatusFrame,
  SkillToggleFrame,
} from "../src/protocol.js"

const item = (id: string, enabled = true): SkillCatalogItem => ({
  id,
  name: `Skill ${id}`,
  description: `Does ${id} things.`,
  whenToUse: `The task involves ${id}.`,
  category: "workflow",
  tags: [id, "test"],
  source: "builtin",
  enabled,
})

describe("skill wire frames (plain TS unions, NO Effect Schema)", () => {
  describe("SkillCatalogFrame (server→client)", () => {
    it("is a member of ServerFrame and roundtrips intact", () => {
      const f: ServerFrame = {
        type: "skill-catalog",
        skills: [item("clear-writing"), item("deep-research", false)],
      }
      const rt = JSON.parse(JSON.stringify(f)) as ServerFrame
      expect(rt).toEqual(f)
      expect(rt.type).toBe("skill-catalog")
      if (rt.type === "skill-catalog") {
        expect(rt.skills).toHaveLength(2)
        expect(rt.skills[1]?.enabled).toBe(false)
      }
    })

    it("METADATA-ONLY invariant: no body-like key survives serialization", () => {
      const f: SkillCatalogFrame = {
        type: "skill-catalog",
        skills: [item("a"), item("b", false)],
      }
      // Type-level: `body` is not assignable to SkillCatalogItem.
      // @ts-expect-error — SkillCatalogItem deliberately has no body field
      const _illegal: SkillCatalogItem = { ...item("x"), body: "leaked" }
      // Runtime: a serialized frame contains no body/segment/prompt keys.
      const wire = JSON.stringify(f)
      const parsed = JSON.parse(wire) as { skills: Array<Record<string, unknown>> }
      for (const s of parsed.skills) {
        expect(Object.keys(s).sort()).toEqual(
          ["category", "description", "enabled", "id", "name", "source", "tags", "whenToUse"],
        )
      }
      expect(wire).not.toContain("\"body\"")
    })
  })

  describe("SkillStatusFrame (server→client)", () => {
    it("ok ack roundtrips; failure carries a message", () => {
      const ok: ServerFrame = {
        type: "skill-status",
        id: "clear-writing",
        enabled: false,
        ok: true,
      }
      const fail: SkillStatusFrame = {
        type: "skill-status",
        id: "ghost",
        enabled: false,
        ok: false,
        message: 'cannot toggle unknown skill "ghost"',
      }
      expect(JSON.parse(JSON.stringify(ok))).toEqual(ok)
      const rtFail = JSON.parse(JSON.stringify(fail)) as SkillStatusFrame
      expect(rtFail.ok).toBe(false)
      expect(rtFail.message).toContain("unknown skill")
    })
  })

  describe("SkillToggleFrame (client→server)", () => {
    it("is a member of ClientFrame and roundtrips intact", () => {
      const f: ClientFrame = {
        type: "skill-toggle",
        id: "deep-research-discipline",
        enabled: false,
      }
      const rt = JSON.parse(JSON.stringify(f)) as ClientFrame
      expect(rt).toEqual(f)
      expect(rt.type).toBe("skill-toggle")
      if (rt.type === "skill-toggle") {
        expect(rt.id).toBe("deep-research-discipline")
        expect(rt.enabled).toBe(false)
      }
    })

    it("toggle carries ONLY id + enabled — no client-supplied metadata", () => {
      const f: SkillToggleFrame = { type: "skill-toggle", id: "x", enabled: true }
      expect(Object.keys(f).sort()).toEqual(["enabled", "id", "type"])
      // Clients cannot rename/recategorize skills over the wire — the
      // catalog is server-authored; the toggle is the only writable bit.
      // @ts-expect-error — no name field on SkillToggleFrame
      const _illegal: SkillToggleFrame = { type: "skill-toggle", id: "x", enabled: true, name: "evil" }
    })
  })

  describe("hello capability", () => {
    it("capabilities.skills is additive/optional — old-server hello (without it) still typechecks", () => {
      const oldHello: ServerFrame = {
        type: "hello",
        protocolVersion: 2,
        kinds: [],
        capabilities: {
          chat: true,
          streamingDeltas: true,
          localShell: false,
          setup: false,
          turnComplete: true,
          // no `skills` key — pre-PRD server
        },
      }
      const newHello: ServerFrame = {
        type: "hello",
        protocolVersion: 2,
        kinds: [],
        capabilities: {
          chat: true,
          streamingDeltas: true,
          localShell: false,
          setup: false,
          turnComplete: true,
          skills: true,
        },
      }
      for (const f of [oldHello, newHello]) {
        const rt = JSON.parse(JSON.stringify(f)) as ServerFrame
        expect(rt).toEqual(f)
      }
      if (newHello.type === "hello") {
        expect(newHello.capabilities.skills).toBe(true)
      }
      if (oldHello.type === "hello") {
        expect(oldHello.capabilities.skills).toBeUndefined()
      }
    })
  })
})
