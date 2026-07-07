// connectors-panel.jsx - the Connectors settings section for Luna Studio
// (React port of packages/ui-shared-solid/src/ConnectorsPanel.tsx, PRD Part A
// section 17).
//
// Browser limitation (PRD section 09): a web page cannot bind a 127.0.0.1
// loopback to capture the OAuth redirect, so the full client-brokered flow
// lives in the Moon desktop app. Here the web client:
//   - lists the catalog + current connections (status, scopes)
//   - connects API-KEY connectors (the secret is stored first via the
//     Secrets flow; this sends only the POINTER, never the raw secret)
//   - disconnects anything
//   - for OAuth connectors with no instance, shows an honest
//     "connect from the Moon app" note instead of a dead button
//
// Multi-account: each definition may have N instances (one per label, e.g.
// "personal" + "flowstay"). All are rendered as per-instance rows.
//
// Capability gating: the parent (Studio's panel DEFS) gates on
// `state.capabilities.connectors === true` before ever summoning this panel,
// mirroring the old Solid App's `<Show when={state.capabilities.connectors}>`.
// This component ALSO guards its own body via the `enabled` prop so a stray
// summon (or a capability that flips false mid-session on reconnect) fails
// soft into a note instead of rendering half-wired connect/disconnect
// controls against a server that never advertised the feature.
//
// Nothing here ever renders a secret value: API-key forms only take a
// `secretRef` pointer (e.g. "env:SLACK_MCP_XOXB_TOKEN"), and the OAuth client
// secret field is a plain password input that is sent up and never echoed
// back or displayed. All server/user strings are rendered as text via JSX
// child expressions (React escapes these) - there is no
// dangerouslySetInnerHTML anywhere in this file.
import React, { useState } from "react";

// ---------------------------------------------------------------------------
// Frame shapes (see packages/ui-ws/src/protocol.ts; mirrored in
// packages/ui-shared/src/wire.ts). This file is plain JS/JSX so these are
// documentation, not enforced types - the parent is responsible for actually
// sending well-formed ClientFrames.
//
// ConnectorConnectFrame (protocol.ts ~L533):
//   { type: "connector-connect", requestId: string, definitionId: string,
//     label: string, secretRef?: string, capabilityIds?: string[] }
// ConnectorDisconnectFrame (protocol.ts ~L543):
//   { type: "connector-disconnect", instanceId: string }
// ConnectorSetClientFrame (protocol.ts ~L550):
//   { type: "connector-set-client", requestId: string, definitionId: string,
//     clientId: string, clientSecret?: string }
//
// ConnectorCatalogItem / ConnectorInstanceItem: @luna/ui-shared/core.
// ---------------------------------------------------------------------------

/**
 * @param {object} props
 * @param {ReadonlyArray<import("@luna/ui-shared/core").ConnectorCatalogItem>} props.catalog
 * @param {ReadonlyArray<import("@luna/ui-shared/core").ConnectorInstanceItem>} props.instances
 * @param {(definitionId: string, secretRef: string, capabilityIds: ReadonlyArray<string>, label?: string) => void} props.onConnectApiKey
 * @param {(instanceId: string) => void} props.onDisconnect
 * @param {(definitionId: string, clientId: string, clientSecret: string | undefined) => void} [props.onSetClient]
 * @param {boolean} [props.disabled]
 * @param {string | null} [props.lastError]
 * @param {boolean} [props.enabled] - false when the server hasn't advertised
 *   `capabilities.connectors`; renders a soft fallback instead of the panel.
 */
