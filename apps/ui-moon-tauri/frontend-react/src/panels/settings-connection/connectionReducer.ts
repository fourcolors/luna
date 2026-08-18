/**
 * connectionReducer.ts - pure state/reducer for the Connection settings
 * panel's React port (frontend/panels/settings-connection.js ->
 * SettingsConnectionPanel.tsx).
 *
 * Framework-agnostic on purpose (no DOM, no React), consumed via
 * useLocalStore/useMoonSelector (src/state/store.ts) exactly like
 * agentsReducer.ts - every ctx.invoke() `.then()`/`.catch()` callback's whole
 * job is `store.dispatch(...)`; only SettingsConnectionPanel.tsx's render
 * return value decides what appears on screen, so there is exactly one
 * source of truth and it can never desync from a stray imperative DOM write
 * inside a transport callback (the pattern the vanilla module used).
 *
 * Mirrors the vanilla module's behavior 1:1 in the UN-MIGRATED world only
 * (routesKnown resolves to "none" there, never "routes" - see its doc
 * comment; it starts "unknown" at boot and the switch handler treats
 * "unknown" as a refusal, never as un-migrated, until it resolves):
 *  - `channelOptions`/`channel` start as the hardcoded ['stable','dev']
 *    fallback (C8: real routes replace them once MoonSession.listRoutes()
 *    resolves - see "routes-loaded").
 *  - `pendingActiveProfile` is the reducer-state equivalent of the vanilla
 *    module's `channelSelect._activeProfile` DOM stash.
 * Step 1a (docs/next/routes-and-view-mode-plan.md) QUARANTINES this once
 * client.toml routes exist: "routes-loaded" alone decides `channel`/
 * `channelOptions` from then on, in EITHER arrival order relative to
 * "profile-loaded" - see `routesKnown`'s doc comment on ConnectionPanelState
 * for the mechanism. This inverts the old C8 divergence behavior (a stale
 * `activeProfile` no longer gets appended as a selectable option once routes
 * are known) - see the inverted fence test in settings-connection-panel.test.tsx.
 *  - `models`/`modelOptions` are computed once at construction from
 *    localStorage (`luna_available_models` + `luna_model`), exactly like the
 *    vanilla module's synchronous DOM build; `model-selected` recomputes
 *    `effortOptions`/`effort` for the newly chosen model, clearing a saved
 *    effort that isn't valid for it.
 *  - the token field is never wiped on a successful save (see
 *    "save-success"): matches the vanilla module's documented behavior so
 *    the operator can confirm what was stored.
 */

export interface ChannelOption {
  readonly value: string
  readonly label: string
}

export interface ModelEntry {
  readonly id: string
  readonly label: string
  readonly efforts: readonly string[]
}

export interface SaveStatus {
  readonly text: string
  readonly kind: "ok" | "warn" | null
}

/** Named machine targets for Settings → Connection. jax-box is the intentional
 *  remote default (installer/README). Custom is freeform.
 *
 *  This Mac (loopback 127.0.0.1) is CUT until jax-box Connected is proven —
 *  writing loopback into moon-connection / .env / client.toml must not be the
 *  path operators use to get Connected. */
export type MachineTarget = "jax-box" | "this-mac" | "custom"

/** Gate for the named This Mac target. Keep false until jax-box Connected is proven. */
export const THIS_MAC_TARGET_ENABLED = false

export const MACHINE_TARGET_OPTIONS: readonly { value: MachineTarget; label: string }[] = [
  { value: "jax-box", label: "jax-box (default)" },
  ...(THIS_MAC_TARGET_ENABLED
    ? ([{ value: "this-mac", label: "This Mac" }] as const)
    : []),
  { value: "custom", label: "Custom URL" },
]

/** Stable=4753, dev=5753; other channel names default to the stable port. */
export function portForChannel(channel: string): number {
  return channel === "dev" ? 5753 : 4753
}

/** Canonical jax-box stable UI URL — installer / README default. */
export const JAX_BOX_STABLE_WS_URL = "ws://jax-box:4753/ui"

export function urlForMachineTarget(target: MachineTarget, channel: string): string {
  const port = portForChannel(channel)
  if (target === "this-mac") {
    // While gated, never emit loopback from a named target (adversary HOLD).
    if (!THIS_MAC_TARGET_ENABLED) return `ws://jax-box:${port}/ui`
    return `ws://127.0.0.1:${port}/ui`
  }
  // jax-box (and any caller that asked for the remote default)
  return `ws://jax-box:${port}/ui`
}

