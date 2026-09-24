/**
 * logic.ts - pure state/constants for the Models settings panel, ported 1:1
 * from apps/ui-moon-tauri/frontend/panels/settings-models.js (no DOM, no
 * transport - safe to unit test in isolation and safe to reuse from
 * SettingsModelsPanel.tsx via useReducer).
 *
 * STATE SOURCE (why this doesn't touch src/state/store.ts): model-routing
 * settings (providers/roleBindings/draft edits/save status) have no
 * representation in the shared @luna/ui-shared reducer (see UIState in
 * packages/ui-shared/src/reducer.ts) - that reducer's domain is chat/thread
 * state (see its own SCOPE NOTE). This panel's WS frames
 * (model-routing-list/-status, see packages/ui-shared/src/wire.ts) are
 * panel-local and single-consumer, so state lives in a local useReducer
 * (mirrors store.ts's own reduce-over-actions shape) rather than the shared
 * store - every mutation goes through a dispatched action and a re-render,
 * never a direct DOM write, matching the "consume state via a reducer, don't
 * poke the DOM from transport callbacks" rule store.ts itself follows.
 *
 * Role defaults (v1):
 *   advisor      -> claude-opus-4-8   (most capable)
 *   daily-driver -> claude-sonnet-5   (balanced default)
 *   wake         -> claude-sonnet-4-6 (cheapest capable)
 *   dream        -> claude-haiku-4-5  (cheapest)
 *
 * OpenAI / Google are present-but-gated provider slots: shown with a
 * "validated when key + gateway present" notice; this port doesn't filter
 * role model options by lane, matching the vanilla module's shipped
 * behavior (see its render() role loop).
 */
import type { MemoryRerankerSettingsItem, ProviderSettingsItem, RoleBindingItem } from "@luna/ui-shared/core"

export const ROLES = ["advisor", "daily-driver", "wake", "dream"] as const
export type Role = (typeof ROLES)[number]

export const ROLE_LABELS: Record<Role, string> = {
  advisor: "Advisor (pro-level reasoning)",
  "daily-driver": "Daily Driver (chat & tasks)",
  wake: "Wake (morning brief)",
  dream: "Dream (nightly synthesis)",
}

export const DEFAULT_ROLE_MODEL: Record<Role, string> = {
  advisor: "claude-opus-4-8",
  "daily-driver": "claude-sonnet-5",
  wake: "claude-sonnet-4-6",
  dream: "claude-haiku-4-5",
}

export interface ProviderDef {
  readonly kind: string
  readonly label: string
  readonly gated: boolean
}

export const PROVIDERS: readonly ProviderDef[] = [
  { kind: "anthropic", label: "Anthropic", gated: false },
  { kind: "openai", label: "OpenAI", gated: true },
  { kind: "google", label: "Google Gemini", gated: true },
  { kind: "ollama-cloud", label: "Ollama Cloud", gated: false },
  { kind: "ollama-local", label: "Ollama Local", gated: false },
]

export interface ModelOption {
  readonly id: string
  readonly label: string
}

export const ANTHROPIC_MODELS: readonly ModelOption[] = [
  { id: "claude-sonnet-5", label: "Claude Sonnet 5 - balanced default" },
  { id: "claude-fable-5", label: "Claude Fable 5 - 1M context, xhigh reasoning" },
  { id: "claude-fable-5-1", label: "Claude Fable 5.1 - 1M context, xhigh reasoning" },
  { id: "claude-mythos-5", label: "Claude Mythos 5 - 1M context, first-party only" },
  { id: "claude-opus-5", label: "Claude Opus 5 - 1M context, xhigh reasoning" },
  { id: "claude-opus-4-8", label: "Claude Opus 4.8 - most capable" },
  { id: "claude-opus-4-7", label: "Claude Opus 4.7 - prior gen" },
  { id: "claude-opus-4-6", label: "Claude Opus 4.6 - prior gen" },
  { id: "claude-opus-4-5", label: "Claude Opus 4.5 - prior gen" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 - prior gen" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 - fastest" },
]

/**
 * Memory reranker engines, in display order (see packages/memory/bench/README.md
 * "Choosing the rerank engine"). The server validates against the same set.
 */
export const RERANKERS = [
  { engine: "cross-encoder", label: "Local cross-encoder" },
  { engine: "jev", label: "Jev (TypeSafe)" },
] as const

/** A reported engine the panel can show; anything unknown is shown as the local cross-encoder, which is what the server binds for it. */
function knownReranker(engine: string): string {
  return RERANKERS.some((r) => r.engine === engine) ? engine : "cross-encoder"
}

