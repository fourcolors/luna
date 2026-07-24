/**
 * ConnectorsPanel.tsx - React 19 + Astryx port of
 * frontend/panels/settings-connectors.js (registered there as
 * `LunaPanelTypes['settings.connectors']`), the OAuth / api-key connector
 * multi-account management panel (PRD Part A §17).
 *
 * WS-backed exactly like the vanilla module: builds a frame registry via
 * ctx.connectWs, gates on the 'connectors' capability from the hello frame.
 *
 * Frame flow (unchanged from the vanilla module):
 *   <- hello           (gate on capabilities.connectors)
 *   <- connector-catalog  (definition list)
 *   <- connector-list     (instance list)
 *   <- connector-status   (ack / error for connect/disconnect)
 *   <- connector-oauth-redirect  (consent URL from server - open browser)
 *   -> connector-oauth-begin  { requestId, definitionId, label, capabilityIds, loopbackPort }
 *   -> connector-oauth-code   { pendingId, code, state }
 *   -> connector-connect      { requestId, definitionId, label, capabilityIds[, secretRef] }
 *   -> connector-disconnect   { instanceId }
 *   -> connector-set-client   { requestId, definitionId, clientId[, clientSecret] }
 *
 * Tauri commands used:
 *   oauth_loopback_start  -> port number
 *   oauth_loopback_wait   { timeoutMs } -> { code, state }
 *                         (rejects with the provider's reason on an
 *                          error= redirect - e.g. access_denied)
 *   oauth_loopback_cancel
 *   open_external_url     { url }
 *
 * State flows one way only, exactly like SettingsConnectionPanel.tsx: every
 * ctx.invoke()/WS-callback's entire job is `store.dispatch(...)` (see
 * connectorsReducer.ts) - the JSX below is the only thing that reads state
 * (via useLocalStore/useMoonSelector, src/state/store.ts) and decides what
 * appears on screen. The vanilla module's 30s "waiting for the server to ack
 * connector-oauth-begin" watchdog timer is the one piece of genuinely
 * imperative, non-reducer state (a timer handle isn't serializable) and
 * lives in a ref here.
 */
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react"
import {
  Badge,
  Banner,
  Button,
  CheckboxInput,
  EmptyState,
  Text,
  TextInput,
  type BadgeVariant,
} from "../../astryx-kit"
import { useLocalStore, useMoonSelector } from "../../state/store"
import {
  formatOauthConsentError,
  initialConnectorsState,
  instancesFor,
  labelTaken,
  overallStatus,
  reduceConnectors,
  type ConnectorDefinition,
  type ConnectorInstance,
  type ConnectorsPanelAction,
  type ConnectorsPanelState,
  type OverallStatus,
} from "./connectorsReducer"
import type { LunaFrameRegistry, PanelCtx } from "../panel-ctx"
import "./settings-connectors-panel.css"

/** Consumed by the panel-type registry (settings-connectors-mount.tsx) to
 *  set bar-title / document.title, mirroring the vanilla module's
 *  `title: 'Connectors'`. */
export const PANEL_TITLE = "Connectors"

type Store = ReturnType<typeof useLocalStore<ConnectorsPanelState, ConnectorsPanelAction>>

function badgeVariantFor(status: OverallStatus): BadgeVariant {
  switch (status) {
    case "connected":
      return "success"
    case "needs-reauth":
      return "warning"
    case "error":
      return "error"
    default:
      return "neutral"
  }
}

function randomRequestId(prefix: string): string {
  const g = globalThis as { crypto?: Crypto }
  const id = g.crypto?.randomUUID ? g.crypto.randomUUID().replace(/-/g, "") : Math.random().toString(36).slice(2)
  return prefix + "_" + id
}

