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
import { newRequestId } from "@luna/ui-shared/core"
import type { ModelRoutingListFrame, ModelRoutingStatusFrame } from "@luna/ui-shared/core"
import { Badge, Banner, Button, Card, Divider, EmptyState, HStack, NumberInput, Selector, Switch, Text, TextInput, VStack } from "../../astryx-kit"
import type { SelectorOptionData, SelectorOptionType } from "../../astryx-kit"
import { socketOpen } from "../panel-ctx"
import type { LunaFrameRegistry, LunaWsClient, PanelCtx } from "../panel-ctx"
import {
  ANTHROPIC_MODELS,
  buildSavePayload,
  DEFAULT_ROLE_MODEL,
  initialModelRoutingState,
  PROVIDERS,
  reduceModelRouting,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  ROLES,
} from "./logic"

/** Consumed by settings-models-mount.tsx for #bar-title / document.title. */
export const PANEL_TITLE = "Models"

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
    if (!socketOpen(client)) {
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

  const roleModelSections = useMemo<SelectorOptionType[]>(() => {
    const sections: SelectorOptionType[] = [
      {
        type: "section",
        title: "Anthropic",
        options: ANTHROPIC_MODELS.map((m) => ({ value: m.id, label: m.label })),
      },
    ]
    if (ollamaLocalEnabled) {
      sections.push({
        type: "section",
        title: "Ollama Local",
        options: [{ value: "local/qwen3:4b", label: "Qwen3 4B — runs on this machine" }],
      })
    }
    if (ollamaCloudEnabled) {
      sections.push({
        type: "section",
        title: "Ollama Cloud",
        options: [{ value: "qwen3:4b:cloud", label: "Qwen3 4B — hosted by Ollama" }],
      })
    }
    return sections
  }, [ollamaLocalEnabled, ollamaCloudEnabled])

  const knownModelIds = useMemo(
    () =>
      new Set(
        roleModelSections.flatMap((o) =>
          typeof o === "object" && "options" in o ? o.options.map((item) => item.value) : []
        )
      ),
    [roleModelSections],
  )

  // A binding saved outside the picker list (e.g. an older LiteLLM id) still
  // has to display as the current value - surface it as its own top option.
  function optionsForRole(current: string): SelectorOptionType[] {
    if (knownModelIds.has(current)) return roleModelSections
    return [{ value: current, label: `${current} — custom` }, { type: "divider" }, ...roleModelSections]
  }

  if (!state.serverSupports) {
    return (
      <EmptyState
        title="Model settings need a newer Luna server"
        description="This server doesn't expose model routing yet — update Luna, then come back here to pick a model for each job."
        data-testid="settings-models-unsupported"
      />
    )
  }

  return (
    <VStack gap={4} data-testid="settings-models-root">
      <VStack gap={3}>
        <VStack gap={1}>
          <Text type="label">Model providers</Text>
          <Text type="supporting" color="secondary">
            Turn on the services you have keys for — Luna uses them to run the jobs below.
          </Text>
        </VStack>
        {PROVIDERS.map((pd) => {
          const draft = state.draftProviders[pd.kind] ?? { enabled: false, credentialRef: "", monthlyCapUsd: "" as const }
          return (
            <Card key={pd.kind} data-testid={`provider-card-${pd.kind}`}>
              <VStack gap={3}>
                <HStack gap={3} vAlign="center">
                  <VStack gap={0} style={{ flex: 1, minWidth: 0 }}>
                    <Text type="body" weight="semibold">
                      {pd.label}
                    </Text>
                    <Text type="supporting" color="secondary">
                      {pd.description}
                    </Text>
                  </VStack>
                  <Switch
                    label={draft.enabled ? "On" : "Off"}
                    value={draft.enabled}
                    onChange={(checked) => dispatch({ type: "toggle-provider", kind: pd.kind, enabled: checked })}
                    data-testid={`provider-${pd.kind}-toggle`}
                  />
                </HStack>
                {draft.enabled && (
                  <VStack gap={3}>
                    <TextInput
                      label="Credential reference"
                      description="A pointer to your key — an env var or Luna Vault item, never the key itself."
                      placeholder="env:ANTHROPIC_API_KEY or luna-op://label/item"
                      value={draft.credentialRef}
                      onChange={(value) => dispatch({ type: "set-credential-ref", kind: pd.kind, value })}
                      data-testid={`provider-${pd.kind}-credential`}
                    />
                    <NumberInput
                      label="Monthly spend cap (USD)"
                      description="Informational for now — Luna doesn't enforce it yet."
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
                  </VStack>
                )}
              </VStack>
            </Card>
          )
        })}
      </VStack>

      <VStack gap={3}>
        <VStack gap={1}>
          <Text type="label">Models for each job</Text>
          <Text type="supporting" color="secondary">
            Every job Luna does can use its own model — a bigger one for hard thinking, a faster one for
            quick work. Changes apply after a short server restart.
          </Text>
          {!ollamaLocalEnabled && !ollamaCloudEnabled && (
            <Text type="supporting" color="secondary">
              Tip: turn on an Ollama provider above to add its models to these pickers.
            </Text>
          )}
        </VStack>
        {ROLES.map((role) => {
          const current = state.draftRoleModel[role] || DEFAULT_ROLE_MODEL[role]
          return (
            <Card key={role} data-testid={`role-row-${role}`}>
              <HStack gap={3} vAlign="center">
                <VStack gap={0} style={{ flex: 1, minWidth: 0 }}>
                  <Text type="body" weight="semibold">
                    {ROLE_LABELS[role]}
                  </Text>
                  <Text type="supporting" color="secondary">
                    {ROLE_DESCRIPTIONS[role]}
                  </Text>
                </VStack>
                <Selector
                  label={ROLE_LABELS[role]}
                  isLabelHidden
                  options={optionsForRole(current)}
                  value={current}
                  onChange={(value) => dispatch({ type: "set-role-model", role, model: value })}
                  width={280}
                  hasSearch
                  searchPlaceholder="Search models…"
                  renderOption={(option: SelectorOptionData) => (
                    <HStack gap={2} vAlign="center" style={{ justifyContent: "space-between", width: "100%" }}>
                      <span>{option.label ?? option.value}</span>
                      {option.value === DEFAULT_ROLE_MODEL[role] && <Badge variant="info" label="Recommended" />}
                    </HStack>
                  )}
                  data-testid={`role-${role}-select`}
                />
              </HStack>
            </Card>
          )
        })}
      </VStack>

      <VStack gap={2}>
        <Divider />
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
          Luna restarts briefly to apply — your windows reconnect on their own.
        </Text>
      </VStack>
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
