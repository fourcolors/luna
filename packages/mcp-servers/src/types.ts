/**
 * MCP Registry model — operator-registered external MCP servers.
 *
 * This is the DURABLE operator registry (luna.db); core's MCPRegistry is the
 * in-memory runtime projection it will feed.
 *
 * A McpServerRow is one row in the `mcp_servers` table: a slug (also the
 * `mcp__<slug>__` tool prefix), a remote HTTPS endpoint, a HEADER-NAME →
 * secret-ref map (NEVER raw values), and trust/allowlist metadata.
 *
 * The store holds REFS, not values — e.g. {"Authorization":"env:EXAMPLE_TOKEN"}.
 * Tool execution in Slice B resolves those refs at call time via the
 * existing SecretProvider chain.
 *
 * Security defaults: fail-closed.  A freshly-registered server has
 * allowedTools [] and allowAll false, meaning zero tools are exposed until
 * the operator explicitly trusts the server AND allows individual tools (or
 * sets allowAll).  trustAcceptedAt null also gates listEnabledTrusted().
 */
import { Data } from "effect"

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

/**
 * One registered external MCP server.
 *
 * `slug` is the primary key and maps to the SDK tool prefix
 * `mcp__<slug>__<tool>`.  It may contain lowercase letters, digits, and
 * hyphens — no underscores, because `__` is the SDK tool-name delimiter.
 */
export interface McpServerRow {
  /** Primary key.  Also the `mcp__<slug>__` tool prefix. */
  readonly slug: string
  /** Remote HTTPS Streamable-HTTP MCP endpoint. */
  readonly url: string
  /**
   * HEADER-NAME → secret-ref string map, e.g.
   * {"Authorization":"env:EXAMPLE_TOKEN"}.  NEVER stores a raw credential
   * value — only pointers into the SecretProvider chain.
   */
  readonly headers: Record<string, string>
  /** Whether the server is active and will be loaded by the agent. */
  readonly enabled: boolean
  /**
   * Epoch ms when the operator accepted the trust prompt for this server.
   * null = not yet trusted.  listEnabledTrusted() excludes untrusted rows.
   */
  readonly trustAcceptedAt: number | null
  /**
   * Explicit opt-in allowlist of tool names this server may expose.
   * Empty array = deny all (fail-closed default).  Ignored when allowAll is
   * true.
   */
  readonly allowedTools: string[]
  /**
   * When true, all tools advertised by the server are allowed.  Requires an
   * explicit operator action — never set automatically.
   */
  readonly allowAll: boolean
  /** Epoch ms of row creation. */
  readonly createdAt: number
  /** Epoch ms of last mutation. */
  readonly updatedAt: number
}

// ---------------------------------------------------------------------------
// Input shape for inserts
// ---------------------------------------------------------------------------

export interface McpServerInput {
  readonly slug: string
  readonly url: string
  /** Optional header → secret-ref map.  Defaults to {}. */
  readonly headers?: Record<string, string>
  /** Defaults to true if omitted. */
  readonly enabled?: boolean
}

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

/** General registry operation error (wraps unexpected DB / logic failures). */
export class McpRegistryError extends Data.TaggedError("McpRegistryError")<{
  readonly op: string
  readonly message: string
}> {}

/** The requested slug is one of the 8 built-in reserved server names. */
export class McpSlugReserved extends Data.TaggedError("McpSlugReserved")<{
  readonly slug: string
}> {}

/** A server with this slug already exists in the registry. */
export class McpSlugExists extends Data.TaggedError("McpSlugExists")<{
  readonly slug: string
}> {}

/** The slug does not match the required format. */
export class McpSlugInvalid extends Data.TaggedError("McpSlugInvalid")<{
  readonly slug: string
  readonly reason: string
}> {}

/** The supplied url is not a valid HTTPS endpoint. */
export class McpUrlInvalid extends Data.TaggedError("McpUrlInvalid")<{
  readonly url: string
  readonly reason: string
}> {}

// ---------------------------------------------------------------------------
// URL validation — enforces HTTPS to prevent credential leakage
// ---------------------------------------------------------------------------

/**
 * Throws McpUrlInvalid when:
 *  - the string is not a parseable URL, OR
 *  - the protocol is not "https:".
 *
 * Headers carry credential-refs that are resolved and attached at mount time;
 * a plaintext http:// URL would transmit those credentials in the clear.
 * Returns void on success.
 */
export const validateUrl = (url: string): void => {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new McpUrlInvalid({ url, reason: "not a valid URL" })
  }
  if (parsed.protocol !== "https:") {
    throw new McpUrlInvalid({
      url,
      reason: `protocol must be "https:" — got "${parsed.protocol}"`,
    })
  }
}

// ---------------------------------------------------------------------------
// Reserved slugs — built-in servers that must not be shadowed
// ---------------------------------------------------------------------------

/**
 * The 8 built-in MCP server names shipped with the Luna agent SDK.
 * Operators may not register an external server under any of these slugs
 * because doing so would shadow a built-in capability.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "memory",
  "scheduler",
  "observability",
  "local_shell",
  "secret_tools",
  "skill_tools",
  "widget_tools",
  "suggested_actions",
])

// ---------------------------------------------------------------------------
// Slug validation
// ---------------------------------------------------------------------------

/**
 * Valid slug: lowercase letters, digits, hyphens; must START with a letter or
 * digit; length 1–64.  No underscores (they collide with the `mcp__...__`
 * SDK delimiter).
 *
 * Throws McpSlugInvalid when the format is wrong, McpSlugReserved when the
 * slug matches a built-in server name.  Returns void on success.
 */
export const validateSlug = (slug: string): void => {
  // Reserved-ness wins over format: a built-in server name is the more
  // specific, more useful rejection reason. Several built-ins contain
  // underscores (local_shell, secret_tools, …) which would otherwise fail
  // the format check first and mask the real reason ("that name is taken").
  if (RESERVED_SLUGS.has(slug)) {
    throw new McpSlugReserved({ slug })
  }
  const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
  if (!SLUG_RE.test(slug)) {
    throw new McpSlugInvalid({
      slug,
      reason:
        "slug must match /^[a-z0-9][a-z0-9-]{0,63}$/ — lowercase letters, " +
        "digits and hyphens only; no underscores; 1–64 characters",
    })
  }
}
