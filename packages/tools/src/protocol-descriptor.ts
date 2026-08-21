export const UI_WS_PROTOCOL_VERSION = 2 as const

// ============================================================================
// Effort tokens - the wire vocabulary for `effort` fields (fixes #462)
// ============================================================================
//
// WHY THEY LIVE HERE, in a 23-line leaf with zero imports rather than beside
// the richer helpers in packages/chat-service/src/effort.ts: this module is
// the only effort-aware thing a BROWSER bundle can reach. `@luna/chat-service`
// is server-side, and `@luna/ui-ws` publishes a single "." export that
// re-exports server.js plus six node-side bridges, so importing a runtime
// value from either drags server code into the Moon bundle. That gap - the
// union written as a type in one place and its runtime values in an
// unreachable other - is what forced ComposerConfig.tsx's `as Effort`
// assertion at the wire boundary, which is what #462 was about.
//
// SCOPE, deliberately narrow: this is the CLIENT-SELECTABLE vocabulary only.
// The per-model validity matrix (`effortsForModel`), the clamping rules
// (`clampEffort`) and the EffortLevel/Ultracode split all stay in
// chat-service, which remains the server-side source of truth and still
// re-validates every wire value - nothing here is trusted by the server.
//
// chat-service is NOT re-pointed at these constants: doing so inside a
// typing-debt fix would put server behavior at risk for no gain. The two
// lists are instead pinned against each other by
// packages/tools/test/effort-parity.test.ts, so they cannot drift.

/** Every token a client may put in a wire `effort` field, in ascending
 * strength order with the ultracode selector last. Mirrors
 * `[...EFFORT_LEVELS, ULTRACODE]` from chat-service (parity-tested). */
export const EFFORT_OPTIONS = ["low", "medium", "high", "xhigh", "max", "ultracode"] as const

/** The wire type for a client-selectable effort. Identical to
 * chat-service's `EffortOption`; declared here so browser code can name it
 * without importing a server package. */
export type EffortOption = (typeof EFFORT_OPTIONS)[number]

/** Runtime guard for a wire `effort` value. The whole point of this file
 * carrying a VALUE and not just a type: a client narrowing a
 * server-advertised string needs something it can actually execute. */
export const isEffortOption = (v: unknown): v is EffortOption =>
  typeof v === "string" && (EFFORT_OPTIONS as ReadonlyArray<string>).includes(v)

export type ServerKind = "luna-chat-server" | "openclaw" | "hermes" | "unknown"
export type OperationName = "interact" | "inspect" | "update" | "administer"
export interface ServerDescriptorCapability {
  readonly operation: OperationName | string
  readonly available: boolean
  readonly authz: { readonly allowed: boolean; readonly scope?: "read" | "write" | "admin"; readonly requiresElevation?: boolean; readonly reason?: string }
  readonly title?: string
  readonly unavailableReason?: string
  readonly detail?: Readonly<Record<string, unknown>>
}
export interface ServerDescriptor {
  readonly descriptorSchema: number
  readonly generation: number
  readonly issuedAt: string
  readonly negotiation: { readonly agreed: number }
  readonly identity: { readonly name: string; readonly kind: ServerKind; readonly displayName?: string; readonly version: string; readonly instanceId?: string; readonly fingerprint?: string; readonly synthesized?: true }
  readonly runtimeSummary: { readonly category: "container" | "host-process" | "user-service" | "desktop-app" | "remote" | "unknown"; readonly live?: boolean }
  readonly capabilities: ReadonlyArray<ServerDescriptorCapability>
  readonly health: { readonly status: "normal" | "degraded" | "starting" | "error"; readonly credentialOk?: boolean; readonly checks?: ReadonlyArray<{ readonly name: string; readonly ok: boolean; readonly detail?: string }>; readonly checkedAt?: string; readonly port?: number }
  readonly update?: { readonly driverKind: ServerKind; readonly currentVersion: string; readonly targetVersion?: string; readonly updateAvailable?: boolean; readonly revertible: boolean; readonly forwardOnly?: boolean; readonly phase?: "idle" | "checking" | "downloading" | "ready-to-apply" | "applying" | "error" }
}
