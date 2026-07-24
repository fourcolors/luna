/**
 * connectorsReducer.ts - pure state/reducer for the Connectors settings
 * panel's React port (frontend/panels/settings-connectors.js ->
 * ConnectorsPanel.tsx).
 *
 * Framework-agnostic on purpose (no DOM, no React), consumed via
 * useLocalStore/useMoonSelector (src/state/store.ts) exactly like
 * connectionReducer.ts - every ctx.invoke()/WS-frame callback's whole job is
 * `store.dispatch(...)`; only ConnectorsPanel.tsx's render return value
 * decides what appears on screen.
 *
 * Ports the vanilla module's closured state 1:1:
 *  - catalog / instances: server-sent definition + instance lists.
 *  - busy: per-definition 'authorizing' | 'connecting' spinner state.
 *  - consentOpen / clientEditOpen: which definition's consent sheet / OAuth
 *    client-setup form is expanded (single-open, like the vanilla module).
 *  - consentDraft: per-definition in-progress { label, caps, secretRef }
 *    typed into the (not yet submitted) consent sheet. The vanilla module's
 *    one-shot `reconnectLabel` DOM-render stash is folded directly into this
 *    draft on "reconnect-clicked" instead - there is no render-time window
 *    to lose it in React.
 *  - plainRequests: requestId -> definitionId for in-flight api-key connects
 *    (connector-connect), so a later connector-status ack can be routed back
 *    to the right definition's busy/draft state.
 *  - oauthRequestId / oauthDefinitionId / oauthCodeSent: the in-flight OAuth
 *    flow's identity + redemption-window phase gate - see "status-frame"
 *    below for the full attribution rules ported verbatim from applyStatus.
 *  - capabilityDenied: sticky, one-way flag set the first time a `hello`
 *    frame arrives without capabilities.connectors (matches the vanilla
 *    module, which never reverses this once shown).
 *
 * The vanilla module's 30s "waiting for connector-oauth-begin ack" watchdog
 * timer is NOT reducer state (a timer handle is not serializable/pure state)
 * - it lives as a ref in ConnectorsPanel.tsx, which dispatches "oauth-cancelled"
 * when it fires.
 */

export interface ConnectorCapability {
  readonly id: string
  readonly label: string
  readonly defaultGranted?: boolean
  readonly scopes?: readonly string[]
}

export interface ConnectorClientSetup {
  readonly configured: boolean
}

export interface ConnectorDefinition {
  readonly id: string
  readonly name: string
  readonly blurb?: string
  readonly authKind: "oauth2" | "api-key" | string
  readonly capabilities?: readonly ConnectorCapability[]
  readonly clientSetup?: ConnectorClientSetup
}

export type ConnectorInstanceStatus = "connected" | "needs-reauth" | "error" | string

export interface ConnectorInstance {
  readonly id: string
  readonly definitionId: string
  readonly label: string
  readonly status: ConnectorInstanceStatus
  readonly grantedScopes?: readonly string[]
}

export type BusyState = "authorizing" | "connecting"

export interface ConsentDraft {
  readonly label?: string
  readonly caps?: readonly string[]
  readonly secretRef?: string
}

export interface StatusFrame {
  readonly requestId?: string
  readonly ok?: boolean
  readonly message?: string
  readonly instance?: ConnectorInstance
}

export interface ConnectorsPanelState {
  readonly catalog: readonly ConnectorDefinition[]
  readonly instances: readonly ConnectorInstance[]
  readonly busy: Readonly<Record<string, BusyState>>
  readonly consentOpen: string | null
  readonly clientEditOpen: string | null
  readonly consentDraft: Readonly<Record<string, ConsentDraft>>
  readonly plainRequests: Readonly<Record<string, string>>
  readonly oauthRequestId: string | null
  readonly oauthDefinitionId: string | null
  readonly oauthCodeSent: boolean
  readonly error: string | null
  readonly capabilityDenied: boolean
}

