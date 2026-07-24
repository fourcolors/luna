/**
 * SettingsConnectionPanel.tsx - React 19 + Astryx port of
 * frontend/panels/settings-connection.js (registered there as
 * `LunaPanelTypes['settings.connection']`).
 *
 * Controls (ported 1:1 from the vanilla module):
 *  - Channel select (stable/dev, or the real routes from
 *    MoonSession.listRoutes() when available - C8): set_active_profile +
 *    hub_event('profile-changed').
 *  - Model select: populated from localStorage `luna_available_models`;
 *    persists `luna_model`. Accepts both the legacy plain-id-string cache
 *    shape and the extended {id, label, efforts} shape.
 *  - Effort select: only shown when the selected model has efforts in the
 *    extended cache; persists `luna_effort`.
 *  - WS URL + Auth Token + Save: load_connection on mount, save_connection
 *    on save + hub_event('connection-changed'). The token field is never
 *    wiped after a successful save (the engine doesn't clear it - the
 *    operator can confirm what was stored).
 *  - Open setup wizard button: hub_event('open-wizard').
 *
 * State flows one way only, exactly like AgentsPanel.tsx: every
 * ctx.invoke() `.then()`/`.catch()` callback's entire job is
 * `store.dispatch(...)` (see connectionReducer.ts) - never a direct DOM
 * write from inside the callback. The JSX below is the only thing that
 * reads state (via useMoonSelector, src/state/store.ts's
 * useSyncExternalStore binding) and decides what appears on screen.
 *
 * Astryx mapping: TextInput for the two text fields, Button for Save/Open.
 * Channel/Model/Effort stay native <select> elements - Astryx's Selector is
 * a Popover-API-based combobox with no jsdom shim in this test harness (see
 * apps/ui-web/src/studio/settings-panel.jsx's Model dropdown for the same
 * documented precedent) - forcing it here would silently change behavior
 * the covering tests assert on native <select> semantics (.value,
 * 'change' events).
 */
import { useEffect } from "react"
import { Button, HStack, Text, TextInput, VStack } from "../../astryx-kit"
import { useLocalStore, useMoonSelector } from "../../state/store"
import {
  capitalize,
  initialConnectionPanelState,
  reduceConnectionPanel,
  type ChannelOption,
  type ConnectionPanelAction,
  type ConnectionPanelState,
} from "./connectionReducer"
import type { PanelCtx } from "../panel-ctx"

/** Consumed by the panel-type registry (settings-connection-mount.tsx) to
 *  set bar-title / document.title, mirroring the vanilla module's
 *  `title: 'Connection'`. */
export const PANEL_TITLE = "Connection"

const DEFAULT_WS_URL = "ws://127.0.0.1:4753/ui"

/**
 * moon-session.js (frontend/vendor/moon-session.js) attaches this classic
 * global exactly like moon-protocol.js attaches LunaProtocol (see
 * AgentsPanel.tsx) - loads as a plain <script> tag in panel.html's <head>,
 * ahead of this module. Declared locally since this is (so far) the only
 * React panel that needs it.
 */
declare global {
  interface Window {
    MoonSession?: {
      listRoutes: () => Promise<{ default?: string; routes?: unknown[] } | null>
    }
  }
}

interface ListedRoute {
  key?: unknown
  name?: unknown
  label?: unknown
}

function routesToOptions(routes: unknown[]): ChannelOption[] {
  return routes.map((r) => {
    const route = r as ListedRoute
    const key = typeof route.key === "string" && route.key
      ? route.key
      : typeof route.name === "string" && route.name
        ? route.name
        : String(r)
    const label = typeof route.label === "string" && route.label ? route.label : key
    return { value: key, label }
  })
}

