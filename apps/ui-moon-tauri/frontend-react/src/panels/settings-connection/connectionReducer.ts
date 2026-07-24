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
 * Mirrors the vanilla module's behavior 1:1:
 *  - `channelOptions`/`channel` start as the hardcoded ['stable','dev']
 *    fallback (C8: real routes replace them once MoonSession.listRoutes()
 *    resolves - see "routes-loaded").
 *  - `pendingActiveProfile` is the reducer-state equivalent of the vanilla
 *    module's `channelSelect._activeProfile` DOM stash: load_profiles may
 *    resolve before or after listRoutes, so "routes-loaded" reads it back
 *    off state instead of a side channel to decide whether the active
 *    profile must be appended as a dynamic option (C8's route-key/
 *    profile-name divergence case).
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

export interface ConnectionPanelState {
  readonly channelOptions: readonly ChannelOption[]
  readonly channel: string
  readonly channelError: string | null
  /** Reducer-state equivalent of the vanilla module's DOM-stashed
   *  `channelSelect._activeProfile` - see module doc. */
  readonly pendingActiveProfile: string | null
  readonly models: readonly ModelEntry[]
  readonly modelOptions: readonly ChannelOption[]
  readonly model: string
  readonly effortOptions: readonly string[]
  readonly effort: string
  readonly wsUrl: string
  readonly wsToken: string
  readonly saving: boolean
  readonly saveStatus: SaveStatus | null
}

export type ConnectionPanelAction =
  | { readonly type: "connection-loaded"; readonly wsUrl: string | null; readonly wsToken: string | null }
  | { readonly type: "profile-loaded"; readonly activeProfile: string }
  | { readonly type: "routes-loaded"; readonly options: readonly ChannelOption[]; readonly defaultKey: string | null }
  | { readonly type: "channel-selected"; readonly channel: string }
  | { readonly type: "profile-switch-succeeded"; readonly wsUrl: string; readonly wsToken: string }
  | { readonly type: "profile-switch-failed"; readonly message: string }
  | { readonly type: "model-selected"; readonly model: string; readonly effortOptions: readonly string[]; readonly effort: string }
  | { readonly type: "effort-selected"; readonly effort: string }
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
    models,
    modelOptions,
    model: savedModel,
    effortOptions,
    effort: savedEffort,
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
      return {
        ...state,
        wsUrl: action.wsUrl ? action.wsUrl : state.wsUrl,
        wsToken: action.wsToken !== null ? action.wsToken : state.wsToken,
      }
    }
    case "profile-loaded": {
      const active = action.activeProfile
      const hasOpt = state.channelOptions.some((o) => o.value === active)
      const channelOptions = hasOpt
        ? state.channelOptions
        : [...state.channelOptions, { value: active, label: capitalize(active) }]
      return { ...state, channelOptions, channel: active, pendingActiveProfile: active }
    }
    case "routes-loaded": {
      let options = action.options
      let channel = state.channel
      const active = state.pendingActiveProfile
      if (active) {
        // C8: client.toml route keys can diverge from profile names - keep
        // the active profile selectable even if listRoutes() didn't return it.
        if (!options.some((o) => o.value === active)) {
          options = [...options, { value: active, label: capitalize(active) }]
        }
        channel = active
      } else {
        const def = options.find((o) => o.value === action.defaultKey)
        channel = def ? def.value : (options[0]?.value ?? state.channel)
      }
      return { ...state, channelOptions: options, channel }
    }
    case "channel-selected":
      return { ...state, channel: action.channel, channelError: null }
    case "profile-switch-succeeded":
      return { ...state, channelError: null, wsUrl: action.wsUrl, wsToken: action.wsToken }
    case "profile-switch-failed":
      return { ...state, channelError: action.message }
    case "model-selected":
      return { ...state, model: action.model, effortOptions: action.effortOptions, effort: action.effort }
    case "effort-selected":
      return { ...state, effort: action.effort }
    case "url-changed":
      return { ...state, wsUrl: action.value }
    case "token-changed":
      return { ...state, wsToken: action.value }
    case "save-start":
      return { ...state, saving: true, saveStatus: { text: "Saving…", kind: null } }
    case "save-success":
      // Token field is intentionally NOT cleared - see module doc.
      return { ...state, saveStatus: { text: "Saved ✓", kind: "ok" } }
    case "save-error":
      return { ...state, saveStatus: { text: `Save failed: ${action.message}`, kind: "warn" } }
    case "save-settled":
      return { ...state, saving: false }
    default:
      return state
  }
}