/** Display label for an engine id. */
export function rerankerLabel(engine: string): string {
  return RERANKERS.find((r) => r.engine === engine)?.label ?? engine
}

export interface ProviderDraft {
  enabled: boolean
  credentialRef: string
  /** '' means "not set" (mirrors the vanilla module's empty-string sentinel). */
  monthlyCapUsd: number | ""
}

export type ProvidersDraft = Record<string, ProviderDraft>
export type RoleModelDraft = Record<string, string>

export interface StatusMessage {
  readonly message: string
  readonly kind: "ok" | "error" | "info"
}

export interface ModelRoutingState {
  readonly serverSupports: boolean
  readonly isDirty: boolean
  readonly draftProviders: ProvidersDraft
  readonly draftRoleModel: RoleModelDraft
  /** Memory reranker engine; null = the server does not offer the setting (older server: hide it). */
  readonly draftReranker: string | null
  /** The engine the server reported for its next start: a save sends the reranker only when the draft differs,
   *  so an untouched control never freezes today's (possibly env-derived) engine into the store. */
  readonly serverReranker: string | null
  /** The engine the running server bound; differs from serverReranker until a restart. */
  readonly activeReranker: string | null
  readonly reqId: string | null
  readonly status: StatusMessage | null
}

function defaultProviderDraft(): ProviderDraft {
  return { enabled: false, credentialRef: "", monthlyCapUsd: "" }
}

function defaultDraftProviders(): ProvidersDraft {
  const drafts: ProvidersDraft = {}
  for (const p of PROVIDERS) drafts[p.kind] = defaultProviderDraft()
  return drafts
}

function defaultDraftRoleModel(): RoleModelDraft {
  const drafts: RoleModelDraft = {}
  for (const r of ROLES) drafts[r] = DEFAULT_ROLE_MODEL[r]
  return drafts
}

export const initialModelRoutingState: ModelRoutingState = {
  serverSupports: false,
  isDirty: false,
  draftProviders: defaultDraftProviders(),
  draftRoleModel: defaultDraftRoleModel(),
  draftReranker: null,
  serverReranker: null,
  activeReranker: null,
  reqId: null,
  status: null,
}

/**
 * Derive draft state from a fresh `model-routing-list` frame. Ported from
 * the vanilla module's applyServerState(): missing provider drafts fall back
 * to disabled defaults, missing role drafts fall back to DEFAULT_ROLE_MODEL.
 */
function draftsFromServerState(
  providers: ReadonlyArray<ProviderSettingsItem>,
  roleBindings: ReadonlyArray<RoleBindingItem>,
): { draftProviders: ProvidersDraft; draftRoleModel: RoleModelDraft } {
  const draftProviders: ProvidersDraft = {}
  for (const p of providers) {
    draftProviders[p.kind] = {
      enabled: !!p.enabled,
      credentialRef: p.credentialRef || "",
      monthlyCapUsd: typeof p.monthlyCapUsd === "number" ? p.monthlyCapUsd : "",
    }
  }
  for (const pd of PROVIDERS) {
    if (!draftProviders[pd.kind]) draftProviders[pd.kind] = defaultProviderDraft()
  }

  const draftRoleModel: RoleModelDraft = {}
  for (const rb of roleBindings) {
    const first = rb.preferenceList && rb.preferenceList[0]
    if (first && first.model) draftRoleModel[rb.role] = first.model
  }
  for (const r of ROLES) {
    if (!draftRoleModel[r]) draftRoleModel[r] = DEFAULT_ROLE_MODEL[r]
  }
  return { draftProviders, draftRoleModel }
}