export function detectMachineTarget(url: string): MachineTarget {
  const trimmed = url.trim()
  if (/^wss?:\/\/jax-box(?:\.local)?:\d+\/ui\/?$/i.test(trimmed)) return "jax-box"
  // Loopback is Custom while This Mac is cut — do not revive the named option.
  if (/^wss?:\/\/127\.0\.0\.1:\d+\/ui\/?$/i.test(trimmed)) {
    return THIS_MAC_TARGET_ENABLED ? "this-mac" : "custom"
  }
  return "custom"
}

export interface ConnectionPanelState {
  readonly channelOptions: readonly ChannelOption[]
  readonly channel: string
  readonly channelError: string | null
  /** Reducer-state equivalent of the vanilla module's DOM-stashed
   *  `channelSelect._activeProfile` - see module doc. */
  readonly pendingActiveProfile: string | null
  /**
   * Step 1a quarantine flag (docs/next/routes-and-view-mode-plan.md),
   * TRI-STATE (opus review finding F3): boot starts in "unknown" - neither
   * confirmed migrated nor confirmed un-migrated - and the switch handler
   * treats "unknown" as a refusal (defense in depth: a change event that
   * somehow reaches the handler before boot's listRoutes settles must never
   * fall through to the un-guarded legacy branch on an unconfirmed
   * assumption). It resolves to exactly one of:
   *   "routes" - client.toml routes exist; "routes-loaded" alone decides
   *     `channel`/`channelOptions` from then on, in EITHER arrival order
   *     relative to "profile-loaded" (moon-connection.json's activeProfile,
   *     which can name a route-less or stale profile, is INERT once here).
   *   "none"   - confirmed un-migrated (listRoutes absent, returned nothing
   *     useful, or rejected); the legacy profile-loaded/switch behavior
   *     applies, byte-compatible with pre-Step-1a.
   * The select is disabled in the UI while "unknown" - see SettingsConnectionPanel.tsx.
   */
  readonly routesKnown: "unknown" | "routes" | "none"
  /**
   * True while a guarded route switch (routesKnown === "routes") is
   * in-flight. Disables the selector in the UI so a genuine second user
   * interaction cannot start a concurrent switch (F4) - reaching a
   * concurrent attempt requires a programmatic driver (a race, or a test),
   * which is exactly what the in-flight generation guard in
   * SettingsConnectionPanel.tsx protects against regardless. The un-migrated
   * legacy path does not use this: it is a single un-guarded write with no
   * dual-store half-move for a race to exploit.
   */
  readonly switching: boolean
  readonly models: readonly ModelEntry[]
  readonly modelOptions: readonly ChannelOption[]
  readonly model: string
  readonly effortOptions: readonly string[]
  readonly effort: string
  /** Named machine target — drives the WS URL for jax-box (This Mac gated off). */
  readonly machineTarget: MachineTarget
  /**
   * When true, Save also sets activeProfile + client.toml default to the
   * selected channel (mirrors `luna pair --activate`). Off by default so
   * editing a non-active channel's URL never hijacks the running Moon.
   */
  readonly activateOnSave: boolean
  readonly wsUrl: string
  readonly wsToken: string
  readonly saving: boolean
  readonly saveStatus: SaveStatus | null
}

export type ConnectionPanelAction =
  | { readonly type: "connection-loaded"; readonly wsUrl: string | null; readonly wsToken: string | null }
  | { readonly type: "profile-loaded"; readonly activeProfile: string }
  | { readonly type: "routes-loaded"; readonly options: readonly ChannelOption[]; readonly defaultKey: string | null }
  /** F3: listRoutes confirmed there is nothing usable (absent, empty result,
   *  or rejected) - resolves routesKnown from "unknown" to "none". */
  | { readonly type: "routes-unavailable" }
  | { readonly type: "channel-selected"; readonly channel: string }
  | { readonly type: "profile-switch-succeeded"; readonly wsUrl: string; readonly wsToken: string }
  /**
   * F2(b): a refusal that is NOT the pairing case. `revertTo`, when given,
   * restores `channel` to what it was before the optimistic
   * "channel-selected" dispatch - the switch never happened, so the
   * selector must not keep claiming it did. Omitted for the un-migrated
   * legacy path, which never reverts (byte-compatible with pre-Step-1a).
   */
  | { readonly type: "profile-switch-failed"; readonly message: string; readonly revertTo?: string }
  /**
   * F2(a): the UNPAIRED-route refusal (guard 2). Deliberately its own action,
   * not a reuse of profile-switch-succeeded or -failed: the selection stays
   * on the target route (this is the pairing UX - see the module doc), but
   * the displayed creds must be HONEST about what that means - the target
   * route's real endpoint, and an EMPTY token (never the previous channel's
   * stale creds, which would describe the wrong server).
   */
  | { readonly type: "pairing-prompted"; readonly message: string; readonly wsUrl: string }
  /** F4: in-flight marker for a guarded switch, drives the selector's
   *  `disabled` state so a second user interaction cannot start a
   *  concurrent switch (see routesKnown/switching's doc comments). */
  | { readonly type: "switch-started" }
  | { readonly type: "switch-settled" }
  | { readonly type: "model-selected"; readonly model: string; readonly effortOptions: readonly string[]; readonly effort: string }
  | { readonly type: "effort-selected"; readonly effort: string }
  | { readonly type: "machine-target-selected"; readonly target: MachineTarget }
  | { readonly type: "activate-on-save-changed"; readonly value: boolean }
  | { readonly type: "url-changed"; readonly value: string }
  | { readonly type: "token-changed"; readonly value: string }
  | { readonly type: "save-start" }
  | { readonly type: "save-success" }
  | { readonly type: "save-error"; readonly message: string }
  | { readonly type: "save-settled" }

