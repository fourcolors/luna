// connectors-panel.jsx - the Connectors settings section for Luna Studio
// (React port of packages/ui-shared-solid/src/ConnectorsPanel.tsx, PRD Part A
// section 17). Astryx-ified: per-instance status pill -> Astryx Badge,
// action buttons -> Astryx Button, form inputs -> Astryx TextInput, capability
// toggles -> Astryx CheckboxInput. Layout wrappers (cnx-panel/cnx-def/
// cnx-instance/cnx-form/etc.) stay hand-rolled - Astryx has no list/card
// primitive that maps onto this per-definition/per-instance grouping without
// fighting the existing devops-panels.css layout.
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
// back or displayed. Both secret-shaped fields stay uncontrolled-by-Astryx
// beyond the same controlled-value contract the native inputs had (value +
// onChange into local useState, cleared on submit) - Astryx's TextInput does
// not introduce any caching/autofill layer of its own, it's a styled
// passthrough onto a native <input>. All server/user strings are rendered as
// text via JSX child expressions (React escapes these) - there is no
// dangerouslySetInnerHTML anywhere in this file.
import React, { useState } from "react";
import { TextInput, Badge, Button, CheckboxInput } from "./astryx-kit.tsx";

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

/** Instance status -> Astryx Badge variant. */
const STATUS_BADGE_VARIANT = {
  connected: "success",
  "needs-reauth": "warning",
  error: "error",
  disconnected: "neutral",
};

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
                  <Badge variant={STATUS_BADGE_VARIANT[i.status] ?? "neutral"} label={i.status} />
                  <Button
                    label="Disconnect"
                    variant="destructive"
                    size="sm"
                    isDisabled={disabled === true}
                    clickAction={() => onDisconnect(i.id)}
                  />
                </div>
              ))}

              {/* Connect / Add account controls */}
              <div className={"cnx-controls" + (hasInstances ? " with-instances" : "")}>
                {def.authKind === "api-key" ? (
                  // API-key connector: "Connect" (0 instances) or "Add
                  // account" (>=1 instances already connected).
                  <Button
                    label={openId === def.id ? "Cancel" : hasInstances ? "Add account" : "Connect"}
                    variant="secondary"
                    size="sm"
                    isDisabled={disabled === true}
                    clickAction={() => setOpenId((cur) => (cur === def.id ? null : def.id))}
                  />
                ) : (
                  // OAuth2: always show the Moon hint (unless a client-setup
                  // form is required and not yet configured - that form takes
                  // over below instead of this honest dead-end note).
                  oauthHintVisible && (
                    <>
                      {def.clientSetup?.configured === true && (
                        <>
                          <span className="cnx-client-ok">&#10003; OAuth client configured</span>
                          <Button
                            label={editClientId === def.id ? "close" : "edit"}
                            variant="ghost"
                            size="sm"
                            isDisabled={disabled === true}
                            tooltip="Re-enter the OAuth client credentials"
                            clickAction={() =>
                              setEditClientId((cur) => (cur === def.id ? null : def.id))
                            }
                          />
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
      <TextInput
        type="text"
        label="Client ID"
        isLabelHidden
        placeholder="Client ID (required)"
        value={clientId}
        isDisabled={disabled}
        onChange={setClientId}
      />
      {/* Google's token endpoint requires the secret even for Desktop-app
          clients (review M2.6) - only omit it if your provider issues none.
          Plain password input, sent up on submit and cleared - never echoed
          back or held anywhere beyond this form's own local state. */}
      <TextInput
        type="password"
        label="Client secret"
        isLabelHidden
        placeholder="Client secret (Google issues one - paste it too)"
        value={clientSecret}
        isDisabled={disabled}
        onChange={setClientSecret}
      />
      <Button
        label="Save client"
        variant="primary"
        size="sm"
        isDisabled={disabled || clientId.trim().length === 0}
        clickAction={handleSubmit}
      />
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
      <TextInput
        type="text"
        label="Account label"
        isLabelHidden
        placeholder="Account label (e.g. personal, flowstay)"
        value={label}
        onChange={setLabel}
      />
      {def.capabilities.map((cap) => (
        <CheckboxInput
          key={cap.id}
          label={cap.label}
          size="sm"
          value={granted.includes(cap.id)}
          onChange={() => toggle(cap.id)}
        />
      ))}
      {/* Secret POINTER only - e.g. "env:SLACK_MCP_XOXB_TOKEN". The raw
          secret is never entered here; it's stored first via the Secrets
          flow and only its reference travels through this form/state. */}
      <TextInput
        type="text"
        label="Secret ref"
        isLabelHidden
        placeholder="Secret ref, e.g. env:SLACK_MCP_XOXB_TOKEN"
        value={ref}
        onChange={setRef}
      />
      <Button
        label="Connect"
        variant="primary"
        size="sm"
        isDisabled={ref.trim().length === 0}
        clickAction={() => {
          const trimmedLabel = label.trim();
          onSubmit(ref.trim(), granted, trimmedLabel.length > 0 ? trimmedLabel : undefined);
        }}
      />
    </div>
  );
}
