/**
 * AgentRegistry — Persistence-layer store of subagent (AgentDefinition) configs.
 *
 * DESIGN.md §4 places this in the Persistence layer alongside the other
 * lightweight Refs (MCPRegistry, HookRegistry, SkillRegistry). §7.6 calls
 * for the same minimal surface as MCPRegistry — register / unregister /
 * list / toAgentsField — and §15 M2 lists subagents as declarative siblings
 * of hooks/skills/MCP. This module mirrors MCPRegistry exactly.
 *
 * Adapter-sdk is the SOLE runtime package allowed to import from
 * `@anthropic-ai/claude-agent-sdk`. Per §12.2 #6, core treats the
 * SDK's `AgentDefinition` shape as opaque: the registry never inspects
 * fields like `tools` / `skills` / `mcpServers`; the SDK resolves those
 * at query time.
 */
import { Context, Effect, Layer, Ref } from "effect"
import { ValidationError } from "../errors.js"

/**
 * Opaque, structural stand-in for the SDK's `AgentDefinition`. The
 * registry never inspects the shape; the adapter consumes it. Kept
 * permissive to match the SDK's full surface (description, prompt,
 * tools, model, skills, mcpServers, etc.) without coupling core to
 * adapter-sdk types.
 */
export type AgentDefinitionLike = Readonly<Record<string, unknown>>

export interface AgentRegistryApi {
  /**
   * Register `def` under `name`. Fails with ValidationError if the
   * name is already registered — callers must `unregister` first to
   * replace. This is intentional: silent overwrite would mask bugs
   * where two layers both claim the same agent name.
   */
  readonly register: (
    name: string,
    def: AgentDefinitionLike,
  ) => Effect.Effect<void, ValidationError>

  /** Unregister. Returns true if removed, false if no such name. */
  readonly unregister: (name: string) => Effect.Effect<boolean>

  /** Snapshot of all current registrations. */
  readonly list: () => Effect.Effect<Readonly<Record<string, AgentDefinitionLike>>>

  /**
   * Build the `agents` field for `Options` as the SDK adapter expects.
   * Returns a fresh plain record so the caller may freely mutate/merge.
   */
  readonly toAgentsField: () => Effect.Effect<
    Record<string, AgentDefinitionLike>
  >
}

export class AgentRegistry extends Context.Service<AgentRegistry, AgentRegistryApi>()("luna/AgentRegistry") {
  static readonly Default: Layer.Layer<AgentRegistry> = Layer.effect(
    AgentRegistry,
    Effect.gen(function* () {
      const ref = yield* Ref.make<ReadonlyMap<string, AgentDefinitionLike>>(
        new Map(),
      )

      const register: AgentRegistryApi["register"] = (name, def) =>
        Effect.gen(function* () {
          const cur = yield* Ref.get(ref)
          if (cur.has(name)) {
            return yield* Effect.fail(
              new ValidationError({
                module: "AgentRegistry",
                field: "name",
                message: `agent "${name}" already registered`,
              }),
            )
          }
          yield* Ref.update(ref, (m) => {
            const next = new Map(m)
            next.set(name, def)
            return next
          })
        })

      const unregister: AgentRegistryApi["unregister"] = (name) =>
        Ref.modify(ref, (m) => {
          if (!m.has(name)) return [false, m] as const
          const next = new Map(m)
          next.delete(name)
          return [true, next] as const
        })

      const list: AgentRegistryApi["list"] = () =>
        Ref.get(ref).pipe(
          Effect.map((m) => {
            const out: Record<string, AgentDefinitionLike> = {}
            for (const [k, v] of m) out[k] = v
            return out
          }),
        )

      const toAgentsField: AgentRegistryApi["toAgentsField"] = () =>
        Ref.get(ref).pipe(
          Effect.map((m) => {
            const out: Record<string, AgentDefinitionLike> = {}
            for (const [k, v] of m) out[k] = v
            return out
          }),
        )

      return {
        register,
        unregister,
        list,
        toAgentsField,
      } satisfies AgentRegistryApi
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
  def: AgentDefinitionLike,
): Effect.Effect<void, ValidationError, AgentRegistry | import("effect/Scope").Scope> =>
  Effect.gen(function* () {
    const reg = yield* AgentRegistry
    yield* reg.register(name, def)
    yield* Effect.addFinalizer(() =>
      reg.unregister(name).pipe(Effect.catch(() => Effect.void)),
    )
  })
