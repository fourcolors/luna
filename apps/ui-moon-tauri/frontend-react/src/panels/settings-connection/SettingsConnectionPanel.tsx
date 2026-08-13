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
import { useEffect, useRef } from "react"
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
      /**
       * moon-session.js's wrapper around the `set_default_route` Tauri
       * command. NEVER rejects: it swallows a Rust `Err` into
       * `console.warn` and resolves `false` (see moon-session.js). The
       * boolean return is therefore the ONLY refusal signal - a `.catch`
       * on this call is dead code (plan Step 1a's named trap).
       */
      setDefaultRoute?: (routeKey: string) => Promise<boolean>
    }
  }
}

interface ListedRoute {
  key?: unknown
  name?: unknown
  label?: unknown
}

/** Shape of `load_route`'s RouteInfo (client_config.rs), narrowed to the
 *  two fields the Step 1a guards need: `token_ref` for resolvability
 *  (guard 2) and `endpoints[0]` for the honest URL shown on an unpaired
 *  refusal (F2a - see handleChannelChange). */
interface LoadedRouteInfo {
  token_ref?: unknown
  endpoints?: unknown
}

/** Shape of `load_profiles`'s {activeProfile, profiles} (connection.rs),
 *  narrowed to the one field the Step 1a resolvability guard needs. */
interface LoadedProfiles {
  profiles?: Record<string, { wsToken?: unknown } | undefined>
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