export type ConnectorsPanelAction =
  | { readonly type: "hello-received"; readonly capabilities: Readonly<Record<string, unknown>> }
  | { readonly type: "catalog-received"; readonly connectors: readonly ConnectorDefinition[] }
  | { readonly type: "instances-received"; readonly instances: readonly ConnectorInstance[] }
  | { readonly type: "consent-toggled"; readonly defId: string }
  | { readonly type: "draft-label-changed"; readonly defId: string; readonly value: string }
  | { readonly type: "draft-caps-changed"; readonly defId: string; readonly caps: readonly string[] }
  | { readonly type: "draft-secret-ref-changed"; readonly defId: string; readonly value: string }
  | { readonly type: "reconnect-clicked"; readonly defId: string; readonly label: string | null }
  | { readonly type: "oauth-authorizing-start"; readonly defId: string }
  | { readonly type: "oauth-begin-set"; readonly requestId: string; readonly defId: string }
  | { readonly type: "oauth-code-sent" }
  | { readonly type: "oauth-cancelled"; readonly message: string | null }
  | { readonly type: "busy-cleared"; readonly defId: string }
  | { readonly type: "plain-connecting-start"; readonly defId: string; readonly requestId: string }
  | { readonly type: "client-edit-toggled"; readonly defId: string }
  | { readonly type: "client-saved" }
  | { readonly type: "status-frame"; readonly frame: StatusFrame }
  | { readonly type: "error-set"; readonly message: string | null }

export function initialConnectorsState(): ConnectorsPanelState {
  return {
    catalog: [],
    instances: [],
    busy: {},
    consentOpen: null,
    clientEditOpen: null,
    consentDraft: {},
    plainRequests: {},
    oauthRequestId: null,
    oauthDefinitionId: null,
    oauthCodeSent: false,
    error: null,
    capabilityDenied: false,
  }
}

export function instancesFor(
  instances: readonly ConnectorInstance[],
  defId: string,
): ConnectorInstance[] {
  return instances.filter((i) => i.definitionId === defId)
}

export type OverallStatus = "idle" | "error" | "needs-reauth" | "connected"

export function overallStatus(insts: readonly ConnectorInstance[]): OverallStatus {
  if (insts.length === 0) return "idle"
  if (insts.some((i) => i.status === "error")) return "error"
  if (insts.some((i) => i.status === "needs-reauth")) return "needs-reauth"
  return "connected"
}

/** Client-side mirror of the server's labelSlug (lowercase, non-alnum runs ->
 *  '_', trimmed) - close enough to preflight the common collision: a second
 *  account left on the default label. The server check stays authoritative. */
