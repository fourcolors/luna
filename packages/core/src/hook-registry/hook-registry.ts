/**
 * HookRegistry — Persistence-layer store of hook SPECS (declarative).
 *
 * DESIGN.md §4 places this in the Persistence layer alongside other
 * lightweight Refs (MCPRegistry, SkillRegistry). §7.6 constrains the API
 * to a minimal surface mirroring MCPRegistry: register / unregister / list.
 *
 * IMPORTANT (§2.2.2): runtime hook wiring lives in adapter-sdk
 * (`registerHook` on the SDK-backed adapter). This Persistence-tier
 * registry is a SEPARATE declarative store that other layers can use to
 * accumulate hook specs (e.g. for export, inspection, or future-phase
 * batched registration). It does NOT execute hooks and does not interpret
 * the spec shape — values are opaque (§4: core MUST NOT import from
 * `@anthropic-ai/claude-agent-sdk`).
 */
import { Effect, Layer, Ref } from "effect"
import { ValidationError } from "../errors.js"

/**
 * Opaque, structural stand-in for a hook spec. The registry never
 * inspects the shape; the consumer (adapter-sdk or another layer) does.
 * Mirrors `McpServerConfigLike` in spirit: keep core SDK-free.
 */
export type HookSpecLike = Readonly<Record<string, unknown>>

export interface HookRegistryApi {
  /**
   * Register `spec` under `name`. Fails with ValidationError if the name
   * is already registered — callers must `unregister` first to replace.
   * Mirrors MCPRegistry: silent overwrite would mask bugs where two
   * layers both claim the same hook name.
   */
  readonly register: (
    name: string,
    spec: HookSpecLike,
  ) => Effect.Effect<void, ValidationError>

  /** Unregister. Returns true if removed, false if no such name. */
  readonly unregister: (name: string) => Effect.Effect<boolean>

  /** Snapshot of all current registrations. */
  readonly list: () => Effect.Effect<Readonly<Record<string, HookSpecLike>>>
}

export class HookRegistry extends Effect.Tag("luna/HookRegistry")<
  HookRegistry,
  HookRegistryApi
>() {
  static readonly Default: Layer.Layer<HookRegistry> = Layer.effect(
    HookRegistry,
    Effect.gen(function* () {
      const ref = yield* Ref.make<ReadonlyMap<string, HookSpecLike>>(new Map())

      const register: HookRegistryApi["register"] = (name, spec) =>
        Effect.gen(function* () {
          const cur = yield* Ref.get(ref)
          if (cur.has(name)) {
            return yield* Effect.fail(
              new ValidationError({
                module: "HookRegistry",
                field: "name",
                message: `hook "${name}" already registered`,
              }),
            )
          }
          yield* Ref.update(ref, (m) => {
            const next = new Map(m)
            next.set(name, spec)
            return next
          })
        })

      const unregister: HookRegistryApi["unregister"] = (name) =>
        Ref.modify(ref, (m) => {
          if (!m.has(name)) return [false, m] as const
          const next = new Map(m)
          next.delete(name)
          return [true, next] as const
        })

      const list: HookRegistryApi["list"] = () =>
        Ref.get(ref).pipe(
          Effect.map((m) => {
            const out: Record<string, HookSpecLike> = {}
            for (const [k, v] of m) out[k] = v
            return out
          }),
        )

      return {
        register,
        unregister,
        list,
      } satisfies HookRegistryApi
    }),
  )
}

/**
 * Convenience: register within a caller's Scope. The registration is
 * automatically reversed when the Scope closes. Honors §3.4 #4
 * (interruption propagates top-down via Scope finalizers).
 */
export const registerScoped = (
  name: string,
  spec: HookSpecLike,
): Effect.Effect<
  void,
  ValidationError,
  HookRegistry | import("effect/Scope").Scope
> =>
  Effect.gen(function* () {
    const reg = yield* HookRegistry
    yield* reg.register(name, spec)
    yield* Effect.addFinalizer(() =>
      reg.unregister(name).pipe(Effect.catchAll(() => Effect.void)),
    )
  })