export function SettingsConnectionPanel({ ctx }: { ctx: PanelCtx }) {
  const store = useLocalStore<ConnectionPanelState, ConnectionPanelAction>(
    reduceConnectionPanel,
    initialConnectionPanelState(),
  )
  const state = useMoonSelector(store, (snapshot) => snapshot)

  useEffect(() => {
    ctx.invoke("load_connection").then((conn) => {
      const c = conn as { wsUrl?: unknown; wsToken?: unknown } | null
      if (!c) return
      store.dispatch({
        type: "connection-loaded",
        wsUrl: typeof c.wsUrl === "string" && c.wsUrl ? c.wsUrl : null,
        wsToken: typeof c.wsToken === "string" ? c.wsToken : null,
      })
    }).catch(() => { /* off-Tauri - inputs stay empty */ })

    ctx.invoke("load_profiles").then((prof) => {
      const p = prof as { activeProfile?: unknown } | null
      if (p && typeof p.activeProfile === "string" && p.activeProfile) {
        store.dispatch({ type: "profile-loaded", activeProfile: p.activeProfile })
      }
    }).catch(() => { /* off-Tauri - keep default */ })

    const ms = window.MoonSession
    if (ms && typeof ms.listRoutes === "function") {
      ms.listRoutes().then((result) => {
        if (result && Array.isArray(result.routes) && result.routes.length > 0) {
          store.dispatch({
            type: "routes-loaded",
            options: routesToOptions(result.routes),
            defaultKey: typeof result.default === "string" ? result.default : null,
          })
        }
        // listRoutes returned nothing useful → un-migrated; leave fallback.
      }).catch(() => { /* listRoutes rejected → leave fallback options in place. */ })
    }
    // ctx/store are stable for this component's lifetime (useLocalStore
    // memoizes the store; ctx is panel.html's single window.__panelCtx) -
    // this effect only ever needs to run once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function handleChannelChange(next: string): void {
    store.dispatch({ type: "channel-selected", channel: next })
    ctx.invoke("set_active_profile", { name: next }).then((creds) => {
      const c = creds as { wsUrl?: unknown; wsToken?: unknown } | null
      store.dispatch({
        type: "profile-switch-succeeded",
        wsUrl: c && typeof c.wsUrl === "string" ? c.wsUrl : "",
        wsToken: c && typeof c.wsToken === "string" ? c.wsToken : "",
      })
      ctx.invoke("hub_event", { name: "profile-changed" }).catch(() => {})
    }).catch((e) => {
      const reason = e instanceof Error ? e.message : String(e)
      store.dispatch({ type: "profile-switch-failed", message: `Couldn't switch to "${next}": ${reason}` })
    })
  }

  function handleModelChange(next: string): void {
    if (next) localStorage.setItem("luna_model", next)
    else localStorage.removeItem("luna_model")

    const entry = state.models.find((m) => m.id === next) ?? null
    const effortOptions = entry?.efforts ?? []
    let effort = localStorage.getItem("luna_effort") || ""
    if (effort && effortOptions.indexOf(effort) === -1) {
      localStorage.removeItem("luna_effort")
      effort = ""
    }
    store.dispatch({ type: "model-selected", model: next, effortOptions, effort })
  }

  function handleEffortChange(next: string): void {
    if (next) localStorage.setItem("luna_effort", next)
    else localStorage.removeItem("luna_effort")
    store.dispatch({ type: "effort-selected", effort: next })
  }

  async function handleSave(): Promise<void> {
    const url = state.wsUrl.trim() || DEFAULT_WS_URL
    const token = state.wsToken.trim()
    store.dispatch({ type: "save-start" })
    try {
      // Rust param names are `url`/`token` (distinct from file JSON keys wsUrl/wsToken).
      await ctx.invoke("save_connection", { url, token })
      store.dispatch({ type: "save-success" })
      ctx.invoke("hub_event", { name: "connection-changed" }).catch(() => {})
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      store.dispatch({ type: "save-error", message: reason })
    } finally {
      store.dispatch({ type: "save-settled" })
    }
  }

  function handleWizard(): void {
    ctx.invoke("hub_event", { name: "open-wizard" }).catch(() => {})
  }

  return (
    <div className="moon-astryx-root settings-connection-panel" data-testid="settings-connection-panel">
      <VStack gap={4}>
        <HStack justify="between" align="center" gap={3}>
          <VStack gap={0}>
            <Text type="label">Channel</Text>
            <Text type="supporting">Switch this moon between the stable and dev servers</Text>
            <span
              id="channel-error"
              data-testid="channel-error"
              className="panel-status warn"
              role="alert"
              hidden={!state.channelError}
            >
              {state.channelError ?? ""}
            </span>
          </VStack>
          <select
            id="channel-select"
            data-testid="channel-select"
            value={state.channel}
            onChange={(e) => handleChannelChange(e.target.value)}
          >
            {state.channelOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </HStack>

        <HStack justify="between" align="center" gap={3}>
          <VStack gap={0}>
            <Text type="label">Model</Text>
            <Text type="supporting">Model for new conversations - existing threads keep theirs</Text>
          </VStack>
          <select
            id="model-select"
            data-testid="model-select"
            value={state.model}
            onChange={(e) => handleModelChange(e.target.value)}
          >
            <option value="">Server default</option>
            {state.modelOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </HStack>

        <HStack
          id="effort-row"
          data-testid="effort-row"
          justify="between"
          align="center"
          gap={3}
          hidden={state.effortOptions.length === 0}
        >
          <VStack gap={0}>
            <Text type="label">Effort</Text>
            <Text type="supporting">Thinking effort for the selected model</Text>
          </VStack>
          <select
            id="effort-select"
            data-testid="effort-select"
            value={state.effort}
            onChange={(e) => handleEffortChange(e.target.value)}
          >
            <option value="">Default</option>
            {state.effortOptions.map((ef) => (
              <option key={ef} value={ef}>{capitalize(ef)}</option>
            ))}
          </select>
        </HStack>

        <TextInput
          label="WebSocket Server URL"
          description="Luna Central server WebSocket address (for the selected channel)"
          size="sm"
          value={state.wsUrl}
          onChange={(value) => store.dispatch({ type: "url-changed", value })}
          placeholder={DEFAULT_WS_URL}
          data-testid="ws-url-input"
        />

        <TextInput
          label="Auth Token"
          description="Optional authentication bearer token"
          size="sm"
          type="password"
          value={state.wsToken}
          onChange={(value) => store.dispatch({ type: "token-changed", value })}
          placeholder="Enter token (optional)..."
          data-testid="ws-token-input"
        />

        <HStack align="center" gap={3}>
          <Button
            label="Save"
            variant="primary"
            size="sm"
            isDisabled={state.saving}
            onClick={handleSave}
            id="save-connection-btn"
            data-testid="save-connection-btn"
          />
          <span
            id="save-connection-status"
            data-testid="save-connection-status"
            className={"panel-status" + (state.saveStatus?.kind ? ` ${state.saveStatus.kind}` : "")}
            role="status"
          >
            {state.saveStatus?.text ?? ""}
          </span>
        </HStack>

        <HStack justify="between" align="center" gap={3}>
          <VStack gap={0}>
            <Text type="label">Setup wizard</Text>
            <Text type="supporting">
              Guided setup - install Luna on this Mac, on a server, or point at one already running
            </Text>
          </VStack>
          <Button
            label="Open"
            variant="secondary"
            size="sm"
            onClick={handleWizard}
            id="open-wizard-btn"
            data-testid="open-wizard-btn"
          />
        </HStack>
      </VStack>
    </div>
  )
}
