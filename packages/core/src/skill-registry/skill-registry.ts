/**
 * SkillRegistry — Persistence-layer store of skill prompt segments.
 *
 * DESIGN.md §4 places this in the Persistence layer alongside other
 * lightweight Refs (MCPRegistry, HookRegistry). §7.6 constrains the API
 * to a minimal surface mirroring MCPRegistry: register / unregister / list.
 *
 * Phase 7 scope (per build brief): in-memory declarative store only. No
 * filesystem discovery, no scripts, no sandbox — those belong to a later
 * phase (DESIGN.md §2.1.9). Callers feed `listSegments()` directly into
 * `composeBasePrompt({ skillSegments })` (§2.1.3).
 *
 * Core stays SDK-free at runtime (§4): this module imports nothing from
 * `@anthropic-ai/claude-agent-sdk`.
 */
import { Effect, Layer, Ref } from "effect"
import { ValidationError } from "../errors.js"

/**
 * Minimal skill entry. The `segment` is the prompt-fragment text that
 * `composeBasePrompt` will inject. Keeping the shape narrow lets a later
 * phase extend it (e.g. with allowed-tools / scripts) without breaking
 * existing consumers.
 */
export interface SkillEntry {
  readonly name: string
  readonly segment: string
}

export interface SkillRegistryApi {
  /**
   * Register `entry` under `entry.name`. Fails with ValidationError if the
   * name is already registered — callers must `unregister` first to
   * replace. Mirrors MCPRegistry: silent overwrite would mask bugs where
   * two layers both claim the same skill name.
   */
  readonly register: (entry: SkillEntry) => Effect.Effect<void, ValidationError>

  /** Unregister. Returns true if removed, false if no such name. */
  readonly unregister: (name: string) => Effect.Effect<boolean>

  /** Snapshot of all current registrations. */
  readonly list: () => Effect.Effect<Readonly<Record<string, SkillEntry>>>

  /**
   * Convenience: ordered list of segment strings (Map insertion order),
   * suitable for passing directly to `composeBasePrompt({ skillSegments })`.
   */
  readonly listSegments: () => Effect.Effect<ReadonlyArray<string>>
}

export class SkillRegistry extends Effect.Tag("experiment-agent/SkillRegistry")<
  SkillRegistry,
  SkillRegistryApi
>() {
  static readonly Default: Layer.Layer<SkillRegistry> = Layer.effect(
    SkillRegistry,
    Effect.gen(function* () {
      const ref = yield* Ref.make<ReadonlyMap<string, SkillEntry>>(new Map())

      const register: SkillRegistryApi["register"] = (entry) =>
        Effect.gen(function* () {
          const cur = yield* Ref.get(ref)
          if (cur.has(entry.name)) {
            return yield* Effect.fail(
              new ValidationError({
                module: "SkillRegistry",
                field: "name",
                message: `skill "${entry.name}" already registered`,
              }),
            )
          }
          yield* Ref.update(ref, (m) => {
            const next = new Map(m)
            next.set(entry.name, entry)
            return next
          })
        })

      const unregister: SkillRegistryApi["unregister"] = (name) =>
        Ref.modify(ref, (m) => {
          if (!m.has(name)) return [false, m] as const
          const next = new Map(m)
          next.delete(name)
          return [true, next] as const
        })

      const list: SkillRegistryApi["list"] = () =>
        Ref.get(ref).pipe(
          Effect.map((m) => {
            const out: Record<string, SkillEntry> = {}
            for (const [k, v] of m) out[k] = v
            return out
          }),
        )

      const listSegments: SkillRegistryApi["listSegments"] = () =>
        Ref.get(ref).pipe(
          Effect.map((m) => {
            const out: string[] = []
            for (const [, v] of m) out.push(v.segment)
            return out
          }),
        )

      return {
        register,
        unregister,
        list,
        listSegments,
      } satisfies SkillRegistryApi
    }),
  )
}

/**
 * Convenience: register within a caller's Scope. The registration is
 * automatically reversed when the Scope closes. Honors §3.4 #4
 * (interruption propagates top-down via Scope finalizers).
 */
export const registerScoped = (
  entry: SkillEntry,
): Effect.Effect<
  void,
  ValidationError,
  SkillRegistry | import("effect/Scope").Scope
> =>
  Effect.gen(function* () {
    const reg = yield* SkillRegistry
    yield* reg.register(entry)
    yield* Effect.addFinalizer(() =>
      reg.unregister(entry.name).pipe(Effect.catchAll(() => Effect.void)),
    )
  })
