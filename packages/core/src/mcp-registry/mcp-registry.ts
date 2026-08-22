/**
 * MCPRegistry — Persistence-layer store of MCP server configs.
 *
 * DESIGN.md §4 places this in the Persistence layer alongside other
 * lightweight Refs (HookRegistry, SkillRegistry, etc.). §7.6 constrains
 * the API to a minimal surface: register / unregister / list / toMcpServersField.
 *
 * Adapter-sdk is the SOLE runtime package allowed to import from
 * `@anthropic-ai/claude-agent-sdk`. Core stays SDK-free at runtime: we
 * use a type-only import of `McpServerConfig` (re-exported by adapter-sdk)
 * via a structural placeholder type here to avoid coupling the core
 * package graph to adapter-sdk. The adapter passes concrete
 * `McpServerConfig` values through; this registry treats them as opaque.
 */
import { Context, Effect, Layer, Ref } from "effect"
import { ValidationError } from "../errors.js"

/**
 * Opaque, structural stand-in for `McpServerConfig`. The registry never
 * inspects the shape; the SDK adapter consumes it. Keep this permissive
 * to match the SDK's union (stdio | sse | http | sdk-with-instance).
 */
export type McpServerConfigLike = Readonly<Record<string, unknown>>

export interface MCPRegistryApi {
  /**
   * Register `config` under `name`. Fails with ValidationError if the
   * name is already registered — callers must `unregister` first to
   * replace. This is intentional: silent overwrite would mask bugs
   * where two layers both claim the same MCP name.
   */
  readonly register: (
    name: string,
    config: McpServerConfigLike,
  ) => Effect.Effect<void, ValidationError>

  /** Unregister. Returns true if removed, false if no such name. */
  readonly unregister: (name: string) => Effect.Effect<boolean>

  /** Snapshot of all current registrations. */
  readonly list: () => Effect.Effect<Readonly<Record<string, McpServerConfigLike>>>

  /**
   * Build the `mcpServers` field for `Options` as the SDK adapter expects.
   * Returns a fresh plain record so the caller may freely mutate/merge.
   */
  readonly toMcpServersField: () => Effect.Effect<
    Record<string, McpServerConfigLike>
  >

  /**
   * Synchronous snapshot of all current registrations. Safe to call from
   * synchronous contexts (e.g. per-thread `decorate()` wiring) where an
   * Effect cannot be awaited. Returns a shallow copy so callers cannot
   * mutate internal registry state.
   *
   * Kept in lockstep with the Ref via a plain mutable mirror maintained
   * inside the Default layer. list/toMcpServersField still read the Ref.
   */
  readonly snapshotSync: () => Record<string, McpServerConfigLike>
}

export class MCPRegistry extends Context.Service<MCPRegistry, MCPRegistryApi>()("luna/MCPRegistry") {
  static readonly Default: Layer.Layer<MCPRegistry> = Layer.effect(
    MCPRegistry,
    Effect.gen(function* () {
      const ref = yield* Ref.make<ReadonlyMap<string, McpServerConfigLike>>(
        new Map(),
      )

      // Mutable mirror kept in lockstep with `ref`. Never exposed directly —
      // snapshotSync() returns a shallow copy so external mutations can't
      // corrupt the registry.
      const mirror: Record<string, McpServerConfigLike> = {}

      const register: MCPRegistryApi["register"] = (name, config) =>
        Effect.gen(function* () {
          const cur = yield* Ref.get(ref)
          if (cur.has(name)) {
            return yield* Effect.fail(
              new ValidationError({
                module: "MCPRegistry",
                field: "name",
                message: `mcp server "${name}" already registered`,
              }),
            )
          }
          yield* Ref.update(ref, (m) => {
            const next = new Map(m)
            next.set(name, config)
            return next
          })
          mirror[name] = config
        })

      const unregister: MCPRegistryApi["unregister"] = (name) =>
        Ref.modify(ref, (m) => {
          if (!m.has(name)) return [false, m] as const
          const next = new Map(m)
          next.delete(name)
          return [true, next] as const
        }).pipe(
          Effect.tap((removed) =>
            Effect.sync(() => {
              if (removed) delete mirror[name]
            }),
          ),
        )

      const list: MCPRegistryApi["list"] = () =>
        Ref.get(ref).pipe(
          Effect.map((m) => {
            const out: Record<string, McpServerConfigLike> = {}
            for (const [k, v] of m) out[k] = v
            return out
          }),
        )

      const toMcpServersField: MCPRegistryApi["toMcpServersField"] = () =>
        Ref.get(ref).pipe(
          Effect.map((m) => {
            const out: Record<string, McpServerConfigLike> = {}
            for (const [k, v] of m) out[k] = v
            return out
          }),
        )

      const snapshotSync: MCPRegistryApi["snapshotSync"] = () => ({ ...mirror })

      return {
        register,
        unregister,
        list,
        toMcpServersField,
        snapshotSync,
      } satisfies MCPRegistryApi
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
  config: McpServerConfigLike,
): Effect.Effect<void, ValidationError, MCPRegistry | import("effect/Scope").Scope> =>
  Effect.gen(function* () {
    const reg = yield* MCPRegistry
    yield* reg.register(name, config)
    yield* Effect.addFinalizer(() =>
      reg.unregister(name).pipe(Effect.catch(() => Effect.void)),
    )
  })
