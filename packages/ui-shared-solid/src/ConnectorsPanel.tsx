/**
 * ConnectorsPanel — the Connectors settings section for the WEB client
 * (PRD Part A §17).
 *
 * Browser limitation (PRD §09): a web page cannot bind a 127.0.0.1
 * loopback to capture the OAuth redirect, so the full client-brokered
 * flow lives in the Moon desktop app. Here the web client:
 *   - lists the catalog + current connections (status, scopes)
 *   - connects API-KEY connectors (the secret is stored first via the
 *     Secrets flow; this sends only the POINTER)
 *   - disconnects anything
 *   - for OAuth connectors with no instance, shows an honest
 *     "connect from the Moon app" note instead of a dead button
 *
 * Multi-account: each definition may have N instances (one per label,
 * e.g. "personal" + "flowstay"). All are rendered as per-instance rows.
 *
 * onConnect/onDisconnect send the corresponding ClientFrames; the parent
 * gates rendering on capabilities.connectors.
 */
import { For, Show, createSignal, type Component } from "solid-js"
import type {
  ConnectorCatalogItem,
  ConnectorInstanceItem,
} from "@luna/ui-shared"

export interface ConnectorsPanelProps {
  readonly catalog: ReadonlyArray<ConnectorCatalogItem>
  readonly instances: ReadonlyArray<ConnectorInstanceItem>
  readonly onConnectApiKey: (
    definitionId: string,
    secretRef: string,
    capabilityIds: ReadonlyArray<string>,
    label?: string,
  ) => void
  readonly onDisconnect: (instanceId: string) => void
  readonly onSetClient?: (
    definitionId: string,
    clientId: string,
    clientSecret: string | undefined,
  ) => void
  readonly disabled?: boolean
  readonly lastError?: string | null
}

export const ConnectorsPanel: Component<ConnectorsPanelProps> = (props) => {
  const [openId, setOpenId] = createSignal<string | null>(null)
  // Definition whose OAuth-client edit form is open even though configured —
  // the recovery path for a wrong/half-written credential (review M2.6).
  const [editClientId, setEditClientId] = createSignal<string | null>(null)

  /** All instances for a given definition, in insertion order. */
  const instancesFor = (defId: string) =>
    props.instances.filter((i) => i.definitionId === defId)

  return (
    <div class="skills-panel">
      <div class="skills-head">
        <span class="skills-title">Connectors</span>
      </div>
      <Show when={props.lastError}>
        <div class="skills-error" role="alert">
          {props.lastError}
        </div>
      </Show>
      <div class="skills-list">
        <For
          each={props.catalog}
          fallback={<div class="skills-empty">No connectors available.</div>}
        >
          {(def) => {
            const instances = () => instancesFor(def.id)
            const hasInstances = () => instances().length > 0
            return (
              <div classList={{ "skill-row": true, off: !hasInstances() }}>
                <div class="skill-meta">
                  <span class="skill-name">{def.name}</span>
                  <span class="skill-desc">{def.blurb}</span>
                </div>

                {/* Per-instance rows (one per label) */}
                <For each={instances()}>
                  {(i) => (
                    <div
                      style={{
                        // Full-width break inside the flex-row tile (review C1
                        // #12): without it the stacked rows render on one
                        // squashed horizontal line. Matches the forms' idiom.
                        flex: "0 0 100%",
                        display: "flex",
                        gap: "6px",
                        "align-items": "center",
                        "margin-top": "4px",
                      }}
                    >
                      <span class="skill-desc" style={{ flex: "1" }}>
                        {i.label}
                      </span>
                      <span
                        class={`skill-badge ${i.status === "needs-reauth" ? "src-user" : "cat"}`}
                      >
                        {i.status}
                      </span>
                      <button
                        type="button"
                        disabled={props.disabled === true}
                        onClick={() => props.onDisconnect(i.id)}
                      >
                        Disconnect
                      </button>
                    </div>
                  )}
                </For>

                {/* Connect / Add account controls */}
                <div style={{ display: "flex", gap: "6px", "align-items": "center", "margin-top": hasInstances() ? "6px" : undefined }}>
                  <Show
                    when={def.authKind === "api-key"}
                    fallback={
                      /* OAuth2: always show Moon hint + optional clientSetup */
                      <Show
                        when={def.clientSetup === undefined || def.clientSetup.configured === true}
                        fallback={null}
                      >
                        <Show when={def.clientSetup?.configured === true}>
                          <span class="skill-desc" style={{ color: "var(--ok, #4caf50)", "font-size": "0.8em" }}>
                            ✓ OAuth client configured
                          </span>
                          <button
                            type="button"
                            class="chip small"
                            disabled={props.disabled === true}
                            onClick={() =>
                              setEditClientId(editClientId() === def.id ? null : def.id)
                            }
                            title="Re-enter the OAuth client credentials"
                          >
                            {editClientId() === def.id ? "close" : "edit"}
                          </button>
                        </Show>
                        <span class="skill-desc" style={{ "max-width": "160px" }}>
                          Connect from the Moon app
                        </span>
                      </Show>
                    }
                  >
                    {/* API-key connector: "Connect" (0 instances) or "Add account" (≥1) */}
                    <button
                      type="button"
                      disabled={props.disabled === true}
                      onClick={() =>
                        setOpenId(openId() === def.id ? null : def.id)
                      }
                    >
                      {openId() === def.id
                        ? "Cancel"
                        : hasInstances()
                          ? "Add account"
                          : "Connect"}
                    </button>
                  </Show>
                </div>

                {/* API-key connect form (open regardless of existing instances) */}
                <Show when={openId() === def.id && def.authKind === "api-key"}>
                  <ApiKeyConnectForm
                    def={def}
                    onSubmit={(ref, caps, label) => {
                      props.onConnectApiKey(def.id, ref, caps, label)
                      setOpenId(null)
                    }}
                  />
                </Show>

                {/* OAuth client setup form (unconfigured, or edit mode) */}
                <Show
                  when={
                    def.clientSetup !== undefined &&
                    (def.clientSetup.configured === false || editClientId() === def.id)
                  }
                >
                  <OAuthClientSetupForm
                    def={def}
                    disabled={props.disabled === true}
                    onSubmit={(clientId, clientSecret) => {
                      props.onSetClient?.(def.id, clientId, clientSecret)
                      setEditClientId(null)
                    }}
                  />
                </Show>
              </div>
            )
          }}
        </For>
      </div>
    </div>
  )
}

