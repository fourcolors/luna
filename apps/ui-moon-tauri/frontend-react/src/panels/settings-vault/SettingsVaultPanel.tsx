/**
 * SettingsVaultPanel.tsx - React 19 + Astryx port of
 * frontend/panels/settings-vault.js (registered there as
 * `LunaPanelTypes['settings.vault']`) - the Vault credential registry (Luna
 * Vault V1).
 *
 * WS-backed: connects via ctx.connectWs, gates on the hello frame's
 * `capabilities.vault` flag (read off the shared store - see below).
 * Capability present → the Vault credential registry (list is METADATA +
 * POINTERS only - `vault-list` never carries values) + add form + 1Password
 * sync section. Capability absent (old server, or none yet - pre-hello
 * matches the hub markup's default state) → the legacy op-token-only form,
 * behavior-identical to the old Secrets tab.
 *
 * SECURITY - unchanged from the vanilla module (see its own SECURITY doc
 * comment): a typed secret lives in exactly one place, a controlled React
 * input bound to vaultReducer.ts's `valueInput` (or `opTokenInput` for the
 * legacy form) state, and only until the OPEN-guarded send. It is wiped
 * one-shot on submit (see "submit-add-started"/"op-submit-started" in the
 * reducer) and on socket close (the `registerCloseHook` seam - "socket-closed"
 * clears both). Secrets are NEVER logged and never rendered anywhere except
 * that one controlled input's value - every WS frame handler below only ever
 * calls `localDispatch(...)` or `store.dispatch(...)`, never a direct DOM
 * write, so a secret can never leak into a place other than that input.
 *
 * STATE SPLIT: `vaultItems`/`vaultSync`/`vaultStorage`/`capabilities` are
 * shared domain state - read via useMoonSelector off useMoonStore() exactly
 * like SettingsSkillsPanel.tsx's `skills`/`skillError` (packages/ui-shared/
 * src/reducer.ts's "vault-list" case already exists; no reducer changes were
 * needed for this conversion). Everything else (the add form, the two-step
 * delete confirm, the sync form's editable fields, the legacy op-token form,
 * and every in-flight requestId slot) is panel-local - see vaultReducer.ts's
 * module doc for the full rationale.
 *
 * Astryx mapping: TextInput (text/password) for every text field, Button for
 * every action, SegmentedControl for the 2-way kind choice (env-secret vs.
 * op-token - same "plain-text single-select row" precedent
 * SettingsAppearancePanel.tsx documents for SegmentedControl over a native
 * `<select>`), Switch for the sync-enabled toggle, NumberInput for the poll-
 * seconds field (deliberately given no `min` - the floor is enforced only at
 * submit time, exactly like the vanilla module's `Math.max(60, pollRaw)`, so
 * a below-floor value can still be typed and then clamped on save - see the
 * covering test), Badge for the kind/source/synced/shadowed chips.
 */
import { useEffect, useRef } from "react"
import type { Action } from "@luna/ui-shared/core"
import { Badge, Button, NumberInput, SegmentedControl, SegmentedControlItem, Switch, TextInput } from "../../astryx-kit"
import { useLocalStore, useMoonSelector, useMoonStore } from "../../state/store"
import type { LunaFrameRegistry, LunaWsClient, PanelCtx } from "../panel-ctx"
import {
  effectiveVarName,
  initialVaultPanelState,
  newReqId,
  reduceVaultPanel,
  storageLineText,
  type VaultKind,
  type VaultPanelAction,
  type VaultPanelState,
  type VaultSyncLike,
} from "./vaultReducer"
import "./settings-vault.css"

/** Consumed by the panel-type registry (settings-vault-mount.tsx) to set
 *  bar-title / document.title, mirroring the vanilla module's `title: 'Vault'`. */
export const SETTINGS_VAULT_TITLE = "Vault"

declare global {
  interface Window {
    LunaWS?: { createFrameRegistry: () => LunaFrameRegistry }
  }
}

const KIND_BADGE: Record<string, string> = { "env-secret": "API key", "op-token": "1P token", "op-item": "1P item" }
const SOURCE_LABEL: Record<string, string> = {
  manual: "added by you",
  agent: "added by Luna",
  "1password": "from 1Password",
  "apple-import": "Apple import",
}

interface VaultItem {
  readonly id: string
  readonly name: string
  readonly kind: string
  readonly ref: string
  readonly source: string
  readonly description: string | null
  readonly synced: boolean
  readonly shadowed: boolean
}

