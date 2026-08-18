/**
 * SettingsModelsPanel.tsx - React 19 + Astryx port of
 * apps/ui-moon-tauri/frontend/panels/settings-models.js (the Models settings
 * panel: registered there as `LunaPanelTypes['settings.models']`).
 *
 * WS-backed, same as the vanilla module: connects via `ctx.connectWs` and
 * gates on the hello capability `modelRouting`. When the capability is
 * absent (old server) a notice is shown and no settings are exposed.
 *
 * Frame flow (packages/ui-shared/src/wire.ts):
 *   <- hello                  gate on capabilities.modelRouting
 *   <- model-routing-list     providers + roleBindings from server
 *   <- model-routing-status   ack for a save (ok/message, requestId)
 *   -> model-routing-save     { requestId, providers, roleBindings }
 *
 * SECURITY (unchanged from the vanilla module):
 *   - No credential values ever appear here. `credentialRef` is an opaque
 *     pointer (e.g. "env:ANTHROPIC_API_KEY") - shown as a monospace chip
 *     only (TextInput renders the raw ref text; never any secret value).
 *   - Credential ENTRY uses the existing request_secret flow (agent tool),
 *     not this panel. The panel only stores the opaque ref.
 *   - The `monthlyCapUsd` field is stored and displayed but NOT enforced -
 *     labeled "not yet enforced" via the Banner below the field.
 *
 * All state/transitions live in ./logic.ts's reduceModelRouting (see that
 * module's doc for why this panel uses a local useReducer instead of
 * src/state/store.ts). Every WS frame handler below only dispatches an
 * action - it never touches the DOM directly, and every render is a pure
 * function of state, matching the "never poke the DOM from transport
 * callbacks" rule.
 */
import { useEffect, useMemo, useReducer, useRef } from "react"
import type { ModelRoutingListFrame, ModelRoutingStatusFrame } from "@luna/ui-shared/core"
import { Banner, Button, Card, HStack, NumberInput, Selector, Switch, Text, TextInput, VStack } from "../../astryx-kit"
import type { LunaFrameRegistry, LunaWsClient, PanelCtx } from "../panel-ctx"
import {
  ANTHROPIC_MODELS,
  buildSavePayload,
  DEFAULT_ROLE_MODEL,
  initialModelRoutingState,
  PROVIDERS,
  reduceModelRouting,
  ROLE_LABELS,
  ROLES,
} from "./logic"

/** Consumed by settings-models-mount.tsx for #bar-title / document.title. */
export const PANEL_TITLE = "Models"

function newRequestId(prefix: string): string {
  const g = globalThis as { crypto?: Crypto }
  if (g.crypto && typeof g.crypto.randomUUID === "function") {
    return prefix + g.crypto.randomUUID().replace(/-/g, "")
  }
  return prefix + Math.random().toString(36).slice(2)
}

function socketIsOpen(client: LunaWsClient | null): boolean {
  const sock = client?.socket() as { readyState?: number } | null | undefined
  const OPEN = (globalThis as { WebSocket?: { OPEN?: number } }).WebSocket?.OPEN ?? 1
  return !!(sock && sock.readyState === OPEN)
}

