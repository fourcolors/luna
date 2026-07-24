/**
 * vaultReducer.ts - pure state/reducer for the Vault settings panel's React
 * port (frontend/panels/settings-vault.js -> SettingsVaultPanel.tsx).
 *
 * Framework-agnostic on purpose (no DOM, no React), consumed via
 * useLocalStore/useMoonSelector (../../state/store.ts) exactly like
 * connectionReducer.ts - every WS frame handler's and every submit
 * function's whole job is `store.dispatch(...)`; only
 * SettingsVaultPanel.tsx's render return value decides what appears on
 * screen, so a typed secret can never be poked into the DOM from a transport
 * callback (the pattern the vanilla module used, and the security property
 * this port must preserve - see that module's SECURITY doc comment).
 *
 * SCOPE SPLIT vs. the shared @luna/ui-shared store:
 *   - `vaultItems` / `vaultSync` / `vaultStorage` are SERVER-AUTHORITATIVE
 *     domain state, already modeled by packages/ui-shared/src/reducer.ts's
 *     "vault-list" case (mirrors settings-skills's `skills` split) - the
 *     panel reads those off useMoonStore(), not this reducer.
 *   - Everything here is panel-local UI state with no shared-store
 *     representation: the add-form fields (the ONLY place a typed secret
 *     ever lives client-side), the two-step delete confirm, the 1Password
 *     sync form's EDITABLE fields (fill-if-empty + dirty-flag guarded, since
 *     `vaultSync` itself is server-authoritative but the inputs must not
 *     clobber an in-progress edit), the legacy op-token form, and the
 *     in-flight requestId slots (`reqId`/`reqKind`, `syncReqId`, `opReqId`)
 *     used to correlate `vault-status` / `register-op-token-status` acks -
 *     ported verbatim from the vanilla module's closure-scoped slots.
 *
 * "vault-status-received" ports `handleStatus` 1:1: it first tries the sync
 * slot (independent from the add-form slot, so a racing add-form put and a
 * sync save can both be in-flight without orphaning each other), then falls
 * through to the add-form/delete slot, silently ignoring a stale/unmatched
 * requestId either way.
 */

export type StatusKind = "ok" | "error" | "info"

export interface StatusLine {
  readonly text: string
  readonly kind: StatusKind
}

export type VaultKind = "env-secret" | "op-token"

export interface VaultStatusFrameLike {
  readonly requestId?: unknown
  readonly ok?: unknown
  readonly message?: unknown
}

export interface VaultListItemLike {
  readonly id?: unknown
}

export interface VaultSyncLike {
  readonly enabled?: unknown
  readonly opLabel?: unknown
  readonly opVault?: unknown
  readonly pollSeconds?: unknown
}

export interface VaultStorageLike {
  readonly writeTier?: unknown
  readonly onePassword?: unknown
  readonly envResidue?: unknown
}

export interface VaultPanelState {
  readonly kind: VaultKind
  readonly name: string
  readonly varOverride: boolean
  readonly varInput: string
  readonly labelInput: string
  /** THE secret value - lives here and only here until the OPEN-guarded
   *  send, wiped one-shot on submit-add-started and on socket close. */
  readonly valueInput: string
  readonly descInput: string
  readonly statusLine: StatusLine | null
  readonly confirmId: string | null
  readonly reqId: string | null
  readonly reqKind: "put" | "put-op-token" | "delete" | null
  readonly syncEnabled: boolean
  readonly syncCheckboxDirty: boolean
  readonly syncOpLabel: string
  readonly syncOpVault: string
  readonly syncPoll: number | null
  readonly syncStatus: StatusLine | null
  readonly syncReqId: string | null
  readonly opLabelInput: string
  /** THE legacy-form secret - wiped one-shot on op-submit-started and on
   *  socket close, exactly like `valueInput`. */
  readonly opTokenInput: string
  readonly opStatus: StatusLine | null
  readonly opReqId: string | null
}

export type VaultPanelAction =
  | { readonly type: "name-changed"; readonly value: string }
  | { readonly type: "kind-changed"; readonly value: VaultKind }
  | { readonly type: "var-override-toggled" }
  | { readonly type: "var-input-changed"; readonly value: string }
  | { readonly type: "label-input-changed"; readonly value: string }
  | { readonly type: "value-input-changed"; readonly value: string }
  | { readonly type: "desc-input-changed"; readonly value: string }
  | { readonly type: "status-set"; readonly text: string; readonly kind: StatusKind }
  | { readonly type: "status-cleared" }
  | { readonly type: "submit-add-started"; readonly requestId: string; readonly isOpToken: boolean }
  | { readonly type: "delete-armed"; readonly id: string }
  | { readonly type: "delete-cancelled" }
  | { readonly type: "delete-started"; readonly requestId: string }
  | { readonly type: "vault-status-received"; readonly frame: VaultStatusFrameLike }
  | { readonly type: "vault-list-received"; readonly items: ReadonlyArray<VaultListItemLike> }
  | { readonly type: "sync-list-received"; readonly sync: VaultSyncLike | null }
  | { readonly type: "capability-lost" }
  | { readonly type: "sync-enabled-toggled"; readonly checked: boolean }
  | { readonly type: "sync-op-label-changed"; readonly value: string }
  | { readonly type: "sync-op-vault-changed"; readonly value: string }
  | { readonly type: "sync-poll-changed"; readonly value: number | null }
  | { readonly type: "sync-save-started"; readonly requestId: string }
  | { readonly type: "op-label-input-changed"; readonly value: string }
  | { readonly type: "op-token-input-changed"; readonly value: string }
  | { readonly type: "op-submit-started"; readonly requestId: string }
  | { readonly type: "op-status-set"; readonly text: string; readonly kind: StatusKind }
  | { readonly type: "op-status-received"; readonly frame: VaultStatusFrameLike }
  | { readonly type: "socket-closed" }

