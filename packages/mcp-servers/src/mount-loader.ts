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
import { validateSlug } from "./types.js"

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface SyncMcpMountsOptions {
  /**
   * Caller-supplied set of slug strings that must not be mounted even if
   * they appear in the durable store as enabled+trusted.  Used by the
   * boot caller to pass live connector mount keys (e.g. "github", "slack")
   * so an operator row whose slug collides with a connector key is skipped
   * rather than silently shadowing the connector — or worse, causing the
   * gate to apply operator policy to connector tool names.
   *
   * Fail-closed: any collision → skip + report, never mount.
   */
  readonly reservedSlugs?: ReadonlySet<string>
}

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
 *
 * @param opts.reservedSlugs - caller-supplied set of slug keys that must not
 *   be mounted (e.g. live connector mount keys).  Any row whose slug collides
 *   is skipped with a descriptive reason.  See {@link SyncMcpMountsOptions}.
 */
// ---------------------------------------------------------------------------
// Header value templating
// ---------------------------------------------------------------------------

/**
 * Regex to find embedded secret-ref placeholders in header values.
 * Matches `${<ref>}` and captures the ref inside.
 */
const TEMPLATE_RE = /\$\{([^}]+)\}/g

/**
 * Resolve a header value that may contain embedded `${ref}` placeholders.
 *
 * - If the value contains no `${`, treat the entire value as a single secret
 *   ref (backward-compatible behavior).
 * - If the value contains `${...}`, resolve each placeholder via the
 *   SecretProvider and substitute into the literal string. Any placeholder
 *   that fails → the whole server is skipped (fail-closed).
 *
 * Never logs resolved values. Redacted.value() is called only at the moment
 * of substitution.
 */
const resolveHeaderValue = (
  headerName: string,
  value: string,
  slug: string,
  secretProvider: import("@luna/core").SecretProviderApi,
): Effect.Effect<string, { slug: string; reason: string }> => {
  if (!value.includes("${")) {
    // Backward-compat: treat the entire value as a single ref.
    return secretProvider.get(value).pipe(
      Effect.map((s) => Redacted.value(s)),
      Effect.mapError(() => ({
        slug,
        reason: `unresolved secret-ref for header '${headerName}': ${value}`,
      })),
    )
  }
  // Template mode: find all ${ref} placeholders, resolve all, then substitute.
  const matches = [...value.matchAll(TEMPLATE_RE)]
  if (matches.length === 0) {
    // The value contains "${" but no well-formed "${ref}" (e.g. a missing
    // closing brace). Fail closed: skip the server rather than mounting the
    // unresolved literal as if it were a real header value.
    return Effect.fail({
      slug,
      reason: `malformed secret-ref template in header '${headerName}': ${value}`,
    })
  }
  return Effect.forEach(matches, (m) => {
    const ref = m[1]!
    return secretProvider.get(ref).pipe(
      Effect.map((s) => ({ placeholder: m[0]!, resolved: Redacted.value(s) })),
      Effect.mapError(() => ({
        slug,
        reason: `unresolved embedded secret-ref '${ref}' in header '${headerName}'`,
      })),
    )
  }).pipe(
    Effect.map((resolutions) => {
      let result = value
      for (const { placeholder, resolved } of resolutions) {
        result = result.replaceAll(placeholder, resolved)
      }
      return result
    }),
  )
}

export const syncMcpMounts = (
  opts?: SyncMcpMountsOptions,
): Effect.Effect<
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
      // --- HOLE 3 FIX: re-validate slug before any secret resolution.
      // Defense-in-depth: store.add() already validates, but a hand-edited
      // luna.db row with an invalid slug (e.g. "GitHub", "my_server") would
      // mount a server whose tool names the gate regex `^mcp__([a-z0-9-]+)__`
      // cannot parse → slug lookup returns undefined → "pass" → full allow.
      // Catching it here ensures the loader is the last line of defense.
      try {
        validateSlug(row.slug)
      } catch (e) {
        const reason =
          e instanceof Error
            ? `invalid slug (failed validation): ${row.slug} — ${e.message}`
            : `invalid slug (failed validation): ${row.slug}`
        skipped.push({ slug: row.slug, reason })
        continue
      }

      // --- HOLE 2 FIX: skip rows whose slug collides with a caller-supplied
      // reserved set (e.g. live connector mount keys).  An operator-registered
      // "github" slug would shadow the connector mount in the mcpServers object
      // AND cause the gate to apply operator policy to connector tool names.
      if (opts?.reservedSlugs?.has(row.slug) === true) {
        skipped.push({
          slug: row.slug,
          reason: `slug collides with a reserved/built-in mount key: ${row.slug}`,
        })
        continue
      }

      const entries = Object.entries(row.headers)
      const resolvedHeaders: Record<string, string> = {}
      let skip: { slug: string; reason: string } | undefined

      for (const [headerName, value] of entries) {
        const result = yield* resolveHeaderValue(
          headerName,
          value,
          row.slug,
          secretProvider,
        ).pipe(Effect.either)
        if (result._tag === "Left") {
          skip = result.left
          break
        }
        resolvedHeaders[headerName] = result.right
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
    // MINOR FIX: only push to `registered` AFTER a successful register call.
    // Previously registered.push(slug) ran unconditionally even when the
    // registry.register() Effect was caught (failed silently).
    for (const [slug, config] of desired) {
      // Always unregister first to pick up rotated tokens / url changes.
      yield* registry.unregister(slug).pipe(Effect.catchAll(() => Effect.void))
      let registerOk = true
      yield* registry.register(slug, config).pipe(
        Effect.catchAll(() => {
          registerOk = false
          return Effect.void
        }),
      )
      if (!registerOk) {
        skipped.push({ slug, reason: "registry.register() failed" })
        continue
      }
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