  // F4 (opus review): a plain ref, NOT reducer state - state reads inside a
  // handler are render-captured (a stale closure once an await yields), so
  // only a ref is live enough to detect "a newer switch started while I was
  // awaiting". Bumped once per handleChannelChange call; every checkpoint
  // after an await re-reads it and abandons silently (no dispatch, no
  // further writes) the moment it no longer matches what this call bumped
  // it to - the invariant is that only the LATEST-STARTED call's writes are
  // ever allowed to land, regardless of which call's promises settle first.
  const inFlightGenRef = useRef(0)

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
        } else {
          // listRoutes returned nothing useful → confirmed un-migrated (F3:
          // routesKnown "unknown" → "none", never left dangling).
          store.dispatch({ type: "routes-unavailable" })
        }
      }).catch(() => {
        // listRoutes rejected → same as "nothing useful": confirmed
        // un-migrated, not left "unknown" forever.
        store.dispatch({ type: "routes-unavailable" })
      })
    } else {
      // No MoonSession/listRoutes at all (off-Tauri, or an old build) →
      // confirmed un-migrated immediately; nothing async to wait for (F3).
      store.dispatch({ type: "routes-unavailable" })
    }
    // ctx/store are stable for this component's lifetime (useLocalStore
    // memoizes the store; ctx is panel.html's single window.__panelCtx) -
    // this effect only ever needs to run once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * Step 1a (docs/next/routes-and-view-mode-plan.md): once client.toml
   * routes are known (routesKnown === "routes"), the switch becomes a
   * GUARDED dual write instead of a bare set_active_profile call. The
   * un-migrated world (routesKnown === "none") keeps the byte-identical
   * legacy path; "unknown" (boot still discovering routes, F3) is refused
   * outright rather than guessed at.
   *
   * F2 pins two DIFFERENT honest outcomes for a refusal:
   *   (a) UNPAIRED (guard 2 finds no resolvable token): the selection STAYS
   *       on the target - this is the pairing UX, paste a token and Save
   *       (which always targets the selected channel - see handleSave),
   *       then retry - but the displayed URL/token fields update to the
   *       TARGET route's real endpoint and an empty token, never the old
   *       channel's stale creds shown under the new channel's name.
   *   (b) EVERY OTHER refusal (unknown route, an invoke throwing, or
   *       setDefaultRoute resolving false): the selector REVERTS to
   *       `previousChannel` - the switch did not happen, so the UI must not
   *       keep claiming it did.
   */
  async function handleChannelChange(next: string): Promise<void> {
    const previousChannel = state.channel
    // F4: bump the in-flight generation before any dispatch or await. Every
    // checkpoint below re-checks this after an await and abandons silently
    // (no dispatch, no further invoke calls) the instant it no longer holds
    // the latest value - see inFlightGenRef's doc comment.
    const myGen = ++inFlightGenRef.current
    const superseded = () => inFlightGenRef.current !== myGen

    store.dispatch({ type: "channel-selected", channel: next })

    if (state.routesKnown === "unknown") {
      // F3 defense in depth: the selector is disabled while "unknown" (see
      // the JSX below), so a real user cannot reach this - only a
      // programmatic driver (a race, or a test) can. Refuse and revert
      // exactly like any other non-pairing refusal (F2b) rather than ever
      // guessing which branch (guarded vs legacy) applies.
      store.dispatch({
        type: "profile-switch-failed",
        message: `Couldn't switch to "${next}": still discovering routes`,
        revertTo: previousChannel,
      })
      return
    }

    if (state.routesKnown === "none") {
      // Un-migrated world (b): byte-compatible with the pre-Step-1a
      // behavior - no generation guard, no disabling. A single un-guarded
      // write cannot leave the two stores half-moved the way the guarded
      // dual write can, so F4's race has nothing to protect here.
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
      return
    }

    // routesKnown === "routes" from here on: the guarded dual write.
    store.dispatch({ type: "switch-started" })

    // GUARD 1, target must be a route key. Defense in depth, not the primary
    // gate: the Step 1a reducer quarantine means channelOptions is EXACTLY
    // the route keys once routesKnown, so a non-route-key value can only
    // reach here via stale DOM state or a race, never normal use.
    if (!state.channelOptions.some((o) => o.value === next)) {
      store.dispatch({
        type: "profile-switch-failed",
        message: `Couldn't switch to "${next}": not a known route`,
        revertTo: previousChannel,
      })
      store.dispatch({ type: "switch-settled" })
      return
    }

    // GUARD 2, the route's token must be resolvable before committing to it.
    // This mirrors connection.rs's load_connection_in sentinel resolution on
    // the frontend - a TEMPORARY duplication. Step 1b replaces it with a
    // single Result-returning Rust command so this check stops living in two
    // places (docs/next/routes-and-view-mode-plan.md's Step 1b).
    let route: LoadedRouteInfo | null
    try {
      route = (await ctx.invoke("load_route", { routeKey: next })) as LoadedRouteInfo | null
    } catch (e) {
      if (superseded()) return
      const reason = e instanceof Error ? e.message : String(e)
      store.dispatch({ type: "profile-switch-failed", message: `Couldn't switch to "${next}": ${reason}`, revertTo: previousChannel })
      store.dispatch({ type: "switch-settled" })
      return
    }
    if (superseded()) return

    const routeEndpoint = route && Array.isArray(route.endpoints) && typeof route.endpoints[0] === "string"
      ? route.endpoints[0]
      : ""

    if (route && route.token_ref === "legacy") {
      // Non-legacy refs (env:/file:/op://) pass through unresolved - Phase 3 scope.
      let resolvable = false
      try {
        const prof = (await ctx.invoke("load_profiles")) as LoadedProfiles | null
        const token = prof?.profiles?.[next]?.wsToken
        resolvable = typeof token === "string" && token.length > 0
      } catch {
        resolvable = false
      }
      if (superseded()) return
      if (!resolvable) {
        // F2(a): UNPAIRED refusal. Selection stays on `next` (already
        // dispatched above); the fields shown are the TARGET route's real
        // endpoint and an EMPTY token - never the previous channel's creds,
        // which would describe the wrong server under the new channel's name.
        store.dispatch({
          type: "pairing-prompted",
          message: `"${next}" is not paired yet - paste a token and save to pair it`,
          wsUrl: routeEndpoint,
        })
        store.dispatch({ type: "switch-settled" })
        return
      }
    }

    // ORDER IS LOAD-BEARING (plan Step 1a). One click writes two files
    // through two unlocked commands and cannot be atomic across files, so
    // client.toml's `default` is written LAST: both the URL and the token
    // key off cfg.default (connection.rs), so whichever file is written
    // last is the one that decides, and a failure between the two writes
    // leaves the connect path fully on the OLD route rather than half
    // switched. set_active_profile goes first for un-migrated-world (b)
    // coherence and because it returns the creds this panel displays.
    let creds: { wsUrl?: unknown; wsToken?: unknown } | null
    try {
      creds = (await ctx.invoke("set_active_profile", { name: next })) as typeof creds
    } catch (e) {
      if (superseded()) return
      const reason = e instanceof Error ? e.message : String(e)
      store.dispatch({ type: "profile-switch-failed", message: `Couldn't switch to "${next}": ${reason}`, revertTo: previousChannel })
      store.dispatch({ type: "switch-settled" })
      return
    }
    if (superseded()) return

    // MoonSession.setDefaultRoute NEVER rejects (see its type doc above) -
    // the boolean return is the ONLY refusal signal here.
    const ms = window.MoonSession
    const ok = ms && typeof ms.setDefaultRoute === "function" ? await ms.setDefaultRoute(next) : false
    if (superseded()) return
    if (!ok) {
      // F2(b): setDefaultRoute resolving false leaves the two stores
      // intentionally half-moved - moon-connection.json's activeProfile
      // already advanced to `next` (set_active_profile above succeeded),
      // but client.toml's default did not. Default is what rules the
      // connect path for a migrated user (connection.rs), so the SELECTOR
      // reverting to `previousChannel` matches what the socket is actually
      // still doing, even though the activeProfile pointer did move.
      store.dispatch({
        type: "profile-switch-failed",
        message: `Couldn't switch to "${next}": failed to set the default route`,
        revertTo: previousChannel,
      })
      store.dispatch({ type: "switch-settled" })
      return
    }

    store.dispatch({
      type: "profile-switch-succeeded",
      wsUrl: creds && typeof creds.wsUrl === "string" ? creds.wsUrl : "",
      wsToken: creds && typeof creds.wsToken === "string" ? creds.wsToken : "",
    })
    store.dispatch({ type: "switch-settled" })
    // hub_event fires only after BOTH writes succeeded (plan Step 1a).
    ctx.invoke("hub_event", { name: "profile-changed" }).catch(() => {})
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
      // Rust param names are `url`/`token` (distinct from file JSON keys
      // wsUrl/wsToken). `profile` always targets the currently-selected
      // channel (plan Step 1a) - without it, save_connection falls back to
      // moon-connection.json's activeProfile (connection.rs), which the
      // Step 1a quarantine no longer keeps in sync with the selector, so a
      // token typed while viewing an unpaired route would silently land
      // under the WRONG profile.
      await ctx.invoke("save_connection", { url, token, profile: state.channel })
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
            // F3: disabled while boot is still discovering routes.
            // F4: disabled while a guarded switch is in flight, so a second
            // genuine user interaction cannot start a concurrent one -
            // reaching a concurrent attempt then needs a programmatic
            // driver, which the in-flight generation guard also protects
            // against regardless.
            disabled={state.routesKnown === "unknown" || state.switching}
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
            isDisabled={state.saving || state.switching}
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