export function labelSlugLite(label: string | null | undefined): string {
  return String(label || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
}

export function labelTaken(
  instances: readonly ConnectorInstance[],
  defId: string,
  label: string,
): boolean {
  const slug = labelSlugLite(label)
  return instances.some((i) => i.definitionId === defId && labelSlugLite(i.label) === slug)
}

/**
 * Turn a raw loopback / provider failure into an operator-actionable banner.
 * Pure helper, exported for unit tests. Ported verbatim from the vanilla
 * module's formatOauthConsentError (issue #107).
 *
 * Covers:
 *   - provider error= redirect (access_denied, etc.) vs 5-minute timeout
 *   - Testing-mode apps that only admit listed test users
 *   - Workspace org policies that block unverified third-party apps
 *   - cancelled / abandoned consent
 */
export function formatOauthConsentError(raw: unknown): string {
  // Tauri invoke rejects with string OR Error/object depending on the bridge.
  let msg = ""
  if (typeof raw === "string") {
    msg = raw.trim()
  } else if (raw && typeof raw === "object") {
    const obj = raw as { message?: unknown }
    if (typeof obj.message === "string" && obj.message.trim()) {
      msg = obj.message.trim()
    } else {
      try {
        msg = String(raw)
      } catch {
        msg = ""
      }
      if (msg === "[object Object]") msg = ""
    }
  } else if (raw != null) {
    msg = String(raw).trim()
  }
  if (!msg) msg = "The consent flow did not complete."
  const lower = msg.toLowerCase()

  // Explicit cancel (Cancel button or oauth_loopback_cancel) - leave alone.
  if (/oauth flow cancelled|cancelled by the user|canceled by the user/.test(lower)) {
    return "Consent cancelled. Click Connect again when you are ready."
  }

  // Loopback wait deadline - distinct from a provider denial.
  if (/timed out waiting for the browser consent|timed out/.test(lower)) {
    return (
      "Timed out waiting for browser consent. Keep the consent tab open, finish the grant, " +
      'then click Connect again. If Google showed "Something went wrong", pick a personal ' +
      "Gmail account (not a Workspace org that blocks unverified apps) and retry."
    )
  }

  // Workspace org admin policy / admin_policy_enforced.
  if (/admin_policy_enforced|org(?:anization)? policy|blocked by your organization|access blocked/.test(lower)) {
    return (
      msg +
      " - a Google Workspace org policy is blocking this unverified app. Use a personal " +
      "Gmail account, or ask your Workspace admin to allow the OAuth client."
    )
  }

  // Classic Testing-mode / unverified-app denial.
  if (/access_denied|not.{0,8}verified|consent was declined/.test(lower)) {
    return (
      msg +
      " - if the OAuth app is still in Testing mode, add this Google account as a test user " +
      "(or Publish the consent screen to Production) in Google Cloud Console. " +
      "Workspace org accounts may also block unverified apps - try a personal Gmail, or " +
      'use Advanced -> "Go to <app>" on the unverified-app interstitial.'
    )
  }

  return msg
}

function clearBusy(
  busy: Readonly<Record<string, BusyState>>,
  defId: string | null,
): Record<string, BusyState> {
  if (!defId || !Object.prototype.hasOwnProperty.call(busy, defId)) return { ...busy }
  const next = { ...busy }
  delete next[defId]
  return next
}

function teardownOauth(
  state: ConnectorsPanelState,
  message: string | null,
): ConnectorsPanelState {
  return {
    ...state,
    busy: clearBusy(state.busy, state.oauthDefinitionId),
    oauthRequestId: null,
    oauthDefinitionId: null,
    oauthCodeSent: false,
    error: message ? message : state.error,
  }
}

/**
 * Ported verbatim from the vanilla module's applyStatus - see that function's
 * doc comment for the full attribution rationale (plain connect ack vs our
 * in-flight OAuth flow vs an unrelated ack sharing this handler).
 */
function applyStatusFrame(
  state: ConnectorsPanelState,
  frame: StatusFrame,
): ConnectorsPanelState {
  if (!frame) return state

  // Path 1: plain connector-connect response.
  if (frame.requestId && Object.prototype.hasOwnProperty.call(state.plainRequests, frame.requestId)) {
    const defId = state.plainRequests[frame.requestId]!
    const plainRequests = { ...state.plainRequests }
    delete plainRequests[frame.requestId]
    const busy = clearBusy(state.busy, defId)
    if (frame.ok) {
      const consentDraft = { ...state.consentDraft }
      delete consentDraft[defId]
      return { ...state, plainRequests, busy, consentDraft, error: null }
    }
    return { ...state, plainRequests, busy, error: frame.message || "Connector request failed." }
  }

  // Path 2: a connector-status frame that is NOT a tracked plain connect. It
  // may belong to OUR in-flight OAuth flow, or be an ack for a different flow
  // that merely shares this handler - see the vanilla module's doc for the
  // full attribution rules (kept verbatim, including the redemption-window
  // phase gate on oauthCodeSent).
  const attributableToOurOauth =
    state.oauthRequestId !== null &&
    ((!!frame.requestId && frame.requestId === state.oauthRequestId) ||
      (!!frame.instance && frame.instance.definitionId === state.oauthDefinitionId) ||
      (state.oauthCodeSent && !frame.ok && !frame.requestId && !frame.instance))

  let next = state
  if (attributableToOurOauth) {
    if (!frame.ok) {
      return teardownOauth(state, frame.message || "Connector request failed.")
    }
    next = {
      ...state,
      busy: clearBusy(state.busy, state.oauthDefinitionId),
      oauthRequestId: null,
      oauthDefinitionId: null,
      oauthCodeSent: false,
    }
  }

  if (frame.instance) {
    const busy = clearBusy(next.busy, frame.instance.definitionId)
    const consentDraft = { ...next.consentDraft }
    delete consentDraft[frame.instance.definitionId]
    next = { ...next, busy, consentDraft }
  }

  // A failure ack with no flow to attribute it to (set-client, disconnect,
  // late completeAuth) must still SHOW its message - never silently discard.
  return { ...next, error: frame.ok ? null : (frame.message || "Connector request failed.") }
}

export function reduceConnectors(
  state: ConnectorsPanelState,
  action: ConnectorsPanelAction,
): ConnectorsPanelState {
  switch (action.type) {
    case "hello-received":
      return action.capabilities.connectors ? state : { ...state, capabilityDenied: true }

    case "catalog-received":
      return { ...state, catalog: action.connectors }

    case "instances-received":
      return { ...state, instances: action.instances }

    case "consent-toggled": {
      const closing = state.consentOpen === action.defId
      const consentOpen = closing ? null : action.defId
      let consentDraft: Readonly<Record<string, ConsentDraft>> = state.consentDraft
      if (closing) {
        const next: Record<string, ConsentDraft> = { ...state.consentDraft }
        delete next[action.defId]
        consentDraft = next
      }
      return { ...state, consentOpen, consentDraft, error: null }
    }

    case "draft-label-changed":
      return {
        ...state,
        consentDraft: {
          ...state.consentDraft,
          [action.defId]: { ...state.consentDraft[action.defId], label: action.value },
        },
      }

    case "draft-caps-changed":
      return {
        ...state,
        consentDraft: {
          ...state.consentDraft,
          [action.defId]: { ...state.consentDraft[action.defId], caps: action.caps },
        },
      }

    case "draft-secret-ref-changed":
      return {
        ...state,
        consentDraft: {
          ...state.consentDraft,
          [action.defId]: { ...state.consentDraft[action.defId], secretRef: action.value },
        },
      }

    case "reconnect-clicked": {
      const draft = { ...state.consentDraft[action.defId] }
      if (action.label) draft.label = action.label
      return {
        ...state,
        consentDraft: { ...state.consentDraft, [action.defId]: draft },
        consentOpen: action.defId,
      }
    }

    case "oauth-authorizing-start":
      return {
        ...state,
        busy: { ...state.busy, [action.defId]: "authorizing" },
        consentOpen: null,
      }

    case "oauth-begin-set":
      return {
        ...state,
        oauthRequestId: action.requestId,
        oauthDefinitionId: action.defId,
        oauthCodeSent: false,
      }

    case "oauth-code-sent":
      return { ...state, oauthCodeSent: true }

    case "oauth-cancelled":
      return teardownOauth(state, action.message)

    case "busy-cleared":
      return { ...state, busy: clearBusy(state.busy, action.defId) }

    case "plain-connecting-start":
      return {
        ...state,
        busy: { ...state.busy, [action.defId]: "connecting" },
        consentOpen: null,
        plainRequests: { ...state.plainRequests, [action.requestId]: action.defId },
      }

    case "client-edit-toggled":
      return {
        ...state,
        clientEditOpen: state.clientEditOpen === action.defId ? null : action.defId,
      }

    case "client-saved":
      return { ...state, clientEditOpen: null }

    case "status-frame":
      return applyStatusFrame(state, action.frame)

    case "error-set":
      return { ...state, error: action.message }

    default:
      return state
  }
}