const OAuthClientSetupForm: Component<{
  def: ConnectorCatalogItem
  disabled: boolean
  onSubmit: (clientId: string, clientSecret: string | undefined) => void
}> = (props) => {
  const [clientId, setClientId] = createSignal("")
  const [clientSecret, setClientSecret] = createSignal("")

  const handleSubmit = () => {
    const id = clientId().trim()
    if (id.length === 0) return
    const secret = clientSecret().trim()
    props.onSubmit(id, secret.length > 0 ? secret : undefined)
    setClientId("")
    setClientSecret("")
  }

  return (
    <div
      style={{
        flex: "0 0 100%",
        display: "flex",
        "flex-direction": "column",
        gap: "6px",
        "margin-top": "6px",
      }}
    >
      <span class="skill-desc" style={{ "line-height": "1.4" }}>
        This connector uses YOUR own Google OAuth client. Create one in the
        Google Cloud Console (Desktop app), then paste it here.
      </span>
      <input
        type="text"
        placeholder="Client ID (required)"
        value={clientId()}
        disabled={props.disabled}
        onInput={(e) => setClientId(e.currentTarget.value)}
      />
      {/* Google's token endpoint requires the secret even for Desktop-app
          clients (review M2.6) — only omit it if your provider issues none. */}
      <input
        type="password"
        placeholder="Client secret (Google issues one — paste it too)"
        value={clientSecret()}
        disabled={props.disabled}
        onInput={(e) => setClientSecret(e.currentTarget.value)}
      />
      <button
        type="button"
        disabled={props.disabled || clientId().trim().length === 0}
        onClick={handleSubmit}
      >
        Save client
      </button>
    </div>
  )
}

const ApiKeyConnectForm: Component<{
  def: ConnectorCatalogItem
  onSubmit: (secretRef: string, capabilityIds: ReadonlyArray<string>, label: string | undefined) => void
}> = (props) => {
  const [ref, setRef] = createSignal("")
  const [label, setLabel] = createSignal("")
  const [granted, setGranted] = createSignal<ReadonlyArray<string>>(
    props.def.capabilities.filter((c) => c.defaultGranted).map((c) => c.id),
  )
  const toggle = (id: string) =>
    setGranted((g) => (g.includes(id) ? g.filter((x) => x !== id) : [...g, id]))

  return (
    <div
      style={{
        flex: "0 0 100%",
        display: "flex",
        "flex-direction": "column",
        gap: "6px",
        "margin-top": "6px",
      }}
    >
      <input
        type="text"
        placeholder="Account label (e.g. personal, flowstay)"
        value={label()}
        onInput={(e) => setLabel(e.currentTarget.value)}
      />
      <For each={props.def.capabilities}>
        {(cap) => (
          <label class="toggle">
            <input
              type="checkbox"
              checked={granted().includes(cap.id)}
              onChange={() => toggle(cap.id)}
            />
            <span>{cap.label}</span>
          </label>
        )}
      </For>
      <input
        type="text"
        placeholder="Secret ref, e.g. env:SLACK_MCP_XOXB_TOKEN"
        value={ref()}
        onInput={(e) => setRef(e.currentTarget.value)}
      />
      <button
        type="button"
        disabled={ref().trim().length === 0}
        onClick={() => {
          const trimmedLabel = label().trim()
          props.onSubmit(ref().trim(), granted(), trimmedLabel.length > 0 ? trimmedLabel : undefined)
        }}
      >
        Connect
      </button>
    </div>
  )
}