/** Ported from the vanilla module's providerForModel(): simple prefix rules. */
export function providerForModel(model: string): string {
  if (/^claude/i.test(model) || /^anthropic/i.test(model)) return "anthropic"
  if (/^gemini/i.test(model)) return "google"
  if (/^gpt/i.test(model) || /^o[0-9]/i.test(model)) return "openai"
  if (/:cloud$/i.test(model)) return "ollama-cloud"
  if (/^local\//i.test(model)) return "ollama-local"
  return "anthropic"
}

export interface ModelRoutingSavePayload {
  providers: ProviderSettingsItem[]
  roleBindings: RoleBindingItem[]
  /** Only when the server offers the setting: an older server must not receive a field it would ignore. */
  memoryReranker?: MemoryRerankerSettingsItem
}

/** Ported from the vanilla module's buildPayload(). */
export function buildSavePayload(state: ModelRoutingState): ModelRoutingSavePayload {
  const payProviders: ProviderSettingsItem[] = PROVIDERS.map((pd) => {
    const d = state.draftProviders[pd.kind] || defaultProviderDraft()
    const p: { kind: string; enabled: boolean; credentialRef?: string; monthlyCapUsd?: number } = {
      kind: pd.kind,
      enabled: !!d.enabled,
    }
    if (d.credentialRef && d.credentialRef.trim()) p.credentialRef = d.credentialRef.trim()
    if (typeof d.monthlyCapUsd === "number" && d.monthlyCapUsd > 0) p.monthlyCapUsd = d.monthlyCapUsd
    return p
  })
  const payBindings: RoleBindingItem[] = ROLES.map((r) => {
    const model = state.draftRoleModel[r] || DEFAULT_ROLE_MODEL[r]
    const provider = providerForModel(model)
    return { role: r, preferenceList: [{ provider, model }] }
  })
  return {
    providers: payProviders,
    roleBindings: payBindings,
    ...(state.draftReranker !== null && state.draftReranker !== state.serverReranker
      ? { memoryReranker: { engine: state.draftReranker } }
      : {}),
  }
}

export type ModelRoutingAction =
  | { type: "hello"; modelRouting: boolean }
  | {
      type: "server-list"
      providers: ReadonlyArray<ProviderSettingsItem>
      roleBindings: ReadonlyArray<RoleBindingItem>
      memoryReranker?: MemoryRerankerSettingsItem
    }
  | { type: "set-reranker"; engine: string }
  | { type: "toggle-provider"; kind: string; enabled: boolean }
  | { type: "set-credential-ref"; kind: string; value: string }
  | { type: "set-monthly-cap"; kind: string; value: number | "" }
  | { type: "set-role-model"; role: string; model: string }
  | { type: "save-start"; requestId: string }
  | { type: "save-rejected" }
  | { type: "save-result"; requestId: string; ok: boolean; message: string }
  | { type: "not-connected" }

function patchProviderDraft(state: ModelRoutingState, kind: string, patch: Partial<ProviderDraft>): ProvidersDraft {
  const existing = state.draftProviders[kind] || defaultProviderDraft()
  return { ...state.draftProviders, [kind]: { ...existing, ...patch } }
}

export function reduceModelRouting(state: ModelRoutingState, action: ModelRoutingAction): ModelRoutingState {
  switch (action.type) {
    case "hello":
      return { ...state, serverSupports: action.modelRouting }

    case "server-list": {
      // isDirty: preserve unsaved draft edits, only refresh the backing
      // arrays - ported from the vanilla module's applyServerState().
      if (state.isDirty) return state
      const { draftProviders, draftRoleModel } = draftsFromServerState(action.providers, action.roleBindings)
      const reported = action.memoryReranker === undefined ? null : knownReranker(action.memoryReranker.engine)
      const active = action.memoryReranker?.active === undefined ? null : knownReranker(action.memoryReranker.active)
      return { ...state, draftProviders, draftRoleModel, draftReranker: reported, serverReranker: reported, activeReranker: active }
    }

    case "set-reranker":
      if (state.draftReranker === null || action.engine === state.draftReranker) return state
      return { ...state, isDirty: true, draftReranker: action.engine }

    case "toggle-provider":
      return {
        ...state,
        isDirty: true,
        draftProviders: patchProviderDraft(state, action.kind, { enabled: action.enabled }),
      }

    case "set-credential-ref":
      return {
        ...state,
        isDirty: true,
        draftProviders: patchProviderDraft(state, action.kind, { credentialRef: action.value }),
      }

    case "set-monthly-cap":
      return {
        ...state,
        isDirty: true,
        draftProviders: patchProviderDraft(state, action.kind, { monthlyCapUsd: action.value }),
      }

    case "set-role-model":
      return {
        ...state,
        isDirty: true,
        draftRoleModel: { ...state.draftRoleModel, [action.role]: action.model },
      }

    case "save-start":
      return { ...state, reqId: action.requestId, status: { message: "Saving…", kind: "info" } }

    case "save-rejected":
      return { ...state, reqId: null, status: { message: "Not connected to a server.", kind: "error" } }

    case "save-result": {
      if (action.requestId !== state.reqId) return state
      return {
        ...state,
        reqId: null,
        // Save confirmed - safe to accept server-pushed state again.
        isDirty: action.ok ? false : state.isDirty,
        status: {
          message: action.message || (action.ok ? "Saved. Server restarting…" : "Could not save settings."),
          kind: action.ok ? "ok" : "error",
        },
      }
    }

    case "not-connected":
      return { ...state, status: { message: "Not connected to a server.", kind: "error" } }

    default:
      return state
  }
}