export function SettingsModelsPanel({ ctx }: { ctx: PanelCtx }) {
  const [state, dispatch] = useReducer(reduceModelRouting, initialModelRoutingState)
  const clientRef = useRef<LunaWsClient | null>(null)

  // Connect once on mount (mirrors the vanilla module's render()-time
  // ctx.connectWs call). Frame handlers only dispatch - see the module doc.
  useEffect(() => {
    if (!ctx.connectWs) return
    const LunaWS = (globalThis as { LunaWS?: { createFrameRegistry: () => LunaFrameRegistry } }).LunaWS
    if (!LunaWS) return

    const registry = LunaWS.createFrameRegistry()

    registry.register("hello", (frame: { capabilities?: { modelRouting?: boolean } }) => {
      const LunaProtocol = (globalThis as {
        LunaProtocol?: { parseHelloCapabilities: (f: unknown) => { modelRouting?: boolean } }
      }).LunaProtocol
      const caps = LunaProtocol ? LunaProtocol.parseHelloCapabilities(frame) : frame?.capabilities || {}
      dispatch({ type: "hello", modelRouting: !!caps.modelRouting })
    })

    registry.register("model-routing-list", (frame: ModelRoutingListFrame) => {
      dispatch({
        type: "server-list",
        providers: Array.isArray(frame?.providers) ? frame.providers : [],
        roleBindings: Array.isArray(frame?.roleBindings) ? frame.roleBindings : [],
      })
    })

    registry.register("model-routing-status", (frame: ModelRoutingStatusFrame) => {
      if (!frame) return
      dispatch({ type: "save-result", requestId: frame.requestId, ok: !!frame.ok, message: frame.message })
    })

    const client = ctx.connectWs(registry, { autoPong: true })
    clientRef.current = client

    return () => {
      client.close()
      clientRef.current = null
    }
    // ctx is stable for the lifetime of a panel window (see panel-ctx.ts) -
    // connect once, mirroring the vanilla module's one-shot render()/connectWs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function submitSave(): void {
    // Defensive only: the Save button doesn't render while
    // !state.serverSupports (see the early return below), so this branch is
    // unreachable in normal use - guards the edge case where a hello frame
    // flips serverSupports false between render and a queued click.
    if (!state.serverSupports) {
      dispatch({ type: "not-connected" })
      return
    }
    const client = clientRef.current
    if (!socketIsOpen(client)) {
      dispatch({ type: "not-connected" })
      return
    }
    const payload = buildSavePayload(state)
    const requestId = newRequestId("mr_")
    const ok = client!.send({
      type: "model-routing-save",
      requestId,
      providers: payload.providers,
      roleBindings: payload.roleBindings,
    })
    if (!ok) {
      dispatch({ type: "save-rejected" })
      return
    }
    dispatch({ type: "save-start", requestId })
  }

  const ollamaLocalEnabled = state.draftProviders["ollama-local"]?.enabled ?? false
  const ollamaCloudEnabled = state.draftProviders["ollama-cloud"]?.enabled ?? false

  const roleModelOptions = useMemo(() => {
    const base = ANTHROPIC_MODELS.map((m) => ({ value: m.id, label: m.label }))
    if (ollamaLocalEnabled) base.push({ value: "local/qwen3:4b", label: "Ollama Local (e.g. local/qwen3:4b)" })
    if (ollamaCloudEnabled) base.push({ value: "qwen3:4b:cloud", label: "Ollama Cloud (e.g. qwen3:4b:cloud)" })
    return base
  }, [ollamaLocalEnabled, ollamaCloudEnabled])

  if (!state.serverSupports) {
    return (
      <div className="notice" data-testid="settings-models-unsupported">
        This server does not support model-routing settings.
      </div>
    )
  }

  return (
    <VStack gap={4} data-testid="settings-models-root">
      <VStack gap={2}>
        <Text type="label">Providers</Text>
        <Text type="supporting" color="secondary">
          Enable providers and set a credentialRef (env:NAME / op://… / luna-op://…). Saving writes the
          account on this connected server — no second `luna account add` on the wrong machine. Raw API
          keys never leave the Vault / request_secret flow.
        </Text>
        {PROVIDERS.map((pd) => {
          const draft = state.draftProviders[pd.kind] ?? { enabled: false, credentialRef: "", monthlyCapUsd: "" as const }
          return (
            <Card key={pd.kind} data-testid={`provider-card-${pd.kind}`}>
              <VStack gap={2}>
                <HStack gap={2} vAlign="center">
                  <Text type="body" weight="semibold" style={{ flex: 1 }}>
                    {pd.label}
                  </Text>
                  {pd.gated && <Text type="supporting" color="secondary">needs gateway</Text>}
                  <Switch
                    label={draft.enabled ? "Enabled" : "Disabled"}
                    value={draft.enabled}
                    onChange={(checked) => dispatch({ type: "toggle-provider", kind: pd.kind, enabled: checked })}
                    data-testid={`provider-${pd.kind}-toggle`}
                  />
                </HStack>
                {draft.enabled && (
                  <>
                    <TextInput
                      label="Credential ref (e.g. env:ANTHROPIC_API_KEY)"
                      placeholder="env:MY_API_KEY or luna-op://label/item"
                      value={draft.credentialRef}
                      onChange={(value) => dispatch({ type: "set-credential-ref", kind: pd.kind, value })}
                      data-testid={`provider-${pd.kind}-credential`}
                    />
                    <NumberInput
                      label="Monthly cap (USD)"
                      description="not yet enforced (coming in next update)"
                      placeholder="50"
                      min={0}
                      step={1}
                      hasClear
                      value={draft.monthlyCapUsd === "" ? null : draft.monthlyCapUsd}
                      onChange={(value) =>
                        dispatch({ type: "set-monthly-cap", kind: pd.kind, value: value === null || value === undefined ? "" : value })
                      }
                      data-testid={`provider-${pd.kind}-cap`}
                    />
                    {pd.gated && (
                      <Banner
                        status="warning"
                        title={`${pd.label} routes via LiteLLM gateway`}
                        description="Set LUNA_LLM_GATEWAY_URL and configure the provider there."
                      />
                    )}
                  </>
                )}
              </VStack>
            </Card>
          )
        })}
      </VStack>

      <VStack gap={2}>
        <Text type="label">Role Model Assignments</Text>
        <Text type="supporting" color="secondary">
          Choose which model Luna uses for each role. Changes take effect after the server restarts.
        </Text>
        {ROLES.map((role) => {
          const current = state.draftRoleModel[role] || DEFAULT_ROLE_MODEL[role]
          return (
            <HStack key={role} gap={2} vAlign="center" data-testid={`role-row-${role}`}>
              <VStack gap={0} style={{ flex: 1, minWidth: 0 }}>
                <Text type="body" weight="semibold">
                  {ROLE_LABELS[role]}
                </Text>
                <Text type="supporting" color="secondary">
                  current: {current}
                </Text>
              </VStack>
              <Selector
                label={ROLE_LABELS[role]}
                isLabelHidden
                options={roleModelOptions}
                value={current}
                onChange={(value) => dispatch({ type: "set-role-model", role, model: value })}
                data-testid={`role-${role}-select`}
              />
            </HStack>
          )
        })}
      </VStack>

      <HStack gap={2} vAlign="center">
        <Button label="Save & Restart" variant="primary" onClick={submitSave} data-testid="save-models-btn" />
        {state.status && (
          <Text
            type="supporting"
            style={{ color: statusColor(state.status.kind) }}
            data-testid="save-status"
          >
            {state.status.message}
          </Text>
        )}
      </HStack>
      <Text type="supporting" color="secondary">
        Save & Restart applies routing on this connected server and schedules a supervised restart —
        Moon reconnects automatically. No folklore manual restart for the common case.
      </Text>
    </VStack>
  )
}

/** Text has no semantic error/success color variant - see TextColor in
 * @astryxdesign/core/theme/types.ts - so the status line's ok/error tint is
 * an inline style, matching the vanilla module's own setStatus() which did
 * the exact same thing (statusEl.style.color = ...). */
function statusColor(kind: "ok" | "error" | "info"): string {
  if (kind === "error") return "var(--color-danger, #f87171)"
  if (kind === "ok") return "var(--color-success, #4ade80)"
  return "var(--muted, #94a3b8)"
}