export const FALLBACK_CHANNEL_OPTIONS: readonly ChannelOption[] = [
  { value: "stable", label: "Stable" },
  { value: "dev", label: "Dev" },
]

export function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

/** Back-compat: old cache = array of id strings; new cache = array of
 *  {id, label, efforts} objects (written by applyAvailableModels in
 *  chat.html) - ported verbatim from the vanilla module. */
function readAvailableModels(): ModelEntry[] {
  const raw = localStorage.getItem("luna_available_models")
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return [] // malformed - ignore
  }
  if (!Array.isArray(parsed)) return []
  const out: ModelEntry[] = []
  for (const entry of parsed) {
    if (!entry) continue
    if (typeof entry === "string") {
      out.push({ id: entry, label: entry, efforts: [] })
      continue
    }
    if (typeof entry === "object") {
      const e = entry as { id?: unknown; label?: unknown; efforts?: unknown }
      if (typeof e.id === "string" && e.id) {
        out.push({
          id: e.id,
          label: typeof e.label === "string" && e.label ? e.label : e.id,
          efforts: Array.isArray(e.efforts) ? (e.efforts as string[]) : [],
        })
      }
    }
  }
  return out
}

/** Synchronous initial snapshot - mirrors the vanilla module's synchronous
 *  DOM build at render() time (before any ctx.invoke() resolves). */
export function initialConnectionPanelState(): ConnectionPanelState {
  const models = readAvailableModels()
  const savedModel = localStorage.getItem("luna_model") || ""

  const modelOptions: ChannelOption[] = models.map((m) => ({ value: m.id, label: m.label }))
  if (savedModel && !models.some((m) => m.id === savedModel)) {
    modelOptions.push({ value: savedModel, label: `${savedModel} (custom)` })
  }

  const selectedEntry = models.find((m) => m.id === savedModel) ?? null
  const effortOptions = selectedEntry?.efforts ?? []
  const savedEffort = localStorage.getItem("luna_effort") || ""

  return {
    channelOptions: FALLBACK_CHANNEL_OPTIONS,
    channel: FALLBACK_CHANNEL_OPTIONS[0]!.value,
    channelError: null,
    pendingActiveProfile: null,
    routesKnown: "unknown",
    switching: false,
    models,
    modelOptions,
    model: savedModel,
    effortOptions,
    effort: savedEffort,
    machineTarget: "jax-box",
    activateOnSave: false,
    wsUrl: "",
    wsToken: "",
    saving: false,
    saveStatus: null,
  }
}

