/**
 * Connector model — PRD Part A §06.
 *
 * A ConnectorDefinition is a static, in-repo catalog entry describing a
 * connectable service: how we authenticate (AuthSpec) and how its tools
 * reach the agent (TransportSpec). A ConnectorInstance is one operator
 * connection — a row in luna.db whose `secretRef` is a POINTER into the
 * SecretProvider chain (`env:` / `luna-op://`), never a credential value.
 *
 * Definitions are curated and shipped with Luna (pinned URLs/commands —
 * PRD §23: mounting an MCP server with a live token is a trust grant, so
 * user-entered server URLs are out of scope for v1).
 */
import { Data } from "effect"

export type ConnectorCategory =
  | "productivity"
  | "communication"
  | "storage"
  | "development"
  | "other"

export type ConnectorStatus =
  | "connected"
  | "needs-reauth"
  | "error"
  | "disconnected"

/** One togglable capability of a connector (drives consent scope-narrowing). */
export interface CapabilitySpec {
  readonly id: string
  readonly label: string
  /** OAuth scopes this capability requires (empty for non-OAuth connectors). */
  readonly scopes: ReadonlyArray<string>
  /** Granted by default when the operator doesn't customize the consent. */
  readonly defaultGranted: boolean
}

export type AuthSpec =
  | {
      readonly kind: "oauth2"
      /** PKCE authorization-code flow (RFC 8252 loopback). Always PKCE —
       *  Google Desktop clients support it and it never hurts. */
      readonly authorizationEndpoint: string
      readonly tokenEndpoint: string
      /** Env-var names (NOT values) holding the per-operator client id/secret
       *  — PRD §23: per-operator client REQUIRED; nothing ships in-repo. */
      readonly clientIdEnvVar: string
      readonly clientSecretEnvVar: string
      /** Extra authorize-URL params (e.g. Google's access_type=offline). */
      readonly extraAuthParams?: Readonly<Record<string, string>>
    }
  | {
      readonly kind: "api-key"
      /** What the consent sheet asks for, e.g. "Slack bot token (xoxb-…)". */
      readonly fieldLabel: string
    }
  | { readonly kind: "none" }

export type TransportSpec =
  | {
      /** Streamable-HTTP MCP server; the minted/stored credential rides as
       *  `Authorization: Bearer <token>` (verified: SDK McpHttpServerConfig
       *  supports `headers`). */
      readonly kind: "mcp-remote"
      readonly url: string
    }
  | {
      /** Stdio MCP server; the credential is injected as an env var
       *  (verified: SDK McpStdioServerConfig supports `env`). */
      readonly kind: "mcp-stdio"
      readonly command: string
      readonly args: ReadonlyArray<string>
      readonly secretEnvVar: string
    }
  | {
      /** ESCAPE HATCH: an in-process SDK MCP server built by the definition
       *  (used by the mock connector and future native adapters). */
      readonly kind: "native"
      readonly makeServer: () => unknown // McpSdkServerConfigWithInstance — opaque here (core stays SDK-free)
    }

export interface ConnectorDefinition {
  readonly id: string
  readonly name: string
  readonly blurb: string
  readonly category: ConnectorCategory
  readonly auth: AuthSpec
  readonly transport: TransportSpec
  readonly capabilities: ReadonlyArray<CapabilitySpec>
  /**
   * Server key in the per-thread `mcpServers` dict (and the tool-name
   * prefix the agent sees: `mcp__<serverKey>__*`). Lowercase + underscores.
   */
  readonly serverKey: string
}

/** Wire-safe definition metadata (what the settings catalog renders). */
export interface ConnectorDefinitionMeta {
  readonly id: string
  readonly name: string
  readonly blurb: string
  readonly category: ConnectorCategory
  readonly authKind: AuthSpec["kind"]
  readonly capabilities: ReadonlyArray<CapabilitySpec>
}

export interface ConnectorInstance {
  readonly id: string
  readonly definitionId: string
  readonly label: string
  readonly status: ConnectorStatus
  /** Pointer into the SecretProvider chain — NEVER the credential value.
   *  "none" for auth-kind none. */
  readonly secretRef: string
  readonly grantedScopes: ReadonlyArray<string>
  /** Mirrors accounts.kind for future broker routing, e.g. "connector-google-workspace". */
  readonly accountKind: string
  readonly createdAt: number
  readonly lastHealthyAt: number | null
}

export class ConnectorError extends Data.TaggedError("ConnectorError")<{
  readonly op: string
  readonly message: string
}> {}

export const scopesForCapabilities = (
  definition: ConnectorDefinition,
  capabilityIds: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const wanted = new Set(capabilityIds)
  const scopes = new Set<string>()
  for (const cap of definition.capabilities) {
    if (wanted.has(cap.id)) for (const s of cap.scopes) scopes.add(s)
  }
  return Array.from(scopes)
}