export default function ConnectorsPanel({
  catalog = [],
  instances = [],
  onConnectApiKey,
  onDisconnect,
  onSetClient,
  disabled = false,
  lastError = null,
  enabled = true,
}) {
  // Definition whose API-key connect/add-account form is open.
  const [openId, setOpenId] = useState(null);
  // Definition whose OAuth-client edit form is open even though already
  // configured - the recovery path for a wrong/half-written credential
  // (review M2.6).
  const [editClientId, setEditClientId] = useState(null);

  if (!enabled) {
    return (
      <div className="cnx-panel">
        <div className="cnx-head">
          <span className="cnx-title">Connectors</span>
        </div>
        <div className="cnx-empty">Connectors aren't available on this server yet.</div>
      </div>
    );
  }

  /** All instances for a given definition, in insertion order. */
  const instancesFor = (defId) => instances.filter((i) => i.definitionId === defId);

  return (
    <div className="cnx-panel">
      <div className="cnx-head">
        <span className="cnx-title">Connectors</span>
      </div>

      {lastError && (
        <div className="cnx-error" role="alert">
          {lastError}
        </div>
      )}

      <div className="cnx-list">
        {catalog.length === 0 && <div className="cnx-empty">No connectors available.</div>}

        {catalog.map((def) => {
          const defInstances = instancesFor(def.id);
          const hasInstances = defInstances.length > 0;
          const oauthHintVisible =
            def.authKind !== "api-key" &&
            (def.clientSetup === undefined || def.clientSetup.configured === true);
          const showApiKeyForm = openId === def.id && def.authKind === "api-key";
          const showClientSetupForm =
            def.clientSetup !== undefined &&
            (def.clientSetup.configured === false || editClientId === def.id);

          return (
            <div key={def.id} className={"cnx-def" + (hasInstances ? "" : " off")}>
              <div className="cnx-def-meta">
                <span className="cnx-def-name">{def.name}</span>
                <span className="cnx-def-desc">{def.blurb}</span>
              </div>

              {/* Per-instance rows (one per label) */}
              {defInstances.map((i) => (
                <div key={i.id} className="cnx-instance">
                  <span className="cnx-instance-label">{i.label}</span>
                  <span className={"cnx-badge cnx-badge-" + i.status}>{i.status}</span>
                  <button
                    type="button"
                    className="ghost-btn cnx-danger"
                    disabled={disabled === true}
                    onClick={() => onDisconnect(i.id)}
                  >
                    Disconnect
                  </button>
                </div>
              ))}

              {/* Connect / Add account controls */}
              <div className={"cnx-controls" + (hasInstances ? " with-instances" : "")}>
                {def.authKind === "api-key" ? (
                  // API-key connector: "Connect" (0 instances) or "Add
                  // account" (>=1 instances already connected).
                  <button
                    type="button"
                    className="ghost-btn"
                    disabled={disabled === true}
                    onClick={() => setOpenId((cur) => (cur === def.id ? null : def.id))}
                  >
                    {openId === def.id ? "Cancel" : hasInstances ? "Add account" : "Connect"}
                  </button>
                ) : (
                  // OAuth2: always show the Moon hint (unless a client-setup
                  // form is required and not yet configured - that form takes
                  // over below instead of this honest dead-end note).
                  oauthHintVisible && (
                    <>
                      {def.clientSetup?.configured === true && (
                        <>
                          <span className="cnx-client-ok">&#10003; OAuth client configured</span>
                          <button
                            type="button"
                            className="chip small"
                            disabled={disabled === true}
                            title="Re-enter the OAuth client credentials"
                            onClick={() =>
                              setEditClientId((cur) => (cur === def.id ? null : def.id))
                            }
                          >
                            {editClientId === def.id ? "close" : "edit"}
                          </button>
                        </>
                      )}
                      <span className="cnx-def-desc cnx-moon-hint">Connect from the Moon app</span>
                    </>
                  )
                )}
              </div>

              {/* API-key connect form (open regardless of existing instances) */}
              {showApiKeyForm && (
                <ApiKeyConnectForm
                  def={def}
                  onSubmit={(ref, caps, label) => {
                    onConnectApiKey(def.id, ref, caps, label);
                    setOpenId(null);
                  }}
                />
              )}

              {/* OAuth client setup form (unconfigured, or edit mode) */}
              {showClientSetupForm && (
                <OAuthClientSetupForm
                  def={def}
                  disabled={disabled === true}
                  onSubmit={(clientId, clientSecret) => {
                    onSetClient?.(def.id, clientId, clientSecret);
                    setEditClientId(null);
                  }}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * @param {object} props
 * @param {import("@luna/ui-shared/core").ConnectorCatalogItem} props.def
 * @param {boolean} props.disabled
 * @param {(clientId: string, clientSecret: string | undefined) => void} props.onSubmit
 */
function OAuthClientSetupForm({ def, disabled, onSubmit }) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");

  function handleSubmit() {
    const id = clientId.trim();
    if (id.length === 0) return;
    const secret = clientSecret.trim();
    onSubmit(id, secret.length > 0 ? secret : undefined);
    setClientId("");
    setClientSecret("");
  }

  return (
    <div className="cnx-form">
      <span className="cnx-def-desc cnx-form-hint">
        This connector uses YOUR own Google OAuth client. Create one in the Google Cloud Console
        (Desktop app), then paste it here.
      </span>
      <input
        type="text"
        className="cnx-input"
        placeholder="Client ID (required)"
        value={clientId}
        disabled={disabled}
        onChange={(e) => setClientId(e.target.value)}
      />
      {/* Google's token endpoint requires the secret even for Desktop-app
          clients (review M2.6) - only omit it if your provider issues none. */}
      <input
        type="password"
        className="cnx-input"
        placeholder="Client secret (Google issues one - paste it too)"
        value={clientSecret}
        disabled={disabled}
        onChange={(e) => setClientSecret(e.target.value)}
      />
      <button
        type="button"
        className="cnx-primary-btn"
        disabled={disabled || clientId.trim().length === 0}
        onClick={handleSubmit}
      >
        Save client
      </button>
    </div>
  );
}

/**
 * @param {object} props
 * @param {import("@luna/ui-shared/core").ConnectorCatalogItem} props.def
 * @param {(secretRef: string, capabilityIds: ReadonlyArray<string>, label: string | undefined) => void} props.onSubmit
 */
function ApiKeyConnectForm({ def, onSubmit }) {
  const [ref, setRef] = useState("");
  const [label, setLabel] = useState("");
  // Seeded once from the definition's default-granted capabilities, same as
  // the Solid original's createSignal(initial) - it does not re-derive if
  // `def` changes later, since the form only lives while open for one def.
  const [granted, setGranted] = useState(() =>
    def.capabilities.filter((c) => c.defaultGranted).map((c) => c.id),
  );

  function toggle(id) {
    setGranted((g) => (g.includes(id) ? g.filter((x) => x !== id) : [...g, id]));
  }

  return (
    <div className="cnx-form">
      <input
        type="text"
        className="cnx-input"
        placeholder="Account label (e.g. personal, flowstay)"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
      />
      {def.capabilities.map((cap) => (
        <label key={cap.id} className="toggle cnx-cap-toggle">
          <input type="checkbox" checked={granted.includes(cap.id)} onChange={() => toggle(cap.id)} />
          <span>{cap.label}</span>
        </label>
      ))}
      <input
        type="text"
        className="cnx-input"
        placeholder="Secret ref, e.g. env:SLACK_MCP_XOXB_TOKEN"
        value={ref}
        onChange={(e) => setRef(e.target.value)}
      />
      <button
        type="button"
        className="cnx-primary-btn"
        disabled={ref.trim().length === 0}
        onClick={() => {
          const trimmedLabel = label.trim();
          onSubmit(ref.trim(), granted, trimmedLabel.length > 0 ? trimmedLabel : undefined);
        }}
      >
        Connect
      </button>
    </div>
  );
}