export function initialVaultPanelState(): VaultPanelState {
  return {
    kind: "env-secret",
    name: "",
    varOverride: false,
    varInput: "",
    labelInput: "",
    valueInput: "",
    descInput: "",
    statusLine: null,
    confirmId: null,
    reqId: null,
    reqKind: null,
    syncEnabled: false,
    syncCheckboxDirty: false,
    syncOpLabel: "",
    syncOpVault: "Luna",
    syncPoll: 300,
    syncStatus: null,
    syncReqId: null,
    opLabelInput: "",
    opTokenInput: "",
    opStatus: null,
    opReqId: null,
  }
}

/** 'Notion API Key' → 'NOTION_API_KEY' (best-effort; validated before send).
 *  Ported verbatim from the vanilla module's deriveVarName. */
export function deriveVarName(name: string): string {
  let v = String(name || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
  if (/^[0-9]/.test(v)) v = "_" + v
  return v
}

/** Mirrors the vanilla module's effectiveVarName(): the manual override wins
 *  when armed and non-empty, else fall back to the derived name. */
export function effectiveVarName(state: VaultPanelState): string {
  const override = state.varOverride ? state.varInput.trim() : ""
  return override || deriveVarName(state.name)
}

/** Human phrasing for where a new secret will land - ported verbatim. */
export function writeTierLabel(tier: unknown): string {
  if (tier === "keychain") return "New secrets → macOS Keychain"
  if (tier === "luna-vault") return "New secrets → Luna encrypted vault"
  return "New secrets → plaintext .env (LUNA_VAULT_STORAGE=env)"
}

/** Rebuild the compact storage status line text from a VaultStorageWire
 *  frame - ported verbatim from the vanilla module's renderStorage(). Callers
 *  hide the line entirely when `storage` is null (pre-W2 server). */
export function storageLineText(storage: VaultStorageLike): string {
  let text = writeTierLabel(storage.writeTier)
  if (storage.onePassword === "active") {
    text += " · 1Password: connected"
  } else if (storage.onePassword === "detected") {
    text += " · 1Password: CLI detected - connect a service account to use it"
  }
  const residue = Number(storage.envResidue) || 0
  if (residue > 0) {
    text += " · " + residue + " secret" + (residue === 1 ? "" : "s") +
      " still in plaintext .env - run the migration script to secure them"
  }
  return text
}

/** prefix + a UUID (dashes stripped) when available, else a random fallback -
 *  ported verbatim from the vanilla module's newReqId(). */
export function newReqId(prefix: string): string {
  const c = (globalThis as { crypto?: Crypto }).crypto
  const uuid = c && typeof c.randomUUID === "function" ? c.randomUUID().replace(/-/g, "") : null
  return prefix + (uuid ?? Math.random().toString(36).slice(2))
}

const GENERIC_OK = "Saved."
const GENERIC_FAIL = "That didn’t work — try again."

export function reduceVaultPanel(state: VaultPanelState, action: VaultPanelAction): VaultPanelState {
  switch (action.type) {
    case "name-changed":
      return { ...state, name: action.value }
    case "kind-changed":
      return { ...state, kind: action.value }
    case "var-override-toggled": {
      const next = !state.varOverride
      const varInput = next && !state.varInput ? deriveVarName(state.name) : state.varInput
      return { ...state, varOverride: next, varInput }
    }
    case "var-input-changed":
      return { ...state, varInput: action.value }
    case "label-input-changed":
      return { ...state, labelInput: action.value }
    case "value-input-changed":
      return { ...state, valueInput: action.value }
    case "desc-input-changed":
      return { ...state, descInput: action.value }
    case "status-set":
      return { ...state, statusLine: { text: action.text, kind: action.kind } }
    case "status-cleared":
      return { ...state, statusLine: null }
    case "submit-add-started":
      return {
        ...state,
        reqId: action.requestId,
        reqKind: action.isOpToken ? "put-op-token" : "put",
        statusLine: {
          text: action.isOpToken ? "Verifying… the server will restart briefly." : "Saving…",
          kind: "info",
        },
        valueInput: "", // one-shot — the value is never retained client-side
      }
    case "delete-armed":
      return { ...state, confirmId: action.id }
    case "delete-cancelled":
      return { ...state, confirmId: null }
    case "delete-started":
      return {
        ...state,
        reqId: action.requestId,
        reqKind: "delete",
        confirmId: null,
        statusLine: { text: "Removing…", kind: "info" },
      }
    case "vault-status-received": {
      const frame = action.frame
      // ── sync slot (independent from the add-form slot) ──────────────────
      if (state.syncReqId && frame.requestId === state.syncReqId) {
        return {
          ...state,
          syncReqId: null,
          syncCheckboxDirty: frame.ok ? false : state.syncCheckboxDirty,
          syncStatus: {
            text: frame.ok ? (typeof frame.message === "string" && frame.message ? frame.message : GENERIC_OK)
              : (typeof frame.message === "string" && frame.message ? frame.message : GENERIC_FAIL),
            kind: frame.ok ? "ok" : "error",
          },
        }
      }
      // ── add-form / delete slot ───────────────────────────────────────────
      if (!state.reqId || frame.requestId !== state.reqId) return state
      const wasPut = state.reqKind === "put" || state.reqKind === "put-op-token"
      const statusLine: StatusLine = {
        text: frame.ok ? (typeof frame.message === "string" && frame.message ? frame.message : GENERIC_OK)
          : (typeof frame.message === "string" && frame.message ? frame.message : GENERIC_FAIL),
        kind: frame.ok ? "ok" : "error",
      }
      if (frame.ok && wasPut) {
        return {
          ...state,
          reqId: null,
          reqKind: null,
          statusLine,
          name: "",
          varInput: "",
          labelInput: "",
          descInput: "",
          valueInput: "",
          varOverride: false,
        }
      }
      return { ...state, reqId: null, reqKind: null, statusLine }
    }
    case "vault-list-received": {
      if (state.confirmId && !action.items.some((i) => i.id === state.confirmId)) {
        return { ...state, confirmId: null }
      }
      return state
    }
    case "sync-list-received": {
      const sync = action.sync
      const syncEnabled = state.syncCheckboxDirty ? state.syncEnabled : !!(sync && sync.enabled)
      const syncOpLabel = !state.syncOpLabel && sync && typeof sync.opLabel === "string" && sync.opLabel
        ? sync.opLabel
        : state.syncOpLabel
      const syncOpVault = !state.syncOpVault && sync && typeof sync.opVault === "string" && sync.opVault
        ? sync.opVault
        : state.syncOpVault
      const syncPoll = state.syncPoll === null || state.syncPoll === 300
        ? Math.max(60, sync && typeof sync.pollSeconds === "number" ? sync.pollSeconds : 300)
        : state.syncPoll
      return { ...state, syncEnabled, syncOpLabel, syncOpVault, syncPoll }
    }
    case "capability-lost":
      return {
        ...state,
        confirmId: null,
        reqId: null,
        reqKind: null,
        syncReqId: null,
        syncCheckboxDirty: false,
        valueInput: "",
        statusLine: null,
        syncStatus: null,
      }
    case "sync-enabled-toggled":
      return { ...state, syncEnabled: action.checked, syncCheckboxDirty: true }
    case "sync-op-label-changed":
      return { ...state, syncOpLabel: action.value }
    case "sync-op-vault-changed":
      return { ...state, syncOpVault: action.value }
    case "sync-poll-changed":
      return { ...state, syncPoll: action.value }
    case "sync-save-started":
      return { ...state, syncReqId: action.requestId, syncStatus: { text: "Saving sync settings…", kind: "info" } }
    case "op-label-input-changed":
      return { ...state, opLabelInput: action.value }
    case "op-token-input-changed":
      return { ...state, opTokenInput: action.value }
    case "op-submit-started":
      return { ...state, opReqId: action.requestId, opTokenInput: "", opStatus: { text: "Verifying…", kind: "info" } }
    case "op-status-set":
      return { ...state, opStatus: { text: action.text, kind: action.kind } }
    case "op-status-received": {
      const frame = action.frame
      if (frame.requestId !== state.opReqId) return state
      return {
        ...state,
        opReqId: null,
        opStatus: {
          text: frame.ok
            ? (typeof frame.message === "string" && frame.message ? frame.message : "Saved. Restarting…")
            : (typeof frame.message === "string" && frame.message ? frame.message : "Could not save the token."),
          kind: frame.ok ? "ok" : "error",
        },
      }
    }
    case "socket-closed": {
      let next: VaultPanelState = { ...state, valueInput: "", opTokenInput: "" }
      if (next.reqId) {
        const lostKind = next.reqKind
        next = { ...next, reqId: null, reqKind: null }
        if (lostKind && lostKind !== "put-op-token") {
          next = { ...next, statusLine: { text: "Connection lost — check the list after reconnecting.", kind: "error" } }
        }
      }
      if (next.syncReqId) {
        next = { ...next, syncReqId: null, syncStatus: { text: "Connection lost — check sync state after reconnecting.", kind: "error" } }
      }
      return next
    }
    default:
      return state
  }
}
