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
 * Astryx mapping: VStack/HStack + Card sections with Text label/supporting
 * headers (the SettingsModelsPanel.tsx conventions), TextInput (text/password)
 * with visible labels for every text field, Button for every action,
 * SegmentedControl for the 2-way kind choice (env-secret vs. op-token - same
 * "plain-text single-select row" precedent SettingsAppearancePanel.tsx
 * documents for SegmentedControl over a native `<select>`), Switch for the
 * sync-enabled toggle, NumberInput for the poll-seconds field (deliberately
 * given no `min` - the floor is enforced only at submit time, exactly like
 * the vanilla module's `Math.max(60, pollRaw)`, so a below-floor value can
 * still be typed and then clamped on save - see the covering test), Badge for
 * the kind/synced/shadowed chips, Banner for a sync error.
 */
import { useEffect, useRef } from "react"
import { newRequestId, type Action } from "@luna/ui-shared/core"
import {
  Badge,
  Banner,
  Button,
  Card,
  HStack,
  NumberInput,
  SegmentedControl,
  SegmentedControlItem,
  Switch,
  Text,
  TextInput,
  VStack,
} from "../../astryx-kit"
import { useLocalStore, useMoonSelector, useMoonStore } from "../../state/store"
import { socketOpen } from "../panel-ctx"
import type { LunaFrameRegistry, LunaWsClient, PanelCtx } from "../panel-ctx"
import {
  effectiveVarName,
  initialVaultPanelState,
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
          text: "That name can’t become a key - add some letters, or set one under “change”.",
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
    const rid = newRequestId("vlt_")
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
    const rid = newRequestId("vlt_")
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
    const rid = newRequestId("vlt_")
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
    const rid = newRequestId("op_")
    if (!client!.send({ type: "register-op-token", requestId: rid, label, token })) {
      local.dispatch({ type: "op-status-set", text: "Not connected to a server.", kind: "error" })
      return
    }
    local.dispatch({ type: "op-submit-started", requestId: rid })
  }

  return (
    <VStack gap={4} className="settings-vault-panel" data-testid="settings-vault-panel">
      {/* Capability-gated Vault UI (kept hidden, not unmounted, so a hello
       *  arriving after mount only flips visibility). */}
      <div id="vault-section" data-testid="vault-section" hidden={!vaultSupported}>
        <VStack gap={4}>
          <VStack gap={1}>
            <Text type="label">Vault</Text>
            <Text type="supporting" color="secondary">
              Keys and tokens Luna can use. Values are stored safely on the server — once saved, they never appear
              here again.
            </Text>
            {vaultStorage && (
              <Text type="supporting" color="secondary" id="vault-storage-line" data-testid="vault-storage-line">
                {storageLineText(vaultStorage)}
              </Text>
            )}
          </VStack>

          <VStack gap={2} id="vault-list" data-testid="vault-list" className="sp-vault-list">
            {vaultItems.length === 0 ? (
              <Text type="supporting" color="secondary">
                Nothing stored yet — add your first key below.
              </Text>
            ) : (
              vaultItems.map((item) => (
                <Card
                  key={item.id}
                  padding={3}
                  className={"vault-row" + (item.shadowed ? " shadowed" : "")}
                  data-testid={`vault-row-${item.id}`}
                >
                  <HStack gap={3} vAlign="center">
                    <VStack gap={1} style={{ flex: 1, minWidth: 0 }}>
                      <HStack gap={2} vAlign="center" className="vault-row-name">
                        <Text type="body" weight="semibold">
                          {item.name}
                        </Text>
                        <Badge variant="neutral" label={KIND_BADGE[item.kind] || item.kind} data-testid={`vault-row-${item.id}-kind`} />
                        {item.synced && (
                          <span className="vault-chip synced" title="Synced with 1Password">
                            <Badge variant="info" label="1P" />
                          </span>
                        )}
                        {item.shadowed && (
                          <span
                            className="vault-chip shadowed"
                            title="Defined by the server's environment - edits here won't take effect"
                          >
                            <Badge variant="warning" label="⚠ shadowed" />
                          </span>
                        )}
                      </HStack>
                      <HStack gap={2} vAlign="center" className="vault-row-sub">
                        <code className="vault-ref">{item.ref}</code>
                        <Text type="supporting" color="secondary" className="vault-source">
                          {SOURCE_LABEL[item.source] || item.source}
                        </Text>
                      </HStack>
                      {item.description && (
                        <Text type="supporting" color="secondary" className="skill-row-desc">
                          {item.description}
                        </Text>
                      )}
                    </VStack>
                    {state.confirmId === item.id ? (
                      <HStack gap={2} vAlign="center" style={{ flexShrink: 0 }}>
                        <Text type="supporting" className="vault-confirm-note">
                          {item.kind === "op-token" ? "Remove? The server restarts." : "Remove this credential?"}
                        </Text>
                        <Button label="Delete" variant="destructive" size="sm" onClick={() => requestDelete(item.id)} />
                        <Button
                          label="Keep"
                          variant="secondary"
                          size="sm"
                          onClick={() => local.dispatch({ type: "delete-cancelled" })}
                        />
                      </HStack>
                    ) : (
                      <Button label="Delete" variant="destructive" size="sm" onClick={() => requestDelete(item.id)} />
                    )}
                  </HStack>
                </Card>
              ))
            )}
          </VStack>

          <VStack gap={2}>
            <VStack gap={1}>
              <Text type="label">Add a credential</Text>
              <Text type="supporting" color="secondary">
                Pasted values go straight to the server — Luna never shows them again.
              </Text>
            </VStack>
            <Card>
              <VStack gap={3}>
                <TextInput
                  label="Name"
                  size="sm"
                  placeholder="Notion API Key"
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
                  <SegmentedControlItem
                    value="op-token"
                    label="1Password service-account token"
                    data-testid="vault-kind-op-token"
                  />
                </SegmentedControl>

                {state.kind !== "op-token" && (
                  <div id="vault-var-row" data-testid="vault-var-row" className="vault-var-row">
                    <Text type="supporting" color="secondary">
                      Stored as
                    </Text>
                    <code id="vault-var-preview" data-testid="vault-var-preview" className="vault-ref">
                      {effectiveVarName(state) || "ENV_VAR_NAME"}
                    </code>
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
                    size="sm"
                    placeholder="primary"
                    value={state.labelInput}
                    onChange={(value) => local.dispatch({ type: "label-input-changed", value })}
                    data-testid="vault-label-input"
                  />
                )}

                <TextInput
                  label="Secret value"
                  size="sm"
                  type="password"
                  placeholder={state.kind === "op-token" ? "ops_… service-account token" : "Paste the secret value"}
                  value={state.valueInput}
                  onChange={(value) => local.dispatch({ type: "value-input-changed", value })}
                  data-testid="vault-value-input"
                />

                <TextInput
                  label="Note"
                  size="sm"
                  isOptional
                  placeholder="What this key is for"
                  value={state.descInput}
                  onChange={(value) => local.dispatch({ type: "desc-input-changed", value })}
                  data-testid="vault-desc-input"
                />

                {state.kind === "op-token" && (
                  <Text type="supporting" color="secondary" id="vault-restart-note" data-testid="vault-restart-note">
                    Saving verifies the token and briefly restarts the server.
                  </Text>
                )}

                <HStack gap={2} vAlign="center">
                  <Button label="Save to server" variant="primary" size="sm" data-testid="vault-add-btn" onClick={submitAdd} />
                  {state.statusLine && (
                    <Text
                      type="supporting"
                      id="vault-status-line"
                      data-testid="vault-status-line"
                      style={{ color: statusColor(state.statusLine.kind) }}
                    >
                      {state.statusLine.text}
                    </Text>
                  )}
                </HStack>
              </VStack>
            </Card>
          </VStack>

          <VStack gap={2} id="vault-sync-section" data-testid="vault-sync-section">
            <VStack gap={1}>
              <HStack gap={2} vAlign="center">
                <Text type="label">1Password sync</Text>
                <Text type="supporting" color="secondary" id="vault-sync-state" data-testid="vault-sync-state">
                  {syncStateText(vaultSync)}
                </Text>
              </HStack>
              {vaultSync?.lastError && (
                <Banner status="error" title={vaultSync.lastError} data-testid="vault-sync-error" />
              )}
            </VStack>
            <Card>
              <VStack gap={3} id="vault-sync-fields" data-testid="vault-sync-fields">
                <Switch
                  label="Enable 1Password sync"
                  value={state.syncEnabled}
                  onChange={(checked) => local.dispatch({ type: "sync-enabled-toggled", checked })}
                  data-testid="vault-sync-enabled"
                />
                <TextInput
                  label="Service-account label"
                  size="sm"
                  placeholder={opLabelPlaceholder(vaultItems)}
                  value={state.syncOpLabel}
                  onChange={(value) => local.dispatch({ type: "sync-op-label-changed", value })}
                  data-testid="vault-sync-op-label"
                />
                <TextInput
                  label="1Password vault"
                  size="sm"
                  placeholder="Luna"
                  description="Create this vault in 1Password and share it with your service account."
                  value={state.syncOpVault}
                  onChange={(value) => local.dispatch({ type: "sync-op-vault-changed", value })}
                  data-testid="vault-sync-op-vault"
                />
                <NumberInput
                  label="Check for changes every"
                  size="sm"
                  description="Seconds between syncs — minimum 60."
                  value={state.syncPoll}
                  onChange={(value) => local.dispatch({ type: "sync-poll-changed", value })}
                  data-testid="vault-sync-poll"
                />
                <HStack gap={2} vAlign="center">
                  <Button
                    label="Save sync settings"
                    variant="primary"
                    size="sm"
                    data-testid="vault-sync-save-btn"
                    onClick={submitSyncConfig}
                  />
                  {state.syncStatus && (
                    <Text
                      type="supporting"
                      id="vault-sync-status"
                      data-testid="vault-sync-status"
                      style={{ color: statusColor(state.syncStatus.kind) }}
                    >
                      {state.syncStatus.text}
                    </Text>
                  )}
                </HStack>
                {vaultSync?.enabled && (
                  <Text
                    type="supporting"
                    color="secondary"
                    id="vault-sync-import-note"
                    data-testid="vault-sync-import-note"
                  >
                    Import Apple Passwords exports from the web client.
                  </Text>
                )}
              </VStack>
            </Card>
          </VStack>
        </VStack>
      </div>

      {/* Legacy op-token-only form for pre-vault servers. */}
      <div id="legacy-op-token-section" data-testid="legacy-op-token-section" hidden={vaultSupported}>
        <VStack gap={3}>
          <VStack gap={1}>
            <Text type="label">1Password service account</Text>
            <Text type="supporting" color="secondary">
              Send an ops_… service-account token to the server securely. It is verified and stored on the server —
              never kept in chat history or on this device.
            </Text>
          </VStack>
          <Card>
            <VStack gap={3}>
              <TextInput
                label="Account label"
                size="sm"
                placeholder="primary"
                value={state.opLabelInput}
                onChange={(value) => local.dispatch({ type: "op-label-input-changed", value })}
                data-testid="op-label-input"
              />
              <TextInput
                label="Service-account token"
                size="sm"
                type="password"
                placeholder="ops_… service-account token"
                value={state.opTokenInput}
                onChange={(value) => local.dispatch({ type: "op-token-input-changed", value })}
                data-testid="op-token-input"
              />
              <HStack gap={2} vAlign="center">
                <Button
                  label="Save to server"
                  variant="primary"
                  size="sm"
                  data-testid="save-op-token-btn"
                  onClick={submitOpToken}
                />
                {state.opStatus && (
                  <Text
                    type="supporting"
                    id="op-token-status"
                    data-testid="op-token-status"
                    style={{ color: statusColor(state.opStatus.kind) }}
                  >
                    {state.opStatus.text}
                  </Text>
                )}
              </HStack>
              <Text type="supporting" color="secondary">
                Saving verifies the token and briefly restarts the server.
              </Text>
            </VStack>
          </Card>
        </VStack>
      </div>
    </VStack>
  )
}

/** Status-line tint — Text has no semantic error/success color variant, so
 *  this matches SettingsModelsPanel.tsx's statusColor. */
function statusColor(kind: "ok" | "error" | "info"): string {
  if (kind === "error") return "var(--color-danger, #f87171)"
  if (kind === "ok") return "var(--color-success, #4ade80)"
  return "var(--muted, #94a3b8)"
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
