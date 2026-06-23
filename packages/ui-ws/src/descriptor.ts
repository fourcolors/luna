/**
 * descriptor.ts — builds a ServerDescriptor for the Luna hello frame.
 *
 * Pure function, no side-effects on import. The per-process generation
 * counter uses a module-level variable (increments once per call) so each
 * connection gets a fresh, monotonically-increasing generation number that
 * lets clients detect a server restart between connections.
 */
import type { ServerDescriptor, ServerDescriptorCapability } from "./protocol.js"

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

interface LunaDescriptorInputs {
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
    readonly vault?: boolean
    readonly mcpApps?: boolean
    readonly effortSelection?: boolean
    readonly subagents?: boolean
    readonly modelRouting?: boolean
  }
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
  } = inputs

  const generation = ++_generation
  const issuedAt = new Date().toISOString()

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
      authz: { allowed: !setupMode, scope: "admin", requiresElevation: true },
      title: "Administer",
      ...(setupMode ? { unavailableReason: "Server is in setup mode" } : {}),
    },
  ]

  return {
    descriptorSchema: 1,
    generation,
    issuedAt,
    negotiation: { agreed: 2 },
    identity: {
      name: serverName,
      kind: "luna-chat-server",
      displayName: "Luna",
      version,
      instanceId: INSTANCE_ID,
    },
    runtimeSummary: {
      category: "host-process",
      live: true,
    },
    capabilities: descriptorCaps,
    health: {
      status: setupMode ? "starting" : "normal",
      ...(credentialOk !== undefined ? { credentialOk } : {}),
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
