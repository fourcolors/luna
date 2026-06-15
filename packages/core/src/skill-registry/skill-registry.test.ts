/**
 * SkillRegistry tests — manifest model, enabled-state, disclosure
 * rendering, write-through ordering, and the load-bearing guarantee:
 * a disabled skill's text never reaches the prompt snapshot.
 */
import { describe, expect, it } from "vitest"
import { Effect, Exit, Scope } from "effect"
import {
  BUILTIN_SKILLS,
  SkillRegistry,
  registerScopedSkill as registerScoped,
  renderSkillsPrompt,
  type SkillManifest,
  type SkillRegistryOptions,
} from "./index.js"
import { composeBasePrompt } from "../prompt/base-prompt.js"

const manifest = (
  id: string,
  overrides: Partial<SkillManifest> = {},
): SkillManifest => ({
  id,
  name: `Skill ${id}`,
  description: `Does ${id} things.`,
  whenToUse: `The task involves ${id}.`,
  category: "other",
  tags: [id],
  source: "builtin",
  body: `BODY-${id}: full instructions for ${id}.`,
  ...overrides,
})

const runWith = <A, E>(
  options: SkillRegistryOptions,
  eff: Effect.Effect<A, E, SkillRegistry>,
) => Effect.runPromise(eff.pipe(Effect.provide(SkillRegistry.layer(options))))

const run = <A, E>(eff: Effect.Effect<A, E, SkillRegistry>) =>
  runWith({}, eff)

describe("SkillRegistry — catalog & lifecycle", () => {
  it("register + catalog roundtrip preserves order and defaults enabled", async () => {
    const got = await run(
      Effect.gen(function* () {
        const reg = yield* SkillRegistry
        yield* reg.register(manifest("alpha"))
        yield* reg.register(manifest("beta"))
        return yield* reg.catalog()
      }),
    )
    expect(got.map((e) => e.id)).toEqual(["alpha", "beta"])
    expect(got.every((e) => e.enabled)).toBe(true)
    expect(got[0]).toMatchObject({
      id: "alpha",
      name: "Skill alpha",
      category: "other",
      source: "builtin",
    })
  })

  it("duplicate id → ValidationError", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const reg = yield* SkillRegistry
        yield* reg.register(manifest("dup"))
        yield* reg.register(manifest("dup"))
      }).pipe(Effect.provide(SkillRegistry.Default)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const flat = JSON.stringify(exit.cause)
      expect(flat).toContain("ValidationError")
      expect(flat).toContain("dup")
    }
  })

  it("blank required field → ValidationError", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const reg = yield* SkillRegistry
        yield* reg.register(manifest("blankish", { body: "   " }))
      }).pipe(Effect.provide(SkillRegistry.Default)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(JSON.stringify(exit.cause)).toContain("body")
    }
  })

  it("unregister returns true/false appropriately", async () => {
    const out = await run(
      Effect.gen(function* () {
        const reg = yield* SkillRegistry
        yield* reg.register(manifest("x"))
        const a = yield* reg.unregister("x")
        const b = yield* reg.unregister("x")
        const c = yield* reg.unregister("never-registered")
        return { a, b, c }
      }),
    )
    expect(out).toEqual({ a: true, b: false, c: false })
  })

  it("registerScoped unregisters on scope close", async () => {
    const { during, after } = await run(
      Effect.gen(function* () {
        const reg = yield* SkillRegistry
        const scope = yield* Scope.make()
        yield* registerScoped(manifest("scoped")).pipe(Scope.extend(scope))
        const during = yield* reg.catalog()
        yield* Scope.close(scope, Exit.void)
        const after = yield* reg.catalog()
        return { during, after }
      }),
    )
    expect(during.map((e) => e.id)).toEqual(["scoped"])
    expect(after).toEqual([])
  })
})

describe("SkillRegistry — enabled state", () => {
  it("setEnabled(false) flips the catalog row; unknown id → ValidationError", async () => {
    const got = await run(
      Effect.gen(function* () {
        const reg = yield* SkillRegistry
        yield* reg.register(manifest("a"))
        yield* reg.setEnabled("a", false)
        const cat = yield* reg.catalog()
        const bad = yield* reg.setEnabled("ghost", false).pipe(Effect.flip)
        return { cat, bad }
      }),
    )
    expect(got.cat[0]?.enabled).toBe(false)
    expect(got.bad._tag).toBe("ValidationError")
  })

  it("initialDisabled hydrates seeds as disabled; unknown ids ignored", async () => {
    const cat = await runWith(
      {
        seeds: [manifest("on"), manifest("off")],
        initialDisabled: ["off", "stale-row-for-removed-skill"],
      },
      Effect.gen(function* () {
        const reg = yield* SkillRegistry
        return yield* reg.catalog()
      }),
    )
    expect(cat.find((e) => e.id === "on")?.enabled).toBe(true)
    expect(cat.find((e) => e.id === "off")?.enabled).toBe(false)
  })

  it("onToggle write-through runs BEFORE the in-memory flip and skips no-ops", async () => {
    const calls: Array<{ id: string; enabled: boolean; visibleAtCall: boolean }> = []
    // The onToggle closure reads the snapshot AT CALL TIME via this holder:
    // if the in-memory flip had already happened, the snapshot would
    // already reflect the new state — so the recorded visibility proves
    // the persist-before-flip ordering.
    let api: import("./skill-registry.js").SkillRegistryApi | null = null
    const layer = SkillRegistry.layer({
      onToggle: (id, enabled) =>
        Effect.sync(() => {
          calls.push({
            id,
            enabled,
            visibleAtCall: api!.promptSnapshotSync().includes("BODY-t"),
          })
        }),
    })
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const reg = yield* SkillRegistry
        api = reg
        yield* reg.register(manifest("t"))
        yield* reg.setEnabled("t", false)
        yield* reg.setEnabled("t", false) // idempotent — must NOT call onToggle again
        yield* reg.setEnabled("t", true)
        return yield* reg.catalog()
      }).pipe(Effect.provide(layer)),
    )
    expect(result[0]?.enabled).toBe(true)
    expect(calls.map((c) => ({ id: c.id, enabled: c.enabled }))).toEqual([
      { id: "t", enabled: false },
      { id: "t", enabled: true },
    ])
    // ordering proof: when disabling, the body was still visible at call
    // time (flip hadn't happened); when re-enabling, it was still hidden.
    expect(calls[0]?.visibleAtCall).toBe(true)
    expect(calls[1]?.visibleAtCall).toBe(false)
  })
})

