export const UI_WS_PROTOCOL_VERSION = 2 as const

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