export function reduceConnectionPanel(
  state: ConnectionPanelState,
  action: ConnectionPanelAction,
): ConnectionPanelState {
  switch (action.type) {
    case "connection-loaded": {
      const wsUrl = action.wsUrl ? action.wsUrl : state.wsUrl
      return {
        ...state,
        wsUrl,
        wsToken: action.wsToken !== null ? action.wsToken : state.wsToken,
        machineTarget: action.wsUrl ? detectMachineTarget(action.wsUrl) : state.machineTarget,
      }
    }
    case "profile-loaded": {
      const active = action.activeProfile
      if (state.routesKnown === "routes") {
        // Step 1a quarantine (see routesKnown's doc comment): routes-loaded
        // already owns channel/channelOptions - stash the profile pointer
        // for callers that inspect pendingActiveProfile, but do not let a
        // possibly-stale/divergent moon-connection.json name reappend an
        // option or move the selection.
        return { ...state, pendingActiveProfile: active }
      }
      // routesKnown is "unknown" or "none": legacy behavior, still required
      // for the un-migrated world (and safe pre-boot-settle too, since a
      // real un-migrated user never later flips to "routes").
      const hasOpt = state.channelOptions.some((o) => o.value === active)
      const channelOptions = hasOpt
        ? state.channelOptions
        : [...state.channelOptions, { value: active, label: capitalize(active) }]
      return { ...state, channelOptions, channel: active, pendingActiveProfile: active }
    }
    case "routes-loaded": {
      // Step 1a quarantine, INVERTED from the pre-Step-1a C8 behavior this
      // replaces (docs/next/routes-and-view-mode-plan.md): channelOptions is
      // EXACTLY the route keys client.toml reports - no dynamic append of
      // pendingActiveProfile - and channel is action.defaultKey, regardless
      // of arrival order relative to "profile-loaded". This is what makes
      // the selector's value and options come from client.toml alone once
      // routes exist.
      //
      // F1 (opus review): defaultKey must be validated as an ACTUAL member
      // of `options` via `.find`, not taken on faith with a bare `??`. A
      // dangling default (Gate 0.1 world (c)) or an empty-string default
      // must fall through to the first real option instead of becoming the
      // selector's value outright - a bare `defaultKey ?? options[0]` lets
      // a non-null-but-invalid key (including "") through unchanged, which
      // renders as a BLANK selector (no matching <option>, selectedIndex
      // -1) rather than a sane default.
      const options = action.options
      const channel = options.find((o) => o.value === action.defaultKey)?.value
        ?? (options[0]?.value ?? state.channel)
      return { ...state, channelOptions: options, channel, routesKnown: "routes" }
    }
    case "routes-unavailable":
      return { ...state, routesKnown: "none" }
    case "channel-selected": {
      // Named targets recompute the URL for the new channel's port; Custom
      // keeps whatever the operator typed.
      const channel = action.channel
      if (state.machineTarget === "custom") {
        return { ...state, channel, channelError: null }
      }
      return {
        ...state,
        channel,
        channelError: null,
        wsUrl: urlForMachineTarget(state.machineTarget, channel),
      }
    }
    case "profile-switch-succeeded": {
      const wsUrl = action.wsUrl
      return {
        ...state,
        channelError: null,
        wsUrl,
        wsToken: action.wsToken,
        machineTarget: detectMachineTarget(wsUrl),
      }
    }
    case "profile-switch-failed":
      return { ...state, channelError: action.message, channel: action.revertTo ?? state.channel }
    case "pairing-prompted":
      return {
        ...state,
        channelError: action.message,
        wsUrl: action.wsUrl,
        wsToken: "",
        machineTarget: detectMachineTarget(action.wsUrl),
      }
    case "switch-started":
      return { ...state, switching: true }
    case "switch-settled":
      return { ...state, switching: false }
    case "model-selected":
      return { ...state, model: action.model, effortOptions: action.effortOptions, effort: action.effort }
    case "effort-selected":
      return { ...state, effort: action.effort }
    case "machine-target-selected": {
      let target = action.target
      // Refuse to select This Mac while the gate is off.
      if (target === "this-mac" && !THIS_MAC_TARGET_ENABLED) {
        target = "jax-box"
      }
      if (target === "custom") {
        return { ...state, machineTarget: target }
      }
      return {
        ...state,
        machineTarget: target,
        wsUrl: urlForMachineTarget(target, state.channel),
      }
    }
    case "activate-on-save-changed":
      return { ...state, activateOnSave: action.value }
    case "url-changed":
      return {
        ...state,
        wsUrl: action.value,
        // Typing freely flips to Custom so the named target doesn't fight the field.
        machineTarget: "custom",
      }
    case "token-changed":
      return { ...state, wsToken: action.value }
    case "save-start":
      return { ...state, saving: true, saveStatus: { text: "Saving…", kind: null } }
    case "save-success":
      // Token field is intentionally NOT cleared - see module doc.
      return {
        ...state,
        saveStatus: {
          text: "Saved ✓ — Moon + luna chat will dial this host (reconnect if already connected)",
          kind: "ok",
        },
      }
    case "save-error":
      return { ...state, saveStatus: { text: `Save failed: ${action.message}`, kind: "warn" } }
    case "save-settled":
      return { ...state, saving: false }
    default:
      return state
  }
}