function socketOpen(client: LunaWsClient | null): boolean {
  const sock = client?.socket() as { readyState?: number } | null | undefined
  const OPEN = typeof WebSocket !== "undefined" && (WebSocket as unknown as { OPEN?: number }).OPEN !== undefined
    ? (WebSocket as unknown as { OPEN: number }).OPEN
    : 1
  return !!(sock && sock.readyState === OPEN)
}

/** Read a hello frame's `capabilities.vault` flag - mirrors
 *  vendor/moon-protocol.js's parseHelloCapabilities: absent/falsy on older
 *  servers coerces to false (fail-closed), never throws on a malformed frame. */
function helloHasVault(frame: unknown): boolean {
  const f = frame as { capabilities?: { vault?: unknown } } | null | undefined
  return !!(f && f.capabilities && f.capabilities.vault)
}

export function SettingsVaultPanel({ ctx }: { ctx: PanelCtx }) {
  const store = useMoonStore()
  const capabilities = useMoonSelector(store, (s) => s.capabilities)
  const vaultItems = useMoonSelector(store, (s) => s.vaultItems) as ReadonlyArray<VaultItem>
  const vaultSync = useMoonSelector(store, (s) => s.vaultSync)
  const vaultStorage = useMoonSelector(store, (s) => s.vaultStorage)
  const vaultSupported = !!capabilities.vault

  const local = useLocalStore<VaultPanelState, VaultPanelAction>(reduceVaultPanel, initialVaultPanelState())
  const state = useMoonSelector(local, (s) => s)

  const wsClientRef = useRef<LunaWsClient | null>(null)

  useEffect(() => {
    if (!ctx.connectWs || !window.LunaWS) return
    const registry = window.LunaWS.createFrameRegistry()

    registry.register("hello", (frame) => {
      store.dispatch(frame as Action)
      if (!helloHasVault(frame)) local.dispatch({ type: "capability-lost" })
    })

    registry.register("vault-list", (frame) => {
      store.dispatch(frame as Action)
      const f = frame as { items?: ReadonlyArray<{ id?: unknown }>; sync?: VaultSyncLike }
      local.dispatch({ type: "vault-list-received", items: Array.isArray(f.items) ? f.items : [] })
      local.dispatch({ type: "sync-list-received", sync: f.sync ?? null })
    })

    registry.register("vault-status", (frame) => {
      local.dispatch({ type: "vault-status-received", frame: frame as { requestId?: unknown; ok?: unknown; message?: unknown } })
    })

    registry.register("register-op-token-status", (frame) => {
      local.dispatch({ type: "op-status-received", frame: frame as { requestId?: unknown; ok?: unknown; message?: unknown } })
    })

    const client = ctx.connectWs(registry, {})
    wsClientRef.current = client
    client.registerCloseHook(() => {
      local.dispatch({ type: "socket-closed" })
    })
    return () => {
      client.close()
      wsClientRef.current = null
    }
    // ctx/store/local are stable for this component's lifetime (one
    // connection per mount, matching the vanilla module's single
    // `ctx.connectWs` call in `render()`).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function submitAdd(): void {
    const name = state.name.trim()
    const kind: VaultKind = state.kind || "env-secret"
    const value = state.valueInput
    const description = state.descInput.trim()

    if (!name || name.length > 64) {
      local.dispatch({ type: "status-set", text: "Give it a name (1–64 characters).", kind: "error" })
      return
    }
    const frame: Record<string, unknown> = { type: "vault-put", name, kind }
    if (kind === "op-token") {
      frame.label = state.labelInput.trim() || "primary"
      if (!value.trim()) {
        local.dispatch({ type: "status-set", text: "Paste the ops_… token first.", kind: "error" })
        return
      }
    } else {
      const varName = effectiveVarName(state)
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(varName)) {
        local.dispatch({
          type: "status-set",
          text: "That name can’t become a key — add some letters, or set one under “change”.",
          kind: "error",
        })
        return
      }
      frame.varName = varName
      if (!value) {
        local.dispatch({ type: "status-set", text: "Paste the secret value first.", kind: "error" })
        return
      }
      if (/[\r\n]/.test(value)) {
        local.dispatch({ type: "status-set", text: "The value can’t contain line breaks.", kind: "error" })
        return
      }
    }
    if (description) frame.description = description

    if (!vaultSupported) {
      local.dispatch({ type: "status-set", text: "This server doesn't support the Vault.", kind: "error" })
      return
    }
    const client = wsClientRef.current
    if (!socketOpen(client)) {
      local.dispatch({ type: "status-set", text: "Not connected to a server.", kind: "error" })
      return
    }
    const rid = newReqId("vlt_")
    frame.requestId = rid
    frame.value = value // the ONLY frame a secret ever rides on
    if (!client!.send(frame)) {
      local.dispatch({ type: "status-set", text: "Not connected to a server.", kind: "error" })
      return
    }
    local.dispatch({ type: "submit-add-started", requestId: rid, isOpToken: kind === "op-token" })
  }

  function requestDelete(id: string): void {
    if (state.confirmId !== id) {
      local.dispatch({ type: "delete-armed", id })
      return
    }
    if (!vaultSupported) {
      local.dispatch({ type: "status-set", text: "This server doesn't support the Vault.", kind: "error" })
      return
    }
    const client = wsClientRef.current
    if (!socketOpen(client)) {
      local.dispatch({ type: "status-set", text: "Not connected to a server.", kind: "error" })
      return
    }
    const rid = newReqId("vlt_")
    client!.send({ type: "vault-delete", requestId: rid, id })
    local.dispatch({ type: "delete-started", requestId: rid })
  }

  function submitSyncConfig(): void {
    if (!vaultSupported) {
      local.dispatch({ type: "status-set", text: "This server doesn't support the Vault.", kind: "error" })
      return
    }
    const client = wsClientRef.current
    if (!socketOpen(client)) {
      local.dispatch({ type: "status-set", text: "Not connected to a server.", kind: "error" })
      return
    }
    const opVault = state.syncOpVault.trim() || "Luna"
    const pollSeconds = Math.max(60, state.syncPoll ?? 300)
    const rid = newReqId("vlt_")
    client!.send({
      type: "vault-sync-config",
      requestId: rid,
      enabled: state.syncEnabled,
      opLabel: state.syncOpLabel.trim(),
      opVault,
      pollSeconds,
    })
    local.dispatch({ type: "sync-save-started", requestId: rid })
  }

  /** Legacy op-token-only form (SettingsEngine.submitOpToken, ported 1:1) -
   *  no vault-capability gate (this form only shows pre-capability). */
  function submitOpToken(): void {
    const label = state.opLabelInput.trim() || "primary"
    const token = state.opTokenInput
    if (!token.trim()) {
      local.dispatch({ type: "op-status-set", text: "Enter a token first.", kind: "error" })
      return
    }
    const client = wsClientRef.current
    if (!socketOpen(client)) {
      local.dispatch({ type: "op-status-set", text: "Not connected to a server.", kind: "error" })
      return
    }
    const rid = newReqId("op_")
    if (!client!.send({ type: "register-op-token", requestId: rid, label, token })) {
      local.dispatch({ type: "op-status-set", text: "Not connected to a server.", kind: "error" })
      return
    }
    local.dispatch({ type: "op-submit-started", requestId: rid })
  }

  return (
    <div className="moon-astryx-root settings-vault-panel" data-testid="settings-vault-panel">
      <div id="vault-section" data-testid="vault-section" hidden={!vaultSupported}>
        <div className="vault-head">
          <span className="vault-label">Vault</span>
          <span className="vault-desc">
            Keys and tokens Luna can use. Values are stored safely on the server — once saved, they never appear here again.
          </span>
          {vaultStorage && (
            <span id="vault-storage-line" data-testid="vault-storage-line" className="vault-storage-line">
              {storageLineText(vaultStorage)}
            </span>
          )}
        </div>

        <div id="vault-list" data-testid="vault-list" className="sp-vault-list">
          {vaultItems.length === 0 ? (
            <span className="vault-desc">Nothing stored yet — add your first key below.</span>
          ) : (
            vaultItems.map((item) => (
              <div key={item.id} className={"vault-row" + (item.shadowed ? " shadowed" : "")} data-testid={`vault-row-${item.id}`}>
                <div className="skill-blot" />
                <div className="vault-row-info">
                  <span className="vault-row-name">
                    {item.name}
                    <Badge variant="neutral" label={KIND_BADGE[item.kind] || item.kind} data-testid={`vault-row-${item.id}-kind`} />
                    {item.synced && <span className="vault-chip synced" title="Synced with 1Password">1P</span>}
                    {item.shadowed && (
                      <span
                        className="vault-chip shadowed"
                        title="Defined by the server's environment — edits here won't take effect"
                      >
                        ⚠ shadowed
                      </span>
                    )}
                  </span>
                  <span className="vault-row-sub">
                    <code className="vault-ref">{item.ref}</code>
                    <span className="vault-source">{SOURCE_LABEL[item.source] || item.source}</span>
                  </span>
                  {item.description && <span className="skill-row-desc">{item.description}</span>}
                </div>
                <div className="connector-actions">
                  {state.confirmId === item.id ? (
                    <>
                      <span className="vault-confirm-note">
                        {item.kind === "op-token" ? "Remove? The server restarts." : "Remove this credential?"}
                      </span>
                      <Button label="Delete" variant="destructive" size="sm" onClick={() => requestDelete(item.id)} />
                      <Button label="Keep" variant="secondary" size="sm" onClick={() => local.dispatch({ type: "delete-cancelled" })} />
                    </>
                  ) : (
                    <Button label="Delete" variant="destructive" size="sm" onClick={() => requestDelete(item.id)} />
                  )}
                </div>
              </div>
            ))
          )}
        </div>

        <TextInput
          label="Name"
          isLabelHidden
          size="sm"
          placeholder="Name (e.g. Notion API Key)"
          value={state.name}
          onChange={(value) => local.dispatch({ type: "name-changed", value })}
          data-testid="vault-name-input"
        />

        <SegmentedControl
          label="Kind"
          value={state.kind}
          onChange={(value) => local.dispatch({ type: "kind-changed", value: value as VaultKind })}
          data-testid="vault-kind-select"
        >
          <SegmentedControlItem value="env-secret" label="API key / secret" data-testid="vault-kind-env-secret" />
          <SegmentedControlItem value="op-token" label="1Password service-account token" data-testid="vault-kind-op-token" />
        </SegmentedControl>

        {state.kind !== "op-token" && (
          <div id="vault-var-row" data-testid="vault-var-row" className="vault-var-row">
            <span className="vault-desc">
              Stored as <code id="vault-var-preview" data-testid="vault-var-preview" className="vault-ref">
                {effectiveVarName(state) || "ENV_VAR_NAME"}
              </code>
            </span>
            <Button
              label={state.varOverride ? "auto" : "change"}
              variant="secondary"
              size="sm"
              data-testid="vault-var-edit"
              onClick={() => local.dispatch({ type: "var-override-toggled" })}
            />
            {state.varOverride && (
              <TextInput
                label="Environment variable name"
                isLabelHidden
                size="sm"
                placeholder="ENV_VAR_NAME"
                value={state.varInput}
                onChange={(value) => local.dispatch({ type: "var-input-changed", value })}
                data-testid="vault-var-input"
              />
            )}
          </div>
        )}

        {state.kind === "op-token" && (
          <TextInput
            label="Account label"
            isLabelHidden
            size="sm"
            placeholder="Account label (e.g. primary)"
            value={state.labelInput}
            onChange={(value) => local.dispatch({ type: "label-input-changed", value })}
            data-testid="vault-label-input"
          />
        )}

        <TextInput
          label="Secret value"
          isLabelHidden
          size="sm"
          type="password"
          placeholder={state.kind === "op-token" ? "ops_… service-account token" : "Paste the secret value"}
          value={state.valueInput}
          onChange={(value) => local.dispatch({ type: "value-input-changed", value })}
          data-testid="vault-value-input"
        />

        <TextInput
          label="Note"
          isLabelHidden
          size="sm"
          placeholder="Note (optional)"
          value={state.descInput}
          onChange={(value) => local.dispatch({ type: "desc-input-changed", value })}
          data-testid="vault-desc-input"
        />

        {state.kind === "op-token" && (
          <span id="vault-restart-note" data-testid="vault-restart-note" className="vault-desc">
            Saving verifies the token and briefly restarts the server.
          </span>
        )}

        <div className="vault-inline">
          <Button label="Save to server" variant="primary" size="sm" data-testid="vault-add-btn" onClick={submitAdd} />
          <span
            id="vault-status-line"
            data-testid="vault-status-line"
            className={"vault-status" + (state.statusLine?.kind ? ` ${state.statusLine.kind}` : "")}
            hidden={!state.statusLine}
          >
            {state.statusLine?.text ?? ""}
          </span>
        </div>

        <div id="vault-sync-section" data-testid="vault-sync-section" className="vault-sync-section">
          <div className="vault-sync-header">
            <span className="vault-sync-label">1Password Sync</span>
            <span id="vault-sync-state" data-testid="vault-sync-state" className="vault-sync-state">
              {syncStateText(vaultSync)}
            </span>
          </div>
          {vaultSync?.lastError && (
            <span id="vault-sync-error" data-testid="vault-sync-error" className="vault-sync-error">
              {vaultSync.lastError}
            </span>
          )}
          <div id="vault-sync-fields" data-testid="vault-sync-fields" className="vault-sync-fields">
            <Switch
              label="Enable 1Password sync"
              value={state.syncEnabled}
              onChange={(checked) => local.dispatch({ type: "sync-enabled-toggled", checked })}
              data-testid="vault-sync-enabled"
            />
            <TextInput
              label="Service-account label"
              isLabelHidden
              size="sm"
              placeholder={opLabelPlaceholder(vaultItems)}
              value={state.syncOpLabel}
              onChange={(value) => local.dispatch({ type: "sync-op-label-changed", value })}
              data-testid="vault-sync-op-label"
            />
            <TextInput
              label="Vault name"
              isLabelHidden
              size="sm"
              placeholder="Vault name (e.g. Luna)"
              value={state.syncOpVault}
              onChange={(value) => local.dispatch({ type: "sync-op-vault-changed", value })}
              data-testid="vault-sync-op-vault"
            />
            <div className="vault-inline">
              <span className="vault-sync-helper">Poll every</span>
              <NumberInput
                label="Poll seconds"
                isLabelHidden
                size="sm"
                value={state.syncPoll}
                onChange={(value) => local.dispatch({ type: "sync-poll-changed", value })}
                data-testid="vault-sync-poll"
              />
              <span className="vault-sync-helper">seconds</span>
            </div>
            <span className="vault-sync-helper">Create this vault in 1Password and share it with your service account</span>
            <div className="vault-inline">
              <Button label="Save sync settings" variant="primary" size="sm" data-testid="vault-sync-save-btn" onClick={submitSyncConfig} />
              <span
                id="vault-sync-status"
                data-testid="vault-sync-status"
                className={"vault-status" + (state.syncStatus?.kind ? ` ${state.syncStatus.kind}` : "")}
                hidden={!state.syncStatus}
              >
                {state.syncStatus?.text ?? ""}
              </span>
            </div>
            {vaultSync?.enabled && (
              <span id="vault-sync-import-note" data-testid="vault-sync-import-note" className="vault-sync-import-note">
                Import Apple Passwords exports from the web client.
              </span>
            )}
          </div>
        </div>
      </div>

      <div id="legacy-op-token-section" data-testid="legacy-op-token-section" hidden={vaultSupported}>
        <div className="vault-head">
          <span className="vault-label">1Password Service Account</span>
          <span className="vault-desc">
            Send an <code className="vault-ref">ops_…</code> service-account token to the server securely. It is verified and
            stored on the server — never kept in chat history or on this device.
          </span>
        </div>
        <TextInput
          label="Account label"
          isLabelHidden
          size="sm"
          placeholder="Account label (e.g. primary)"
          value={state.opLabelInput}
          onChange={(value) => local.dispatch({ type: "op-label-input-changed", value })}
          data-testid="op-label-input"
        />
        <TextInput
          label="Service-account token"
          isLabelHidden
          size="sm"
          type="password"
          placeholder="ops_… service-account token"
          value={state.opTokenInput}
          onChange={(value) => local.dispatch({ type: "op-token-input-changed", value })}
          data-testid="op-token-input"
        />
        <div className="vault-inline">
          <Button
            label="Save to server"
            variant="primary"
            size="sm"
            data-testid="save-op-token-btn"
            onClick={submitOpToken}
          />
          <span
            id="op-token-status"
            data-testid="op-token-status"
            className={"vault-status" + (state.opStatus?.kind ? ` ${state.opStatus.kind}` : "")}
            hidden={!state.opStatus}
          >
            {state.opStatus?.text ?? ""}
          </span>
        </div>
        <span className="vault-desc">Saving verifies the token and briefly restarts the server.</span>
      </div>
    </div>
  )
}

function syncStateText(sync: { enabled?: boolean; lastSyncedAt?: number | null } | null): string {
  let stateText = sync && sync.enabled ? "Sync: on" : "Sync: off"
  if (sync && sync.lastSyncedAt) {
    const diffSec = Math.floor((Date.now() - sync.lastSyncedAt) / 1000)
    let rel: string
    if (diffSec < 60) rel = diffSec + "s ago"
    else if (diffSec < 3600) rel = Math.floor(diffSec / 60) + "m ago"
    else if (diffSec < 86400) rel = Math.floor(diffSec / 3600) + "h ago"
    else rel = Math.floor(diffSec / 86400) + "d ago"
    stateText += " · " + rel
  }
  return stateText
}

function opLabelPlaceholder(items: ReadonlyArray<VaultItem>): string {
  const opTokenItem = items.find((i) => i.kind === "op-token") ?? null
  if (!opTokenItem) return "primary"
  return String(opTokenItem.ref || "").replace(/^luna-op:\/\//, "").split("/")[0] || "primary"
}
