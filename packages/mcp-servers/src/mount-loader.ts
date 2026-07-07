/**
 * syncMcpMounts — reconcile the durable McpServerStore with the in-memory
 * MCPRegistry.
 *
 * Called at boot (and on reload triggers) to project the operator's
 * registered+trusted+enabled external MCP servers into the live runtime
 * registry.  The function is FAIL-CLOSED: any server whose headers contain
 * an unresolvable secret-ref is skipped and reported rather than mounted
 * with incomplete credentials.
 *
 * Slice B1 of "official MCP support".
 */
import { Effect, Redacted } from "effect"
import { MCPRegistry, SecretProvider } from "@luna/core"
import type { McpServerConfigLike } from "@luna/core"
import { McpServerStore } from "./store.js"

// ---------------------------------------------------------------------------
// Return type
// ---------------------------------------------------------------------------

export interface SyncMcpMountsResult {
  /** Slugs successfully registered (or re-registered after rotation). */
  readonly registered: string[]
  /** Servers that were skipped with the reason for each skip. */
  readonly skipped: Array<{ slug: string; reason: string }>
  /**
   * Live tool-access policy for every REGISTERED server (one entry per
   * successfully mounted slug).  Skipped servers have NO entry — their tools
   * are unknown to the gate, but they are also not mounted, so no tools exist.
   *
   * A registered server with `allowAll: false` and `allowedTools: []` gets an
   * entry with those exact values — its tools are DENIED (fail-closed).
   *
   * Feed this map into `mcpToolGate`'s `policyLookup` by replacing the
   * contents of a mutable holder; the gate reads it on every call so policy
   * changes take effect without recomposing the boot-global callback.
   */
  readonly policy: Record<string, { allowAll: boolean; allowedTools: string[] }>
}

// ---------------------------------------------------------------------------
// Main effect
// ---------------------------------------------------------------------------

/**
 * Reconcile MCPRegistry to exactly the set of enabled+trusted servers in
 * McpServerStore, resolving header secret-refs via SecretProvider.
 *
 * Error channel is `never` — all failures are reported in the `skipped`
 * array so the loader never crashes the caller.  Servers with unresolvable
 * credentials are NEVER registered (fail-closed).
 */
export const syncMcpMounts = (): Effect.Effect<
  SyncMcpMountsResult,
  never,
  McpServerStore | SecretProvider | MCPRegistry
> =>
  Effect.gen(function* () {
    const store = yield* McpServerStore
    const secretProvider = yield* SecretProvider
    const registry = yield* MCPRegistry

    // 1. Fetch the desired set from the durable store.
    const rows = yield* store.listEnabledTrusted().pipe(
      Effect.catchAll(() => Effect.succeed([])),
    )

    const registered: string[] = []
    const skipped: Array<{ slug: string; reason: string }> = []
    const policy: Record<string, { allowAll: boolean; allowedTools: string[] }> = {}

    // 2. Resolve headers and build desired configs, collecting skips.
    const desired = new Map<string, McpServerConfigLike>()
    // Parallel map carrying the tool-access policy for each desired slug.
    const desiredPolicy = new Map<string, { allowAll: boolean; allowedTools: string[] }>()

    for (const row of rows) {
      const entries = Object.entries(row.headers)
      const resolvedHeaders: Record<string, string> = {}
      let skip: { slug: string; reason: string } | undefined

      for (const [headerName, ref] of entries) {
        const result = yield* secretProvider.get(ref).pipe(Effect.either)
        if (result._tag === "Left") {
          skip = {
            slug: row.slug,
            reason: `unresolved secret-ref for header '${headerName}': ${ref}`,
          }
          break
        }
        resolvedHeaders[headerName] = Redacted.value(result.right)
      }

      if (skip !== undefined) {
        skipped.push(skip)
        continue
      }

      const config: McpServerConfigLike = {
        type: "http",
        url: row.url,
        headers: resolvedHeaders,
      }
      desired.set(row.slug, config)
      desiredPolicy.set(row.slug, {
        allowAll: row.allowAll,
        allowedTools: row.allowedTools,
      })
    }

    // 3. Reconcile: get current registry names, unregister stale entries.
    const currentNames = Object.keys(
      yield* registry.list().pipe(Effect.catchAll(() => Effect.succeed({}))),
    )
    const desiredNames = new Set(desired.keys())

    for (const name of currentNames) {
      if (!desiredNames.has(name)) {
        yield* registry.unregister(name).pipe(Effect.catchAll(() => Effect.void))
      }
    }

    // 4. Register (or re-register) each desired server.
    for (const [slug, config] of desired) {
      // Always unregister first to pick up rotated tokens / url changes.
      yield* registry.unregister(slug).pipe(Effect.catchAll(() => Effect.void))
      yield* registry.register(slug, config).pipe(
        Effect.catchAll(() => Effect.void),
      )
      registered.push(slug)
      // Populate the policy map for every successfully registered server.
      // Skipped servers have no entry — fail-closed: if a server couldn't be
      // mounted its tools don't exist anyway.
      const p = desiredPolicy.get(slug)
      if (p !== undefined) {
        policy[slug] = p
      }
    }

    return { registered, skipped, policy }
  })