describe("SkillRegistry — disclosure & the never-injected guarantee", () => {
  it("promptSnapshotSync (inline): enabled bodies in, disabled bodies OUT — mutation-verified", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const reg = yield* SkillRegistry
        yield* reg.register(manifest("keep"))
        yield* reg.register(manifest("drop"))

        // both enabled → both bodies present
        const before = reg.promptSnapshotSync()
        expect(before).toContain("BODY-keep")
        expect(before).toContain("BODY-drop")

        // disable one → its body, name and id vanish from the snapshot
        yield* reg.setEnabled("drop", false)
        const after = reg.promptSnapshotSync()
        expect(after).toContain("BODY-keep")
        expect(after).not.toContain("BODY-drop")
        expect(after).not.toContain("Skill drop")

        // re-enable → restored, no residue lost
        yield* reg.setEnabled("drop", true)
        expect(reg.promptSnapshotSync()).toContain("BODY-drop")
      }).pipe(Effect.provide(SkillRegistry.Default)),
    )
  })

  it("snapshot is empty when nothing is enabled", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const reg = yield* SkillRegistry
        expect(reg.promptSnapshotSync()).toBe("")
        yield* reg.register(manifest("only"))
        yield* reg.setEnabled("only", false)
        expect(reg.promptSnapshotSync()).toBe("")
      }).pipe(Effect.provide(SkillRegistry.Default)),
    )
  })

  it("index mode lists id/description/whenToUse but NEVER the body", async () => {
    const snap = await runWith(
      { disclosure: "index", seeds: [manifest("idx")] },
      Effect.gen(function* () {
        const reg = yield* SkillRegistry
        return reg.promptSnapshotSync()
      }),
    )
    expect(snap).toContain("- idx — Does idx things.")
    expect(snap).toContain("skill_load")
    expect(snap).not.toContain("BODY-idx")
  })

  it("renderSkillsPrompt is pure and filters disabled in both modes", () => {
    const entries = [
      { ...manifest("a"), enabled: true },
      { ...manifest("b"), enabled: false },
    ]
    const inline = renderSkillsPrompt(entries, "inline")
    const index = renderSkillsPrompt(entries, "index")
    for (const rendered of [inline, index]) {
      expect(rendered).toContain("a")
      expect(rendered).not.toContain("BODY-b")
    }
    expect(renderSkillsPrompt([{ ...manifest("c"), enabled: false }], "inline")).toBe("")
  })

  it("body() returns enabled bodies; disabled and unknown ids error", async () => {
    const out = await run(
      Effect.gen(function* () {
        const reg = yield* SkillRegistry
        yield* reg.register(manifest("readable"))
        yield* reg.register(manifest("hidden"))
        yield* reg.setEnabled("hidden", false)
        const ok = yield* reg.body("readable")
        const disabled = yield* reg.body("hidden").pipe(Effect.flip)
        const unknown = yield* reg.body("ghost").pipe(Effect.flip)
        return { ok, disabled: disabled.message, unknown: unknown.message }
      }),
    )
    expect(out.ok).toContain("BODY-readable")
    expect(out.disabled).toContain("disabled")
    expect(out.unknown).toContain("unknown")
  })

  it("listSegments feeds composeBasePrompt with ENABLED bodies only", async () => {
    const segments = await run(
      Effect.gen(function* () {
        const reg = yield* SkillRegistry
        yield* reg.register(manifest("first"))
        yield* reg.register(manifest("second"))
        yield* reg.setEnabled("second", false)
        return yield* reg.listSegments()
      }),
    )
    expect(segments).toEqual(["BODY-first: full instructions for first."])
    const prompt = composeBasePrompt({
      identity: "You are Atlas.",
      skillSegments: segments,
    })
    expect(prompt as string[]).toEqual([
      "You are Atlas.",
      "BODY-first: full instructions for first.",
    ])
  })
})

describe("BUILTIN_SKILLS seeds", () => {
  it("are valid, unique, and load through the layer", async () => {
    const ids = BUILTIN_SKILLS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const s of BUILTIN_SKILLS) {
      expect(s.id.trim().length).toBeGreaterThan(0)
      expect(s.description.trim().length).toBeGreaterThan(0)
      expect(s.whenToUse.trim().length).toBeGreaterThan(0)
      expect(s.body.trim().length).toBeGreaterThan(0)
      expect(s.source).toBe("builtin")
    }
    const cat = await runWith(
      { seeds: BUILTIN_SKILLS },
      Effect.gen(function* () {
        const reg = yield* SkillRegistry
        return yield* reg.catalog()
      }),
    )
    expect(cat.map((e) => e.id)).toEqual(ids)
    expect(cat.every((e) => e.enabled)).toBe(true)
  })
})