export function ConnectorsPanel({ ctx }: { ctx: PanelCtx }) {
  const store = useLocalStore<ConnectorsPanelState, ConnectorsPanelAction>(
    reduceConnectors,
    initialConnectorsState(),
  )
  const state = useMoonSelector(store, (s) => s)

  const clientRef = useRef<ReturnType<NonNullable<PanelCtx["connectWs"]>> | null>(null)
  const beginTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function clearBeginTimer(): void {
    if (beginTimerRef.current) {
      clearTimeout(beginTimerRef.current)
      beginTimerRef.current = null
    }
  }

  function cancelOauth(message: string | null): void {
    clearBeginTimer()
    ctx.invoke("oauth_loopback_cancel").catch(() => {})
    store.dispatch({ type: "oauth-cancelled", message })
  }

  function disconnect(instanceId: string): void {
    clientRef.current?.send({ type: "connector-disconnect", instanceId })
  }

  function connectOauth(def: ConnectorDefinition, capabilityIds: string[], label: string): void {
    if (!ctx.hasTauri) {
      store.dispatch({
        type: "error-set",
        message: "OAuth connect needs the Moon desktop app (the browser cannot capture the redirect).",
      })
      return
    }
    const resolvedLabel = label.trim() || def.name
    // Preflight the duplicate-label rejection the server would send - BEFORE
    // binding a loopback and opening a browser tab.
    if (labelTaken(state.instances, def.id, resolvedLabel)) {
      store.dispatch({
        type: "error-set",
        message: `"${resolvedLabel}" is already connected - give this account a different label (e.g. personal, work).`,
      })
      return
    }
    store.dispatch({ type: "oauth-authorizing-start", defId: def.id })
    ctx.invoke("oauth_loopback_start")
      .then((port) => {
        const requestId = randomRequestId("oauth")
        store.dispatch({ type: "oauth-begin-set", requestId, defId: def.id })
        clearBeginTimer()
        beginTimerRef.current = setTimeout(() => {
          cancelOauth("Timed out starting the connection - please try again.")
        }, 30000)
        clientRef.current?.send({
          type: "connector-oauth-begin",
          requestId,
          definitionId: def.id,
          label: resolvedLabel,
          capabilityIds,
          loopbackPort: port,
        })
      })
      .catch((e) => {
        store.dispatch({ type: "busy-cleared", defId: def.id })
        store.dispatch({ type: "error-set", message: String(e) })
      })
  }

  function applyOauthRedirect(frame: { requestId?: string; authUrl?: string; pendingId?: string }): void {
    // Read the store's live state, NOT the `state` closed over by this
    // render - the registry callback that calls this function is registered
    // ONCE in the mount-only effect below, so a naive `state` read here would
    // be permanently pinned to the state at mount (oauthRequestId always
    // null), never seeing the oauth-begin-set dispatched after mount.
    if (!frame || frame.requestId !== store.getState().oauthRequestId) return
    clearBeginTimer()
    if (!ctx.hasTauri) return
    ctx.invoke("open_external_url", { url: frame.authUrl })
      .then(() => ctx.invoke("oauth_loopback_wait", { timeoutMs: 300000 }))
      .then((captured) => {
        const c = captured as { code?: string; state?: string }
        clientRef.current?.send({
          type: "connector-oauth-code",
          requestId: frame.requestId, // == oauthRequestId; echoed on the completeAuth status for attribution
          pendingId: frame.pendingId,
          code: c.code,
          state: c.state,
        })
        // Now redeeming the code: gates the applyStatus fallback attribution
        // to just this brief completeAuth redemption round-trip.
        store.dispatch({ type: "oauth-code-sent" })
      })
      .catch((e) => {
        cancelOauth(formatOauthConsentError(e))
      })
  }

  function connectPlain(def: ConnectorDefinition, capabilityIds: string[], secretRef: string, label: string): void {
    const resolvedLabel = label.trim() || def.name
    if (labelTaken(state.instances, def.id, resolvedLabel)) {
      store.dispatch({
        type: "error-set",
        message: `"${resolvedLabel}" is already connected - give this account a different label (e.g. personal, work).`,
      })
      return
    }
    const requestId = randomRequestId("conn").replace("oauth_", "conn_")
    store.dispatch({ type: "plain-connecting-start", defId: def.id, requestId })
    const frame: Record<string, unknown> = {
      type: "connector-connect",
      requestId,
      definitionId: def.id,
      label: resolvedLabel,
      capabilityIds,
    }
    if (secretRef) frame.secretRef = secretRef
    clientRef.current?.send(frame)
  }

  function setClient(definitionId: string, clientId: string, clientSecret: string): void {
    const trimmedId = clientId.trim()
    if (!trimmedId) return
    const frame: Record<string, unknown> = {
      type: "connector-set-client",
      requestId: randomRequestId("setclient"),
      definitionId,
      clientId: trimmedId,
    }
    if (clientSecret.trim()) frame.clientSecret = clientSecret.trim()
    clientRef.current?.send(frame)
    store.dispatch({ type: "client-saved" })
  }

  useEffect(() => {
    if (!ctx.connectWs) return
    const lunaWs = (globalThis as { LunaWS?: { createFrameRegistry: () => LunaFrameRegistry } }).LunaWS
    if (!lunaWs) return

    const registry = lunaWs.createFrameRegistry()

    registry.register("hello", (frame: any) => {
      const caps = (frame && frame.capabilities) || {}
      store.dispatch({ type: "hello-received", capabilities: caps })
    })

    registry.register("connector-catalog", (frame: any) => {
      store.dispatch({ type: "catalog-received", connectors: Array.isArray(frame.connectors) ? frame.connectors : [] })
    })

    registry.register("connector-list", (frame: any) => {
      store.dispatch({ type: "instances-received", instances: Array.isArray(frame.instances) ? frame.instances : [] })
    })

    registry.register("connector-status", (frame: any) => {
      clearBeginTimer()
      store.dispatch({ type: "status-frame", frame })
    })

    registry.register("connector-oauth-redirect", (frame: any) => {
      applyOauthRedirect(frame)
    })

    const client = ctx.connectWs(registry, { autoPong: true })
    clientRef.current = client

    return () => {
      client.close()
      clientRef.current = null
      clearBeginTimer()
    }
    // ctx is panel.html's single window.__panelCtx / a stable test double -
    // this effect only ever needs to run once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (state.capabilityDenied) {
    return (
      <div className="moon-astryx-root settings-connectors-panel" data-testid="settings-connectors-panel">
        <Banner
          status="info"
          title="Connectors not available"
          description="This server does not support connectors."
          data-testid="connectors-unsupported"
        />
      </div>
    )
  }

  return (
    <div className="moon-astryx-root settings-connectors-panel" data-testid="settings-connectors-panel">
      <span
        id="connectors-error"
        data-testid="connectors-error"
        className="panel-status warn"
        role="alert"
        hidden={!state.error}
      >
        {state.error ?? ""}
      </span>

      <div id="connectors-list" data-testid="connectors-list">
        {state.catalog.length === 0 ? (
          <EmptyState
            data-testid="connectors-empty"
            title="Not connected"
            description="Connectors appear when the server sends its catalog."
          />
        ) : (
          state.catalog.map((def) => (
            <ConnectorCard
              key={def.id}
              def={def}
              state={state}
              store={store}
              connectOauth={connectOauth}
              connectPlain={connectPlain}
              disconnect={disconnect}
              setClient={setClient}
              cancelOauth={cancelOauth}
              ctx={ctx}
            />
          ))
        )}
      </div>
    </div>
  )
}

function ConnectorCard({
  def,
  state,
  store,
  connectOauth,
  connectPlain,
  disconnect,
  setClient,
  cancelOauth,
  ctx,
}: {
  def: ConnectorDefinition
  state: ConnectorsPanelState
  store: Store
  connectOauth: (def: ConnectorDefinition, capabilityIds: string[], label: string) => void
  connectPlain: (def: ConnectorDefinition, capabilityIds: string[], secretRef: string, label: string) => void
  disconnect: (instanceId: string) => void
  setClient: (definitionId: string, clientId: string, clientSecret: string) => void
  cancelOauth: (message: string | null) => void
  ctx: PanelCtx
}) {
  const insts = instancesFor(state.instances, def.id)
  const status = overallStatus(insts)
  const defBusy = state.busy[def.id]
  const draft = state.consentDraft[def.id] || {}
  const needsClientFirst = !!(def.clientSetup && def.authKind === "oauth2" && !def.clientSetup.configured)
  const clientEditOpen = state.clientEditOpen === def.id
  const consentIsOpen = state.consentOpen === def.id
  const clientNotReady = !!(def.clientSetup && def.authKind === "oauth2" && !def.clientSetup.configured)

  function toggleConsent(): void {
    store.dispatch({ type: "consent-toggled", defId: def.id })
  }

  function handleReconnect(inst: ConnectorInstance): void {
    disconnect(inst.id)
    store.dispatch({ type: "reconnect-clicked", defId: def.id, label: inst.label || null })
  }

  return (
    <div
      className={"connector-card status-" + status}
      data-testid={`connector-card-${def.id}`}
    >
      <div className="connector-head">
        <div className="connector-info">
          <div className="connector-name-row">
            <Text type="body" weight="semibold" data-testid={`connector-name-${def.id}`}>
              {def.name}
            </Text>
            <Badge label={status} variant={badgeVariantFor(status)} data-testid={`connector-status-badge-${def.id}`} />
          </div>
          <Text type="supporting" color="secondary">{def.blurb || ""}</Text>
        </div>
        <div className="connector-actions">
          {defBusy ? (
            <>
              <Text type="supporting" color="secondary" data-testid={`connector-busy-${def.id}`}>
                {defBusy === "authorizing" ? "Waiting for your browser consent…" : "Connecting…"}
              </Text>
              {defBusy === "authorizing" && (
                <Button
                  label="Cancel"
                  size="sm"
                  className="connector-btn"
                  data-testid={`connector-cancel-btn-${def.id}`}
                  onClick={() => cancelOauth(null)}
                />
              )}
            </>
          ) : (
            !needsClientFirst && (
              <Button
                label={consentIsOpen ? "Cancel" : insts.length > 0 ? "Add account" : "Connect"}
                size="sm"
                className="connector-btn"
                data-testid={`connector-connect-btn-${def.id}`}
                onClick={toggleConsent}
              />
            )
          )}
        </div>
      </div>

      {insts.map((inst) => (
        <div className="connector-instance-row" data-testid={`connector-instance-${inst.id}`} key={inst.id}>
          <div className="connector-instance-info">
            <Text type="body" data-testid={`connector-instance-label-${inst.id}`}>{inst.label || inst.id}</Text>
            <Text
              type="supporting"
              color={inst.status === "needs-reauth" ? "accent" : "secondary"}
              data-testid={`connector-instance-status-${inst.id}`}
            >
              {inst.status === "connected"
                ? "Connected · " + ((inst.grantedScopes && inst.grantedScopes.length) || "no") + " scope(s)"
                : inst.status === "needs-reauth"
                  ? "Needs your approval again - reconnect"
                  : "Error - check the server log"}
            </Text>
            {inst.status === "connected" && def.authKind === "oauth2" && (
              <Text type="supporting" color="secondary">
                Requires its local connector server running on this machine.
              </Text>
            )}
          </div>
          <div className="connector-instance-actions">
            {inst.status === "needs-reauth" && def.authKind === "oauth2" && (
              <Button
                label="Reconnect"
                size="sm"
                className="connector-btn"
                data-testid={`connector-reconnect-btn-${inst.id}`}
                onClick={() => handleReconnect(inst)}
              />
            )}
            <Button
              label="Disconnect"
              size="sm"
              variant="destructive"
              className="connector-btn"
              data-testid={`connector-disconnect-btn-${inst.id}`}
              onClick={() => disconnect(inst.id)}
            />
          </div>
        </div>
      ))}

      {def.clientSetup && def.authKind === "oauth2" && !defBusy && (
        <ClientSetupSection
          def={def}
          editOpen={clientEditOpen}
          store={store}
          setClient={setClient}
          ctx={ctx}
        />
      )}

      {consentIsOpen && !defBusy && !clientNotReady && (
        <ConsentSheet
          def={def}
          draft={draft}
          store={store}
          connectOauth={connectOauth}
          connectPlain={connectPlain}
        />
      )}
    </div>
  )
}

function ClientSetupSection({
  def,
  editOpen,
  store,
  setClient,
  ctx,
}: {
  def: ConnectorDefinition
  editOpen: boolean
  store: Store
  setClient: (definitionId: string, clientId: string, clientSecret: string) => void
  ctx: PanelCtx
}) {
  const configured = !!def.clientSetup?.configured
  const isGoogle = /google|gws/i.test(String(def.id || "") + " " + String(def.name || ""))

  const [clientId, setClientId] = useState("")
  const [clientSecret, setClientSecret] = useState("")

  function handleLinkClick(ev: ReactMouseEvent<HTMLDivElement>): void {
    if (!isGoogle || !ctx.hasTauri) return
    const target = ev.target as HTMLElement
    const a = target.closest ? (target.closest("a[href]") as HTMLAnchorElement | null) : null
    if (!a) return
    const href = a.getAttribute("href") || ""
    if (!/^https:\/\//i.test(href)) return
    ev.preventDefault()
    ctx.invoke("open_external_url", { url: href }).catch((err) => {
      console.warn("[connectors] open_external_url failed", href, err)
    })
  }

  function handleSave(): void {
    if (!clientId.trim()) return
    const cid = clientId
    const csec = clientSecret
    setClientId("")
    setClientSecret("")
    setClient(def.id, cid, csec)
  }

  return (
    <>
      {configured && (
        <div className="connector-client-configured" data-testid={`connector-client-badge-${def.id}`}>
          <span>✓ OAuth client configured</span>
          <Button
            label={editOpen ? "Close" : "Edit"}
            size="sm"
            className="connector-btn"
            data-testid={`connector-client-edit-toggle-${def.id}`}
            onClick={() => store.dispatch({ type: "client-edit-toggled", defId: def.id })}
          />
        </div>
      )}

      {(!configured || editOpen) && (
        <div className="connector-client-setup" data-testid={`connector-client-setup-${def.id}`} onClick={handleLinkClick}>
          {isGoogle ? (
            <div className="connector-client-explainer">
              <span>
                Uses <strong>your own</strong> Google OAuth client (Desktop app). One-time setup, about 10 minutes:
              </span>
              <ol className="connector-setup-steps">
                <li>
                  Open <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener noreferrer">Google Cloud Console</a> and create a project.
                </li>
                <li>
                  Enable <a href="https://console.cloud.google.com/apis/library/gmail.googleapis.com" target="_blank" rel="noopener noreferrer">Gmail</a>,{" "}
                  <a href="https://console.cloud.google.com/apis/library/calendar-json.googleapis.com" target="_blank" rel="noopener noreferrer">Calendar</a>, and{" "}
                  <a href="https://console.cloud.google.com/apis/library/drive.googleapis.com" target="_blank" rel="noopener noreferrer">Drive</a> APIs.
                </li>
                <li>
                  OAuth consent screen → External → <strong>Publish to Production</strong> (Testing mode refresh tokens die every 7 days).
                </li>
                <li>
                  Credentials → Create OAuth client ID → <strong>Desktop app</strong>.
                </li>
                <li>Paste the Client ID and secret below.</li>
              </ol>
              <div style={{ marginTop: 6 }}>
                First Connect shows Google's unverified-app warning once - Advanced → "Go to &lt;app&gt;" is the sanctioned
                personal-use path. Workspace org accounts may block unverified apps; use a personal Gmail if so. Full
                guide: docs/connectors-google-oauth-setup.md
              </div>
            </div>
          ) : (
            <div className="connector-client-explainer">
              Uses YOUR own OAuth client. Create a Desktop-app client with the provider, then paste it here.
            </div>
          )}

          <TextInput
            label="Client ID"
            size="sm"
            placeholder="e.g. 123456789-abc.apps.googleusercontent.com"
            value={clientId}
            onChange={setClientId}
            data-testid={`connector-client-id-${def.id}`}
          />
          <TextInput
            label="Client secret"
            size="sm"
            type="password"
            placeholder="Google issues one - paste it too"
            value={clientSecret}
            onChange={setClientSecret}
            data-testid={`connector-client-secret-${def.id}`}
          />
          <Button
            label="Save client"
            size="sm"
            className="connector-btn"
            data-testid={`connector-client-save-${def.id}`}
            onClick={handleSave}
          />
        </div>
      )}
    </>
  )
}

function ConsentSheet({
  def,
  draft,
  store,
  connectOauth,
  connectPlain,
}: {
  def: ConnectorDefinition
  draft: { label?: string; caps?: readonly string[]; secretRef?: string }
  store: Store
  connectOauth: (def: ConnectorDefinition, capabilityIds: string[], label: string) => void
  connectPlain: (def: ConnectorDefinition, capabilityIds: string[], secretRef: string, label: string) => void
}) {
  const caps = def.capabilities || []
  const draftCapsSet = draft.caps ? new Set(draft.caps) : null

  function checkedFor(capId: string, defaultGranted: boolean | undefined): boolean {
    return draftCapsSet ? draftCapsSet.has(capId) : !!defaultGranted
  }

  function toggleCap(capId: string, checked: boolean): void {
    const current = new Set(draftCapsSet ?? caps.filter((c) => c.defaultGranted).map((c) => c.id))
    if (checked) current.add(capId)
    else current.delete(capId)
    store.dispatch({ type: "draft-caps-changed", defId: def.id, caps: Array.from(current) })
  }

  function handleGo(): void {
    const capabilityIds = caps.filter((c) => checkedFor(c.id, c.defaultGranted)).map((c) => c.id)
    const accountLabel = (draft.label ?? "").trim() || def.name
    if (def.authKind === "oauth2") {
      connectOauth(def, capabilityIds, accountLabel)
    } else {
      connectPlain(def, capabilityIds, (draft.secretRef ?? "").trim(), accountLabel)
    }
  }

  return (
    <div className="connector-consent" data-testid={`connector-consent-${def.id}`}>
      <TextInput
        label="Account label"
        size="sm"
        placeholder="e.g. personal, flowstay"
        value={draft.label ?? ""}
        onChange={(value) => store.dispatch({ type: "draft-label-changed", defId: def.id, value })}
        data-testid={`connector-label-input-${def.id}`}
      />

      {caps.map((cap) => (
        <CheckboxInput
          key={cap.id}
          label={cap.label + (cap.scopes && cap.scopes.length ? " - " + cap.scopes.join(" ") : "")}
          value={checkedFor(cap.id, cap.defaultGranted)}
          onChange={(checked) => toggleCap(cap.id, checked)}
          data-testid={`connector-cap-${def.id}-${cap.id}`}
        />
      ))}

      {def.authKind === "api-key" && (
        <TextInput
          label="Secret reference"
          isLabelHidden
          size="sm"
          placeholder="Secret ref, e.g. env:SLACK_MCP_XOXB_TOKEN (store the value via the Secrets tab first)"
          value={draft.secretRef ?? ""}
          onChange={(value) => store.dispatch({ type: "draft-secret-ref-changed", defId: def.id, value })}
          data-testid={`connector-secretref-input-${def.id}`}
        />
      )}

      <Button
        label={def.authKind === "oauth2" ? "Authorize in browser" : "Connect"}
        variant="primary"
        size="sm"
        className="connector-btn primary"
        data-testid={`connector-go-btn-${def.id}`}
        onClick={handleGo}
      />
    </div>
  )
}
