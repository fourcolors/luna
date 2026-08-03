/**
 * descriptor/project.ts — builds a ServerDescriptor for the Luna hello frame.
 *
 * Pure function, no side-effects on import. The per-process generation
 * counter uses a module-level variable (increments once per call) so each
 * connection gets a fresh, monotonically-increasing generation number that
 * lets clients detect a server restart between connections.
 */
import type { ServerDescriptor, ServerDescriptorCapability } from "@luna/tools/protocol-descriptor"
import { UI_WS_PROTOCOL_VERSION } from "@luna/tools/protocol-descriptor"

// Module-level monotonic counter: incremented once per descriptor build
// (i.e. once per new WebSocket connection). Resets to 0 on process restart,
// which lets clients detect a restart between two connections.
let _generation = 0

// Stable per-PROCESS identity, minted once at module load. Unlike `generation`
// (which resets to 0 on restart and only rises within a single process), this
// gets a fresh value after every restart — so a client comparing instanceId
// across connections can reliably detect a restarted/different server, which a
// reset-to-0 monotonic counter alone cannot.
const INSTANCE_ID = crypto.randomUUID()

export interface LunaDescriptorInputs {
  /** Name to use in identity.name (default: "luna") */
  readonly serverName?: string
  /** Semver or buildSha used for identity.version and update.currentVersion */
  readonly version?: string
  /** Port the WS server is listening on (for health.port) */
  readonly port?: number
  /** Whether credentials are confirmed ok (normal-mode = true) */
  readonly credentialOk?: boolean
  /** Whether the server is in setup mode (affects health.status) */
  readonly setupMode?: boolean
  /** Capabilities flags from the existing boolean caps to derive descriptor capabilities */
  readonly caps: {
    readonly chat: boolean
    readonly localShell?: boolean
    readonly skills?: boolean
    readonly connectors?: boolean
    readonly artifacts?: boolean
    readonly workflows?: boolean
    readonly suggestedActions?: boolean
    readonly threadForks?: boolean
    readonly vault?: boolean
    readonly mcpApps?: boolean
    readonly effortSelection?: boolean
    readonly subagents?: boolean
    readonly modelRouting?: boolean
  }
  // ── C1 enrichments ──────────────────────────────────────────────────────────
  /** The negotiated protocolVersion (defaults to UI_WS_PROTOCOL_VERSION = 2). */
  readonly negotiationAgreed?: number
  /** Runtime deployment category (defaults to "host-process"). */
  readonly runtimeCategory?: "container" | "host-process" | "user-service" | "desktop-app" | "remote" | "unknown"
  /**
   * Whether timer-based deploys are allowed for this server instance.
   * Affects administer authz: administer is only allowed if isLoopback AND
   * timerAllowed AND !setupMode. Defaults to true when omitted.
   */
  readonly timerAllowed?: boolean
  /**
   * Whether the connection is from a loopback address (127.x or ::1).
   * Server-computed — never accepted from client assertions.
   * Affects administer authz: administer is only allowed if isLoopback AND
   * timerAllowed AND !setupMode.
   */
  readonly isLoopback?: boolean
  /** Live health checks to embed in the descriptor (defaults to []). */
  readonly healthChecks?: ReadonlyArray<{ readonly name: string; readonly ok: boolean; readonly detail?: string }>
}

/**
 * Build a fresh ServerDescriptor for the Luna hello frame.
 * Called once per new WebSocket connection — issuedAt and generation are
 * always current at the time of the call.
 */
export function projectLunaDescriptor(inputs: LunaDescriptorInputs): ServerDescriptor {
  const {
    serverName = "luna",
    version = "unknown",
    port,
    credentialOk,
    setupMode = false,
    caps,
    negotiationAgreed = UI_WS_PROTOCOL_VERSION,
    runtimeCategory = "host-process",
    timerAllowed,
    isLoopback,
    healthChecks,
  } = inputs

  const generation = ++_generation
  const issuedAt = new Date().toISOString()

  // C1: administer is server-side computed — NEVER from a client assertion.
  // Allowed iff: request is from loopback AND timers are allowed AND not in setup mode.
  //
  // NOTE (Phase-2 C9 — intentional deferral): `isLoopback` and `timerAllowed` are
  // not yet wired by the production caller (ui-ws/src/server.ts). This is a deliberate
  // conservative default — administer stays DENIED until a reliable operator-identity
  // mechanism (token/trust header) is in place. Raw socket-loopback CANNOT be used as
  // the signal: this server runs inside an incus container and all external connections
  // arrive via the incusd :4753 proxy, so they appear as loopback to the process and
  // would wrongly grant administer. Wire isLoopback/timerAllowed only as part of C9.
  const administersAllowed =
    (isLoopback === true) && (timerAllowed !== false) && !setupMode

  const descriptorCaps: ServerDescriptorCapability[] = [
    {
      operation: "interact",
      available: caps.chat,
      authz: { allowed: true, scope: "write" },
      title: "Chat",
      ...(!caps.chat ? { unavailableReason: "No chat service bound (setup mode)" } : {}),
    },
    {
      operation: "inspect",
      available: true,
      authz: { allowed: true, scope: "read" },
      title: "Status",
      detail: {
        skills: caps.skills ?? false,
        connectors: caps.connectors ?? false,
        artifacts: caps.artifacts ?? false,
        workflows: caps.workflows ?? false,
        vault: caps.vault ?? false,
        mcpApps: caps.mcpApps ?? false,
        subagents: caps.subagents ?? false,
        modelRouting: caps.modelRouting ?? false,
      },
    },
    {
      operation: "update",
      available: true,
      authz: { allowed: true, scope: "write", requiresElevation: true },
      title: "Update server",
    },
    {
      operation: "administer",
      available: !setupMode,
      authz: {
        allowed: administersAllowed,
        scope: "admin",
        requiresElevation: true,
        ...(!administersAllowed ? {
          reason: setupMode
            ? "Server is in setup mode"
            : isLoopback !== true
              ? "Requires host-local connection"
              : "Deploy timer disabled",
        } : {}),
      },
      title: "Administer",
      ...(setupMode ? { unavailableReason: "Server is in setup mode" } : {}),
    },
  ]

  return {
    descriptorSchema: 1,
    generation,
    issuedAt,
    negotiation: { agreed: negotiationAgreed },
    identity: {
      name: serverName,
      kind: "luna-chat-server",
      displayName: "Luna",
      version,
      instanceId: INSTANCE_ID,
    },
    runtimeSummary: {
      category: runtimeCategory,
      live: true,
    },
    capabilities: descriptorCaps,
    health: {
      status: setupMode ? "starting" : "normal",
      ...(credentialOk !== undefined ? { credentialOk } : {}),
      checks: healthChecks ?? [],
      checkedAt: issuedAt,
      ...(port !== undefined ? { port } : {}),
    },
    update: {
      driverKind: "luna-chat-server",
      currentVersion: version,
      revertible: true,
    },
  }
}
